import asyncio
import json
import shutil
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "py_modules"))
import heybox_renderer as renderer  # noqa: E402


SOURCE = "https://www.xiaoheihe.cn/app/bbs/link/123456abcdef"
MARKER = "a" * 32
EXPECTED = f"{SOURCE}#grip-import-{MARKER}"
SOCKET = "ws://127.0.0.1:8080/devtools/page/GRIP-page-1"
GUIDE = {"sourceUrl": SOURCE, "title": "公开文章", "sections": []}
BUNDLE = (
    "var GRIPHeyboxRenderer = { renderHeyboxArticle: async sourceUrl => "
    "({ sourceUrl, title: '公开文章', sections: [] }) };"
)


def target(url=EXPECTED, websocket=SOCKET):
    return {"type": "page", "url": url, "webSocketDebuggerUrl": websocket}


def message(reply):
    return types.SimpleNamespace(type="text", data=json.dumps(reply))


class Context:
    closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_error):
        self.closed = True


class Response(Context):
    status = 200

    def __init__(self, targets):
        self.body = json.dumps(targets).encode()
        self.content = self

    async def iter_chunked(self, _size):
        yield self.body


class Websocket(Context):
    def __init__(self):
        self.sent = []
        self.started = asyncio.Event()
        self.messages = [
            message({"id": 1, "result": {"result": {"value": json.dumps(GUIDE)}}})
        ]

    async def send_json(self, request):
        self.sent.append(request)
        self.started.set()

    async def receive(self):
        if self.messages:
            return self.messages.pop(0)
        await asyncio.Event().wait()


class Session(Context):
    def __init__(self):
        self.response = Response([target()])
        self.websocket = Websocket()
        self.get = mock.Mock(return_value=self.response)
        self.ws_connect = mock.Mock(return_value=self.websocket)


class HeyboxRendererTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.session = Session()
        self.trace = types.SimpleNamespace(on_request_redirect=[])
        self.aiohttp = types.SimpleNamespace(
            ClientSession=mock.Mock(return_value=self.session),
            ClientTimeout=mock.Mock(),
            TraceConfig=mock.Mock(return_value=self.trace),
            WSMsgType=types.SimpleNamespace(TEXT="text"),
        )
        patch = mock.patch.dict(sys.modules, {"aiohttp": self.aiohttp})
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(renderer, "BUNDLE_PATH")
        self.bundle = patch.start()
        self.addCleanup(patch.stop)
        self.bundle.read_text.return_value = BUNDLE

    async def capture(self):
        return await renderer.capture_heybox(SOURCE, MARKER)

    async def test_invalid_inputs_never_open_a_session(self):
        for url in [
            "http" + SOURCE[5:],
            SOURCE + "?tracking=1",
            SOURCE + "#fragment",
            SOURCE + "/",
            SOURCE.replace(".cn", ".cn.evil.test"),
            SOURCE.replace("123456abcdef", "../../passwd"),
            SOURCE + "\n",
            None,
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                await renderer.capture_heybox(url, MARKER)
        for marker in ["a" * 31, "A" * 32, MARKER + "\n", None]:
            with self.subTest(marker=marker), self.assertRaises(ValueError):
                await renderer.capture_heybox(SOURCE, marker)
        self.aiohttp.ClientSession.assert_not_called()

    async def test_only_marked_page_is_evaluated_and_iife_runs(self):
        self.session.response = Response([target(SOURCE), target(), target("https://other.test")])
        self.session.get.return_value = self.session.response
        self.session.websocket.messages.insert(0, message({"method": "Runtime.event"}))
        self.assertEqual(await self.capture(), GUIDE)
        self.session.get.assert_called_once_with(
            "http://localhost:8080/json", allow_redirects=False
        )
        self.session.ws_connect.assert_called_once_with(
            SOCKET, max_msg_size=renderer.MAX_WEBSOCKET_BYTES
        )
        request = self.session.websocket.sent[0]
        self.assertEqual(request["method"], "Runtime.evaluate")
        self.assertTrue(request["params"]["awaitPromise"])
        self.assertTrue(request["params"]["returnByValue"])
        expression = request["params"]["expression"]
        node = shutil.which("node")
        if node:
            for location, success in [(EXPECTED, True), (SOURCE, False)]:
                run = subprocess.run(
                    [node, "--input-type=module", "-e",
                     f"globalThis.location = {{ href: {json.dumps(location)} }};"
                     f"console.log(await {expression});"],
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(run.returncode == 0, success, run.stderr)
                if success:
                    self.assertEqual(json.loads(run.stdout), GUIDE)
        self.assertTrue(self.session.closed)
        self.assertTrue(self.session.websocket.closed)

    async def test_unsafe_socket_and_duplicate_target_are_rejected(self):
        for websocket in [
            "ws://evil.test:8080/devtools/page/a",
            "ws://127.0.0.1:80/devtools/page/a",
            "ws://user@localhost:8080/devtools/page/a",
            "ws://localhost:8080/devtools/browser/a",
            "ws://local\nhost:8080/devtools/page/a",
            SOCKET + "?other=1", None,
        ]:
            self.session.get.return_value = Response([target(websocket=websocket)])
            with self.subTest(websocket=websocket), self.assertRaises(ValueError):
                await self.capture()
        self.session.get.return_value = Response([target(), target()])
        with self.assertRaises(ValueError):
            await self.capture()
        self.session.ws_connect.assert_not_called()

    async def test_missing_page_times_out_without_touching_other_tabs(self):
        self.session.get.return_value = Response([target(SOURCE)])
        with mock.patch.object(renderer, "DISCOVERY_TIMEOUT_SECONDS", 0):
            with self.assertRaises(TimeoutError):
                await self.capture()
        self.session.ws_connect.assert_not_called()
        self.assertTrue(self.session.closed)

    async def test_discovery_timeout_cancels_an_unfinished_http_body(self):
        async def stalled_body(_size):
            yield b"["
            await asyncio.Event().wait()

        self.session.response.iter_chunked = stalled_body
        with mock.patch.object(renderer, "DISCOVERY_TIMEOUT_SECONDS", 0.01):
            with self.assertRaises(TimeoutError):
                await self.capture()
        self.assertTrue(self.session.response.closed)
        self.assertTrue(self.session.closed)
        self.session.ws_connect.assert_not_called()

    async def test_timeout_and_cancellation_close_both_connections(self):
        self.session.websocket.messages = []
        with mock.patch.object(renderer, "CAPTURE_TIMEOUT_SECONDS", 0.01):
            with self.assertRaises(TimeoutError):
                await self.capture()
        self.assertTrue(self.session.closed)
        self.assertTrue(self.session.websocket.closed)
        self.session.closed = self.session.websocket.closed = False
        self.session.websocket.started.clear()
        task = asyncio.create_task(self.capture())
        await asyncio.wait_for(self.session.websocket.started.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.session.closed)
        self.assertTrue(self.session.websocket.closed)

    async def test_closed_page_and_script_errors_fail_without_reconnecting(self):
        for reply in [
            types.SimpleNamespace(type="closed", data=None),
            message({"id": 1, "error": {"message": "closed"}}),
            message({"id": 1, "result": {"exceptionDetails": {}}}),
        ]:
            self.session.websocket.messages = [reply]
            with self.assertRaises(RuntimeError):
                await self.capture()
        self.assertEqual(self.session.get.call_count, 3)
        self.assertEqual(self.session.ws_connect.call_count, 3)

    async def test_response_limits_and_source_identity_are_checked(self):
        for guide in [None, {**GUIDE, "sourceUrl": SOURCE + "?other"}]:
            self.session.websocket.messages = [
                message({"id": 1, "result": {"result": {"value": json.dumps(guide)}}})
            ]
            with self.assertRaises(ValueError):
                await self.capture()
        self.session.websocket.messages = [message({"id": 1, "result": {"result": []}})]
        with self.assertRaises(ValueError):
            await self.capture()
        with mock.patch.object(renderer, "MAX_RESPONSE_BYTES", 8):
            with self.assertRaisesRegex(ValueError, "大小限制"):
                await self.capture()
        self.session.websocket.messages = [types.SimpleNamespace(type="text", data="x" * 17)]
        with mock.patch.object(renderer, "MAX_WEBSOCKET_BYTES", 16):
            with self.assertRaisesRegex(ValueError, "大小限制"):
                await self.capture()

    async def test_redirects_and_missing_bundle_are_rejected(self):
        await self.capture()
        with self.assertRaisesRegex(ValueError, "重定向"):
            await self.trace.on_request_redirect[0](None, None, None)
        self.bundle.read_text.side_effect = FileNotFoundError()
        with self.assertRaisesRegex(RuntimeError, "组件缺失"):
            await self.capture()

    async def test_render_error_preserves_only_a_bounded_first_line(self):
        self.session.websocket.messages = [message({
            "id": 1,
            "result": {"exceptionDetails": {"exception": {
                "description": "Error: 图片未完整加载\n    at render (private details)",
            }}},
        })]
        with self.assertRaisesRegex(RuntimeError, "^Error: 图片未完整加载$"):
            await self.capture()


if __name__ == "__main__":
    unittest.main()
