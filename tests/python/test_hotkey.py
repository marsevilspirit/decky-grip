import sys
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))

from grip_hotkey import L4HotkeyMonitor  # noqa: E402


def report(*, l4: bool) -> bytes:
    payload = bytearray(L4HotkeyMonitor.REPORT_SIZE)
    payload[0:4] = b"\x01\x00\x09\x40"
    if l4:
        payload[13] = 2
    return bytes(payload)


class L4HotkeyMonitorTests(unittest.TestCase):
    def test_emits_once_for_each_press_edge(self):
        presses = []
        now = [10.0]
        monitor = L4HotkeyMonitor(
            lambda: presses.append("L4"),
            clock=lambda: now[0],
        )

        self.assertFalse(monitor.process_report(report(l4=False)))
        self.assertTrue(monitor.process_report(report(l4=True)))
        self.assertFalse(monitor.process_report(report(l4=True)))
        self.assertFalse(monitor.process_report(report(l4=False)))
        now[0] += 1
        self.assertTrue(monitor.process_report(report(l4=True)))

        self.assertEqual(presses, ["L4", "L4"])

    def test_ignores_an_initially_held_button_and_debounces_reconnect_noise(self):
        presses = []
        now = [20.0]
        monitor = L4HotkeyMonitor(
            lambda: presses.append("L4"),
            clock=lambda: now[0],
        )

        self.assertFalse(monitor.process_report(report(l4=True)))
        self.assertFalse(monitor.process_report(report(l4=False)))
        self.assertTrue(monitor.process_report(report(l4=True)))
        self.assertFalse(monitor.process_report(report(l4=False)))
        now[0] += 0.1
        self.assertFalse(monitor.process_report(report(l4=True)))

        self.assertEqual(presses, ["L4"])

    def test_rejects_short_reports(self):
        monitor = L4HotkeyMonitor(lambda: self.fail("unexpected hotkey"))
        self.assertFalse(monitor.process_report(b"short"))

    def test_rejects_other_64_byte_report_types(self):
        presses = []
        monitor = L4HotkeyMonitor(lambda: presses.append("L4"))
        invalid = bytearray(report(l4=True))
        invalid[2] = 8

        self.assertFalse(monitor.process_report(report(l4=False)))
        self.assertFalse(monitor.process_report(bytes(invalid)))
        self.assertEqual(presses, [])

    def test_ignores_neighboring_grip_buttons_and_only_emits_l4(self):
        presses = []
        monitor = L4HotkeyMonitor(lambda: presses.append("L4"))
        idle = bytearray(report(l4=False))
        r5 = bytearray(idle)
        r5[10] = 1
        r4 = bytearray(idle)
        r4[13] = 4

        self.assertFalse(monitor.process_report(bytes(idle)))
        self.assertFalse(monitor.process_report(bytes(r5)))
        self.assertFalse(monitor.process_report(bytes(r4)))
        self.assertTrue(monitor.process_report(report(l4=True)))
        self.assertEqual(presses, ["L4"])

    def test_treats_an_empty_read_as_a_disconnect(self):
        with mock.patch("grip_hotkey.os.read", return_value=b""):
            with self.assertRaisesRegex(OSError, "returned EOF"):
                L4HotkeyMonitor._read_report(42)

    def test_finds_only_the_steam_deck_gamepad_data_interface(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            device_root = root / "dev"
            sysfs_root = root / "sys" / "class" / "hidraw"
            device_root.mkdir()
            device = device_root / "hidraw2"
            device.touch()
            uevent = sysfs_root / "hidraw2" / "device" / "uevent"
            uevent.parent.mkdir(parents=True)
            uevent.write_text(
                "HID_ID=0003:000028DE:00001205\n",
                encoding="utf-8",
            )
            monitor = L4HotkeyMonitor(
                lambda: None,
                device_root=device_root,
                sysfs_root=sysfs_root,
            )

            with mock.patch(
                "grip_hotkey.os.path.realpath",
                return_value="/sys/devices/3-3:1.2/hidraw/hidraw2",
            ):
                self.assertEqual(monitor._find_device(), device)

    def test_peer_scan_excludes_self_and_accepts_another_holder(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            device = root / "hidraw2"
            device.touch()
            other_fd = root / "proc" / "123" / "fd" / "4"
            self_fd = root / "proc" / "999" / "fd" / "5"
            other_fd.parent.mkdir(parents=True)
            self_fd.parent.mkdir(parents=True)
            other_fd.touch()
            self_fd.touch()
            monitor = L4HotkeyMonitor(
                lambda: None,
                proc_root=root / "proc",
            )
            char_device = SimpleNamespace(
                st_mode=stat.S_IFCHR | 0o660,
                st_rdev=1234,
            )

            with (
                mock.patch("grip_hotkey.os.getpid", return_value=999),
                mock.patch("grip_hotkey.os.stat", return_value=char_device),
            ):
                self.assertTrue(monitor._other_process_has_device_open(device))

            other_fd.unlink()
            with (
                mock.patch("grip_hotkey.os.getpid", return_value=999),
                mock.patch("grip_hotkey.os.stat", return_value=char_device),
            ):
                self.assertFalse(monitor._other_process_has_device_open(device))

    def test_peer_scan_fails_closed_and_connect_rechecks_after_open(self):
        monitor = L4HotkeyMonitor(lambda: None)
        device = Path("/dev/hidraw2")

        with mock.patch("grip_hotkey.os.stat", side_effect=PermissionError):
            self.assertFalse(monitor._other_process_has_device_open(device))

        with (
            mock.patch.object(
                monitor, "_candidate_devices", return_value=iter((device,))
            ),
            mock.patch.object(
                monitor,
                "_other_process_has_device_open",
                side_effect=(True, False),
            ),
            mock.patch("grip_hotkey.os.open", return_value=77),
            mock.patch("grip_hotkey.os.close") as close,
        ):
            self.assertFalse(monitor._connect())
            close.assert_called_once_with(77)


if __name__ == "__main__":
    unittest.main()
