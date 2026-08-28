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


class PluginBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_hotkey_emit_is_ignored_after_unload(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            plugin._event_loop = None

            with mock.patch.object(asyncio, "create_task") as create_task:
                plugin._emit_hotkey()

            create_task.assert_not_called()

    async def test_unload_and_uninstall_stop_hotkey_monitor(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            plugin._hotkey_monitor = mock.Mock()
            plugin._event_loop = asyncio.get_running_loop()

            await plugin._unload()
            await plugin._uninstall()

            self.assertIsNone(plugin._event_loop)
            self.assertEqual(plugin._hotkey_monitor.stop.call_count, 2)

    async def test_get_positions_returns_frontend_snapshot(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()

            self.assertEqual(await plugin.get_positions(), {})

            first = await plugin.save_position("1:10", 10)
            second = await plugin.save_position("2:20", 20)

            positions = await plugin.get_positions()

            self.assertEqual(
                positions,
                {
                    "1:10": {
                        "scrollTop": first["scroll_top"],
                        "updatedAt": first["updated_at_ms"],
                    },
                    "2:20": {
                        "scrollTop": second["scroll_top"],
                        "updatedAt": second["updated_at_ms"],
                    },
                },
            )
            positions["1:10"]["scrollTop"] = 999
            self.assertEqual(
                (await plugin.get_positions())["1:10"]["scrollTop"], 10.0
            )

    async def test_run_io_serializes_concurrent_backend_calls(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            events = []
            first_started = threading.Event()
            release_first = threading.Event()

            def operation(label):
                events.append(f"{label}:start")
                if label == "first":
                    first_started.set()
                    release_first.wait(timeout=2)
                events.append(f"{label}:end")

            tasks = []
            try:
                tasks.append(
                    asyncio.create_task(plugin._run_io(operation, "first"))
                )
                started = await asyncio.to_thread(first_started.wait, 1)
                self.assertTrue(started)

                tasks.append(
                    asyncio.create_task(plugin._run_io(operation, "second"))
                )
                await asyncio.sleep(0.02)
                second_started_early = "second:start" in events
            finally:
                release_first.set()
                if tasks:
                    await asyncio.wait_for(
                        asyncio.gather(*tasks, return_exceptions=True), timeout=2
                    )

            self.assertFalse(second_started_early)
            self.assertEqual(
                events,
                ["first:start", "first:end", "second:start", "second:end"],
            )

    async def test_cancellation_does_not_release_lock_before_io_finishes(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
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
            started = await asyncio.to_thread(first_started.wait, 1)
            self.assertTrue(started)

            first.cancel()
            second = asyncio.create_task(plugin._run_io(operation, "second"))
            await asyncio.sleep(0.02)
            second_started_early = "second:start" in events

            release_first.set()
            results = await asyncio.wait_for(
                asyncio.gather(first, second, return_exceptions=True), timeout=2
            )

            self.assertFalse(second_started_early)
            self.assertIsInstance(results[0], asyncio.CancelledError)
            self.assertIsNone(results[1])
            self.assertEqual(
                events,
                ["first:start", "first:end", "second:start", "second:end"],
            )

    async def test_get_guide_forwards_force_refresh_and_camel_case_document(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            expected = {
                "guideId": "3414883877",
                "title": "P4G guide",
                "author": "author",
                "sourceUrl": "https://steamcommunity.com/",
                "fetchedAt": 123,
                "fromCache": False,
                "stale": False,
                "sections": [{"id": "1", "title": "四月", "html": "4/23"}],
            }
            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get.return_value = expected

            result = await plugin.get_guide("3414883877", True)

            self.assertEqual(result, expected)
            plugin._guide_reader.get.assert_called_once_with("3414883877", True)

    async def test_guide_download_does_not_block_position_rpcs(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            guide_started = threading.Event()
            release_guide = threading.Event()
            expected = {"guideId": "3414883877"}

            def get_guide(_guide_id, _force_refresh):
                guide_started.set()
                release_guide.wait(timeout=2)
                return expected

            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get.side_effect = get_guide
            guide_task = asyncio.create_task(plugin.get_guide("3414883877"))
            try:
                started = await asyncio.to_thread(guide_started.wait, 1)
                self.assertTrue(started)
                position = await asyncio.wait_for(
                    plugin.get_reader_position("1113000:3414883877"), timeout=1
                )
            finally:
                release_guide.set()
                guide_result = await asyncio.wait_for(guide_task, timeout=2)

            self.assertIsNone(position)
            self.assertEqual(guide_result, expected)

    async def test_reader_position_bridge_uses_separate_camel_case_store(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()

            self.assertIsNone(await plugin.get_reader_position("1113000:3414883877"))
            saved = await plugin.save_reader_position(
                "1113000:3414883877",
                4040.25,
                "7667220",
                "去河堤下方与老人对话",
                -17.5,
            )

            self.assertEqual(
                saved,
                {
                    "scrollTop": 4040.25,
                    "sectionId": "7667220",
                    "anchorText": "去河堤下方与老人对话",
                    "anchorOffset": -17.5,
                    "updatedAt": saved["updatedAt"],
                },
            )
            self.assertEqual(
                await plugin.get_reader_position("1113000:3414883877"), saved
            )
            self.assertTrue(
                (Path(settings_directory) / "reader_positions.json").exists()
            )
            self.assertFalse(
                (Path(settings_directory) / "positions.json").exists()
            )


if __name__ == "__main__":
    unittest.main()
