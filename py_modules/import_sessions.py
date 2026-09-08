"""Own the temporary article captures and phone inbox for one plugin lifetime."""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from heybox_renderer import capture_heybox
from phone_import import PhoneImportSession


class ImportSessions:
    def __init__(self, run_executor_io: Callable[..., Awaitable[Any]]) -> None:
        self._run_executor_io = run_executor_io
        self._captures: dict[str, asyncio.Task] = {}
        self._phone_lock = asyncio.Lock()
        self._phone_pairing: PhoneImportSession | None = None
        self._closing = False

    async def capture(self, source_url: str, marker: str):
        if self._closing:
            raise RuntimeError("插件正在卸载，无法开始导入")
        if not isinstance(marker, str) or marker in self._captures:
            raise ValueError("导入页面标记无效或正在使用")
        task = asyncio.create_task(capture_heybox(source_url, marker))
        self._captures[marker] = task
        try:
            return await task
        finally:
            if self._captures.get(marker) is task:
                del self._captures[marker]

    async def cancel_capture(self, marker: str):
        task = self._captures.get(marker)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def start_phone(self):
        async with self._phone_lock:
            if self._closing:
                raise RuntimeError("插件正在卸载，无法开启手机接收")
            if self._phone_pairing is not None:
                await self._run_executor_io(self._phone_pairing.stop, wait_on_cancel=True)
            session = PhoneImportSession()
            self._phone_pairing = session
            try:
                return await self._run_executor_io(session.start, wait_on_cancel=True)
            except BaseException:
                self._phone_pairing = None
                await self._run_executor_io(session.stop, wait_on_cancel=True)
                raise

    async def get_phone(self, session_id: str):
        async with self._phone_lock:
            session = self._phone_pairing
            if session is None or session.id != session_id:
                return {"state": "expired"}
            return session.snapshot()

    async def stop_phone(self, session_id: str | None = None):
        async with self._phone_lock:
            session = self._phone_pairing
            if session is not None and (session_id is None or session.id == session_id):
                self._phone_pairing = None
                await self._run_executor_io(session.stop, wait_on_cancel=True)

    async def close(self) -> None:
        self._closing = True
        tasks = list(self._captures.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.stop_phone()
