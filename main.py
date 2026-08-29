"""Decky Loader RPC bridge for GRIP's persistent guide positions."""

import asyncio
import concurrent.futures
import functools
import threading
from pathlib import Path
from typing import Any, Callable, Optional

import decky

from guide_reader import GuideReader, ReaderPositionStore
from grip_hotkey import L4HotkeyMonitor
from grip_store import PositionStore


class _ExecutorUnavailable(RuntimeError):
    """Raised only when work cannot be submitted to an executor."""


class Plugin:
    def __init__(self) -> None:
        settings_directory = Path(decky.DECKY_PLUGIN_SETTINGS_DIR)
        positions_path = settings_directory / "positions.json"
        self._store = PositionStore(positions_path)
        self._guide_reader = GuideReader(settings_directory / "guides")
        self._reader_positions = ReaderPositionStore(
            settings_directory / "reader_positions.json"
        )
        self._io_lock = asyncio.Lock()
        self._preload_executor: Optional[
            concurrent.futures.ThreadPoolExecutor
        ] = concurrent.futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="grip-preload"
        )
        self._event_loop: Optional[asyncio.AbstractEventLoop] = None
        self._hotkey_sequence = 0
        self._hotkey_sequence_lock = threading.Lock()
        self._hotkey_monitor = L4HotkeyMonitor(
            self._schedule_hotkey_emit,
            decky.logger,
        )

    @staticmethod
    async def _run_executor_io(
        function: Callable[..., Any],
        *args: Any,
        executor: Optional[concurrent.futures.Executor] = None,
        wait_on_cancel: bool = False,
    ) -> Any:
        loop = asyncio.get_running_loop()
        work = functools.partial(function, *args)
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
            return await cls._run_executor_io(
                function, *args, wait_on_cancel=True
            )

    async def _run_io(self, function: Callable[..., Any], *args: Any) -> Any:
        return await self._run_locked_io(self._io_lock, function, *args)

    async def _run_guide_io(
        self, function: Callable[..., Any], *args: Any
    ) -> Any:
        # GuideReader serializes only operations for the same guide id. Keeping
        # a second global asyncio lock here would let one slow Steam request
        # delay an unrelated, already-cached guide.
        return await self._run_executor_io(function, *args)

    async def _main(self) -> None:
        self._event_loop = asyncio.get_running_loop()
        self._hotkey_monitor.start()
        decky.logger.info("GRIP backend ready")

    async def _unload(self) -> None:
        self._stop_hotkey()
        self._stop_preloading()
        decky.logger.info("GRIP backend stopped")

    async def _uninstall(self) -> None:
        self._stop_hotkey()
        self._stop_preloading()

    def _stop_hotkey(self) -> None:
        self._event_loop = None
        self._hotkey_monitor.stop()

    def _stop_preloading(self) -> None:
        executor = self._preload_executor
        self._preload_executor = None
        if executor is not None:
            executor.shutdown(wait=False, cancel_futures=True)

    def _schedule_hotkey_emit(self, detected_at_ms: int) -> None:
        loop = self._event_loop
        if loop is None or loop.is_closed():
            return
        with self._hotkey_sequence_lock:
            self._hotkey_sequence += 1
            event = {
                "version": 1,
                "button": "L4",
                "sequence": self._hotkey_sequence,
                "detectedAtUnixMs": detected_at_ms,
            }
        loop.call_soon_threadsafe(self._emit_hotkey, event)

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
        return self._hotkey_monitor.status()

    async def get_position(self, guide_key: str):
        return await self._run_io(self._store.get, guide_key)

    async def get_positions(self):
        positions = await self._run_io(self._store.snapshot)
        return {
            guide_key: {
                "scrollTop": position["scroll_top"],
                "updatedAt": position["updated_at_ms"],
            }
            for guide_key, position in positions.items()
        }

    async def save_position(self, guide_key: str, scroll_top: float):
        return await self._run_io(self._store.save, guide_key, scroll_top)

    async def delete_position(self, guide_key: str) -> bool:
        return await self._run_io(self._store.delete, guide_key)

    async def clear_positions(self) -> int:
        return await self._run_io(self._store.clear)

    async def get_position_count(self) -> int:
        return await self._run_io(self._store.count)

    async def get_guide(self, guide_id: str, force_refresh: bool = False):
        return await self._run_guide_io(
            self._guide_reader.get, guide_id, force_refresh
        )

    async def get_cached_guide(self, guide_id: str):
        # Cache-only warming has its own single worker, so even a large cache
        # validation cannot occupy the executor needed by an L4 foreground open.
        executor = self._preload_executor
        if executor is None:
            return None
        try:
            return await self._run_executor_io(
                self._guide_reader.get_cached,
                guide_id,
                executor=executor,
            )
        except _ExecutorUnavailable:
            return None

    async def get_guide_image(
        self, url: str, allow_download: bool = True
    ):
        return await self._run_guide_io(
            self._guide_reader.get_guide_image, url, allow_download
        )

    async def clear_guide_cache(self):
        return await self._run_guide_io(
            self._guide_reader.clear_guide_cache
        )

    async def clear_image_cache(self):
        return await self._run_guide_io(
            self._guide_reader.clear_image_cache
        )

    async def get_reader_cache_stats(self):
        return await self._run_guide_io(self._guide_reader.cache_stats)

    def _repair_position_stores(self):
        return {
            "positions": self._store.repair(),
            "readerPositions": self._reader_positions.repair(),
        }

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
        position = await self._run_io(self._reader_positions.get, guide_key)
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
            self._reader_positions.save,
            guide_key,
            scroll_top,
            section_id,
            anchor_text,
            anchor_offset,
        )
        return self._reader_position_for_frontend(position)
