//! Capture only the marked, disposable CEF page owned by GRIP.

use crate::{guides::GuideError, storage::read_bounded_regular_file};
use serde_json::{Value, json};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Error as WsError, HandshakeError, Message, client::client_with_config};

const SOURCE_PREFIX: &str = "https://www.xiaoheihe.cn/app/bbs/link/";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_WEBSOCKET_BYTES: usize = 8 * 1024 * 1024;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(120);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);
const IO_SLICE: Duration = Duration::from_millis(200);
const POLL: Duration = Duration::from_millis(20);

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn validate_request(source_url: &str, marker: &str) -> Result<(), GuideError> {
    if !source_url
        .strip_prefix(SOURCE_PREFIX)
        .is_some_and(|id| valid_hex(id, 12))
    {
        return Err(GuideError::download("仅支持小黑盒公开文章的完整链接"));
    }
    if !valid_hex(marker, 32) {
        return Err(GuideError::download("小黑盒临时页面标记无效"));
    }
    Ok(())
}

fn check(canceled: &AtomicBool, deadline: Instant) -> Result<Duration, GuideError> {
    if canceled.load(Ordering::Acquire) {
        return Err(GuideError::download("已取消小黑盒导入"));
    }
    deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| GuideError::download("小黑盒文章渲染超时，请保持临时页面打开后重试"))
}

fn pause(canceled: &AtomicBool, deadline: Instant) -> Result<(), GuideError> {
    thread::sleep(POLL.min(check(canceled, deadline)?));
    check(canceled, deadline).map(|_| ())
}

fn target_socket(body: &[u8], expected_url: &str) -> Result<Option<String>, GuideError> {
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(GuideError::download("Steam 本地页面列表超过大小限制"));
    }
    let targets: Value = serde_json::from_slice(body)
        .map_err(|_| GuideError::download("Steam 本地页面列表格式无效"))?;
    let mut matches = targets
        .as_array()
        .ok_or_else(|| GuideError::download("Steam 本地页面列表格式无效"))?
        .iter()
        .filter(|target| target["type"] == "page" && target["url"] == expected_url);
    let Some(target) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(GuideError::download("发现多个小黑盒临时页面，请重新导入"));
    }
    let url = target["webSocketDebuggerUrl"].as_str().unwrap_or_default();
    let id = url
        .strip_prefix("ws://localhost:8080/devtools/page/")
        .or_else(|| url.strip_prefix("ws://127.0.0.1:8080/devtools/page/"));
    if !id.is_some_and(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        return Err(GuideError::download("拒绝连接非本地的小黑盒渲染页面"));
    }
    Ok(Some(url.to_owned()))
}

fn find_target(
    address: SocketAddr,
    expected_url: &str,
    canceled: &AtomicBool,
    deadline: Instant,
) -> Result<String, GuideError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .max_idle_connections(0)
        .build()
        .into();
    loop {
        let timeout = IO_SLICE.min(check(canceled, deadline)?);
        // Local discovery can be retried; each request must release its socket promptly on cancel.
        let response = (|| {
            let mut response = agent
                .get(format!("http://{address}/json"))
                .config()
                .timeout_global(Some(timeout))
                .build()
                .call()?;
            if response.status().as_u16() != 200 {
                return Err(ureq::Error::StatusCode(response.status().as_u16()));
            }
            response
                .body_mut()
                .with_config()
                .limit(MAX_RESPONSE_BYTES as u64 + 1)
                .read_to_vec()
        })();
        check(canceled, deadline)?;
        match response {
            Ok(body) => {
                if let Some(url) = target_socket(&body, expected_url)? {
                    return Ok(url);
                }
            }
            Err(ureq::Error::Timeout(_)) => {}
            Err(ureq::Error::BodyExceedsLimit(_)) => {
                return Err(GuideError::download("Steam 本地页面列表超过大小限制"));
            }
            Err(
                ureq::Error::TooManyRedirects
                | ureq::Error::StatusCode(301 | 302 | 303 | 307 | 308),
            ) => {
                return Err(GuideError::download("本地渲染连接不接受重定向"));
            }
            Err(_) => return Err(GuideError::download("无法读取 Steam 本地浏览器页面")),
        }
        pause(canceled, deadline)?;
    }
}

fn evaluation(source_url: &str, expected_url: &str, bundle: &str) -> String {
    let guard = format!(
        "if (globalThis.location.href !== {}) {{ throw new Error(\"GRIP 临时页面已离开原文，请重新导入\"); }}",
        json!(expected_url)
    );
    let expression = format!(
        "(async () => {{ {guard}\n{bundle}\n;{guard}\nconst guide = await GRIPHeyboxRenderer.renderHeyboxArticle({});\n{guard}\nreturn JSON.stringify(guide); }})()",
        json!(source_url)
    );
    json!({
        "id": 1, "method": "Runtime.evaluate",
        "params": { "expression": expression, "awaitPromise": true, "returnByValue": true }
    })
    .to_string()
}

fn read_reply(text: &str, source_url: &str) -> Result<Option<Value>, GuideError> {
    if text.len() > MAX_WEBSOCKET_BYTES {
        return Err(GuideError::download("小黑盒渲染结果超过大小限制"));
    }
    let reply: Value =
        serde_json::from_str(text).map_err(|_| GuideError::download("小黑盒渲染响应格式无效"))?;
    if !reply.is_object() {
        return Err(GuideError::download("小黑盒渲染响应格式无效"));
    }
    if reply["id"].as_u64() != Some(1) {
        return Ok(None);
    }
    let result = &reply["result"];
    if reply.get("error").is_some()
        || !result.is_object()
        || result.get("exceptionDetails").is_some()
    {
        let details = &result["exceptionDetails"];
        let message = details["exception"]["description"]
            .as_str()
            .or_else(|| details["text"].as_str())
            .and_then(|text| text.trim().lines().next())
            .map(|line| line.chars().take(500).collect::<String>())
            .filter(|line| !line.is_empty())
            .unwrap_or_else(|| "小黑盒文章渲染失败，请确认原文可以公开访问".into());
        return Err(GuideError::download(message));
    }
    let value = result["result"]["value"]
        .as_str()
        .ok_or_else(|| GuideError::download("小黑盒文章没有返回有效正文"))?;
    if value.len() > MAX_RESPONSE_BYTES {
        return Err(GuideError::download("小黑盒渲染结果超过大小限制"));
    }
    let guide: Value = serde_json::from_str(value)
        .map_err(|_| GuideError::download("小黑盒文章没有返回有效正文"))?;
    if !guide.is_object() || guide["sourceUrl"] != source_url {
        return Err(GuideError::download("小黑盒渲染结果与导入原文不一致"));
    }
    Ok(Some(guide))
}

fn would_block(error: &WsError) -> bool {
    matches!(error, WsError::Io(error) if error.kind() == io::ErrorKind::WouldBlock)
}

fn capture_at(
    source_url: &str,
    expected_url: &str,
    bundle: &str,
    canceled: &AtomicBool,
    address: SocketAddr,
    deadline: Instant,
) -> Result<Value, GuideError> {
    let websocket_url = find_target(
        address,
        expected_url,
        canceled,
        deadline.min(Instant::now() + DISCOVERY_TIMEOUT),
    )?;
    let stream = TcpStream::connect_timeout(&address, IO_SLICE.min(check(canceled, deadline)?))
        .map_err(|_| GuideError::download("无法连接 Steam 本地浏览器页面"))?;
    stream
        .set_nonblocking(true)
        .map_err(|_| GuideError::download("无法配置 Steam 本地浏览器连接"))?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WEBSOCKET_BYTES))
        .max_frame_size(Some(MAX_WEBSOCKET_BYTES));
    // client_with_config does not follow redirects and owns only this TCP stream.
    let mut handshake = client_with_config(websocket_url.as_str(), stream, Some(config));
    let mut websocket = loop {
        check(canceled, deadline)?;
        match handshake {
            Ok((websocket, _)) => break websocket,
            Err(HandshakeError::Interrupted(pending)) => {
                pause(canceled, deadline)?;
                handshake = pending.handshake();
            }
            Err(HandshakeError::Failure(_)) => {
                return Err(GuideError::download("本地渲染连接失败或发生重定向"));
            }
        }
    };
    if let Err(error) = websocket.write(Message::Text(
        evaluation(source_url, expected_url, bundle).into(),
    )) {
        if !would_block(&error) {
            return Err(GuideError::download("小黑盒临时页面连接中断"));
        }
    }
    loop {
        check(canceled, deadline)?;
        match websocket.flush() {
            Ok(()) => break,
            Err(error) if would_block(&error) => pause(canceled, deadline)?,
            Err(_) => return Err(GuideError::download("小黑盒临时页面连接中断")),
        }
    }
    loop {
        check(canceled, deadline)?;
        match websocket.read() {
            Ok(Message::Text(text)) => {
                if let Some(guide) = read_reply(text.as_str(), source_url)? {
                    return Ok(guide);
                }
            }
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Err(error) if would_block(&error) => pause(canceled, deadline)?,
            Err(WsError::Capacity(_)) => {
                return Err(GuideError::download("小黑盒渲染结果超过大小限制"));
            }
            _ => return Err(GuideError::download("小黑盒临时页面已关闭或渲染连接中断")),
        }
    }
}

/// The runtime owns the worker/cancellation flag. No browser or listener is created here.
pub fn capture(
    source_url: &str,
    marker: &str,
    bundle_path: &Path,
    canceled: &AtomicBool,
) -> Result<Value, GuideError> {
    validate_request(source_url, marker)?;
    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    check(canceled, deadline)?;
    let (bundle, _) = read_bounded_regular_file(bundle_path, MAX_RESPONSE_BYTES as u64, None)
        .map_err(|_| GuideError::download("小黑盒渲染组件缺失或无效，请重新安装插件"))?;
    let bundle = String::from_utf8(bundle.expect("uncached reads include the payload"))
        .map_err(|_| GuideError::download("小黑盒渲染组件格式无效，请重新安装插件"))?;
    if bundle.trim().is_empty() {
        return Err(GuideError::download("小黑盒渲染组件为空，请重新安装插件"));
    }
    capture_at(
        source_url,
        &format!("{source_url}#grip-import-{marker}"),
        &bundle,
        canceled,
        SocketAddr::from((Ipv4Addr::LOCALHOST, 8080)),
        deadline,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::process::Command;
    use std::sync::{Arc, mpsc};

    const SOURCE: &str = "https://www.xiaoheihe.cn/app/bbs/link/123456abcdef";
    const MARKER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SOCKET: &str = "ws://127.0.0.1:8080/devtools/page/GRIP-page-1";
    const BUNDLE: &str = "var GRIPHeyboxRenderer = { renderHeyboxArticle: async sourceUrl => ({ sourceUrl, title: '公开文章' }) };";

    fn expected_url() -> String {
        format!("{SOURCE}#grip-import-{MARKER}")
    }

    fn targets(socket: &str) -> Vec<u8> {
        serde_json::to_vec(&json!([
            {"type":"page", "url":SOURCE, "webSocketDebuggerUrl":"ws://other.test:8080/user-page"},
            {"type":"page", "url":expected_url(), "webSocketDebuggerUrl":socket},
            {"type":"page", "url":"https://unrelated.test", "webSocketDebuggerUrl":"ws://other.test:8080/user-page"}
        ])).unwrap()
    }

    fn read_headers(stream: &mut TcpStream) {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
            assert!(headers.len() < 16 * 1024);
        }
    }

    fn serve_target(
        action: impl FnOnce(TcpStream) + Send + 'static,
    ) -> (SocketAddr, thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut http, _) = listener.accept().unwrap();
            read_headers(&mut http);
            let body = targets(SOCKET);
            write!(
                http,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            http.write_all(&body).unwrap();
            drop(http);
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            action(stream);
        });
        (address, worker)
    }

    fn run_at(
        address: SocketAddr,
        canceled: &AtomicBool,
        timeout: Duration,
    ) -> Result<Value, GuideError> {
        capture_at(
            SOURCE,
            &expected_url(),
            BUNDLE,
            canceled,
            address,
            Instant::now() + timeout,
        )
    }

    #[test]
    fn validates_identity_and_requires_the_exact_marked_local_page() {
        validate_request(SOURCE, MARKER).unwrap();
        for source in [
            format!("{SOURCE}\n"),
            format!("{SOURCE}?tracking=1"),
            format!("{SOURCE}/"),
            SOURCE.replace("https:", "http:"),
            SOURCE.replace(".cn", ".cn.evil.test"),
        ] {
            assert!(validate_request(&source, MARKER).is_err());
        }
        for marker in ["a".repeat(31), "A".repeat(32), format!("{MARKER}\n")] {
            assert!(validate_request(SOURCE, &marker).is_err());
        }
        assert_eq!(
            target_socket(&targets(SOCKET), &expected_url())
                .unwrap()
                .as_deref(),
            Some(SOCKET)
        );
        assert!(
            target_socket(&targets(SOCKET), "different-marked-page")
                .unwrap()
                .is_none()
        );
        for socket in [
            "ws://evil.test:8080/devtools/page/a",
            "ws://localhost:80/devtools/page/a",
            "ws://user@localhost:8080/devtools/page/a",
            "ws://localhost:8080/devtools/browser/a",
            "ws://local\nhost:8080/devtools/page/a",
            "ws://localhost:8080/devtools/page/a?other=1",
        ] {
            assert!(target_socket(&targets(socket), &expected_url()).is_err());
        }
        let duplicate =
            json!([{"type":"page","url":expected_url()},{"type":"page","url":expected_url()}]);
        assert!(target_socket(duplicate.to_string().as_bytes(), &expected_url()).is_err());
        assert!(target_socket(b"{}", &expected_url()).is_err());
    }

    #[test]
    fn rejects_missing_bundle_and_precancellation_without_connecting() {
        let missing = Path::new("/nonexistent-grip-renderer/heybox-render.js");
        assert!(
            capture(SOURCE, MARKER, missing, &AtomicBool::new(false))
                .unwrap_err()
                .message()
                .contains("组件")
        );
        assert!(
            capture(SOURCE, MARKER, missing, &AtomicBool::new(true))
                .unwrap_err()
                .message()
                .contains("取消")
        );
    }

    #[test]
    fn evaluates_the_iife_with_location_guards_before_and_after_rendering() {
        let request: Value =
            serde_json::from_str(&evaluation(SOURCE, &expected_url(), BUNDLE)).unwrap();
        assert_eq!(request["method"], "Runtime.evaluate");
        assert_eq!(request["params"]["awaitPromise"], true);
        for (location, should_succeed) in [(expected_url(), true), (SOURCE.to_owned(), false)] {
            let script = format!(
                "globalThis.location={{href:{}}};console.log(await {});",
                json!(location),
                request["params"]["expression"].as_str().unwrap()
            );
            let output = match Command::new("node")
                .args(["--input-type=module", "-e", &script])
                .output()
            {
                Err(error) if error.kind() == io::ErrorKind::NotFound => return,
                output => output.unwrap(),
            };
            assert_eq!(output.status.success(), should_succeed);
            if should_succeed {
                let result: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(result["sourceUrl"], SOURCE);
            }
        }
        assert_eq!(
            request["params"]["expression"]
                .as_str()
                .unwrap()
                .matches("globalThis.location.href")
                .count(),
            3
        );
    }

    #[test]
    fn captures_only_the_marked_page_over_real_loopback_http_and_websocket() {
        let (address, worker) = serve_target(|stream| {
            let mut websocket = tungstenite::accept(stream).unwrap();
            let request = websocket.read().unwrap();
            let request: Value = serde_json::from_str(request.to_text().unwrap()).unwrap();
            assert_eq!(request["method"], "Runtime.evaluate");
            assert!(
                request["params"]["expression"]
                    .as_str()
                    .unwrap()
                    .contains(&expected_url())
            );
            websocket
                .send(Message::Text(
                    json!({"method":"Runtime.event"}).to_string().into(),
                ))
                .unwrap();
            let guide = json!({"sourceUrl":SOURCE,"title":"公开文章"});
            websocket
                .send(Message::Text(
                    json!({"id":1,"result":{"result":{"value":guide.to_string()}}})
                        .to_string()
                        .into(),
                ))
                .unwrap();
        });
        let guide = run_at(address, &AtomicBool::new(false), Duration::from_secs(2)).unwrap();
        assert_eq!(guide["title"], "公开文章");
        worker.join().unwrap();
    }

    #[test]
    fn cancellation_drops_an_unfinished_http_body_promptly() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let canceled = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&canceled);
        let worker = thread::spawn(move || run_at(address, &flag, Duration::from_secs(2)));
        let (mut stream, _) = listener.accept().unwrap();
        read_headers(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n[")
            .unwrap();
        let start = Instant::now();
        canceled.store(true, Ordering::Release);
        assert!(
            worker
                .join()
                .unwrap()
                .unwrap_err()
                .message()
                .contains("取消")
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(stream.read(&mut [0]).unwrap(), 0);
    }

    #[test]
    fn cancellation_and_deadline_drop_waiting_websockets_without_reconnecting() {
        for (handshake, cancel) in [(false, false), (false, true), (true, true)] {
            let (ready, started) = mpsc::channel();
            let (address, server) = serve_target(move |mut stream| {
                if handshake {
                    read_headers(&mut stream);
                    ready.send(()).unwrap();
                    assert_eq!(stream.read(&mut [0]).unwrap(), 0);
                    return;
                }
                let mut websocket = tungstenite::accept(stream).unwrap();
                websocket.read().unwrap();
                ready.send(()).unwrap();
                assert!(websocket.read().is_err());
            });
            let canceled = Arc::new(AtomicBool::new(false));
            let flag = Arc::clone(&canceled);
            let worker = thread::spawn(move || run_at(address, &flag, Duration::from_millis(300)));
            started.recv_timeout(Duration::from_secs(2)).unwrap();
            if cancel {
                canceled.store(true, Ordering::Release);
            }
            let message = worker.join().unwrap().unwrap_err().message().to_owned();
            assert!(message.contains(if cancel { "取消" } else { "超时" }));
            server.join().unwrap();
        }
    }

    #[test]
    fn websocket_budget_rejects_an_oversized_frame_before_receiving_the_body() {
        let (address, server) = serve_target(|stream| {
            let mut websocket = tungstenite::accept(stream).unwrap();
            websocket.read().unwrap();
            // The client closes on the frame header; the rest may fail to write.
            let _ = websocket.send(Message::Binary(vec![0; MAX_WEBSOCKET_BYTES + 1].into()));
        });
        let error = run_at(address, &AtomicBool::new(false), Duration::from_secs(2)).unwrap_err();
        assert!(error.message().contains("大小限制"));
        server.join().unwrap();
    }

    #[test]
    fn rejects_http_and_websocket_redirects_instead_of_following_them() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_headers(&mut stream);
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://evil.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert!(
            run_at(address, &AtomicBool::new(false), Duration::from_secs(2))
                .unwrap_err()
                .message()
                .contains("重定向")
        );
        server.join().unwrap();
        let (address, server) = serve_target(|mut stream| {
            read_headers(&mut stream);
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: ws://evil.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert!(
            run_at(address, &AtomicBool::new(false), Duration::from_secs(2))
                .unwrap_err()
                .message()
                .contains("重定向")
        );
        server.join().unwrap();
    }

    #[test]
    fn enforces_response_budgets_and_reports_only_bounded_error_details() {
        assert!(target_socket(&vec![b' '; MAX_RESPONSE_BYTES + 1], &expected_url()).is_err());
        assert!(read_reply(&" ".repeat(MAX_WEBSOCKET_BYTES + 1), SOURCE).is_err());
        let oversized =
            json!({"id":1,"result":{"result":{"value":"a".repeat(MAX_RESPONSE_BYTES + 1)}}});
        assert!(
            read_reply(&oversized.to_string(), SOURCE)
                .unwrap_err()
                .message()
                .contains("大小限制")
        );
        let failure = json!({"id":1,"result":{"exceptionDetails":{"exception":{"description":format!("{}\nsecret stack", "图".repeat(600))}}}});
        assert_eq!(
            read_reply(&failure.to_string(), SOURCE)
                .unwrap_err()
                .message(),
            "图".repeat(500)
        );
        for reply in [
            json!(null),
            json!({"id":1,"error":{}}),
            json!({"id":1,"result":{"result":[]}}),
            json!({"id":1,"result":{"result":{"value":"{\"sourceUrl\":\"wrong\"}"}}}),
        ] {
            assert!(read_reply(&reply.to_string(), SOURCE).is_err());
        }
    }
}
