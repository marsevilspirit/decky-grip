"""Small, dependency-free persistent store for GRIP guide positions."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional


SCHEMA_VERSION = 1
GUIDE_KEY_PATTERN = re.compile(r"^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}$")


class StorageError(RuntimeError):
    """Raised when stored data cannot be read or safely replaced."""


class DurabilityError(StorageError):
    """Raised after replacement when directory metadata could not be synced."""


class PositionStore:
    MAX_FILE_BYTES = 2 * 1024 * 1024
    MAX_POSITIONS = 10_000
    MAX_SCROLL_TOP = 1_000_000_000.0

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()

    @staticmethod
    def _empty_document() -> Dict[str, Any]:
        return {"schema_version": SCHEMA_VERSION, "positions": {}}

    @staticmethod
    def _validate_guide_key(guide_key: Any) -> str:
        if not isinstance(guide_key, str) or not GUIDE_KEY_PATTERN.fullmatch(
            guide_key
        ):
            raise ValueError("guide_key must have the form <app_id>:<guide_id>")
        return guide_key

    @classmethod
    def _validate_scroll_top(cls, scroll_top: Any) -> float:
        if (
            isinstance(scroll_top, bool)
            or not isinstance(scroll_top, (int, float))
            or scroll_top < 0
            or scroll_top > cls.MAX_SCROLL_TOP
        ):
            raise ValueError("scroll_top must be a finite non-negative number")

        normalized = float(scroll_top)
        if not math.isfinite(normalized):
            raise ValueError("scroll_top must be a finite non-negative number")
        return normalized

    @staticmethod
    def _validate_updated_at(updated_at_ms: Any) -> int:
        if (
            isinstance(updated_at_ms, bool)
            or not isinstance(updated_at_ms, int)
            or updated_at_ms < 0
        ):
            raise StorageError("positions.json contains an invalid timestamp")
        return updated_at_ms

    def _validate_document(self, value: Any) -> Dict[str, Any]:
        if not isinstance(value, dict):
            raise StorageError("positions.json must contain a JSON object")
        if set(value) != {"schema_version", "positions"}:
            raise StorageError("positions.json contains unknown or missing fields")
        schema_version = value.get("schema_version")
        if type(schema_version) is not int or schema_version != SCHEMA_VERSION:
            raise StorageError("positions.json uses an unsupported schema version")

        positions = value.get("positions")
        if not isinstance(positions, dict):
            raise StorageError("positions.json contains an invalid positions map")
        if len(positions) > self.MAX_POSITIONS:
            raise StorageError("positions.json contains too many positions")

        normalized: Dict[str, Dict[str, Any]] = {}
        for raw_key, raw_position in positions.items():
            try:
                guide_key = self._validate_guide_key(raw_key)
            except ValueError as error:
                raise StorageError("positions.json contains an invalid guide key") from error

            if not isinstance(raw_position, dict):
                raise StorageError("positions.json contains an invalid position")
            if set(raw_position) != {"scroll_top", "updated_at_ms"}:
                raise StorageError(
                    "positions.json contains unknown or missing position fields"
                )

            try:
                scroll_top = self._validate_scroll_top(
                    raw_position.get("scroll_top")
                )
            except ValueError as error:
                raise StorageError(
                    "positions.json contains an invalid scroll position"
                ) from error

            normalized[guide_key] = {
                "scroll_top": scroll_top,
                "updated_at_ms": self._validate_updated_at(
                    raw_position.get("updated_at_ms")
                ),
            }

        return {"schema_version": SCHEMA_VERSION, "positions": normalized}

    def _read_document(self) -> Dict[str, Any]:
        if not self.path.exists():
            return self._empty_document()

        try:
            if self.path.stat().st_size > self.MAX_FILE_BYTES:
                raise StorageError("positions.json is larger than the safety limit")
            with self.path.open("r", encoding="utf-8") as stream:
                return self._validate_document(json.load(stream))
        except StorageError:
            raise
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise StorageError("positions.json could not be read") from error

    def _write_atomic(self, document: Dict[str, Any]) -> None:
        payload = json.dumps(
            document,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
        if len(payload.encode("utf-8")) > self.MAX_FILE_BYTES:
            raise StorageError("positions.json would exceed the safety limit")

        descriptor = -1
        temporary_name: Optional[str] = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=".positions-",
                suffix=".tmp",
                dir=str(self.path.parent),
            )
        except OSError as error:
            raise StorageError("could not create a temporary positions file") from error

        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                descriptor = -1
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())

            os.replace(temporary_name, self.path)
            temporary_name = None
        except OSError as error:
            raise StorageError("could not atomically replace positions.json") from error
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except OSError:
                    pass

        directory_descriptor = -1
        try:
            directory_descriptor = os.open(
                str(self.path.parent),
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
            os.fsync(directory_descriptor)
        except OSError as error:
            raise DurabilityError(
                "positions.json was replaced, but its directory could not be synced"
            ) from error
        finally:
            if directory_descriptor >= 0:
                try:
                    os.close(directory_descriptor)
                except OSError:
                    pass

    def get(self, guide_key: str) -> Optional[Dict[str, Any]]:
        key = self._validate_guide_key(guide_key)
        with self._lock:
            position = self._read_document()["positions"].get(key)
            return None if position is None else dict(position)

    def save(self, guide_key: str, scroll_top: float) -> Dict[str, Any]:
        key = self._validate_guide_key(guide_key)
        normalized_scroll_top = self._validate_scroll_top(scroll_top)

        with self._lock:
            document = self._read_document()
            document["positions"][key] = {
                "scroll_top": normalized_scroll_top,
                "updated_at_ms": time.time_ns() // 1_000_000,
            }
            if len(document["positions"]) > self.MAX_POSITIONS:
                raise StorageError("position limit reached")
            self._write_atomic(document)
            return dict(document["positions"][key])

    def delete(self, guide_key: str) -> bool:
        key = self._validate_guide_key(guide_key)
        with self._lock:
            document = self._read_document()
            if key not in document["positions"]:
                return False
            del document["positions"][key]
            self._write_atomic(document)
            return True

    def clear(self) -> int:
        with self._lock:
            document = self._read_document()
            count = len(document["positions"])
            if count:
                self._write_atomic(self._empty_document())
            return count

    def count(self) -> int:
        with self._lock:
            return len(self._read_document()["positions"])
