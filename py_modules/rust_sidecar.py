"""Blocking JSON-lines client for GRIP's Rust backend."""

from __future__ import annotations

import json
import subprocess
import threading
from concurrent.futures import Future, TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import Any, Callable, Dict, Optional


class RustSidecarError(RuntimeError):
    """A transport failure or an error returned by the Rust backend."""

    def __init__(self, message: str, kind: str = "transport") -> None:
        super().__init__(message)
        self.kind = kind


class RustSidecar:
    """Multiplexed client for GRIP's required resident Rust backend."""

    REQUIRED_CAPABILITIES = frozenset(
        {
            "positions",
            "reader_positions",
            "favorites",
            "guides",
            "images",
            "hotkey",
            "multiplex",
        }
    )
    RESPONSE_TIMEOUT_SECONDS = 5
    LONG_RESPONSE_TIMEOUT_SECONDS = 45
    MAX_RESPONSE_BYTES = 32 * 1024 * 1024

    def __init__(self, binary: Path, positions_path: Path) -> None:
        self._state_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._next_id = 0
        self._failed = False
        self._closed = False
        self._pending: Dict[int, Future[Dict[str, Any]]] = {}
        self._event_callback: Optional[Callable[[str, Any], None]] = None
        self._process = subprocess.Popen(
            [str(binary), str(positions_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        assert self._process.stdin is not None
        assert self._process.stdout is not None
        self._reader_thread = threading.Thread(
            target=self._read_stdout,
            name="grip-rust-sidecar-reader",
            daemon=True,
        )
        self._reader_thread.start()

    @classmethod
    def start(cls, binary: Path, positions_path: Path, logger: Any) -> "RustSidecar":
        client: Optional[RustSidecar] = None
        try:
            if not binary.is_file():
                raise RustSidecarError("GRIP Rust sidecar binary is missing")
            client = cls(binary, positions_path)
            hello = client.request("ping", {})
            if (
                not isinstance(hello, dict)
                or set(hello) != {"version", "capabilities"}
                or type(hello["version"]) is not int
                or hello["version"] != 2
                or not isinstance(hello["capabilities"], list)
                or any(
                    not isinstance(capability, str) or not capability
                    for capability in hello["capabilities"]
                )
                or len(set(hello["capabilities"])) != len(hello["capabilities"])
                or not cls.REQUIRED_CAPABILITIES.issubset(hello["capabilities"])
            ):
                raise RustSidecarError("GRIP Rust sidecar uses an unsupported protocol")
        except Exception as error:
            if client is not None:
                client.close()
            failure = (
                error
                if isinstance(error, RustSidecarError)
                else RustSidecarError(f"Could not start GRIP Rust sidecar: {error}")
            )
            logger.error(str(failure))
            if failure is error:
                raise
            raise failure from error

        logger.info("GRIP Rust sidecar ready")
        return client

    def close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            self._fail_transport(terminate=False)
            process = self._process
            with self._write_lock:
                if process.stdin is not None and not process.stdin.closed:
                    try:
                        process.stdin.close()
                    except OSError:
                        pass
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if threading.current_thread() is not self._reader_thread:
                self._reader_thread.join(timeout=1)
            if process.stdout is not None and not process.stdout.closed:
                process.stdout.close()

    def set_event_callback(
        self, callback: Optional[Callable[[str, Any], None]]
    ) -> None:
        if callback is not None and not callable(callback):
            raise TypeError("event callback must be callable")
        with self._state_lock:
            self._event_callback = callback

    @staticmethod
    def _unavailable_error() -> RustSidecarError:
        return RustSidecarError("GRIP Rust sidecar is unavailable")

    def _fail_transport(self, *, terminate: bool = True) -> None:
        with self._state_lock:
            if self._failed:
                return
            self._failed = True
            pending = list(self._pending.values())
            self._pending.clear()

        for request in pending:
            request.set_exception(self._unavailable_error())
        if terminate and self._process.poll() is None:
            try:
                self._process.terminate()
            except OSError:
                pass

    @staticmethod
    def _validate_response(response: Dict[str, Any]) -> bool:
        request_id = response.get("id")
        if type(request_id) is not int or request_id <= 0:
            return False
        if type(response.get("ok")) is not bool:
            return False
        if response["ok"]:
            return set(response) == {"id", "ok", "result"}
        if set(response) != {"id", "ok", "error"}:
            return False
        error = response["error"]
        return (
            isinstance(error, dict)
            and set(error) == {"kind", "message"}
            and isinstance(error["kind"], str)
            and bool(error["kind"])
            and isinstance(error["message"], str)
        )

    def _dispatch_message(self, message: Any) -> bool:
        if not isinstance(message, dict):
            return False
        if "id" in message:
            if not self._validate_response(message):
                return False
            with self._state_lock:
                pending = self._pending.pop(message["id"], None)
            if pending is not None:
                pending.set_result(message)
            return True
        if (
            set(message) != {"event", "payload"}
            or not isinstance(message["event"], str)
            or not message["event"]
        ):
            return False
        with self._state_lock:
            callback = self._event_callback
        if callback is not None:
            try:
                callback(message["event"], message["payload"])
            except Exception:
                pass
        return True

    def _read_stdout(self) -> None:
        assert self._process.stdout is not None
        try:
            while True:
                line = self._process.stdout.readline(self.MAX_RESPONSE_BYTES + 1)
                if (
                    not line
                    or len(line) > self.MAX_RESPONSE_BYTES
                    or not line.endswith(b"\n")
                ):
                    break
                try:
                    message = json.loads(line)
                except (UnicodeError, json.JSONDecodeError):
                    break
                if not self._dispatch_message(message):
                    break
        except Exception:
            pass
        self._fail_transport()

    @staticmethod
    def _unwrap_response(response: Dict[str, Any]) -> Any:
        if response["ok"]:
            return response["result"]
        error = response["error"]
        if error["kind"] == "validation":
            raise ValueError(error["message"])
        raise RustSidecarError(error["message"], error["kind"])

    def request(
        self,
        method: str,
        params: Dict[str, Any],
        *,
        timeout: Optional[float] = None,
    ) -> Any:
        with self._state_lock:
            if self._failed:
                raise self._unavailable_error()
            process_dead = self._process.poll() is not None
            if not process_dead:
                self._next_id += 1
                request_id = self._next_id
                pending: Future[Dict[str, Any]] = Future()
                self._pending[request_id] = pending

        if process_dead:
            self._fail_transport()
            raise self._unavailable_error()

        try:
            payload = (
                json.dumps(
                    {"id": request_id, "method": method, "params": params},
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                ).encode("utf-8")
                + b"\n"
            )
        except (TypeError, ValueError, UnicodeError):
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise

        try:
            with self._write_lock:
                assert self._process.stdin is not None
                written = 0
                while written < len(payload):
                    count = self._process.stdin.write(payload[written:])
                    if not count:
                        raise BrokenPipeError
                    written += count
                self._process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            self._fail_transport()

        try:
            response = pending.result(
                timeout=self.RESPONSE_TIMEOUT_SECONDS if timeout is None else timeout
            )
        except FutureTimeoutError:
            with self._state_lock:
                abandoned = self._pending.pop(request_id, None) is pending
            if abandoned:
                raise RustSidecarError("GRIP Rust sidecar request timed out")
            response = pending.result()

        return self._unwrap_response(response)
