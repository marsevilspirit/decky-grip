import asyncio
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))


class _TestLogger:
    def info(self, _message):
        pass

    def error(self, _message):
        pass


fake_decky = types.ModuleType("decky")
fake_decky.DECKY_PLUGIN_SETTINGS_DIR = ""
fake_decky.logger = _TestLogger()
sys.modules["decky"] = fake_decky

import main as plugin_main  # noqa: E402
from rust_sidecar import RustSidecar, RustSidecarError  # noqa: E402


def make_sidecar():
    sidecar = mock.Mock()
    sidecar.responses = {
        "positions.snapshot": {},
        "positions.repair": {"repaired": False, "backup": None},
        "reader_positions.get": None,
        "reader_positions.repair": {"repaired": False, "backup": None},
        "hotkey.status": {
            "available": False,
            "button": "L4",
            "device": None,
            "running": True,
        },
    }

    def request(method, _params, **_kwargs):
        response = sidecar.responses.get(method)
        if isinstance(response, Exception):
            raise response
        return response

    sidecar.request.side_effect = request
    return sidecar


class PluginBridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.settings_directory.cleanup)
        plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = self.settings_directory.name
        self.sidecar = make_sidecar()
        self.start_patch = mock.patch.object(
            plugin_main.RustSidecar, "start", return_value=self.sidecar
        )
        self.start = self.start_patch.start()
        self.addCleanup(self.start_patch.stop)
        self.plugins = []

    async def asyncTearDown(self):
        for plugin in self.plugins:
            plugin._stop_hotkey()
            plugin._stop_preloading()

    def plugin(self):
        plugin = plugin_main.Plugin()
        self.plugins.append(plugin)
        return plugin

    async def test_constructor_requires_the_one_rust_backend(self):
        plugin = self.plugin()

        self.assertIs(plugin._sidecar, self.sidecar)
        self.assertEqual(
            self.start.call_args.args[1],
            Path(self.settings_directory.name) / "positions.json",
        )
        self.assertIs(
            self.sidecar.set_event_callback.call_args.args[0].__self__, plugin
        )

    async def test_start_failure_is_not_replaced_with_a_python_writer(self):
        self.start.side_effect = RustSidecarError("missing")
        with self.assertRaisesRegex(RustSidecarError, "missing"):
            plugin_main.Plugin()
        self.start.assert_called_once()

    async def test_running_sidecar_failure_does_not_switch_writers(self):
        plugin = self.plugin()
        self.sidecar.responses["positions.snapshot"] = RustSidecarError("dead")

        with self.assertRaisesRegex(RustSidecarError, "dead"):
            await plugin.get_positions()
        with self.assertRaisesRegex(RustSidecarError, "dead"):
            await plugin.get_positions()

        self.assertIs(plugin._sidecar, self.sidecar)
        self.start.assert_called_once()

    async def test_hotkey_event_is_validated_forwarded_and_stopped(self):
        plugin = self.plugin()
        callback = self.sidecar.set_event_callback.call_args.args[0]
        loop = mock.Mock()
        loop.is_closed.return_value = False
        plugin._event_loop = loop
        event = {
            "version": 1,
            "button": "L4",
            "sequence": 7,
            "detectedAtUnixMs": 1001,
        }

        callback("grip_hotkey", event)
        callback("grip_hotkey", {**event, "sequence": True})

        loop.call_soon_threadsafe.assert_called_once_with(plugin._emit_hotkey, event)
        self.assertEqual((await plugin.get_hotkey_status())["button"], "L4")
        await plugin._unload()
        self.sidecar.set_event_callback.assert_called_with(None)
        self.sidecar.close.assert_called_once_with()

    async def test_hotkey_emit_uses_decky_event_and_ignores_stopped_loop(self):
        plugin = self.plugin()
        event = {
            "version": 1,
            "button": "L4",
            "sequence": 1,
            "detectedAtUnixMs": 1001,
        }
        plugin._event_loop = None
        with mock.patch.object(asyncio, "create_task") as create_task:
            plugin._emit_hotkey(event)
        create_task.assert_not_called()

        plugin._event_loop = asyncio.get_running_loop()
        with mock.patch.object(
            plugin_main.decky,
            "emit",
            new_callable=mock.AsyncMock,
            create=True,
        ) as emit:
            plugin._emit_hotkey(event)
            await asyncio.sleep(0)
        emit.assert_awaited_once_with("grip_hotkey", event)

    async def test_position_rpcs_forward_and_shape_snapshots(self):
        plugin = self.plugin()
        self.sidecar.responses["positions.snapshot"] = {
            "1:2": {"scroll_top": 12.5, "updated_at_ms": 34}
        }
        self.sidecar.responses["positions.save"] = {"scroll_top": 2}

        self.assertEqual(
            await plugin.get_positions(),
            {"1:2": {"scrollTop": 12.5, "updatedAt": 34}},
        )
        self.assertEqual(await plugin.save_position("1:2", 2), {"scroll_top": 2})
        self.sidecar.request.assert_any_call(
            "positions.save", {"guide_key": "1:2", "scroll_top": 2}
        )

    async def test_reader_position_and_repair_bridges_shape_only_for_frontend(self):
        plugin = self.plugin()
        saved = {
            "scroll_top": 4040.25,
            "section_id": "7667220",
            "anchor_text": "定位文本",
            "anchor_offset": -17.5,
            "updated_at_ms": 34,
        }
        self.sidecar.responses["reader_positions.get"] = saved
        self.sidecar.responses["reader_positions.save"] = saved
        self.sidecar.responses["positions.repair"] = {
            "repaired": True,
            "backup": "/tmp/positions.bak",
        }

        expected = {
            "scrollTop": 4040.25,
            "sectionId": "7667220",
            "anchorText": "定位文本",
            "anchorOffset": -17.5,
            "updatedAt": 34,
        }
        self.assertEqual(await plugin.get_reader_position("1:2"), expected)
        self.assertEqual(
            await plugin.save_reader_position(
                "1:2", 4040.25, "7667220", "定位文本", -17.5
            ),
            expected,
        )
        repairs = await plugin.repair_position_stores()
        self.assertTrue(repairs["positions"]["repaired"])
        self.assertFalse(repairs["readerPositions"]["repaired"])

    async def test_position_io_remains_serialized_when_cancelled(self):
        plugin = self.plugin()
        events = []
        first_started = threading.Event()
        release_first = threading.Event()

        def operation(label):
            events.append(f"{label}:start")
            if label == "first":
                first_started.set()
                release_first.wait(timeout=2)
            events.append(f"{label}:end")

        first = asyncio.create_task(plugin._run_io(operation, "first"))
        self.assertTrue(await asyncio.to_thread(first_started.wait, 1))
        first.cancel()
        second = asyncio.create_task(plugin._run_io(operation, "second"))
        await asyncio.sleep(0.02)
        self.assertNotIn("second:start", events)
        release_first.set()
        results = await asyncio.wait_for(
            asyncio.gather(first, second, return_exceptions=True), timeout=2
        )

        self.assertIsInstance(results[0], asyncio.CancelledError)
        self.assertEqual(
            events,
            ["first:start", "first:end", "second:start", "second:end"],
        )

    async def test_unload_waits_for_an_inflight_position_request(self):
        plugin = self.plugin()
        started = threading.Event()
        release = threading.Event()

        def request(method, _params, **_kwargs):
            self.assertEqual(method, "positions.snapshot")
            started.set()
            release.wait(timeout=2)
            return {}

        self.sidecar.request.side_effect = request
        request = asyncio.create_task(plugin.get_positions())
        self.assertTrue(await asyncio.to_thread(started.wait, 1))
        unloading = asyncio.create_task(plugin._unload())
        await asyncio.sleep(0.02)
        self.assertFalse(self.sidecar.close.called)
        release.set()
        await asyncio.wait_for(asyncio.gather(request, unloading), timeout=2)
        self.sidecar.close.assert_called_once_with()

    async def test_guides_run_concurrently_and_forward_force_refresh(self):
        plugin = self.plugin()
        first_started = threading.Event()
        release_first = threading.Event()

        def request(method, params, *, timeout=None):
            self.assertEqual(method, "guides.get")
            self.assertEqual(timeout, RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS)
            guide_id = params["guide_id"]
            if guide_id == "1":
                first_started.set()
                release_first.wait(timeout=2)
            return {
                "guideId": guide_id,
                "forceRefresh": params["force_refresh"],
            }

        self.sidecar.request.side_effect = request
        first = asyncio.create_task(plugin.get_guide("1"))
        try:
            self.assertTrue(await asyncio.to_thread(first_started.wait, 1))
            self.assertEqual(
                await asyncio.wait_for(plugin.get_guide("2", True), timeout=1),
                {"guideId": "2", "forceRefresh": True},
            )
        finally:
            release_first.set()
            await asyncio.wait_for(first, timeout=2)

    async def test_cache_preload_has_a_separate_cancelable_worker(self):
        plugin = self.plugin()
        started = threading.Event()
        release = threading.Event()
        calls = []

        def request(method, params, *, timeout=None):
            self.assertEqual(method, "guides.get_cached")
            self.assertEqual(timeout, RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS)
            guide_id = params["guide_id"]
            calls.append(guide_id)
            if guide_id == "1":
                started.set()
                release.wait(timeout=2)
            return None

        self.sidecar.request.side_effect = request
        first = asyncio.create_task(plugin.get_cached_guide("1"))
        self.assertTrue(await asyncio.to_thread(started.wait, 1))
        second = asyncio.create_task(plugin.get_cached_guide("2"))
        await asyncio.sleep(0)
        second.cancel()
        await asyncio.sleep(0)
        self.assertTrue(second.done())
        release.set()
        results = await asyncio.gather(first, second, return_exceptions=True)
        self.assertIsInstance(results[1], asyncio.CancelledError)
        self.assertEqual(calls, ["1"])

        plugin._stop_preloading()
        self.assertIsNone(await plugin.get_cached_guide("3"))

    async def test_cancelled_guide_rpc_does_not_wait_for_worker(self):
        plugin = self.plugin()
        started = threading.Event()
        release = threading.Event()
        cancellation_observed = asyncio.Event()

        def request(method, _params, *, timeout=None):
            self.assertEqual(method, "guides.get")
            self.assertEqual(timeout, RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS)
            started.set()
            release.wait(timeout=2)
            return {}

        async def call():
            try:
                return await plugin.get_guide("1")
            except asyncio.CancelledError:
                cancellation_observed.set()
                raise

        self.sidecar.request.side_effect = request
        task = asyncio.create_task(call())
        self.assertTrue(await asyncio.to_thread(started.wait, 1))
        task.cancel()
        for _ in range(5):
            if cancellation_observed.is_set():
                break
            await asyncio.sleep(0)
        self.assertTrue(cancellation_observed.is_set())
        release.set()
        result = await asyncio.gather(task, return_exceptions=True)
        self.assertIsInstance(result[0], asyncio.CancelledError)

    async def test_image_and_cache_admin_rpcs_forward_protocol_methods(self):
        plugin = self.plugin()
        self.sidecar.responses["images.get"] = {"fromCache": True}
        self.sidecar.responses["guides.clear"] = {"filesRemoved": 1}
        self.sidecar.responses["images.clear"] = {"filesRemoved": 2}
        self.sidecar.responses["reader_cache.stats"] = {
            "guides": {"files": 0},
            "images": {"files": 0},
        }

        self.assertTrue(
            (
                await plugin.get_guide_image(
                    "https://images.steamusercontent.com/a.png", False
                )
            )["fromCache"]
        )
        self.assertEqual((await plugin.clear_guide_cache())["filesRemoved"], 1)
        self.assertEqual((await plugin.clear_image_cache())["filesRemoved"], 2)
        self.assertEqual((await plugin.get_reader_cache_stats())["guides"]["files"], 0)
        self.sidecar.request.assert_any_call(
            "images.get",
            {
                "url": "https://images.steamusercontent.com/a.png",
                "allow_download": False,
            },
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )


if __name__ == "__main__":
    unittest.main()
