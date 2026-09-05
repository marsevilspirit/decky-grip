"""Decky Loader RPC bridge for GRIP's persistent guide positions."""

import asyncio
import concurrent.futures
import functools
from pathlib import Path
from typing import Any, Callable, Optional

import decky

from rust_sidecar import RustSidecar


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

    @classmethod
    async def _run_locked_io(
        cls, lock: asyncio.Lock, function: Callable[..., Any], *args: Any
    ) -> Any:
        async with lock:
            return await cls._run_executor_io(function, *args, wait_on_cancel=True)

    async def _run_io(self, function: Callable[..., Any], *args: Any) -> Any:
        return await self._run_locked_io(self._io_lock, function, *args)

    async def _run_guide_io(
        self, function: Callable[..., Any], *args: Any, **kwargs: Any
    ) -> Any:
        # GuideReader serializes only operations for the same guide id. Keeping
        # a second global asyncio lock here would let one slow Steam request
        # delay an unrelated, already-cached guide.
        return await self._run_executor_io(function, *args, **kwargs)

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
        self._stop_hotkey()
        self._stop_preloading()
        await self._stop_sidecar()
        decky.logger.info("GRIP backend stopped")

    async def _uninstall(self) -> None:
        self._stop_hotkey()
        self._stop_preloading()
        await self._stop_sidecar()

    def _stop_hotkey(self) -> None:
        self._event_loop = None
        self._sidecar.set_event_callback(None)

    def _stop_preloading(self) -> None:
        executor = self._preload_executor
        self._preload_executor = None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)

    async def _stop_sidecar(self) -> None:
        await self._run_io(self._sidecar.close)

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
        return await self._run_guide_io(
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

    async def get_guide_library(self, app_id: Optional[str]):
        return await self._run_guide_io(
            self._sidecar.request,
            "guides.list",
            {"app_id": app_id},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def get_guide_download_status(self, guide_id: str):
        return await self._run_guide_io(
            self._sidecar.request,
            "guides.download_status",
            {"guide_id": guide_id},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def get_guide_image(self, url: str, allow_download: bool = True):
        return await self._run_guide_io(
            self._sidecar.request,
            "images.get",
            {"url": url, "allow_download": allow_download},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def download_guide_image(self, url: str):
        return await self._run_guide_io(
            self._sidecar.request,
            "images.download",
            {"url": url},
            timeout=RustSidecar.LONG_RESPONSE_TIMEOUT_SECONDS,
        )

    async def clear_guide_cache(self):
        return await self._run_destructive_guide_io("guides.clear", {})

    async def remove_guide_cache(self, guide_id: str):
        return await self._run_destructive_guide_io(
            "guides.remove", {"guide_id": guide_id}
        )

    async def clear_image_cache(self):
        return await self._run_destructive_guide_io("images.clear", {})

    async def get_reader_cache_stats(self):
        return await self._run_guide_io(self._sidecar.request, "reader_cache.stats", {})

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
