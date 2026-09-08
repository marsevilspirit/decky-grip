use super::*;
use std::net::SocketAddr;

fn session() -> PhoneImportSession {
    PhoneImportSession::start_loopback(LIFETIME).unwrap()
}

fn address(session: &PhoneImportSession) -> SocketAddr {
    format!(
        "127.0.0.1:{}",
        url::Url::parse(&session.url).unwrap().port().unwrap()
    )
    .parse()
    .unwrap()
}

fn headers(session: &PhoneImportSession) -> String {
    format!(
        "Host: {}\r\nOrigin: {}\r\nContent-Type: application/json\r\nX-GRIP-Token: {}\r\n",
        session.shared.authority, session.shared.origin, session.shared.token
    )
}

fn exchange(session: &PhoneImportSession, request: &[u8]) -> String {
    let mut stream = TcpStream::connect(address(session)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream.write_all(request).unwrap();
    stream.shutdown(Shutdown::Write).unwrap();
    let mut reply = String::new();
    if let Err(error) = stream.read_to_string(&mut reply) {
        assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
        assert!(!reply.is_empty());
    }
    let (head, body) = reply
        .split_once("\r\n\r\n")
        .expect("complete response headers");
    let length: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(body.len(), length, "complete response body");
    reply
}

fn post(session: &PhoneImportSession, body: &[u8], headers: &str) -> String {
    let mut request = format!(
        "POST /submit HTTP/1.1\r\n{headers}Content-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(body);
    exchange(session, &request)
}

fn status(response: &str) -> u16 {
    response
        .split_whitespace()
        .nth(1)
        .unwrap_or_else(|| panic!("incomplete HTTP response: {response:?}"))
        .parse()
        .unwrap()
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "local server did not reach expected state"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn starts_explicitly_and_returns_independent_secret_and_session_id() {
    let first = session();
    let second = session();
    let info = first.info();
    assert_eq!(info.as_object().unwrap().len(), 3);
    assert_eq!(info["id"], first.id());
    assert_eq!(first.id().len(), 24);
    assert_ne!(first.id(), second.id());
    assert_ne!(first.shared.token, second.shared.token);
    assert_eq!(first.shared.token.len(), 43);
    assert!(
        info["expiresAt"].as_u64().unwrap()
            > SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
    );
    let url = url::Url::parse(&first.url).unwrap();
    assert_eq!(url.path(), "/");
    assert_eq!(url.query(), None);
    assert_eq!(url.fragment(), Some(first.shared.token.as_str()));
    for invalid in [
        "",
        "bad/name",
        "localhost:1234",
        "-host",
        "host-",
        "a\r\nHost: evil",
    ] {
        assert!(PhoneImportSession::start_at("127.0.0.1:0", invalid, LIFETIME).is_err());
    }
}

#[test]
fn serves_only_local_static_page_with_security_headers_and_without_secrets() {
    let session = session();
    let response = exchange(
        &session,
        format!(
            "GET / HTTP/1.1\r\nHost: {}\r\n\r\n",
            session.shared.authority
        )
        .as_bytes(),
    );
    assert_eq!(status(&response), 200);
    assert!(response.contains("Cache-Control: no-store\r\n"));
    assert!(response.contains("Referrer-Policy: no-referrer\r\n"));
    assert!(response.contains("X-Content-Type-Options: nosniff\r\n"));
    assert!(response.contains("default-src 'none'"));
    assert!(response.contains("frame-ancestors 'none'"));
    assert!(!response.contains("Access-Control-Allow-Origin"));
    assert!(!response.contains(&session.shared.token));
    assert!(!response.contains(session.id()));
    assert!(response.contains("location.hash.slice(1)"));
    assert!(response.contains("history.replaceState"));
    assert!(!response.contains("innerHTML"));
    for (path, extra, expected) in [
        ("/?token=ignored", "", 404),
        ("/", "Origin: http://evil.test\r\n", 403),
    ] {
        let response = exchange(
            &session,
            format!(
                "GET {path} HTTP/1.1\r\nHost: {}\r\n{extra}\r\n",
                session.shared.authority
            )
            .as_bytes(),
        );
        assert_eq!(status(&response), expected);
    }
}

#[test]
fn accepts_one_plain_text_submission_without_claiming_import_success() {
    let mut session = session();
    assert_eq!(session.snapshot(), json!({"state": "waiting"}));
    let reply = post(
        &session,
        br#"{"text":"  one shared link  "}"#,
        &headers(&session),
    );
    assert_eq!(status(&reply), 200);
    assert!(reply.ends_with(SUCCESS));
    assert_eq!(
        session.snapshot(),
        json!({"state": "submitted", "text": "one shared link"})
    );
    assert_eq!(
        status(&post(&session, br#"{"text":"second"}"#, &headers(&session))),
        409
    );
    assert_eq!(session.snapshot()["text"], "one shared link");
    session.stop();
    assert_eq!(session.snapshot(), json!({"state": "expired"}));
    assert!(lock(&session.shared.state).text.is_none());
}

#[test]
fn simultaneous_submissions_can_only_store_one_text() {
    let session = session();
    let statuses = thread::scope(|scope| {
        let first =
            scope.spawn(|| status(&post(&session, br#"{"text":"first"}"#, &headers(&session))));
        let second =
            scope.spawn(|| status(&post(&session, br#"{"text":"second"}"#, &headers(&session))));
        let mut results = [first.join().unwrap(), second.join().unwrap()];
        results.sort();
        results
    });
    assert_eq!(statuses, [200, 409]);
    assert!(matches!(
        session.snapshot()["text"].as_str(),
        Some("first" | "second")
    ));
}

#[test]
fn rejects_missing_wrong_or_duplicate_security_headers() {
    let session = session();
    let base = headers(&session);
    let fields = [
        ("Host", session.shared.authority.as_str()),
        ("Origin", session.shared.origin.as_str()),
        ("X-GRIP-Token", session.shared.token.as_str()),
    ];
    for (name, value) in fields {
        let line = format!("{name}: {value}\r\n");
        for altered in [
            base.replace(&line, ""),
            base.replace(&line, &format!("{name}: wrong\r\n")),
            format!("{base}{line}"),
        ] {
            assert_eq!(
                status(&post(&session, br#"{"text":"ok"}"#, &altered)),
                403,
                "{name}"
            );
        }
    }
    assert_eq!(session.snapshot(), json!({"state": "waiting"}));
}

#[test]
fn accepts_only_bounded_json_with_a_single_plain_text_field() {
    let session = session();
    for body in [
        b"{}".as_slice(),
        br#"{"text":[]}"#,
        br#"{"text":""}"#,
        br#"{"text":"\u0000"}"#,
        br#"{"text":"<script>"}"#,
        br#"{"text":"ok","code":"run"}"#,
        b"{broken",
        b"\xff",
    ] {
        assert_eq!(status(&post(&session, body, &headers(&session))), 400);
    }
    assert_eq!(
        status(&post(
            &session,
            &vec![b'x'; MAX_BODY_BYTES + 1],
            &headers(&session)
        )),
        413
    );
    for (extra, expected) in [
        ("Transfer-Encoding: chunked\r\n", 415),
        ("Content-Length: 1\r\n", 400),
        ("Content-Type: text/plain\r\n", 415),
    ] {
        assert_eq!(
            status(&post(
                &session,
                br#"{"text":"ok"}"#,
                &format!("{}{extra}", headers(&session))
            )),
            expected
        );
    }
    for (length, expected) in [("-1", 400), ("8193", 413), ("10000000000", 400)] {
        let request = format!(
            "POST /submit HTTP/1.1\r\n{}Content-Length: {length}\r\n\r\n",
            headers(&session)
        );
        assert_eq!(status(&exchange(&session, request.as_bytes())), expected);
    }
    let exact = serde_json::to_vec(&json!({"text":"x".repeat(MAX_BODY_BYTES - 11)})).unwrap();
    assert_eq!(exact.len(), MAX_BODY_BYTES);
    assert_eq!(status(&post(&session, &exact, &headers(&session))), 200);
}

#[test]
fn malformed_or_oversized_headers_never_submit() {
    let session = session();
    assert_eq!(
        status(&exchange(
            &session,
            b"POST /submit HTTP/1.1\r\nBad Header: x\r\n\r\n"
        )),
        400
    );
    let oversized = format!("GET / HTTP/1.1\r\nX-Long: {}", "x".repeat(MAX_HEADER_BYTES));
    assert_eq!(status(&exchange(&session, oversized.as_bytes())), 431);
    assert_eq!(session.snapshot(), json!({"state": "waiting"}));
}

#[test]
fn stops_idempotently_and_drop_also_releases_the_listener() {
    let mut inbox = session();
    let stopped_address = address(&inbox);
    inbox.stop();
    inbox.stop();
    assert_eq!(inbox.snapshot(), json!({"state": "expired"}));
    assert!(TcpStream::connect_timeout(&stopped_address, Duration::from_millis(100)).is_err());
    drop(TcpListener::bind(stopped_address).unwrap());
    let other = session();
    let address = address(&other);
    drop(other);
    assert!(TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err());
}

#[test]
fn stop_and_expiry_disconnect_incomplete_headers_and_bodies_and_join_handlers() {
    for expire in [false, true] {
        for body in [false, true] {
            let lifetime = if expire {
                Duration::from_millis(150)
            } else {
                LIFETIME
            };
            let mut session =
                PhoneImportSession::start_at("127.0.0.1:0", "localhost", lifetime).unwrap();
            let mut stream = TcpStream::connect(address(&session)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let partial = if body {
                format!(
                    "POST /submit HTTP/1.1\r\n{}Content-Length: 100\r\n\r\n{{",
                    headers(&session)
                )
            } else {
                "GET / HTTP/1.1\r\n".into()
            };
            stream.write_all(partial.as_bytes()).unwrap();
            wait_until(|| lock(&session.shared.state).connections.len() == 1);
            if expire {
                wait_until(|| session.listener.as_ref().unwrap().is_finished());
            } else {
                session.stop();
            }
            let mut reply = [0; 1];
            match stream.read(&mut reply) {
                Ok(0) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::ConnectionReset
                            | io::ErrorKind::NotConnected
                            | io::ErrorKind::BrokenPipe
                    ) => {}
                result => panic!("stopped connection remained readable: {result:?}"),
            }
            assert!(lock(&session.shared.state).connections.is_empty());
            assert_eq!(session.snapshot(), json!({"state": "expired"}));
            assert!(
                TcpStream::connect_timeout(&address(&session), Duration::from_millis(100)).is_err()
            );
        }
    }
}

#[test]
fn fifth_connection_is_closed_while_four_request_slots_are_busy() {
    let session = session();
    let mut connections = Vec::new();
    for _ in 0..MAX_CONNECTIONS {
        connections.push(TcpStream::connect(address(&session)).unwrap());
    }
    wait_until(|| lock(&session.shared.state).connections.len() == MAX_CONNECTIONS);
    let mut fifth = TcpStream::connect(address(&session)).unwrap();
    fifth
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(fifth.read(&mut [0; 1]).unwrap(), 0);
    drop(connections);
    wait_until(|| lock(&session.shared.state).connections.is_empty());
    assert_eq!(
        status(&post(&session, br#"{"text":"ok"}"#, &headers(&session))),
        200
    );
}

#[test]
fn idle_connection_releases_its_slot_after_three_seconds() {
    let session = session();
    let mut stream = TcpStream::connect(address(&session)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream.write_all(b"GET / HTTP/1.1\r\n").unwrap();
    let start = Instant::now();
    assert_eq!(stream.read(&mut [0; 1]).unwrap(), 0);
    assert!(start.elapsed() >= Duration::from_millis(2800));
    wait_until(|| lock(&session.shared.state).connections.is_empty());
}
