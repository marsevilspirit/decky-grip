import io
import json
import os
import stat
import sys
import tempfile
import textwrap
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))

from rust_sidecar import RustSidecar, RustSidecarError  # noqa: E402


FAKE_SIDECAR = r"""#!/usr/bin/env python3
import json
import sys

capabilities = [
    "positions", "reader_positions", "guides", "images", "hotkey", "multiplex"
]
for line in sys.stdin:
    request = json.loads(line)
    request_id = request["id"]
    method = request["method"]
    params = request["params"]
    if method == "ping":
        result = {"version": 2, "capabilities": capabilities}
    elif method.endswith(".get") or method.endswith(".save") or method.endswith(".set"):
        if params.get("guide_key") == "validation":
            print(json.dumps({
                "id": request_id,
                "ok": False,
                "error": {"kind": "validation", "message": "bad input"},
            }), flush=True)
            continue
        if params.get("guide_key") == "storage":
            print(json.dumps({
                "id": request_id,
                "ok": False,
                "error": {"kind": "storage", "message": "disk failed"},
            }), flush=True)
            continue
        result = params
    elif method.endswith(".snapshot"):
        result = {}
    elif method.endswith(".clear"):
        result = {"filesRemoved": 1, "bytesRemoved": 2}
    elif method.endswith(".repair"):
        result = {"repaired": False, "backup": None}
    elif method == "hotkey.status":
        result = {"available": False, "button": "L4", "device": None, "running": True}
    elif method == "reader_cache.stats":
        result = {"guides": {"files": 1}, "images": {"files": 2}}
    else:
        raise AssertionError(method)
    print(json.dumps({"id": request_id, "ok": True, "result": result}), flush=True)
"""

MULTIPLEX_SIDECAR = r"""#!/usr/bin/env python3
import json
import sys

capabilities = [
    "positions", "reader_positions", "guides", "images", "hotkey", "multiplex"
]
pending = []
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "ping":
        result = {"version": 2, "capabilities": capabilities}
        print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
        continue
    pending.append(request)
    if len(pending) == 2:
        first, second = pending
        print(json.dumps({"id": second["id"], "ok": True, "result": second["params"]}), flush=True)
        print(json.dumps({
            "event": "grip_hotkey",
            "payload": {"version": 1, "button": "L4", "sequence": 1, "detectedAtUnixMs": 2},
        }), flush=True)
        print(json.dumps({"id": first["id"], "ok": True, "result": first["params"]}), flush=True)
"""

LATE_RESPONSE_SIDECAR = r"""#!/usr/bin/env python3
import json
import sys
import time

capabilities = [
    "positions", "reader_positions", "guides", "images", "hotkey", "multiplex"
]
handled = 0
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "ping":
        result = {"version": 2, "capabilities": capabilities}
    else:
        handled += 1
        if handled == 1:
            time.sleep(0.15)
            result = "late"
        else:
            result = "next"
    print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
"""

EOF_SIDECAR = r"""#!/usr/bin/env python3
import json
import sys

capabilities = [
    "positions", "reader_positions", "guides", "images", "hotkey", "multiplex"
]
pending = 0
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "ping":
        result = {"version": 2, "capabilities": capabilities}
        print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
    else:
        pending += 1
        if pending == 2:
            break
"""

OVERSIZED_SIDECAR = r"""#!/usr/bin/env python3
import json
import sys

capabilities = [
    "positions", "reader_positions", "guides", "images", "hotkey", "multiplex"
]
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "ping":
        result = {"version": 2, "capabilities": capabilities}
        print(json.dumps({"id": request["id"], "ok": True, "result": result}), flush=True)
    else:
        print("x" * 1024, flush=True)
"""


class RustSidecarTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        root = Path(self.temporary_directory.name)
        self.binary = root / "fake-sidecar"
        self.positions_path = root / "positions.json"
        self.logger = mock.Mock()
        self.write_sidecar(FAKE_SIDECAR)

    def write_sidecar(self, source):
        self.binary.write_text(textwrap.dedent(source), encoding="utf-8")
        self.binary.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)

    def start(self):
        client = RustSidecar.start(self.binary, self.positions_path, self.logger)
        self.addCleanup(client.close)
        return client

    def test_start_requires_protocol_v2_and_all_capabilities(self):
        self.start()
        self.logger.info.assert_called_once_with("GRIP Rust sidecar ready")

        self.write_sidecar(
            """#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({"id": request["id"], "ok": True, "result": {"version": 2, "capabilities": ["positions"]}}), flush=True)
"""
        )
        with self.assertRaisesRegex(RustSidecarError, "unsupported protocol"):
            RustSidecar.start(self.binary, self.positions_path, self.logger)
        self.logger.error.assert_called_once()

    def test_missing_binary_is_fatal(self):
        with self.assertRaisesRegex(RustSidecarError, "binary is missing"):
            RustSidecar.start(
                self.binary.with_name("missing"), self.positions_path, self.logger
            )
        self.logger.error.assert_called_once()

    def test_large_response_pipes_are_buffered(self):
        client = self.start()
        self.assertIsInstance(client._process.stdin, io.BufferedWriter)
        self.assertIsInstance(client._process.stdout, io.BufferedReader)

    def test_request_only_forwards_json(self):
        client = self.start()

        self.assertEqual(
            client.request(
                "positions.save",
                {"guide_key": "raw key", "scroll_top": "raw scroll"},
            ),
            {"guide_key": "raw key", "scroll_top": "raw scroll"},
        )
        self.assertEqual(
            client.request(
                "reader_positions.save",
                {
                    "guide_key": "raw",
                    "scroll_top": "top",
                    "section_id": 7,
                    "anchor_text": [],
                    "anchor_offset": "offset",
                },
            ),
            {
                "guide_key": "raw",
                "scroll_top": "top",
                "section_id": 7,
                "anchor_text": [],
                "anchor_offset": "offset",
            },
        )
        self.assertEqual(
            client.request(
                "guides.get",
                {"guide_id": "3414883877", "force_refresh": True},
            ),
            {"guide_id": "3414883877", "force_refresh": True},
        )
        self.assertEqual(
            client.request(
                "images.get",
                {"url": "https://example.invalid/a", "allow_download": False},
            ),
            {"url": "https://example.invalid/a", "allow_download": False},
        )
        self.assertEqual(client.request("hotkey.status", {})["button"], "L4")
        self.assertEqual(client.request("reader_cache.stats", {})["images"]["files"], 2)

    def test_maps_validation_and_preserves_other_error_kinds(self):
        client = self.start()
        with self.assertRaisesRegex(ValueError, "bad input"):
            client.request("reader_positions.get", {"guide_key": "validation"})
        with self.assertRaisesRegex(RustSidecarError, "disk failed") as raised:
            client.request("reader_positions.get", {"guide_key": "storage"})
        self.assertEqual(raised.exception.kind, "storage")

    def test_demultiplexes_responses_and_dispatches_events(self):
        self.write_sidecar(MULTIPLEX_SIDECAR)
        client = self.start()
        events = []
        client.set_event_callback(lambda name, payload: events.append((name, payload)))

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(client.request, "test.echo", {"value": 1})
            second = executor.submit(client.request, "test.echo", {"value": 2})
            self.assertEqual(first.result(timeout=1), {"value": 1})
            self.assertEqual(second.result(timeout=1), {"value": 2})

        self.assertEqual(events[0][0], "grip_hotkey")
        self.assertEqual(events[0][1]["sequence"], 1)

    def test_one_timeout_does_not_replace_or_stop_the_sidecar(self):
        self.write_sidecar(LATE_RESPONSE_SIDECAR)
        client = self.start()
        client.RESPONSE_TIMEOUT_SECONDS = 0.03
        started = time.monotonic()
        with self.assertRaisesRegex(RustSidecarError, "timed out"):
            client.request("test.slow", {})
        self.assertLess(time.monotonic() - started, 1)

        client.RESPONSE_TIMEOUT_SECONDS = 1
        self.assertEqual(client.request("test.next", {}), "next")

    def test_eof_wakes_every_pending_request(self):
        self.write_sidecar(EOF_SIDECAR)
        client = self.start()
        with ThreadPoolExecutor(max_workers=2) as executor:
            requests = [
                executor.submit(client.request, "test.wait", {"value": value})
                for value in (1, 2)
            ]
            for request in requests:
                with self.assertRaisesRegex(RustSidecarError, "unavailable"):
                    request.result(timeout=1)

    def test_oversized_response_fails_the_transport(self):
        self.write_sidecar(OVERSIZED_SIDECAR)
        client = self.start()
        client.MAX_RESPONSE_BYTES = 64
        with self.assertRaisesRegex(RustSidecarError, "unavailable"):
            client.request("test.oversized", {})
        with self.assertRaisesRegex(RustSidecarError, "unavailable"):
            client.request("test.after_failure", {})


@unittest.skipUnless(
    os.environ.get("GRIP_RUST_SIDECAR"), "Rust sidecar binary was not built"
)
class RustSidecarProcessIntegrationTests(unittest.TestCase):
    def test_python_bridge_and_rust_share_both_position_files(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "positions.json"
            reader_path = path.with_name("reader_positions.json")
            path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "positions": {
                            "1:90071992547409931234": {
                                "scroll_top": 12.5,
                                "updated_at_ms": 34,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            reader_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "positions": {
                            "1:2": {
                                "scroll_top": 3,
                                "section_id": None,
                                "anchor_text": "existing anchor",
                                "anchor_offset": 0,
                                "updated_at_ms": 34,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            client = RustSidecar.start(
                Path(os.environ["GRIP_RUST_SIDECAR"]), path, mock.Mock()
            )
            try:
                self.assertEqual(client.request("hotkey.status", {})["button"], "L4")
                self.assertEqual(
                    client.request("positions.snapshot", {})["1:90071992547409931234"][
                        "scroll_top"
                    ],
                    12.5,
                )
                client.request(
                    "positions.save", {"guide_key": "2:20", "scroll_top": 56}
                )
                self.assertEqual(
                    client.request("reader_positions.get", {"guide_key": "1:2"})[
                        "anchor_text"
                    ],
                    "existing anchor",
                )
                client.request(
                    "reader_positions.save",
                    {
                        "guide_key": "2:20",
                        "scroll_top": 78,
                        "section_id": "section-2",
                        "anchor_text": None,
                        "anchor_offset": -5,
                    },
                )
            finally:
                client.close()

            positions = json.loads(path.read_text(encoding="utf-8"))["positions"]
            readers = json.loads(reader_path.read_text(encoding="utf-8"))["positions"]
            self.assertEqual(positions["2:20"]["scroll_top"], 56.0)
            self.assertEqual(readers["2:20"]["section_id"], "section-2")


if __name__ == "__main__":
    unittest.main()
