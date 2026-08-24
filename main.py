"""Decky Loader RPC bridge for GRIP's persistent guide positions."""

import asyncio
import functools
from pathlib import Path
from typing import Any, Callable

import decky

from grip_store import PositionStore


class Plugin:
    def __init__(self) -> None:
        positions_path = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "positions.json"
        self._store = PositionStore(positions_path)
        self._io_lock = asyncio.Lock()

    async def _run_io(self, function: Callable[..., Any], *args: Any) -> Any:
        async with self._io_lock:
            loop = asyncio.get_running_loop()
            operation = loop.run_in_executor(
                None, functools.partial(function, *args)
            )
            try:
                return await asyncio.shield(operation)
            except asyncio.CancelledError as cancellation:
                while not operation.done():
                    try:
                        await asyncio.shield(operation)
                    except asyncio.CancelledError:
                        continue
                    except Exception:
                        break

                if not operation.cancelled():
                    operation.exception()
                raise cancellation

    async def _main(self) -> None:
        decky.logger.info("GRIP backend ready")

    async def _unload(self) -> None:
        decky.logger.info("GRIP backend stopped")

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
