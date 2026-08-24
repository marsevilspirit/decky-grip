import json
import math
import os
import stat
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))

from grip_store import DurabilityError, PositionStore, StorageError  # noqa: E402


class PositionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "positions.json"
        self.store = PositionStore(self.path)

    def test_missing_file_is_an_empty_store(self):
        self.assertIsNone(self.store.get("1113000:3414883877"))
        self.assertEqual(self.store.snapshot(), {})
        self.assertEqual(self.store.count(), 0)

    def test_save_get_and_overwrite(self):
        first = self.store.save("1113000:3414883877", 5561.3335)
        second = self.store.save("1113000:3414883877", 42)

        self.assertEqual(first["scroll_top"], 5561.3335)
        self.assertEqual(second["scroll_top"], 42.0)
        self.assertEqual(self.store.get("1113000:3414883877"), second)
        self.assertEqual(self.store.count(), 1)

    def test_large_guide_ids_remain_exact_strings(self):
        key = "1113000:90071992547409931234"
        self.store.save(key, 1)

        document = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertIn(key, document["positions"])

    def test_different_guides_do_not_collide(self):
        self.store.save("1:10", 10)
        self.store.save("1:11", 11)
        self.store.save("2:10", 20)

        self.assertEqual(self.store.get("1:10")["scroll_top"], 10)
        self.assertEqual(self.store.get("1:11")["scroll_top"], 11)
        self.assertEqual(self.store.get("2:10")["scroll_top"], 20)

    def test_snapshot_returns_all_positions_without_exposing_store_state(self):
        first = self.store.save("1:10", 10)
        second = self.store.save("2:20", 20)

        snapshot = self.store.snapshot()

        self.assertEqual(snapshot, {"1:10": first, "2:20": second})
        snapshot["1:10"]["scroll_top"] = 999
        del snapshot["2:20"]
        self.assertEqual(self.store.get("1:10"), first)
        self.assertEqual(self.store.get("2:20"), second)

    def test_delete_and_clear_report_what_changed(self):
        self.store.save("1:10", 10)
        self.store.save("1:11", 11)

        self.assertTrue(self.store.delete("1:10"))
        self.assertFalse(self.store.delete("1:10"))
        self.assertEqual(self.store.clear(), 1)
        self.assertEqual(self.store.clear(), 0)
        self.assertEqual(self.store.count(), 0)

    def test_invalid_keys_are_rejected(self):
        for value in (
            None,
            12,
            "",
            "0:1",
            "1:0",
            "1",
            "1:2:3",
            "../1:2",
            "1:2٢",
        ):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.store.get(value)

    def test_invalid_scroll_positions_are_rejected(self):
        values = (
            -1,
            "10",
            True,
            math.nan,
            math.inf,
            -math.inf,
            PositionStore.MAX_SCROLL_TOP + 1,
            10**1000,
        )
        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.store.save("1:2", value)

    def test_corrupt_files_are_never_silently_overwritten(self):
        original = "{ definitely not json"
        self.path.write_text(original, encoding="utf-8")

        with self.assertRaises(StorageError):
            self.store.save("1:2", 3)

        self.assertEqual(self.path.read_text(encoding="utf-8"), original)

    def test_unknown_schema_is_rejected(self):
        for schema_version in (99, True, 1.0):
            with self.subTest(schema_version=schema_version):
                self.path.write_text(
                    json.dumps(
                        {"schema_version": schema_version, "positions": {}}
                    ),
                    encoding="utf-8",
                )

                with self.assertRaises(StorageError):
                    self.store.count()

    def test_unknown_or_missing_fields_are_rejected(self):
        documents = (
            {"schema_version": 1, "positions": {}, "future": True},
            {"schema_version": 1},
            {
                "schema_version": 1,
                "positions": {
                    "1:2": {
                        "scroll_top": 3,
                        "updated_at_ms": 4,
                        "future": True,
                    }
                },
            },
        )

        for document in documents:
            with self.subTest(document=document):
                self.path.write_text(json.dumps(document), encoding="utf-8")
                for operation in (self.store.count, self.store.snapshot):
                    with self.subTest(operation=operation.__name__):
                        with self.assertRaises(StorageError):
                            operation()

    def test_oversized_existing_file_is_rejected(self):
        self.path.write_bytes(b" " * (PositionStore.MAX_FILE_BYTES + 1))

        with self.assertRaisesRegex(StorageError, "larger than"):
            self.store.count()

    def test_oversized_write_is_rejected_before_creating_a_file(self):
        with mock.patch.object(PositionStore, "MAX_FILE_BYTES", 16):
            with self.assertRaisesRegex(StorageError, "would exceed"):
                self.store.save("1:2", 3)

        self.assertFalse(self.path.exists())

    def test_replace_failure_preserves_old_file_and_cleans_temp_file(self):
        old_position = self.store.save("1:2", 3)

        with mock.patch("grip_store.os.replace", side_effect=OSError("boom")):
            with self.assertRaises(StorageError):
                self.store.save("1:2", 4)

        self.assertEqual(self.store.get("1:2"), old_position)
        self.assertEqual(list(self.path.parent.glob(".positions-*.tmp")), [])

    def test_cleanup_failure_does_not_mask_replace_failure(self):
        self.store.save("1:2", 3)

        with mock.patch(
            "grip_store.os.replace", side_effect=OSError("replace failed")
        ), mock.patch("grip_store.os.unlink", side_effect=OSError("cleanup failed")):
            with self.assertRaisesRegex(StorageError, "atomically replace"):
                self.store.save("1:2", 4)

    def test_directory_sync_failure_reports_committed_write(self):
        self.store.save("1:2", 3)
        real_fsync = os.fsync
        call_count = 0

        def fail_directory_sync(descriptor):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise OSError("directory sync failed")
            return real_fsync(descriptor)

        with mock.patch("grip_store.os.fsync", side_effect=fail_directory_sync):
            with self.assertRaisesRegex(DurabilityError, "was replaced"):
                self.store.save("1:2", 4)

        self.assertEqual(self.store.get("1:2")["scroll_top"], 4)

    def test_position_limit_preserves_existing_document(self):
        with mock.patch.object(PositionStore, "MAX_POSITIONS", 2):
            self.store.save("1:1", 1)
            self.store.save("1:2", 2)
            with self.assertRaisesRegex(StorageError, "position limit"):
                self.store.save("1:3", 3)

        self.assertEqual(self.store.count(), 2)
        self.assertIsNone(self.store.get("1:3"))

    def test_concurrent_saves_produce_valid_complete_json(self):
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [
                executor.submit(self.store.save, f"1:{guide_id}", guide_id)
                for guide_id in range(1, 101)
            ]
            for future in futures:
                future.result()

        self.assertEqual(self.store.count(), 100)
        json.loads(self.path.read_text(encoding="utf-8"))

    def test_written_file_is_private(self):
        self.store.save("1:2", 3)
        mode = stat.S_IMODE(self.path.stat().st_mode)
        self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
