"""Read-only Steam Deck L4 hotkey monitoring.

The monitor reads the controller's gamepad HID report directly.  It never grabs
the device or writes feature reports.  It only keeps the descriptor open while
another process already owns the device, so a Steam restart can hand control
back to the kernel hid-steam driver normally.
"""

from __future__ import annotations

import os
import select
import stat
import threading
import time
from pathlib import Path
from typing import Callable, Optional


def _unix_time_ms() -> int:
    return time.time_ns() // 1_000_000


class L4HotkeyMonitor:
    REPORT_SIZE = 64
    REPORT_HEADER = b"\x01\x00\x09\x40"
    L4_MASK = 0x00000200
    DEBOUNCE_SECONDS = 0.35
    PEER_CHECK_SECONDS = 1.0

    def __init__(
        self,
        on_press: Callable[[int], None],
        logger=None,
        *,
        device_root: Path = Path("/dev"),
        sysfs_root: Path = Path("/sys/class/hidraw"),
        proc_root: Path = Path("/proc"),
        clock: Callable[[], float] = time.monotonic,
        wall_clock_ms: Callable[[], int] = _unix_time_ms,
    ) -> None:
        self._on_press = on_press
        self._logger = logger
        self._device_root = device_root
        self._sysfs_root = sysfs_root
        self._proc_root = proc_root
        self._clock = clock
        self._wall_clock_ms = wall_clock_ms
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._descriptor: Optional[int] = None
        self._device_path: Optional[Path] = None
        self._lifecycle_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._seeded = False
        self._pressed = False
        self._last_emit_at = float("-inf")

    def _log(self, level: str, message: str) -> None:
        writer = getattr(self._logger, level, None)
        if writer is not None:
            writer(message)

    def _candidate_devices(self):
        for path in sorted(self._device_root.glob("hidraw*")):
            uevent = self._sysfs_root / path.name / "device" / "uevent"
            try:
                identity = uevent.read_text(encoding="utf-8").upper()
                resolved = os.path.realpath(self._sysfs_root / path.name)
            except OSError:
                continue
            hid_id = next(
                (
                    line.split("=", 1)[1]
                    for line in identity.splitlines()
                    if line.startswith("HID_ID=")
                ),
                "",
            )
            if hid_id != "0003:000028DE:00001205":
                continue
            if any(part.endswith(":1.2") for part in Path(resolved).parts):
                yield path

    def _find_device(self) -> Optional[Path]:
        return next(self._candidate_devices(), None)

    def _other_process_has_device_open(self, path: Path) -> bool:
        """Fail closed unless another process already owns this char device."""

        try:
            device = os.stat(path)
            processes = list(self._proc_root.glob("[0-9]*"))
        except OSError:
            return False
        if not stat.S_ISCHR(device.st_mode):
            return False

        own_pid = str(os.getpid())
        for process in processes:
            if process.name == own_pid:
                continue
            try:
                descriptors = list((process / "fd").iterdir())
            except OSError:
                continue
            for descriptor in descriptors:
                try:
                    opened = os.stat(descriptor)
                    if (
                        stat.S_ISCHR(opened.st_mode)
                        and opened.st_rdev == device.st_rdev
                    ):
                        return True
                except OSError:
                    continue
        return False

    def _connect(self) -> bool:
        for path in self._candidate_devices():
            if not self._other_process_has_device_open(path):
                continue
            try:
                descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as error:
                self._log("warning", f"GRIP could not open {path}: {error}")
                continue
            # Close immediately if the other holder disappeared between the
            # pre-open check and os.open(). Keeping the layered hidraw open by
            # ourselves can prevent hid-steam from restoring its input device.
            if not self._other_process_has_device_open(path):
                os.close(descriptor)
                continue
            with self._state_lock:
                self._descriptor = descriptor
                self._device_path = path
                self._seeded = False
                self._pressed = False
            self._log("info", f"GRIP L4 hotkey listening on {path}")
            return True
        return False

    def _disconnect(self) -> None:
        with self._state_lock:
            descriptor = self._descriptor
            self._descriptor = None
            self._device_path = None
            self._seeded = False
            self._pressed = False
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            stop_event = threading.Event()
            self._stop_event = stop_event
            self._connect()
            thread = threading.Thread(
                target=self._run,
                args=(stop_event,),
                name="grip-l4-hotkey",
                daemon=True,
            )
            self._thread = thread
            thread.start()

    def stop(self) -> None:
        with self._lifecycle_lock:
            stop_event = self._stop_event
            thread = self._thread
            stop_event.set()
        if thread is not None:
            thread.join(timeout=1.0)
            if thread.is_alive():
                self._log("warning", "GRIP L4 hotkey thread did not stop in time")
                return
        self._disconnect()
        with self._lifecycle_lock:
            if self._thread is thread:
                self._thread = None

    def process_report(self, report: bytes) -> bool:
        """Process one report and return whether it produced an L4 press."""

        if len(report) != self.REPORT_SIZE or not report.startswith(
            self.REPORT_HEADER
        ):
            return False
        buttons_high = int.from_bytes(report[12:16], byteorder="little")
        pressed = bool(buttons_high & self.L4_MASK)
        now = self._clock()
        with self._state_lock:
            if not self._seeded:
                self._seeded = True
                self._pressed = pressed
                return False
            rising_edge = pressed and not self._pressed
            self._pressed = pressed
            if not rising_edge or now - self._last_emit_at < self.DEBOUNCE_SECONDS:
                return False
            self._last_emit_at = now

        # Capture wall time on the HID reader thread at the rising edge.  The
        # frontend uses the same Unix epoch to include bridge and route latency
        # in the physical-L4 end-to-end measurement.
        self._on_press(self._wall_clock_ms())
        return True

    @staticmethod
    def _read_report(descriptor: int) -> bytes:
        report = os.read(descriptor, L4HotkeyMonitor.REPORT_SIZE)
        if not report:
            raise OSError("Steam Deck HID device returned EOF")
        return report

    def _run(self, stop_event: threading.Event) -> None:
        next_peer_check = 0.0
        try:
            while not stop_event.is_set():
                with self._state_lock:
                    descriptor = self._descriptor
                    path = self._device_path
                if descriptor is None or path is None:
                    if not self._connect():
                        stop_event.wait(1.0)
                    next_peer_check = 0.0
                    continue

                now = time.monotonic()
                if now >= next_peer_check:
                    next_peer_check = now + self.PEER_CHECK_SECONDS
                    if not self._other_process_has_device_open(path):
                        self._log(
                            "info",
                            "GRIP released the hotkey device because Steam closed it",
                        )
                        self._disconnect()
                        continue
                try:
                    readable, _, _ = select.select([descriptor], [], [], 0.1)
                    if not readable:
                        continue
                    self.process_report(self._read_report(descriptor))
                except (OSError, ValueError) as error:
                    if not stop_event.is_set():
                        self._log(
                            "warning", f"GRIP L4 hotkey disconnected: {error}"
                        )
                    self._disconnect()
                    stop_event.wait(1.0)
                except Exception as error:
                    self._log("error", f"GRIP L4 hotkey failed: {error}")
                    stop_event.wait(0.1)
        finally:
            self._disconnect()
            with self._lifecycle_lock:
                if self._thread is threading.current_thread():
                    self._thread = None

    def status(self) -> dict:
        with self._state_lock:
            thread = self._thread
            return {
                "available": self._descriptor is not None,
                "button": "L4",
                "device": str(self._device_path) if self._device_path else None,
                "running": thread is not None and thread.is_alive(),
            }
