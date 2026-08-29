import asyncio
import concurrent.futures
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
                plugin._emit_hotkey({"version": 1})

            create_task.assert_not_called()

    async def test_hotkey_callback_emits_versioned_ordered_event(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            loop = mock.Mock()
            loop.is_closed.return_value = False
            plugin._event_loop = loop

            plugin._schedule_hotkey_emit(1001)
            plugin._schedule_hotkey_emit(1002)

            first = loop.call_soon_threadsafe.call_args_list[0].args
            second = loop.call_soon_threadsafe.call_args_list[1].args
            self.assertEqual(first[0], plugin._emit_hotkey)
            self.assertEqual(
                first[1],
                {
                    "version": 1,
                    "button": "L4",
                    "sequence": 1,
                    "detectedAtUnixMs": 1001,
                },
            )
            self.assertEqual(second[1]["sequence"], 2)
            self.assertEqual(second[1]["detectedAtUnixMs"], 1002)

    async def test_hotkey_emit_never_sends_a_bare_string(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            plugin._event_loop = asyncio.get_running_loop()
            event = {
                "version": 1,
                "button": "L4",
                "sequence": 1,
                "detectedAtUnixMs": 1001,
            }

            with mock.patch.object(
                plugin_main.decky,
                "emit",
                new_callable=mock.AsyncMock,
                create=True,
            ) as emit:
                plugin._emit_hotkey(event)
                await asyncio.sleep(0)

            emit.assert_awaited_once_with("grip_hotkey", event)

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

    async def test_get_cached_guide_uses_cache_only_reader_method(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            expected = {"guideId": "3414883877", "fromCache": True}
            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get_cached.return_value = expected
            try:
                result = await plugin.get_cached_guide("3414883877")
            finally:
                plugin._stop_preloading()

            self.assertEqual(result, expected)
            plugin._guide_reader.get_cached.assert_called_once_with("3414883877")
            plugin._guide_reader.get.assert_not_called()

    async def test_stopped_preloading_ignores_late_cache_only_calls(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            plugin._guide_reader = mock.Mock()
            plugin._stop_preloading()

            self.assertIsNone(await plugin.get_cached_guide("3414883877"))
            plugin._guide_reader.get_cached.assert_not_called()

    async def test_cached_guide_does_not_hide_worker_runtime_errors_on_stop(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            started = threading.Event()
            release = threading.Event()

            def get_cached(_guide_id):
                started.set()
                release.wait(timeout=2)
                raise RuntimeError("cache validation failed")

            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get_cached.side_effect = get_cached
            cache_task = asyncio.create_task(
                plugin.get_cached_guide("3414883877")
            )
            self.assertTrue(await asyncio.to_thread(started.wait, 1))

            plugin._stop_preloading()
            release.set()

            with self.assertRaisesRegex(RuntimeError, "cache validation failed"):
                await asyncio.wait_for(cache_task, timeout=2)

    async def test_slow_guide_does_not_block_a_different_guide(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            first_started = threading.Event()
            release_first = threading.Event()

            def get_guide(guide_id, _force_refresh):
                if guide_id == "3414883877":
                    first_started.set()
                    release_first.wait(timeout=2)
                return {"guideId": guide_id}

            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get.side_effect = get_guide
            first = asyncio.create_task(plugin.get_guide("3414883877"))
            try:
                started = await asyncio.to_thread(first_started.wait, 1)
                self.assertTrue(started)
                second = await asyncio.wait_for(
                    plugin.get_guide("3414883878"), timeout=1
                )
                self.assertEqual(second, {"guideId": "3414883878"})
                self.assertFalse(release_first.is_set())
            finally:
                release_first.set()
                await asyncio.wait_for(first, timeout=2)

    async def test_preloading_cannot_occupy_the_foreground_executor(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            preload_started = threading.Event()
            release_preload = threading.Event()
            foreground_executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=1
            )
            asyncio.get_running_loop().set_default_executor(foreground_executor)

            def get_cached(_guide_id):
                preload_started.set()
                release_preload.wait(timeout=2)
                return None

            async def wait_until_started():
                while not preload_started.is_set():
                    await asyncio.sleep(0)

            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get_cached.side_effect = get_cached
            plugin._guide_reader.get.return_value = {"guideId": "3414883878"}
            preloading = asyncio.create_task(
                plugin.get_cached_guide("3414883877")
            )
            try:
                await asyncio.wait_for(wait_until_started(), timeout=1)
                foreground = await asyncio.wait_for(
                    plugin.get_guide("3414883878"), timeout=1
                )
                self.assertEqual(foreground, {"guideId": "3414883878"})
                self.assertFalse(release_preload.is_set())
            finally:
                release_preload.set()
                await asyncio.wait_for(preloading, timeout=2)
                plugin._stop_preloading()

    async def test_cancelled_guide_rpc_does_not_wait_for_its_worker(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            guide_started = threading.Event()
            release_guide = threading.Event()
            cancellation_observed = asyncio.Event()

            def get_guide(_guide_id, _force_refresh):
                guide_started.set()
                release_guide.wait(timeout=2)
                return {"guideId": "3414883877"}

            async def call_guide():
                try:
                    return await plugin.get_guide("3414883877")
                except asyncio.CancelledError:
                    cancellation_observed.set()
                    raise

            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get.side_effect = get_guide
            guide_task = asyncio.create_task(call_guide())
            started = await asyncio.to_thread(guide_started.wait, 1)
            self.assertTrue(started)
            try:
                guide_task.cancel()
                for _ in range(5):
                    if cancellation_observed.is_set():
                        break
                    await asyncio.sleep(0)
                cancelled_before_release = cancellation_observed.is_set()
            finally:
                release_guide.set()
                results = await asyncio.gather(
                    guide_task, return_exceptions=True
                )

            self.assertTrue(cancelled_before_release)
            self.assertIsInstance(results[0], asyncio.CancelledError)

    async def test_cancelled_queued_preload_never_enters_the_worker(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            first_started = threading.Event()
            release_first = threading.Event()
            calls = []

            def get_cached(guide_id):
                calls.append(guide_id)
                if guide_id == "3414883877":
                    first_started.set()
                    release_first.wait(timeout=2)
                return None

            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get_cached.side_effect = get_cached
            first = asyncio.create_task(
                plugin.get_cached_guide("3414883877")
            )
            started = await asyncio.to_thread(first_started.wait, 1)
            self.assertTrue(started)
            second = asyncio.create_task(
                plugin.get_cached_guide("3414883878")
            )
            await asyncio.sleep(0)
            second.cancel()
            await asyncio.sleep(0)
            try:
                self.assertTrue(second.done())
                self.assertFalse(release_first.is_set())
            finally:
                release_first.set()
                results = await asyncio.gather(
                    first, second, return_exceptions=True
                )
                plugin._stop_preloading()

            self.assertIsNone(results[0])
            self.assertIsInstance(results[1], asyncio.CancelledError)
            self.assertEqual(calls, ["3414883877"])

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

    async def test_image_cache_and_admin_rpcs_forward_exact_arguments(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            plugin._guide_reader = mock.Mock()
            plugin._guide_reader.get_guide_image.return_value = {
                "mimeType": "image/png",
                "base64": "AAAA",
                "fromCache": True,
            }
            plugin._guide_reader.clear_guide_cache.return_value = {
                "filesRemoved": 1,
                "bytesRemoved": 2,
            }
            plugin._guide_reader.clear_image_cache.return_value = {
                "filesRemoved": 3,
                "bytesRemoved": 4,
            }
            plugin._guide_reader.cache_stats.return_value = {
                "guides": {"files": 0, "bytes": 0},
                "images": {"files": 0, "diskBytes": 0},
            }

            image = await plugin.get_guide_image(
                "https://images.steamusercontent.com/a.png", False
            )
            guides = await plugin.clear_guide_cache()
            images = await plugin.clear_image_cache()
            stats = await plugin.get_reader_cache_stats()

            self.assertTrue(image["fromCache"])
            plugin._guide_reader.get_guide_image.assert_called_once_with(
                "https://images.steamusercontent.com/a.png", False
            )
            self.assertEqual(guides["filesRemoved"], 1)
            self.assertEqual(images["filesRemoved"], 3)
            self.assertEqual(stats["guides"]["files"], 0)

    async def test_repair_position_stores_reports_each_backup(self):
        with tempfile.TemporaryDirectory() as settings_directory:
            plugin_main.decky.DECKY_PLUGIN_SETTINGS_DIR = settings_directory
            plugin = plugin_main.Plugin()
            plugin._store = mock.Mock()
            plugin._reader_positions = mock.Mock()
            plugin._store.repair.return_value = {
                "repaired": True,
                "backup": "/tmp/positions.bak",
            }
            plugin._reader_positions.repair.return_value = {
                "repaired": False,
                "backup": None,
            }

            result = await plugin.repair_position_stores()

            self.assertEqual(
                result,
                {
                    "positions": {
                        "repaired": True,
                        "backup": "/tmp/positions.bak",
                    },
                    "readerPositions": {
                        "repaired": False,
                        "backup": None,
                    },
                },
            )
            plugin._store.repair.assert_called_once_with()
            plugin._reader_positions.repair.assert_called_once_with()

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
