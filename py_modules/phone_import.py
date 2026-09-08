"""Short-lived LAN inbox for one explicitly confirmed guide share text."""

import hmac
import json
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MAX_BODY_BYTES = 8 * 1024
SUCCESS = "已发送到 Deck，待确认并下载，不代表导入成功"


class _PhoneHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args):
        self._slots = threading.BoundedSemaphore(4)
        self._connections = set()
        self._connections_lock = threading.Lock()
        super().__init__(*args)

    def get_request(self):
        request, address = super().get_request()
        with self._connections_lock:
            self._connections.add(request)
        return request, address

    def shutdown_request(self, request):
        try:
            super().shutdown_request(request)
        finally:
            with self._connections_lock:
                self._connections.discard(request)

    def close_connections(self):
        with self._connections_lock:
            connections = tuple(self._connections)
        for request in connections:
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.shutdown_request(request)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, _request, _client_address):
        # Expiring a session can race a phone disconnect; never log request details.
        pass


class PhoneImportSession:
    def __init__(
        self, *, bind_address="0.0.0.0", hostname=None, lifetime_seconds=600
    ):
        self.id = secrets.token_hex(12)
        self._token = secrets.token_urlsafe(32)
        self._hostname = hostname or socket.gethostname().removesuffix(".local") + ".local"
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", self._hostname):
            raise ValueError("Steam Deck 主机名无效")
        self._bind_address = bind_address
        self._lifetime = lifetime_seconds
        self._lock = threading.Lock()
        self._server = None
        self._thread = None
        self._timer = None
        self._closed = False
        self._text = None
        self._url = None

    def start(self):
        with self._lock:
            if self._closed:
                raise RuntimeError("手机导入会话已结束，请生成新的二维码")
            if self._server is None:
                session = self

                class Handler(BaseHTTPRequestHandler):
                    def setup(self):
                        super().setup()
                        self.connection.settimeout(3)

                    def log_message(self, *_args):
                        pass

                    def reply(self, status, text, content_type="text/plain; charset=utf-8"):
                        body = text.encode("utf-8")
                        self.send_response(status)
                        self.send_header("Content-Type", content_type)
                        self.send_header("Content-Length", str(len(body)))
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Referrer-Policy", "no-referrer")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        self.send_header("Connection", "close")
                        self.send_header(
                            "Content-Security-Policy",
                            "default-src 'none'; connect-src 'self'; "
                            f"script-src 'nonce-{session._nonce}'; "
                            f"style-src 'nonce-{session._nonce}'; "
                            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                        )
                        self.end_headers()
                        self.wfile.write(body)

                    def valid_host(self):
                        return self.headers.get_all("Host") == [session._authority]

                    def do_GET(self):
                        if not self.valid_host():
                            self.reply(403, "请求来源不正确")
                        elif self.path != "/":
                            self.reply(404, "页面不存在")
                        elif self.headers.get("Origin") not in (None, session._origin):
                            self.reply(403, "请求来源不正确")
                        else:
                            self.reply(200, session._page(), "text/html; charset=utf-8")

                    def do_POST(self):
                        if (
                            not self.valid_host()
                            or self.headers.get_all("Origin") != [session._origin]
                            or self.headers.get_all("X-GRIP-Token") is None
                            or len(self.headers.get_all("X-GRIP-Token")) != 1
                            or not hmac.compare_digest(
                                self.headers["X-GRIP-Token"].encode("utf-8"),
                                session._token.encode("ascii"),
                            )
                        ):
                            self.reply(403, "二维码无效或请求来源不正确")
                            return
                        if self.path != "/submit":
                            self.reply(404, "页面不存在")
                            return
                        if (
                            self.headers.get_all("Content-Type") != ["application/json"]
                            or self.headers.get("Transfer-Encoding") is not None
                        ):
                            self.reply(415, "仅接收分享文字")
                            return
                        lengths = self.headers.get_all("Content-Length") or []
                        if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,10}", lengths[0]):
                            self.reply(400, "请求长度无效")
                            return
                        length = int(lengths[0])
                        if length > MAX_BODY_BYTES:
                            self.reply(413, "分享文字过长")
                            return
                        try:
                            body = self.rfile.read(length)
                            if len(body) != length:
                                raise ValueError("incomplete body")
                            data = json.loads(body)
                        except (ValueError, UnicodeError, OSError):
                            self.reply(400, "分享文字格式无效")
                            return
                        if (
                            not isinstance(data, dict)
                            or set(data) != {"text"}
                            or not isinstance(data["text"], str)
                            or not data["text"].strip()
                            or any(character in data["text"] for character in "<>\x00")
                        ):
                            self.reply(400, "请发送链接或纯文本分享内容")
                            return
                        with session._lock:
                            if session._closed or time.monotonic() >= session._deadline:
                                status, response = 410, "二维码已过期，请在 Deck 上重新生成"
                            elif session._text is not None:
                                status, response = 409, "本次内容已发送，请在 Deck 上确认"
                            else:
                                session._text = data["text"].strip()
                                status, response = 200, SUCCESS
                        self.reply(status, response)

                self._server = _PhoneHTTPServer((self._bind_address, 0), Handler)
                self._authority = f"{self._hostname}:{self._server.server_port}"
                self._origin = f"http://{self._authority}"
                self._url = f"{self._origin}/#{self._token}"
                self._nonce = secrets.token_urlsafe(16)
                self._deadline = time.monotonic() + self._lifetime
                self._expires_at = int((time.time() + self._lifetime) * 1000)
                self._thread = threading.Thread(
                    target=self._server.serve_forever,
                    kwargs={"poll_interval": 0.05},
                    name="grip-phone-import",
                    daemon=True,
                )
                self._thread.start()
                self._timer = threading.Timer(self._lifetime, self.stop)
                self._timer.daemon = True
                self._timer.start()
            return {"id": self.id, "url": self._url, "expiresAt": self._expires_at}

    def snapshot(self):
        with self._lock:
            if self._closed or self._server is None or time.monotonic() >= self._deadline:
                return {"state": "expired"}
            if self._text is not None:
                return {"state": "submitted", "text": self._text}
            return {"state": "waiting"}

    def stop(self):
        with self._lock:
            self._closed = True
            server, self._server = self._server, None
            self._text = None
            if self._timer:
                self._timer.cancel()
        if server:
            server.shutdown()
            server.close_connections()
            server.server_close()
            if self._thread:
                self._thread.join(timeout=2)

    def _page(self):
        return """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>发送指南到 GRIP</title><style nonce="NONCE">
body{font:17px system-ui;background:#142434;color:#fff;margin:24px;max-width:640px}
textarea,button{box-sizing:border-box;width:100%;font:inherit;border-radius:8px;padding:12px}
textarea{min-height:180px;margin:12px 0}button{background:#66c0f4;color:#101b24;border:0}
p{line-height:1.5}button:disabled{opacity:.5}
</style><h1>发送指南到 Steam Deck</h1>
<p>粘贴小黑盒分享文字。这里只发送链接，仍需在 Deck 上确认并保存。</p>
<label for="text">分享文字或链接</label><textarea id="text" maxlength="8000"></textarea>
<button id="send" type="button">发送到 Deck</button><p id="status" role="status"></p>
<script nonce="NONCE">
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const button = document.getElementById('send'), status = document.getElementById('status');
if (!token) { button.disabled = true; status.textContent = '请扫描 Deck 上的完整二维码'; }
button.onclick = async () => {
  button.disabled = true;
  status.textContent = '正在发送…';
  try {
    const response = await fetch('/submit', {method:'POST',
      headers:{'Content-Type':'application/json','X-GRIP-Token':token},
      body:JSON.stringify({text:document.getElementById('text').value})});
    status.textContent = await response.text();
    button.disabled = response.ok || response.status === 409 || response.status === 410;
  } catch (_) {
    status.textContent = '连接失败，请确认手机与 Deck 在同一可信局域网，并重新扫码';
    button.disabled = false;
  }
};
</script></html>""".replace("NONCE", self._nonce)
