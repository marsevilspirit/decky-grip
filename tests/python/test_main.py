import asyncio
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))


class _TestLogger:
    def info(self, _message):
        pass


fake_decky = types.ModuleType("decky")
fake_decky.DECKY_PLUGIN_SETTINGS_DIR = ""
fake_decky.logger = _TestLogger()
sys.modules["decky"] = fake_decky

import main as plugin_main  # noqa: E402


class PluginBridgeTests(unittest.IsolatedAsyncioTestCase):
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


if __name__ == "__main__":
    unittest.main()
