"""Decky Loader RPC bridge and composition root for GRIP's backend services."""

import asyncio
import concurrent.futures
import functools
from pathlib import Path
from typing import Any, Callable, Optional

import decky

from rust_sidecar import RustSidecar, RustSidecarError
from import_sessions import ImportSessions


class _ExecutorUnavailable(RuntimeError):
    """Raised only when work cannot be submitted to an executor."""


class Plugin:
    def __init__(self) -> None:
        settings_directory = Path(decky.DECKY_PLUGIN_SETTINGS_DIR)
        positions_path = settings_directory / "positions.json"
        self._sidecar = RustSidecar.start(
            Path(__file__).resolve().parent / "bin" / "grip-sidecar",
            positions_path,
            decky.logger,
        )
        self._io_lock = asyncio.Lock()
        self._import_sessions = ImportSessions(self._run_executor_io)
        self._closing = False
        self._preload_executor: Optional[concurrent.futures.ThreadPoolExecutor] = (
            concurrent.futures.ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="grip-preload"
            )
        )
        self._event_loop: Optional[asyncio.AbstractEventLoop] = None
        self._sidecar.set_event_callback(self._handle_sidecar_event)

    @staticmethod
    async def _run_executor_io(
        function: Callable[..., Any],
        *args: Any,
        executor: Optional[concurrent.futures.Executor] = None,
        wait_on_cancel: bool = False,
        **kwargs: Any,
    ) -> Any:
        loop = asyncio.get_running_loop()
        work = functools.partial(function, *args, **kwargs)
        source: Optional[concurrent.futures.Future] = None
        if executor is None:
            operation = loop.run_in_executor(None, work)
        else:
            try:
                source = executor.submit(work)
            except RuntimeError as error:
                raise _ExecutorUnavailable from error
            operation = asyncio.wrap_future(source, loop=loop)
        try:
            return await asyncio.shield(operation)
        except asyncio.CancelledError as cancellation:
            if wait_on_cancel:
                while not operation.done():
                    try:
                        await asyncio.shield(operation)
                    except asyncio.CancelledError:
                        continue
                    except Exception:
                        break
                if not operation.cancelled():
                    operation.exception()
            else:
                if source is not None:
                    source.cancel()
                if not operation.cancel() and not operation.cancelled():
                    operation.exception()
            raise cancellation

    async def _run_io(self, function: Callable[..., Any], *args: Any) -> Any:
        async with self._io_lock:
            return await self._run_executor_io(function, *args, wait_on_cancel=True)

    async def _run_destructive_guide_io(self, method: str, params: dict) -> Any:
        return await self._run_executor_io(
            self._sidecar.request,
            method,
            params,
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
            wait_on_cancel=True,
        )

    async def _main(self) -> None:
        self._event_loop = asyncio.get_running_loop()
        decky.logger.info("GRIP backend ready")

    async def _unload(self) -> None:
        self._closing = True
        await self._import_sessions.close()
        self._stop_hotkey()
        self._stop_preloading()
        await self._run_io(self._sidecar.close)
        decky.logger.info("GRIP backend stopped")

    async def _uninstall(self) -> None:
        self._closing = True
        await self._import_sessions.close()
        self._stop_hotkey()
        self._stop_preloading()
        await self._run_io(self._sidecar.close)

    def _stop_hotkey(self) -> None:
        self._event_loop = None
        self._sidecar.set_event_callback(None)

    def _stop_preloading(self) -> None:
        executor = self._preload_executor
        self._preload_executor = None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)

    def _handle_sidecar_event(self, name: str, payload: Any) -> None:
        if (
            name != "grip_hotkey"
            or not isinstance(payload, dict)
            or set(payload) != {"version", "button", "sequence", "detectedAtUnixMs"}
            or payload["version"] != 1
            or payload["button"] != "L4"
            or type(payload["sequence"]) is not int
            or payload["sequence"] <= 0
            or type(payload["detectedAtUnixMs"]) is not int
            or not 0 <= payload["detectedAtUnixMs"] <= (1 << 53) - 1
        ):
            return
        loop = self._event_loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._emit_hotkey, payload)

    @staticmethod
    def _report_emit_result(task: asyncio.Task) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except Exception as error:
            decky.logger.error(f"Could not emit GRIP hotkey: {error}")

    def _emit_hotkey(self, event) -> None:
        loop = self._event_loop
        if loop is None or loop.is_closed():
            return
        task = asyncio.create_task(decky.emit("grip_hotkey", event))
        task.add_done_callback(self._report_emit_result)

    async def get_hotkey_status(self):
        return await self._run_io(self._sidecar.request, "hotkey.status", {})

    async def get_positions(self):
        positions = await self._run_io(self._sidecar.request, "positions.snapshot", {})
        return {
            guide_key: {
                "scrollTop": position["scroll_top"],
                "updatedAt": position["updated_at_ms"],
            }
            for guide_key, position in positions.items()
        }

    async def save_position(self, guide_key: str, scroll_top: float):
        return await self._run_io(
            self._sidecar.request,
            "positions.save",
            {"guide_key": guide_key, "scroll_top": scroll_top},
        )

    async def get_guide(self, guide_id: str, force_refresh: bool = False):
        # Rust serializes each guide; a global bridge lock would block unrelated reads.
        return await self._run_executor_io(
            self._sidecar.request,
            "guides.get",
            {"guide_id": guide_id, "force_refresh": force_refresh},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def get_cached_guide(self, guide_id: str):
        # Cache-only warming has its own single worker, so even a large cache
        # validation cannot occupy the executor needed by an L4 foreground open.
        executor = self._preload_executor
        if executor is None:
            return None
        try:
            return await self._run_executor_io(
                self._sidecar.request,
                "guides.get_cached",
                {"guide_id": guide_id},
                timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
                executor=executor,
            )
        except _ExecutorUnavailable:
            return None

    async def prepare_guide(self, guide_id: str, force_refresh: bool):
        return await self._run_executor_io(
            self._sidecar.request,
            "guides.prepare",
            {"guide_id": guide_id, "force_refresh": force_refresh},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def capture_heybox(self, source_url: str, marker: str):
        return await self._import_sessions.capture(source_url, marker)

    async def cancel_heybox_capture(self, marker: str):
        await self._import_sessions.cancel_capture(marker)

    async def start_phone_import(self):
        return await self._import_sessions.start_phone()

    async def get_phone_import(self, session_id: str):
        return await self._import_sessions.get_phone(session_id)

    async def stop_phone_import(self, session_id: str):
        await self._import_sessions.stop_phone(session_id)

    async def prepare_imported_guide(self, guide: dict):
        return await self._run_executor_io(
            self._sidecar.request,
            "guides.prepare_import",
            {"guide": guide},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def commit_guide(self, guide_id: str, token: str):
        return await self._run_destructive_guide_io(
            "guides.commit", {"guide_id": guide_id, "token": token}
        )

    async def commit_imported_guide(self, guide_id: str, token: str, app_id: str) -> dict:
        return await self._run_io(self._commit_imported_guide, guide_id, token, app_id)

    def _commit_imported_guide(self, guide_id: str, token: str, app_id: str) -> dict:
        # Keep publication and its game association ahead of sidecar shutdown.
        if self._closing:
            raise RuntimeError("插件正在卸载，无法保存导入指南")
        guide_key = f"{app_id}:{guide_id}"
        position = self._sidecar.request(
            "reader_positions.get", {"guide_key": guide_key}
        ) or {
            "scroll_top": 0,
            "section_id": None,
            "anchor_text": None,
            "anchor_offset": 0,
        }
        guide = self._sidecar.request(
            "guides.commit",
            {"guide_id": guide_id, "token": token},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )
        try:
            self._sidecar.request(
                "reader_positions.save",
                {
                    "guide_key": guide_key,
                    "scroll_top": position["scroll_top"],
                    "section_id": position["section_id"],
                    "anchor_text": position["anchor_text"],
                    "anchor_offset": position["anchor_offset"],
                },
            )
        except Exception as error:
            raise RuntimeError(
                f"图文已保存，但游戏关联记录保存失败，请重试导入：{error}"
            ) from error
        return guide

    async def discard_guide(self, guide_id: str, token: str):
        return await self._run_destructive_guide_io(
            "guides.discard", {"guide_id": guide_id, "token": token}
        )

    async def get_guide_library(self, app_id: Optional[str]):
        return await self._run_executor_io(
            self._sidecar.request,
            "guides.list",
            {"app_id": app_id},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def get_guide_download_status(self, guide_id: str):
        return await self._run_executor_io(
            self._sidecar.request,
            "guides.download_status",
            {"guide_id": guide_id},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def get_guide_image(self, url: str, allow_download: bool = True):
        return await self._run_executor_io(
            self._sidecar.request,
            "images.get",
            {"url": url, "allow_download": allow_download},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def download_guide_image(self, url: str):
        try:
            saved = await self._run_executor_io(
                self._sidecar.request,
                "images.download",
                {"url": url},
                timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
            )
            return {"saved": True} if saved else {"saved": False, "kind": "download", "error": "图片未保存"}
        except RustSidecarError as error:
            return {"saved": False, "kind": error.kind, "error": str(error)}

    async def clear_guide_cache(self):
        return await self._run_destructive_guide_io("guides.clear", {})

    async def clear_image_cache(self):
        return await self._run_destructive_guide_io("images.clear", {})

    async def remove_offline_guide(self, guide_id: str):
        return await self._run_destructive_guide_io(
            "guides.remove_offline", {"guide_id": guide_id}
        )

    async def set_image_cache_limit(self, bytes: int):
        return await self._run_destructive_guide_io("images.set_limit", {"bytes": bytes})

    async def get_reader_cache_stats(self):
        return await self._run_executor_io(self._sidecar.request, "reader_cache.stats", {})

    def _repair_position_stores(self):
        repairs = {}
        for name, method in (
            ("positions", "positions.repair"),
            ("readerPositions", "reader_positions.repair"),
        ):
            try:
                repairs[name] = self._sidecar.request(method, {})
            except Exception as error:
                repairs[name] = {
                    "repaired": False,
                    "backup": None,
                    "error": str(error) or type(error).__name__,
                }
        return repairs

    async def repair_position_stores(self):
        return await self._run_io(self._repair_position_stores)

    @staticmethod
    def _reader_position_for_frontend(position):
        if position is None:
            return None
        return {
            "scrollTop": position["scroll_top"],
            "sectionId": position["section_id"],
            "anchorText": position["anchor_text"],
            "anchorOffset": position["anchor_offset"],
            "updatedAt": position["updated_at_ms"],
        }

    async def get_reader_position(self, guide_key: str):
        position = await self._run_io(
            self._sidecar.request,
            "reader_positions.get",
            {"guide_key": guide_key},
        )
        return self._reader_position_for_frontend(position)

    async def save_reader_position(
        self,
        guide_key: str,
        scroll_top: float,
        section_id: Optional[str],
        anchor_text: Optional[str],
        anchor_offset: float,
    ):
        position = await self._run_io(
            self._sidecar.request,
            "reader_positions.save",
            {
                "guide_key": guide_key,
                "scroll_top": scroll_top,
                "section_id": section_id,
                "anchor_text": anchor_text,
                "anchor_offset": anchor_offset,
            },
        )
        return self._reader_position_for_frontend(position)
