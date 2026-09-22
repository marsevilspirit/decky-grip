use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(crate) static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TestDirectory(pub(crate) PathBuf, &'static str);

impl TestDirectory {
    pub(crate) fn new(filename: &'static str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "grip-sidecar-test-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path, filename)
    }

    pub(crate) fn path(&self) -> PathBuf {
        self.0.join(self.1)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Route approved source URLs to local HTTP, preserving the production download path.
/// Each reply writes its prefix, waits, then writes its suffix; count accepted connections.
pub(crate) fn local_http_agent(
    replies: Vec<(&'static str, Duration, &'static str)>,
) -> (ureq::Agent, JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let mut connections = 0;
        let mut stream: Option<BufReader<TcpStream>> = None;
        for (prefix, delay, suffix) in replies {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if stream.is_none() {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            socket.set_nonblocking(false).unwrap();
                            socket
                                .set_read_timeout(Some(Duration::from_secs(3)))
                                .unwrap();
                            stream = Some(BufReader::new(socket));
                            connections += 1;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "download did not connect");
                            thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("local accept failed: {error}"),
                    }
                }
                let reader = stream.as_mut().unwrap();
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    stream = None;
                    continue;
                }
                assert!(line.starts_with("GET "), "unexpected request: {line}");
                while line != "\r\n" {
                    line.clear();
                    assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                }
                let _ = reader.get_mut().write_all(prefix.as_bytes());
                thread::sleep(delay);
                // A timeout intentionally closes the peer before its delayed reply.
                let _ = reader.get_mut().write_all(suffix.as_bytes());
                break;
            }
        }
        connections
    });
    let agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .proxy(None)
        .middleware(
            move |mut request: ureq::http::Request<ureq::SendBody>,
                  next: ureq::middleware::MiddlewareNext| {
                *request.uri_mut() = format!(
                    "http://{address}{}",
                    request.uri().path_and_query().unwrap()
                )
                .parse()
                .unwrap();
                next.handle(request)
            },
        )
        .build()
        .into();
    (agent, server)
}
