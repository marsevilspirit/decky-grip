"""Minimal Decky Loader backend declarations used by GRIP."""

from logging import Logger
from typing import Any


DECKY_PLUGIN_SETTINGS_DIR: str

logger: Logger


async def emit(event: str, *args: Any) -> None: ...
