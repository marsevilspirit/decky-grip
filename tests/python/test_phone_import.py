import http.client
import json
import socket
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import urlsplit


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "py_modules"))
from phone_import import MAX_BODY_BYTES, SUCCESS, PhoneImportSession  # noqa: E402


class PhoneImportTests(unittest.TestCase):
    def setUp(self):
        # Tests listen on loopback only; production binds only after the user starts pairing.
        self.session = PhoneImportSession(bind_address="127.0.0.1", hostname="localhost")
        self.addCleanup(self.session.stop)
        self.result = self.session.start()
        self.url = urlsplit(self.result["url"])

    def request(self, method="POST", body=None, headers=None, path="/submit"):
        connection = http.client.HTTPConnection("127.0.0.1", self.url.port, timeout=2)
        self.addCleanup(connection.close)
        default = {
            "Host": self.url.netloc,
            "Origin": f"http://{self.url.netloc}",
            "Content-Type": "application/json",
            "X-GRIP-Token": self.url.fragment,
        }
        default.update(headers or {})
        for key in list(default):
            if default[key] is None:
                del default[key]
        if body is None and method == "POST":
            body = json.dumps({"text": "小黑盒分享 https://www.xiaoheihe.cn/app/bbs/link/123456abcdef"}).encode()
        connection.request(method, path, body=body, headers=default)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read().decode()

    def test_start_is_explicit_idempotent_and_token_is_only_in_fragment(self):
        other = PhoneImportSession(bind_address="127.0.0.1", hostname="localhost")
        self.addCleanup(other.stop)
        self.assertIsNone(other._server)
        self.assertEqual(set(self.result), {"id", "url", "expiresAt"})
        self.assertEqual(self.session.start(), self.result)
        self.assertEqual(self.result["id"], self.session.id)
        self.assertNotEqual(self.result["id"], self.url.fragment)
        self.assertEqual(self.url.path, "/")
        self.assertFalse(self.url.query)
        self.assertGreaterEqual(len(self.url.fragment), 40)
        self.assertGreater(self.result["expiresAt"], int(time.time() * 1000))

    def test_static_page_has_no_token_and_security_headers(self):
        status, headers, body = self.request("GET", path="/", headers={"Origin": None})
        self.assertEqual(status, 200)
        self.assertNotIn(self.url.fragment, body)
        self.assertNotIn(self.session.id, body)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertIn("default-src 'none'", headers["Content-Security-Policy"])
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertIn("location.hash.slice(1)", body)
        self.assertIn("history.replaceState", body)
        self.assertIn("status.textContent", body)
        self.assertNotIn("innerHTML", body)

    def test_one_submission_waits_for_deck_confirmation_and_rejects_duplicates(self):
        self.assertEqual(self.session.snapshot(), {"state": "waiting"})
        status, _, body = self.request(body=json.dumps({"text": "  一个分享链接  "}).encode())
        self.assertEqual((status, body), (200, SUCCESS))
        self.assertEqual(self.session.snapshot(), {"state": "submitted", "text": "一个分享链接"})
        self.assertEqual(self.session.snapshot()["text"], "一个分享链接")
        self.assertEqual(self.request()[0], 409)
        self.assertEqual(self.session.snapshot()["text"], "一个分享链接")

    def test_bad_token_host_or_origin_cannot_submit(self):
        for headers in [
            {"X-GRIP-Token": "wrong"},
            {"X-GRIP-Token": None},
            {"Host": f"evil.test:{self.url.port}"},
            {"Host": "localhost"},
            {"Origin": "http://evil.test"},
            {"Origin": "null"},
            {"Origin": None},
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.session.snapshot(), {"state": "waiting"})
        self.assertEqual(self.request("GET", path="/", headers={"Host": "evil.test"})[0], 403)

    def test_only_bounded_json_plain_text_is_accepted(self):
        for value in [{}, {"text": []}, {"text": ""}, {"text": "\u0000"},
                      {"text": "<script>alert(1)</script>"}, {"text": "ok", "code": "run"}]:
            with self.subTest(value=value):
                self.assertEqual(self.request(body=json.dumps(value).encode())[0], 400)
        self.assertEqual(self.request(body=b"{broken")[0], 400)
        self.assertEqual(self.request(body=b"x" * (MAX_BODY_BYTES + 1))[0], 413)
        self.assertEqual(self.request(headers={"Content-Length": str(MAX_BODY_BYTES + 1)})[0], 413)
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request(headers={"Transfer-Encoding": "chunked"})[0], 415)
        self.assertEqual(self.request(headers={"Content-Length": "-1"})[0], 400)
        self.assertEqual(self.session.snapshot(), {"state": "waiting"})

    def test_stop_is_idempotent_and_releases_port(self):
        self.session.stop()
        self.session.stop()
        self.assertEqual(self.session.snapshot(), {"state": "expired"})
        with self.assertRaises(RuntimeError):
            self.session.start()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", self.url.port))
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", self.url.port), timeout=0.2)

    def test_expiration_automatically_stops_listener(self):
        session = PhoneImportSession(
            bind_address="127.0.0.1", hostname="localhost", lifetime_seconds=0.02
        )
        self.addCleanup(session.stop)
        url = urlsplit(session.start()["url"])
        deadline = time.monotonic() + 2
        while session._thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(session._thread.is_alive())
        self.assertEqual(session.snapshot(), {"state": "expired"})
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", url.port))

    def test_expired_and_other_paths_do_not_accept_text(self):
        self.assertEqual(self.request(path="/other")[0], 404)
        self.assertEqual(self.request("GET", path="/?token=ignored")[0], 404)
        self.session._deadline = 0
        self.assertEqual(self.request()[0], 410)
        self.assertEqual(self.session.snapshot(), {"state": "expired"})

    def test_extra_connections_are_closed_when_four_request_slots_are_busy(self):
        slots = self.session._server._slots
        for _ in range(4):
            self.assertTrue(slots.acquire(blocking=False))
        try:
            with socket.create_connection(("127.0.0.1", self.url.port), timeout=1) as connection:
                self.assertEqual(connection.recv(1), b"")
        finally:
            for _ in range(4):
                slots.release()
        self.assertEqual(self.request("GET", path="/")[0], 200)

    def test_stop_and_expiry_disconnect_incomplete_requests_and_release_handlers(self):
        for expire in [False, True]:
            with self.subTest(expire=expire):
                session = PhoneImportSession(
                    bind_address="127.0.0.1", hostname="localhost",
                    lifetime_seconds=0.1 if expire else 600,
                )
                self.addCleanup(session.stop)
                url = urlsplit(session.start()["url"])
                server = session._server
                with socket.create_connection(("127.0.0.1", url.port), timeout=1) as connection:
                    connection.sendall(b"GET / HTTP/1.1\r\n")
                    deadline = time.monotonic() + 1
                    while server._slots._value == 4 and time.monotonic() < deadline:
                        time.sleep(0.001)
                    self.assertEqual(server._slots._value, 3)
                    if expire:
                        session._timer.join(timeout=1)
                        self.assertFalse(session._timer.is_alive())
                    else:
                        session.stop()
                    try:
                        connection.sendall(f"Host: {url.netloc}\r\n\r\n".encode())
                    except OSError:
                        pass
                    try:
                        response = connection.recv(1024)
                    except ConnectionResetError:
                        response = b""
                    self.assertEqual(response, b"")
                for _ in range(4):
                    self.assertTrue(server._slots.acquire(timeout=1))
                for _ in range(4):
                    server._slots.release()
                self.assertFalse(session._thread.is_alive())
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    probe.bind(("127.0.0.1", url.port))


if __name__ == "__main__":
    unittest.main()
