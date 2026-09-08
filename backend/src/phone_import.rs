//! Explicit, short-lived LAN inbox. A submission is text, never an imported guide.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

use crate::lock;

const MAX_BODY_BYTES: usize = 8 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_CONNECTIONS: usize = 4;
const IDLE_TIMEOUT: Duration = Duration::from_secs(3);
const ACCEPT_POLL: Duration = Duration::from_millis(50);
const LIFETIME: Duration = Duration::from_secs(600);
const SUCCESS: &str = "已发送到 Deck，待确认并下载，不代表导入成功";

#[derive(Default)]
struct State {
    closed: bool,
    text: Option<String>,
    connections: HashMap<u64, TcpStream>,
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    deadline: Instant,
    authority: String,
    origin: String,
    token: String,
    nonce: String,
    page: String,
}

impl Shared {
    fn close(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        state.text = None;
        for connection in state.connections.values() {
            let _ = connection.shutdown(Shutdown::Both);
        }
        self.wake.notify_all();
    }
}

pub struct PhoneImportSession {
    id: String,
    url: String,
    expires_at: u64,
    shared: Arc<Shared>,
    listener: Option<JoinHandle<()>>,
}

impl PhoneImportSession {
    #[cfg(test)]
    pub(crate) fn start_loopback(lifetime: Duration) -> io::Result<Self> {
        Self::start_at("127.0.0.1:0", "localhost", lifetime)
    }

    /// Nothing listens until this explicit call. The URL uses the Deck's mDNS name.
    pub fn start() -> io::Result<Self> {
        let mut hostname = [0_u8; 256];
        // SAFETY: gethostname receives a valid writable buffer and its exact length.
        if unsafe { libc::gethostname(hostname.as_mut_ptr().cast(), hostname.len()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let end = hostname
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Steam Deck 主机名无效"))?;
        let hostname = std::str::from_utf8(&hostname[..end])
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Steam Deck 主机名无效"))?;
        Self::start_at(
            "0.0.0.0:0",
            &format!(
                "{}.local",
                hostname.strip_suffix(".local").unwrap_or(hostname)
            ),
            LIFETIME,
        )
    }

    fn start_at(address: &str, hostname: &str, lifetime: Duration) -> io::Result<Self> {
        if hostname.is_empty()
            || !hostname.as_bytes()[0].is_ascii_alphanumeric()
            || !hostname.as_bytes()[hostname.len() - 1].is_ascii_alphanumeric()
            || !hostname
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Steam Deck 主机名无效",
            ));
        }
        let id = random_bytes::<12>()?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let token = URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);
        let nonce = URL_SAFE_NO_PAD.encode(random_bytes::<16>()?);
        let listener = TcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        let authority = format!("{hostname}:{}", listener.local_addr()?.port());
        let origin = format!("http://{authority}");
        let url = format!("{origin}/#{token}");
        let expires_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_millis() as u64
            + lifetime.as_millis() as u64;
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            deadline: Instant::now() + lifetime,
            authority,
            origin,
            token,
            page: include_str!("../assets/phone-import.html").replace("NONCE", &nonce),
            nonce,
        });
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("grip-phone-import".into())
            .spawn(move || serve(listener, worker_shared))?;
        Ok(Self {
            id,
            url,
            expires_at,
            shared,
            listener: Some(worker),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn info(&self) -> Value {
        json!({"id": self.id, "url": self.url, "expiresAt": self.expires_at})
    }

    pub fn snapshot(&self) -> Value {
        let state = lock(&self.shared.state);
        if state.closed || Instant::now() >= self.shared.deadline {
            json!({"state": "expired"})
        } else if let Some(text) = &state.text {
            json!({"state": "submitted", "text": text})
        } else {
            json!({"state": "waiting"})
        }
    }

    pub fn stop(&mut self) {
        self.shared.close();
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}

impl Drop for PhoneImportSession {
    fn drop(&mut self) {
        self.stop();
    }
}

fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes)
}

struct Connection {
    id: u64,
    stream: TcpStream,
    shared: Arc<Shared>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
        lock(&self.shared.state).connections.remove(&self.id);
    }
}

fn serve(listener: TcpListener, shared: Arc<Shared>) {
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    let mut next_id = 0;
    loop {
        let state = lock(&shared.state);
        if state.closed || Instant::now() >= shared.deadline {
            break;
        }
        drop(state);
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() {
                let _ = workers.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let Ok(tracked) = stream.try_clone() else {
                    continue;
                };
                if stream.set_nonblocking(false).is_err()
                    || stream.set_read_timeout(Some(IDLE_TIMEOUT)).is_err()
                    || stream.set_write_timeout(Some(IDLE_TIMEOUT)).is_err()
                {
                    continue;
                }
                let mut state = lock(&shared.state);
                if state.closed
                    || Instant::now() >= shared.deadline
                    || state.connections.len() >= MAX_CONNECTIONS
                {
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                next_id += 1;
                state.connections.insert(next_id, tracked);
                drop(state);
                let mut connection = Connection {
                    id: next_id,
                    stream,
                    shared: shared.clone(),
                };
                if let Ok(worker) = thread::Builder::new()
                    .name("grip-phone-request".into())
                    .spawn(move || {
                        let _ = handle(&mut connection.stream, &connection.shared);
                    })
                {
                    workers.push(worker);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let state = lock(&shared.state);
                if state.closed {
                    break;
                }
                let wait =
                    ACCEPT_POLL.min(shared.deadline.saturating_duration_since(Instant::now()));
                let _ = shared.wake.wait_timeout(state, wait);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    shared.close();
    drop(listener);
    for worker in workers {
        let _ = worker.join();
    }
}

fn single_header<'a>(headers: &[httparse::Header<'a>], name: &str) -> Option<&'a [u8]> {
    let mut matches = headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case(name));
    let value = matches.next()?.value;
    matches.next().is_none().then_some(value)
}

fn handle(stream: &mut TcpStream, shared: &Shared) -> io::Result<()> {
    let mut input = Vec::new();
    let body_offset = loop {
        let mut headers = [httparse::EMPTY_HEADER; 64];
        match httparse::Request::new(&mut headers).parse(&input) {
            Ok(httparse::Status::Complete(offset)) => break offset,
            Err(_) => return reply(stream, shared, 400, "请求格式无效", false),
            Ok(httparse::Status::Partial) => {}
        }
        if input.len() >= MAX_HEADER_BYTES {
            return reply(stream, shared, 431, "请求头过长", false);
        }
        let mut chunk = [0; 1024];
        let available = chunk.len().min(MAX_HEADER_BYTES - input.len());
        let count = stream.read(&mut chunk[..available])?;
        if count == 0 {
            return Ok(());
        }
        input.extend_from_slice(&chunk[..count]);
    };
    let mut headers = [httparse::EMPTY_HEADER; 64];
    let mut request = httparse::Request::new(&mut headers);
    request
        .parse(&input)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "请求格式无效"))?;
    let valid_host = single_header(request.headers, "Host") == Some(shared.authority.as_bytes());
    if request.method == Some("GET") {
        let origin = single_header(request.headers, "Origin");
        let no_origin = !request
            .headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("Origin"));
        return if !valid_host || (!no_origin && origin != Some(shared.origin.as_bytes())) {
            reply(stream, shared, 403, "请求来源不正确", false)
        } else if request.path != Some("/") {
            reply(stream, shared, 404, "页面不存在", false)
        } else {
            reply(stream, shared, 200, &shared.page, true)
        };
    }
    if request.method != Some("POST") {
        return reply(stream, shared, 501, "不支持的请求方法", false);
    }
    let token = single_header(request.headers, "X-GRIP-Token").unwrap_or_default();
    if !valid_host
        || single_header(request.headers, "Origin") != Some(shared.origin.as_bytes())
        || !bool::from(token.ct_eq(shared.token.as_bytes()))
    {
        return reply(stream, shared, 403, "二维码无效或请求来源不正确", false);
    }
    if request.path != Some("/submit") {
        return reply(stream, shared, 404, "页面不存在", false);
    }
    if single_header(request.headers, "Content-Type") != Some(b"application/json")
        || request
            .headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("Transfer-Encoding"))
    {
        return reply(stream, shared, 415, "仅接收分享文字", false);
    }
    let length = single_header(request.headers, "Content-Length")
        .filter(|value| (1..=10).contains(&value.len()) && value.iter().all(u8::is_ascii_digit))
        .and_then(|value| std::str::from_utf8(value).ok())
        .and_then(|value| value.parse::<usize>().ok());
    let Some(length) = length else {
        return reply(stream, shared, 400, "请求长度无效", false);
    };
    if length > MAX_BODY_BYTES {
        return reply(stream, shared, 413, "分享文字过长", false);
    }
    let mut body = vec![0; length];
    let buffered = length.min(input.len() - body_offset);
    body[..buffered].copy_from_slice(&input[body_offset..body_offset + buffered]);
    if stream.read_exact(&mut body[buffered..]).is_err() {
        return reply(stream, shared, 400, "分享文字格式无效", false);
    }
    let data = serde_json::from_slice::<Value>(&body).ok();
    let text = data
        .as_ref()
        .and_then(Value::as_object)
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("text"))
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty() && !text.contains(['<', '>', '\0']));
    let Some(text) = text else {
        return reply(stream, shared, 400, "请发送链接或纯文本分享内容", false);
    };
    let (status, message) = {
        let mut state = lock(&shared.state);
        if state.closed || Instant::now() >= shared.deadline {
            (410, "二维码已过期，请在 Deck 上重新生成")
        } else if state.text.is_some() {
            (409, "本次内容已发送，请在 Deck 上确认")
        } else {
            state.text = Some(text.trim().to_owned());
            (200, SUCCESS)
        }
    };
    reply(stream, shared, status, message, false)
}

fn reply(
    stream: &mut TcpStream,
    shared: &Shared,
    status: u16,
    body: &str,
    html: bool,
) -> io::Result<()> {
    let content_type = if html {
        "text/html; charset=utf-8"
    } else {
        "text/plain; charset=utf-8"
    };
    let response = format!(
        "HTTP/1.1 {status} Response\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Security-Policy: default-src 'none'; connect-src 'self'; script-src 'nonce-{}'; style-src 'nonce-{}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n\r\n{body}",
        body.len(),
        shared.nonce,
        shared.nonce
    );
    stream.write_all(response.as_bytes())
}

#[cfg(test)]
#[path = "phone_import_tests.rs"]
mod tests;
