import http.client
import json
import math
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))

from guide_reader import (  # noqa: E402
    GuideCacheError,
    GuideDownloadError,
    GuideParseError,
    GuideReader,
    ReaderPositionError,
    ReaderPositionStore,
    _FragmentSanitizer,
    _GuidePageParser,
    localize_guide_images,
    parse_guide_html,
    sanitize_fragment,
)


PUBLIC_GUIDE_FIXTURE = """<!doctype html>
<html>
  <body>
    <div class="workshopItemTitle">P4G 社群 &amp; 支线流程</div>
    <div class="guideAuthors">By 测试作者 and 1 collaborator</div>
    <div class="guide subSections">
      <div class="subSection detailBox" id="7667220">
        <div class="subSectionTitle">四月</div>
        <div class="subSectionDesc">
          <div class="bb_h3" onclick="steal()">4/23</div>
          去河堤下方与老人对话<br>
          <strong style="color:red">保存后继续</strong>
          <a class="bb_link" href="javascript:alert(1)" onfocus="steal()">坏链接</a>
          <a class="bb_link" href="https://steamcommunity.com/sharedfiles/filedetails/?id=1">来源</a>
          <img class="bb_img" src="https://images.steamusercontent.com/ugc/example/image.png" onerror="steal()">
          <img src="https://evil.example/tracker.png">
          <table class="bb_table" onclick="steal()"><tbody><tr class="bb_table_tr"><td class="bb_table_td">日期</td><th class="bb_table_th">行动</th></tr></tbody></table>
          <script>window.pwned = true</script>
          <iframe src="https://steamcommunity.com/">iframe text</iframe>
        </div>
      </div>
      <div class="subSection detailBox" id="7725867">
        <div class="subSectionTitle">五月</div>
        <div class="subSectionDesc"><div class="bb_h3">5/1</div>白天</div>
      </div>
    </div>
  </body>
</html>
"""


def _guide_with_single_section(section_html):
    return (
        '<div class="workshopItemTitle">预算测试指南</div>'
        '<div class="guideAuthors">By 测试作者</div>'
        '<div class="subSection" id="1">'
        '<div class="subSectionTitle">唯一章节</div>'
        f'<div class="subSectionDesc">{section_html}</div>'
        "</div>"
    )


class _Fetcher:
    def __init__(self, body=PUBLIC_GUIDE_FIXTURE.encode("utf-8")):
        self.body = body
        self.calls = []
        self.error = None

    def __call__(self, url, timeout, max_bytes):
        self.calls.append((url, timeout, max_bytes))
        if self.error:
            raise self.error
        return self.body


class GuideParsingTests(unittest.TestCase):
    def test_backend_import_does_not_require_html_parser(self):
        script = f"""
import builtins
import sys
sys.path.insert(0, {str(PROJECT_ROOT / 'py_modules')!r})
real_import = builtins.__import__
def import_without_html_parser(name, *args, **kwargs):
    if name == 'html.parser':
        raise ModuleNotFoundError("No module named 'html.parser'")
    return real_import(name, *args, **kwargs)
builtins.__import__ = import_without_html_parser
from guide_reader import sanitize_fragment
assert sanitize_fragment('<p>可用</p>') == '<p>可用</p>'
"""

        completed = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            check=False,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_extracts_public_guide_and_sanitizes_html(self):
        document = parse_guide_html("3414883877", PUBLIC_GUIDE_FIXTURE)

        self.assertEqual(document["guideId"], "3414883877")
        self.assertEqual(document["title"], "P4G 社群 & 支线流程")
        self.assertEqual(document["author"], "测试作者 and 1 collaborator")
        self.assertEqual(
            [section["id"] for section in document["sections"]],
            ["7667220", "7725867"],
        )
        first = document["sections"][0]["html"]
        self.assertIn('<div class="bb_h3">4/23</div>', first)
        self.assertIn("去河堤下方与老人对话<br>", first)
        self.assertIn("<strong>保存后继续</strong>", first)
        self.assertIn('<a class="bb_link">来源</a>', first)
        self.assertIn(
            'src="https://images.steamusercontent.com/ugc/example/image.png"',
            first,
        )
        self.assertIn('<tr class="bb_table_tr">', first)
        self.assertIn('<td class="bb_table_td">日期</td>', first)
        self.assertIn('<th class="bb_table_th">行动</th>', first)
        for unsafe in (
            "onclick",
            "onfocus",
            "onerror",
            "style=",
            "javascript:",
            "href=",
            "rel=",
            "evil.example",
            "window.pwned",
            "iframe text",
            "<script",
            "<iframe",
        ):
            self.assertNotIn(unsafe, first)

    def test_rejects_non_guide_and_invalid_ids(self):
        with self.assertRaises(GuideParseError):
            parse_guide_html("3414883877", "<html><body>sign in</body></html>")
        for guide_id in ("", "0", "../1", "1&x=2", "١"):
            with self.subTest(guide_id=guide_id):
                with self.assertRaises(ValueError):
                    parse_guide_html(guide_id, PUBLIC_GUIDE_FIXTURE)

    def test_void_drop_content_tag_does_not_discard_following_content(self):
        sanitized = sanitize_fragment(
            '<p>before</p><embed src="https://evil.example/media">'
            "<p>after</p>"
        )

        self.assertEqual(sanitized, "<p>before</p><p>after</p>")

    def test_localizes_only_valid_images_without_attr_order_assumptions(self):
        fragment = (
            "<p>before</p>"
            "<img width='640' src='https://images.steamusercontent.com/ugc/"
            "example/image.png?x=1&amp;y=2' alt='A &amp; B' loading='lazy' "
            "class='bb_img'>"
            "<img src='https://evil.example/image.png' loading='lazy'>"
            "<img src='https://images.steamusercontent.com/a.png' "
            "loading='lazy' onerror='bad'>"
        )

        localized = localize_guide_images(fragment)

        self.assertEqual(
            localized,
            '<p>before</p><img alt="A &amp; B" class="bb_img" '
            'data-grip-image-url="https://images.steamusercontent.com/ugc/'
            'example/image.png?x=1&amp;y=2" loading="lazy" width="640">',
        )
        self.assertNotIn(" src=", localized)
        self.assertNotIn("evil.example", localized)
        self.assertNotIn("onerror", localized)

    def test_rejects_node_depth_text_and_output_budgets(self):
        cases = (
            (_GuidePageParser, "MAX_NODES", 2, "node budget"),
            (_GuidePageParser, "MAX_DEPTH", 2, "nesting depth budget"),
            (_GuidePageParser, "MAX_TEXT_CHARS", 4, "text budget"),
            (_FragmentSanitizer, "MAX_OUTPUT_BYTES", 10, "output budget"),
        )
        for owner, name, limit, message in cases:
            with self.subTest(budget=name), mock.patch.object(owner, name, limit):
                with self.assertRaisesRegex(GuideParseError, message):
                    if owner is _GuidePageParser:
                        parse_guide_html("3414883877", PUBLIC_GUIDE_FIXTURE)
                    else:
                        sanitize_fragment("<p>abcdefgh</p>")

        with mock.patch.object(_FragmentSanitizer, "MAX_DEPTH", 3):
            with self.assertRaisesRegex(GuideParseError, "nesting depth budget"):
                sanitize_fragment("<div>" * 4 + "x" + "</div>" * 4)

    def test_rejects_section_budget_before_building_an_unbounded_result(self):
        sections = "".join(
            f'<div class="subSection" id="{index + 1}">'
            '<div class="subSectionTitle">标题</div>'
            '<div class="subSectionDesc">正文</div></div>'
            for index in range(3)
        )
        source = (
            '<div class="workshopItemTitle">指南</div>'
            '<div class="guideAuthors">By 作者</div>'
            f"<div>{sections}</div>"
        )

        with mock.patch.object(_GuidePageParser, "MAX_SECTIONS", 2):
            with self.assertRaisesRegex(GuideParseError, "too many sections"):
                parse_guide_html("3414883877", source)

    def test_single_section_has_strict_synchronous_mount_budgets(self):
        self.assertLessEqual(_FragmentSanitizer.MAX_NODES, 8_000)
        self.assertLessEqual(
            _FragmentSanitizer.MAX_TEXT_CHARS,
            1 * 1024 * 1024,
        )
        self.assertLessEqual(
            _FragmentSanitizer.MAX_OUTPUT_BYTES,
            2 * 1024 * 1024,
        )

        cases = (
            (
                "nodes",
                "<br>" * (_FragmentSanitizer.MAX_NODES + 1),
                "node budget",
            ),
            (
                "text",
                "x" * (_FragmentSanitizer.MAX_TEXT_CHARS + 1),
                "text budget",
            ),
            (
                "escaped output",
                "&amp;" * (_FragmentSanitizer.MAX_OUTPUT_BYTES // 5 + 1),
                "output budget",
            ),
        )
        for label, section_html, message in cases:
            with self.subTest(limit=label):
                with self.assertRaisesRegex(GuideParseError, message):
                    parse_guide_html(
                        "3414883877",
                        _guide_with_single_section(section_html),
                    )

    def test_unmatched_end_tags_do_not_rescan_the_open_stack(self):
        class CountingStack(list):
            indexed_reads = 0

            def __getitem__(self, index):
                self.indexed_reads += 1
                return super().__getitem__(index)

        for parser in (_GuidePageParser(), _FragmentSanitizer()):
            with self.subTest(parser=type(parser).__name__):
                for _ in range(64):
                    parser.handle_starttag("div", [])
                counting_stack = CountingStack(parser._stack)
                parser._stack = counting_stack

                for _ in range(1_000):
                    parser.handle_endtag("definitely-not-open")

                self.assertEqual(counting_stack.indexed_reads, 0)
                self.assertEqual(len(counting_stack), 64)


class GuideReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.cache_directory = Path(self.temporary_directory.name) / "guides"
        self.now = 1_800_000_000_000
        self.fetcher = _Fetcher()
        self.reader = GuideReader(
            self.cache_directory,
            fetcher=self.fetcher,
            now_ms=lambda: self.now,
        )

    def test_downloads_then_serves_a_fresh_validated_cache(self):
        downloaded = self.reader.get("3414883877")
        cached = self.reader.get("3414883877")

        self.assertEqual(len(self.fetcher.calls), 1)
        self.assertEqual(
            self.fetcher.calls[0][0],
            "https://steamcommunity.com/sharedfiles/filedetails/?id=3414883877&l=schinese",
        )
        self.assertEqual(
            set(downloaded),
            {
                "guideId",
                "title",
                "author",
                "sourceUrl",
                "fetchedAt",
                "fromCache",
                "stale",
                "sections",
            },
        )
        self.assertFalse(downloaded["fromCache"])
        self.assertFalse(downloaded["stale"])
        self.assertTrue(cached["fromCache"])
        self.assertFalse(cached["stale"])
        self.assertEqual(cached["sections"], downloaded["sections"])
        returned_html = downloaded["sections"][0]["html"]
        self.assertIn("data-grip-image-url=", returned_html)
        self.assertNotIn(" src=", returned_html)
        stored = json.loads(
            (self.cache_directory / "3414883877.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn(" src=", stored["sections"][0]["html"])
        self.assertNotIn(
            "data-grip-image-url=", stored["sections"][0]["html"]
        )
        self.assertEqual(
            stat.S_IMODE((self.cache_directory / "3414883877.json").stat().st_mode),
            0o600,
        )

    def test_cache_only_miss_never_downloads(self):
        self.assertIsNone(self.reader.get_cached("3414883877"))
        self.assertEqual(self.fetcher.calls, [])

    def test_special_cache_paths_are_rejected_without_following_or_blocking(self):
        self.cache_directory.mkdir(parents=True)
        path = self.cache_directory / "3414883877.json"
        outside = self.cache_directory.parent / "outside.json"
        outside.write_text("{}", encoding="utf-8")
        path.symlink_to(outside)
        with self.assertRaisesRegex(GuideCacheError, "safely"):
            self.reader.get_cached("3414883877")
        path.unlink()

        os.mkfifo(path)
        real_open = os.open

        def require_safe_flags(candidate, flags, *args, **kwargs):
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertTrue(flags & os.O_NONBLOCK)
            return real_open(candidate, flags, *args, **kwargs)

        with mock.patch(
            "store_repair.os.open", side_effect=require_safe_flags
        ):
            with self.assertRaisesRegex(GuideCacheError, "safely"):
                self.reader.get_cached("3414883877")

    def test_clear_removes_managed_special_entries_without_following(self):
        self.cache_directory.mkdir(parents=True)
        outside = self.cache_directory.parent / "outside.json"
        outside.write_text("keep", encoding="utf-8")
        symlink = self.cache_directory / "3414883877.json"
        fifo = self.cache_directory / "3414883878.json"
        symlink.symlink_to(outside)
        os.mkfifo(fifo)

        result = self.reader.clear_guide_cache()

        self.assertEqual(result, {"filesRemoved": 2, "bytesRemoved": 0})
        self.assertFalse(symlink.exists())
        self.assertFalse(fifo.exists())
        self.assertEqual(outside.read_text(encoding="utf-8"), "keep")

    def test_cache_only_returns_a_valid_stale_cache_without_downloading(self):
        original = self.reader.get("3414883877")
        self.now += GuideReader.CACHE_MAX_AGE_MS + 1
        self.fetcher.error = AssertionError("cache-only lookup attempted network")

        cached = self.reader.get_cached("3414883877")

        self.assertIsNotNone(cached)
        self.assertTrue(cached["fromCache"])
        self.assertTrue(cached["stale"])
        self.assertEqual(cached["fetchedAt"], original["fetchedAt"])
        self.assertEqual(len(self.fetcher.calls), 1)

    def test_cache_only_rejects_corruption_without_downloading(self):
        self.cache_directory.mkdir(parents=True)
        path = self.cache_directory / "3414883877.json"
        path.write_text("{ definitely not json", encoding="utf-8")
        self.fetcher.error = AssertionError("cache-only lookup attempted network")

        with self.assertRaises(GuideCacheError):
            self.reader.get_cached("3414883877")

        self.assertEqual(self.fetcher.calls, [])
        self.assertEqual(path.read_text(encoding="utf-8"), "{ definitely not json")

    def test_different_guides_do_not_share_a_network_lock(self):
        first_started = threading.Event()
        release_first = threading.Event()

        def fetcher(url, _timeout, _max_bytes):
            if "id=3414883877" in url:
                first_started.set()
                release_first.wait(timeout=2)
            return PUBLIC_GUIDE_FIXTURE.encode("utf-8")

        reader = GuideReader(
            self.cache_directory,
            fetcher=fetcher,
            now_ms=lambda: self.now,
        )
        reader.get("3414883878")
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(reader.get, "3414883877")
            try:
                self.assertTrue(first_started.wait(timeout=1))
                second = executor.submit(reader.get, "3414883878")
                second_result = second.result(timeout=1)
                self.assertEqual(second_result["guideId"], "3414883878")
                self.assertTrue(second_result["fromCache"])
                self.assertFalse(release_first.is_set())
            finally:
                release_first.set()
                self.assertEqual(
                    first.result(timeout=2)["guideId"], "3414883877"
                )

    def test_cache_only_reads_while_the_same_guide_refresh_is_busy(self):
        foreground_started = threading.Event()
        release_foreground = threading.Event()

        original = self.reader.get("3414883877")

        def blocking_fetcher(_url, _timeout, _max_bytes):
            foreground_started.set()
            release_foreground.wait(timeout=2)
            return PUBLIC_GUIDE_FIXTURE.encode("utf-8")

        self.reader._fetcher = blocking_fetcher
        with ThreadPoolExecutor(max_workers=1) as executor:
            foreground = executor.submit(self.reader.get, "3414883877", True)
            try:
                self.assertTrue(foreground_started.wait(timeout=1))
                cached = self.reader.get_cached("3414883877")
                self.assertIsNotNone(cached)
                self.assertEqual(cached["fetchedAt"], original["fetchedAt"])
                self.assertTrue(cached["fromCache"])
                self.assertFalse(release_foreground.is_set())
            finally:
                release_foreground.set()
                self.assertEqual(
                    foreground.result(timeout=2)["guideId"], "3414883877"
                )

    def test_unchanged_cache_uses_process_validation_memo(self):
        self.reader.get("3414883877")
        disk_reader = GuideReader(
            self.cache_directory,
            fetcher=self.fetcher,
            now_ms=lambda: self.now,
        )

        with mock.patch.object(
            disk_reader,
            "_validate_cached_document",
            wraps=disk_reader._validate_cached_document,
        ) as validate:
            first = disk_reader.get("3414883877")
            second = disk_reader.get("3414883877")

        self.assertEqual(validate.call_count, 1)
        self.assertEqual(first, second)
        self.assertEqual(len(self.fetcher.calls), 1)

    def test_cache_file_change_invalidates_process_validation_memo(self):
        self.reader.get("3414883877")
        disk_reader = GuideReader(
            self.cache_directory,
            fetcher=self.fetcher,
            now_ms=lambda: self.now,
        )
        path = self.cache_directory / "3414883877.json"

        with mock.patch.object(
            disk_reader,
            "_validate_cached_document",
            wraps=disk_reader._validate_cached_document,
        ) as validate:
            original = disk_reader.get("3414883877")
            document = json.loads(path.read_text(encoding="utf-8"))
            document["title"] = f'{document["title"]}（已更新）'
            path.write_text(
                json.dumps(document, ensure_ascii=False), encoding="utf-8"
            )
            changed = disk_reader.get("3414883877")

        self.assertEqual(validate.call_count, 2)
        self.assertNotEqual(changed["title"], original["title"])
        self.assertEqual(changed["title"], document["title"])
        self.assertEqual(len(self.fetcher.calls), 1)

    def test_force_refresh_bypasses_a_fresh_cache(self):
        self.reader.get("3414883877")
        self.now += 1
        refreshed = self.reader.get("3414883877", True)

        self.assertEqual(len(self.fetcher.calls), 2)
        self.assertFalse(refreshed["fromCache"])
        self.assertEqual(refreshed["fetchedAt"], self.now)

    def test_stale_cache_is_returned_without_fetching(self):
        original = self.reader.get("3414883877")
        self.now += GuideReader.CACHE_MAX_AGE_MS + 1
        self.fetcher.error = OSError("offline")

        stale = self.reader.get("3414883877")

        self.assertTrue(stale["fromCache"])
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["fetchedAt"], original["fetchedAt"])
        self.assertEqual(len(self.fetcher.calls), 1)

    def test_failed_force_refresh_uses_stale_cache(self):
        original = self.reader.get("3414883877")
        self.now += GuideReader.CACHE_MAX_AGE_MS + 1
        self.fetcher.error = http.client.IncompleteRead(b"partial", 100)

        stale = self.reader.get("3414883877", True)

        self.assertTrue(stale["fromCache"])
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["fetchedAt"], original["fetchedAt"])
        self.assertEqual(len(self.fetcher.calls), 2)

    def test_force_refresh_updates_a_stale_cache(self):
        self.reader.get("3414883877")
        self.now += GuideReader.CACHE_MAX_AGE_MS + 1
        self.fetcher.body = PUBLIC_GUIDE_FIXTURE.replace(
            "P4G 社群 &amp; 支线流程", "更新后的指南"
        ).encode("utf-8")

        refreshed = self.reader.get("3414883877", True)

        self.assertEqual(len(self.fetcher.calls), 2)
        self.assertFalse(refreshed["fromCache"])
        self.assertFalse(refreshed["stale"])
        self.assertEqual(refreshed["fetchedAt"], self.now)
        self.assertEqual(refreshed["title"], "更新后的指南")

    def test_download_normalizes_incomplete_http_response(self):
        headers = Message()
        headers["Content-Type"] = "text/html; charset=UTF-8"
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = GuideReader.source_url("3414883877")
        response.headers = headers
        response.read.side_effect = http.client.IncompleteRead(b"partial", 100)
        opener = mock.Mock()
        opener.open.return_value = response

        with mock.patch(
            "guide_reader.urllib.request.build_opener", return_value=opener
        ):
            with self.assertRaises(GuideDownloadError) as raised:
                GuideReader._download(
                    GuideReader.source_url("3414883877"),
                    GuideReader.REQUEST_TIMEOUT_SECONDS,
                    GuideReader.MAX_DOWNLOAD_BYTES,
                )

        self.assertIsInstance(raised.exception.__cause__, http.client.IncompleteRead)

    def test_download_failure_without_cache_is_reported(self):
        self.fetcher.error = GuideDownloadError("offline")
        with self.assertRaises(GuideDownloadError):
            self.reader.get("3414883877")

    def test_invalid_or_oversized_response_is_not_cached(self):
        for body in (
            b"not utf-8: \xff",
            b"x" * (GuideReader.MAX_DOWNLOAD_BYTES + 1),
            b"<html>login required</html>",
        ):
            with self.subTest(size=len(body)):
                self.fetcher.body = body
                with self.assertRaises((GuideDownloadError, GuideParseError)):
                    self.reader.get("3414883877", True)
                self.assertFalse(
                    (self.cache_directory / "3414883877.json").exists()
                )

    def test_corrupt_cache_is_rejected_and_preserved_without_refresh(self):
        self.cache_directory.mkdir(parents=True)
        path = self.cache_directory / "3414883877.json"
        original = "{ definitely not json"
        path.write_text(original, encoding="utf-8")

        with self.assertRaises(GuideCacheError):
            self.reader.get("3414883877")

        self.assertEqual(path.read_text(encoding="utf-8"), original)
        self.assertEqual(self.fetcher.calls, [])

    def test_force_refresh_replaces_a_corrupt_cache(self):
        self.cache_directory.mkdir(parents=True)
        path = self.cache_directory / "3414883877.json"
        path.write_text("{ definitely not json", encoding="utf-8")

        refreshed = self.reader.get("3414883877", True)

        self.assertFalse(refreshed["fromCache"])
        self.assertFalse(refreshed["stale"])
        self.assertEqual(len(self.fetcher.calls), 1)
        cached = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(cached["guideId"], "3414883877")

    def test_failed_force_refresh_preserves_a_corrupt_cache(self):
        self.cache_directory.mkdir(parents=True)
        path = self.cache_directory / "3414883877.json"
        original = "{ definitely not json"
        path.write_text(original, encoding="utf-8")
        self.fetcher.error = GuideDownloadError("offline")

        with self.assertRaises(GuideDownloadError):
            self.reader.get("3414883877", True)

        self.assertEqual(path.read_text(encoding="utf-8"), original)
        self.assertEqual(len(self.fetcher.calls), 1)

    def test_cache_html_is_revalidated_before_returning(self):
        self.reader.get("3414883877")
        path = self.cache_directory / "3414883877.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        document["sections"][0]["html"] += "<script>alert(1)</script>"
        path.write_text(json.dumps(document), encoding="utf-8")

        with self.assertRaisesRegex(GuideCacheError, "unsafe"):
            self.reader.get("3414883877")

    def test_force_refresh_requires_a_real_boolean(self):
        with self.assertRaises(ValueError):
            self.reader.get("3414883877", 1)

    def test_image_lookup_and_cache_admin_ignore_unmanaged_names(self):
        image_cache = mock.Mock()
        image_cache.get.return_value = {
            "mimeType": "image/png",
            "base64": "AAAA",
            "fromCache": True,
        }
        image_cache.clear.return_value = {
            "filesRemoved": 2,
            "bytesRemoved": 10,
        }
        image_cache.stats.return_value = {"files": 2, "diskBytes": 10}
        reader = GuideReader(
            self.cache_directory,
            fetcher=self.fetcher,
            now_ms=lambda: self.now,
            image_cache=image_cache,
        )
        reader.get("3414883877")
        unmanaged = self.cache_directory / "metadata.json"
        unmanaged.write_text("keep", encoding="utf-8")

        payload = reader.get_guide_image(
            "https://images.steamusercontent.com/a.png", False
        )
        stats = reader.cache_stats()
        cleared = reader.clear_guide_cache()

        self.assertTrue(payload["fromCache"])
        image_cache.get.assert_called_once_with(
            "https://images.steamusercontent.com/a.png", False
        )
        self.assertEqual(stats["guides"]["files"], 1)
        self.assertEqual(stats["images"], image_cache.stats.return_value)
        self.assertEqual(cleared["filesRemoved"], 1)
        self.assertTrue(unmanaged.exists())
        self.assertIsNone(reader.get_cached("3414883877"))
        self.assertEqual(
            reader.clear_image_cache(), image_cache.clear.return_value
        )


class ReaderPositionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "reader_positions.json"
        self.store = ReaderPositionStore(self.path, now_ms=lambda: 123456)

    def test_missing_save_and_overwrite(self):
        self.assertIsNone(self.store.get("1113000:3414883877"))

        saved = self.store.save(
            "1113000:3414883877",
            4040.25,
            "7667220",
            "去河堤下方与老人对话",
            -17.5,
        )

        self.assertEqual(
            saved,
            {
                "scroll_top": 4040.25,
                "section_id": "7667220",
                "anchor_text": "去河堤下方与老人对话",
                "anchor_offset": -17.5,
                "updated_at_ms": 123456,
            },
        )
        self.assertEqual(self.store.get("1113000:3414883877"), saved)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

        replacement = self.store.save(
            "1113000:3414883877", 1, None, None, 0
        )
        self.assertEqual(replacement["scroll_top"], 1.0)
        self.assertIsNone(replacement["section_id"])

    def test_special_store_paths_are_rejected_without_following_or_blocking(self):
        outside = self.path.parent / "outside.json"
        outside.write_text(
            json.dumps(ReaderPositionStore._empty_document()),
            encoding="utf-8",
        )
        self.path.symlink_to(outside)
        with self.assertRaisesRegex(ReaderPositionError, "safely"):
            self.store.get("1:2")
        self.path.unlink()

        os.mkfifo(self.path)
        real_open = os.open

        def require_safe_flags(path, flags, *args, **kwargs):
            self.assertTrue(flags & os.O_NOFOLLOW)
            self.assertTrue(flags & os.O_NONBLOCK)
            return real_open(path, flags, *args, **kwargs)

        with mock.patch(
            "store_repair.os.open", side_effect=require_safe_flags
        ):
            with self.assertRaisesRegex(ReaderPositionError, "safely"):
                self.store.get("1:2")

    def test_invalid_inputs_are_rejected_without_a_write(self):
        cases = (
            ("bad", 1, None, None, 0),
            ("1:2", -1, None, None, 0),
            ("1:2", math.nan, None, None, 0),
            ("1:2", 1, "../section", None, 0),
            ("1:2", 1, None, "", 0),
            ("1:2", 1, None, "x" * 513, 0),
            ("1:2", 1, None, "\ud800", 0),
            ("1:2", 1, None, None, math.inf),
        )
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(ValueError):
                    self.store.save(*case)
        self.assertFalse(self.path.exists())

    def test_timestamp_must_fit_a_javascript_safe_integer(self):
        store = ReaderPositionStore(self.path, now_ms=lambda: 1 << 53)

        with self.assertRaisesRegex(ValueError, "updated_at_ms is invalid"):
            store.save("1:2", 1, None, None, 0)

        self.assertFalse(self.path.exists())

    def test_repair_resets_nonportable_stored_values(self):
        base_position = {
            "scroll_top": 1,
            "section_id": None,
            "anchor_text": "valid anchor",
            "anchor_offset": 0,
            "updated_at_ms": (1 << 53) - 1,
        }
        document = {
            "schema_version": 1,
            "positions": {"1:2": base_position},
        }
        self.path.write_text(json.dumps(document), encoding="utf-8")
        self.assertEqual(
            self.store.get("1:2")["updated_at_ms"],
            (1 << 53) - 1,
        )

        invalid_values = (
            ("unsafe timestamp", "updated_at_ms", 1 << 53),
            ("unpaired surrogate", "anchor_text", "\ud800"),
        )
        for label, field, value in invalid_values:
            with self.subTest(value=label):
                position = dict(base_position)
                position[field] = value
                original = json.dumps(
                    {
                        "schema_version": 1,
                        "positions": {"1:2": position},
                    }
                ).encode("utf-8")
                self.path.write_bytes(original)

                with self.assertRaises(ReaderPositionError):
                    self.store.get("1:2")

                result = self.store.repair()
                self.assertTrue(result["repaired"])
                self.assertEqual(Path(result["backup"]).read_bytes(), original)
                self.assertIsNone(self.store.get("1:2"))

    def test_corrupt_store_is_rejected_and_preserved(self):
        original = "{ definitely not json"
        self.path.write_text(original, encoding="utf-8")

        with self.assertRaises(ReaderPositionError):
            self.store.save("1:2", 3, None, None, 0)

        self.assertEqual(self.path.read_text(encoding="utf-8"), original)

    def test_unknown_position_fields_are_rejected(self):
        self.path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "positions": {
                        "1:2": {
                            "scroll_top": 1,
                            "section_id": None,
                            "anchor_text": None,
                            "anchor_offset": 0,
                            "updated_at_ms": 1,
                            "script": "alert(1)",
                        }
                    },
                }
            ),
            encoding="utf-8",
        )

        with self.assertRaises(ReaderPositionError):
            self.store.get("1:2")

    def test_repair_backs_up_corruption_then_atomically_resets(self):
        original = b"{ definitely not json"
        self.path.write_bytes(original)

        result = self.store.repair()

        backup = Path(result["backup"])
        self.assertTrue(result["repaired"])
        self.assertEqual(backup.parent, self.path.parent)
        self.assertEqual(backup.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        self.assertIsNone(self.store.get("1:2"))
        self.assertEqual(
            self.store.repair(), {"repaired": False, "backup": None}
        )

    def test_repair_does_not_touch_a_valid_store(self):
        self.store.save("1:2", 3, None, None, 0)
        original = self.path.read_bytes()

        result = self.store.repair()

        self.assertEqual(result, {"repaired": False, "backup": None})
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.path.parent.glob("*.corrupt-*.bak")), [])


if __name__ == "__main__":
    unittest.main()
