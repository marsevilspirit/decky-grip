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
import import_sessions  # noqa: E402
from rust_sidecar import RustSidecar, RustSidecarError  # noqa: E402


def make_sidecar():
    sidecar = mock.Mock()
    sidecar.responses = {
        "positions.snapshot": {},
        "positions.repair": {"repaired": False, "backup": None},
        "reader_positions.get": None,
        "reader_positions.repair": {"repaired": False, "backup": None},
        "guides.list": [],
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

    async def test_store_repair_attempts_every_store_after_failures(self):
        plugin = self.plugin()
        self.sidecar.responses["reader_positions.repair"] = RustSidecarError(
            "reader unavailable"
        )

        repairs = await plugin.repair_position_stores()

        self.assertFalse(repairs["positions"]["repaired"])
        self.assertEqual(repairs["readerPositions"]["error"], "reader unavailable")
        repair_calls = [
            call.args[0]
            for call in self.sidecar.request.call_args_list
            if call.args[0].endswith(".repair")
        ]
        self.assertEqual(
            repair_calls,
            ["positions.repair", "reader_positions.repair"],
        )

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

    async def test_guide_library_is_a_bounded_cache_only_sidecar_query(self):
        plugin = self.plugin()
        entries = [
            {
                "appId": "1113000",
                "guideId": "3414883877",
                "updatedAt": 300,
                "cache": {"title": "完整攻略"},
            }
        ]
        self.sidecar.responses["guides.list"] = entries

        self.assertIs(await plugin.get_guide_library("1113000"), entries)
        self.sidecar.request.assert_called_with(
            "guides.list",
            {"app_id": "1113000"},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

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

    async def test_cancelled_offline_delete_waits_for_the_result(self):
        plugin = self.plugin()
        started = threading.Event()
        release = threading.Event()

        def request(method, params, *, timeout=None):
            self.assertEqual(method, "guides.remove_offline")
            self.assertEqual(params, {"guide_id": "1"})
            self.assertEqual(timeout, RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS)
            started.set()
            release.wait(timeout=2)
            return {"filesRemoved": 1}

        self.sidecar.request.side_effect = request
        task = asyncio.create_task(plugin.remove_offline_guide("1"))
        self.assertTrue(await asyncio.to_thread(started.wait, 1))
        task.cancel()
        await asyncio.sleep(0.02)
        self.assertFalse(task.done())
        release.set()

        result = await asyncio.wait_for(
            asyncio.gather(task, return_exceptions=True), timeout=2
        )
        self.assertIsInstance(result[0], asyncio.CancelledError)

    async def test_image_and_cache_admin_rpcs_forward_protocol_methods(self):
        plugin = self.plugin()
        self.sidecar.responses["images.get"] = {"fromCache": True}
        self.sidecar.responses["images.download"] = True
        self.sidecar.responses["guides.download_status"] = {
            "state": "partial", "completed": 13, "total": 61
        }
        self.sidecar.responses["guides.clear"] = {"filesRemoved": 1}
        self.sidecar.responses["guides.remove_offline"] = {"filesRemoved": 3}
        self.sidecar.responses["images.set_limit"] = {"diskLimitBytes": 268435456}
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
        self.assertEqual((await plugin.get_guide_download_status("1"))["state"], "partial")
        self.sidecar.request.assert_any_call(
            "guides.download_status",
            {"guide_id": "1"},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )
        self.assertEqual(await plugin.download_guide_image("https://images.steamusercontent.com/a.png"), {"saved": True})
        self.sidecar.request.assert_any_call(
            "images.download",
            {"url": "https://images.steamusercontent.com/a.png"},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )
        self.assertEqual((await plugin.remove_offline_guide("1"))["filesRemoved"], 3)
        self.assertEqual((await plugin.set_image_cache_limit(268435456))["diskLimitBytes"], 268435456)
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
        for method, params in (
            ("guides.clear", {}),
            ("guides.remove_offline", {"guide_id": "1"}),
            ("images.set_limit", {"bytes": 268435456}),
            ("images.clear", {}),
        ):
            self.sidecar.request.assert_any_call(
                method,
                params,
                timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
            )


    async def test_rendered_import_uses_fixed_capture_and_existing_prepared_transaction(self):
        plugin = self.plugin()
        guide = {"guideId": "heybox-249c72219fed", "sourceUrl": "https://www.xiaoheihe.cn/app/bbs/link/249c72219fed"}
        with mock.patch.object(import_sessions, "capture_heybox", new=mock.AsyncMock(return_value=guide)) as capture:
            self.assertEqual(await plugin.capture_heybox(guide["sourceUrl"], "a" * 32), guide)
            capture.assert_awaited_once_with(guide["sourceUrl"], "a" * 32)
        self.sidecar.responses["guides.prepare_import"] = {"token": "import", "guide": guide}
        self.assertEqual((await plugin.prepare_imported_guide(guide))["token"], "import")
        self.sidecar.request.assert_called_with("guides.prepare_import", {"guide": guide}, timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS)

    async def test_cancel_capture_and_unload_stop_only_live_owned_work(self):
        plugin = self.plugin()
        started = asyncio.Event()

        async def pending_capture(*_args):
            started.set()
            await asyncio.Event().wait()

        with mock.patch.object(import_sessions, "capture_heybox", side_effect=pending_capture):
            task = asyncio.create_task(plugin.capture_heybox("source", "a" * 32))
            await started.wait()
            with self.assertRaisesRegex(ValueError, "正在使用"):
                await plugin.capture_heybox("source", "a" * 32)
            await plugin.cancel_heybox_capture("b" * 32)
            self.assertFalse(task.done())
            await plugin.cancel_heybox_capture("a" * 32)
            with self.assertRaises(asyncio.CancelledError):
                await task
            started.clear()
            task = asyncio.create_task(plugin.capture_heybox("source", "a" * 32))
            await started.wait()
            await plugin._unload()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_phone_pairing_late_close_cannot_stop_a_new_session(self):
        plugin = self.plugin()
        first, second = mock.Mock(id="first"), mock.Mock(id="second")
        first.start.return_value = {"id": "first"}
        second.start.return_value = {"id": "second"}
        second.snapshot.return_value = {"state": "waiting"}
        with mock.patch.object(import_sessions, "PhoneImportSession", side_effect=[first, second]):
            await plugin.start_phone_import()
            await plugin.start_phone_import()
            first.stop.assert_called_once()
            await plugin.stop_phone_import("first")
            second.stop.assert_not_called()
            self.assertEqual(await plugin.get_phone_import("first"), {"state": "expired"})
            self.assertEqual(await plugin.get_phone_import("second"), {"state": "waiting"})
            await plugin._unload()
            second.stop.assert_called_once()

    async def test_unload_rejects_new_receivers_and_captures_before_sidecar_closes(self):
        plugin = self.plugin()
        closing, release = threading.Event(), threading.Event()

        def slow_close():
            closing.set()
            release.wait(2)

        self.sidecar.close.side_effect = slow_close
        task = asyncio.create_task(plugin._unload())
        try:
            await asyncio.to_thread(closing.wait, 2)
            self.assertTrue(closing.is_set())
            with mock.patch.object(import_sessions, "PhoneImportSession") as start:
                with self.assertRaisesRegex(RuntimeError, "卸载"):
                    await plugin.start_phone_import()
                start.assert_not_called()
            with mock.patch.object(import_sessions, "capture_heybox") as capture:
                with self.assertRaisesRegex(RuntimeError, "卸载"):
                    await plugin.capture_heybox("source", "a" * 32)
                capture.assert_not_called()
        finally:
            release.set()
            await task
        self.assertEqual(await plugin.get_phone_import("closed"), {"state": "expired"})

    async def test_canceled_phone_start_waits_for_cleanup_before_allowing_retry(self):
        plugin = self.plugin()
        started, release = threading.Event(), threading.Event()
        first, second = mock.Mock(id="first"), mock.Mock(id="second")

        def slow_start():
            started.set()
            if not release.wait(2):
                raise TimeoutError("test release timed out")
            return {"id": "first"}

        first.start.side_effect = slow_start
        second.start.return_value = {"id": "second"}
        with mock.patch.object(import_sessions, "PhoneImportSession", side_effect=[first, second]):
            task = asyncio.create_task(plugin.start_phone_import())
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                task.cancel()
                await asyncio.sleep(0)
                self.assertFalse(task.done())
                first.stop.assert_not_called()
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            first.stop.assert_called_once_with()
            self.assertEqual(await plugin.get_phone_import("first"), {"state": "expired"})
            self.assertEqual(await plugin.start_phone_import(), {"id": "second"})
            await plugin.stop_phone_import("second")
            second.stop.assert_called_once_with()

    async def test_unload_and_uninstall_keep_import_resources_ahead_of_sidecar_shutdown(self):
        for method in ("_unload", "_uninstall"):
            with self.subTest(method=method):
                plugin = self.plugin()
                events = []
                started = asyncio.Event()

                async def capture(*_args):
                    started.set()
                    try:
                        await asyncio.Event().wait()
                    finally:
                        events.append("capture")

                phone = mock.Mock(id="phone")
                phone.stop.side_effect = lambda: events.append("phone")
                self.sidecar.close.side_effect = lambda: events.append("sidecar")
                with (
                    mock.patch.object(import_sessions, "capture_heybox", side_effect=capture),
                    mock.patch.object(import_sessions, "PhoneImportSession", return_value=phone),
                    mock.patch.object(plugin, "_stop_hotkey", side_effect=lambda: events.append("hotkey")),
                    mock.patch.object(plugin, "_stop_preloading", side_effect=lambda: events.append("preload")),
                ):
                    await plugin.start_phone_import()
                    task = asyncio.create_task(plugin.capture_heybox("source", "a" * 32))
                    await started.wait()
                    await getattr(plugin, method)()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                self.assertEqual(events, ["capture", "phone", "hotkey", "preload", "sidecar"])

    async def test_offline_transaction_and_structured_image_errors(self):
        plugin = self.plugin()
        self.sidecar.responses["guides.prepare"] = {"token": "candidate", "guide": {"title": "New"}}
        self.sidecar.responses["guides.commit"] = {"title": "New"}
        self.sidecar.responses["guides.discard"] = True
        self.assertEqual((await plugin.prepare_guide("1", True))["token"], "candidate")
        self.assertEqual((await plugin.commit_guide("1", "candidate"))["title"], "New")
        self.assertTrue(await plugin.discard_guide("1", "candidate"))
        for method, params in (
            ("guides.prepare", {"guide_id": "1", "force_refresh": True}),
            ("guides.commit", {"guide_id": "1", "token": "candidate"}),
            ("guides.discard", {"guide_id": "1", "token": "candidate"}),
        ):
            self.sidecar.request.assert_any_call(method, params, timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS)
        for kind in ("capacity", "download", "transport"):
            self.sidecar.responses["images.download"] = RustSidecarError("image error", kind=kind)
            self.assertEqual(await plugin.download_guide_image("https://images.steamusercontent.com/a.png"), {"saved": False, "kind": kind, "error": "image error"})

    async def test_import_commit_associates_only_after_publication_and_preserves_position(self):
        plugin = self.plugin()
        guide_id = "heybox-249c72219fed"
        guide = {"guideId": guide_id, "title": "Imported"}
        self.sidecar.responses["guides.commit"] = guide
        for stored in (None, {
            "scroll_top": 420,
            "section_id": "3",
            "anchor_text": "正文锚点",
            "anchor_offset": 12,
            "updated_at_ms": 100,
        }):
            with self.subTest(stored=stored):
                self.sidecar.responses["reader_positions.get"] = stored
                self.sidecar.request.reset_mock()
                self.assertIs(await plugin.commit_imported_guide(guide_id, "candidate", "1113000"), guide)
                position = stored or {"scroll_top": 0, "section_id": None, "anchor_text": None, "anchor_offset": 0}
                self.assertEqual(self.sidecar.request.call_args_list, [
                    mock.call("reader_positions.get", {"guide_key": f"1113000:{guide_id}"}),
                    mock.call("guides.commit", {"guide_id": guide_id, "token": "candidate"}, timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS),
                    mock.call("reader_positions.save", {
                        "guide_key": f"1113000:{guide_id}",
                        **{key: position[key] for key in ("scroll_top", "section_id", "anchor_text", "anchor_offset")},
                    }),
                ])

    async def test_import_commit_validation_and_publication_failures_never_report_success(self):
        plugin = self.plugin()
        methods = ["reader_positions.get", "guides.commit", "reader_positions.save"]
        for failed in methods:
            with self.subTest(failed=failed):
                self.sidecar.responses.update({method: None for method in methods})
                self.sidecar.responses[failed] = RustSidecarError("deliberate failure")
                self.sidecar.request.reset_mock()
                with self.assertRaisesRegex(RuntimeError, "游戏关联记录保存失败" if failed == methods[-1] else "deliberate failure"):
                    await plugin.commit_imported_guide("heybox-249c72219fed", "candidate", "1113000")
                self.assertEqual(
                    [call.args[0] for call in self.sidecar.request.call_args_list],
                    methods[:methods.index(failed) + 1],
                )

    async def test_unload_and_cancellation_wait_for_import_association_and_reject_queued_commits(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                plugin = self.plugin()
                publishing, release = threading.Event(), threading.Event()
                calls = []
                guide = {"guideId": "heybox-249c72219fed"}

                def request(method, _params, **_kwargs):
                    calls.append(method)
                    if method == "guides.commit":
                        publishing.set()
                        if not release.wait(2):
                            raise TimeoutError("test release timed out")
                        return guide
                    return None

                self.sidecar.request.side_effect = request
                self.sidecar.close.side_effect = lambda: calls.append("close")
                self.sidecar.close.reset_mock()
                committing = asyncio.create_task(plugin.commit_imported_guide(guide["guideId"], "candidate", "1113000"))
                try:
                    self.assertTrue(await asyncio.to_thread(publishing.wait, 2))
                    queued = asyncio.create_task(plugin.commit_imported_guide(guide["guideId"], "queued", "1113000"))
                    if cancel:
                        committing.cancel()
                    unloading = asyncio.create_task(plugin._unload())
                    await asyncio.sleep(0)
                    self.assertTrue(plugin._closing)
                    self.assertFalse(committing.done())
                    self.sidecar.close.assert_not_called()
                finally:
                    release.set()
                results = await asyncio.wait_for(asyncio.gather(committing, queued, unloading, return_exceptions=True), 2)
                if cancel:
                    self.assertIsInstance(results[0], asyncio.CancelledError)
                else:
                    self.assertIs(results[0], guide)
                self.assertIsInstance(results[1], RuntimeError)
                self.assertIn("卸载", str(results[1]))
                self.assertIsNone(results[2])
                self.assertEqual(calls, ["reader_positions.get", "guides.commit", "reader_positions.save", "close"])


if __name__ == "__main__":
    unittest.main()
