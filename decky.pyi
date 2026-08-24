"""Minimal Decky Loader backend declarations used by GRIP."""

from logging import Logger
from typing import Any


DECKY_PLUGIN_SETTINGS_DIR: str
DECKY_PLUGIN_RUNTIME_DIR: str
DECKY_PLUGIN_LOG_DIR: str
DECKY_PLUGIN_DIR: str
DECKY_PLUGIN_NAME: str
DECKY_PLUGIN_VERSION: str
DECKY_PLUGIN_AUTHOR: str

logger: Logger


async def emit(event: str, *args: Any) -> None: ...
