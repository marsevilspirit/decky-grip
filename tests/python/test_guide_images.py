import base64
import os
import sys
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))

from guide_images import (  # noqa: E402
    GuideImageCache,
    ImageDownloadError,
    _SafeImageRedirectHandler,
    canonical_image_url,
)


def _png(marker=b"a", *, width=1, height=1):
    return (
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big")
        + b"IHDR"
        + width.to_bytes(4, "big")
        + height.to_bytes(4, "big")
        + b"\x08\x06\x00\x00\x00"
        + marker * 4
    )


PNG_A = _png(b"a")
PNG_B = _png(b"b")
PNG_C = _png(b"c")
IMAGE_URL = "https://images.steamusercontent.com/ugc/example/image.png"


def _gif(*, frames=1):
    header = b"GIF89a\x01\x00\x01\x00\x00\x00\x00"
    frame = (
        b",\x00\x00\x00\x00\x01\x00\x01\x00\x00"
        b"\x02\x02\x44\x01\x00"
    )
    return header + frame * frames + b";"


def _webp(*, animated=False):
    payload = (
        bytes([0x02 if animated else 0x00])
        + b"\x00\x00\x00"
        + b"\x00\x00\x00"
        + b"\x00\x00\x00"
    )
    chunk = b"VP8X" + len(payload).to_bytes(4, "little") + payload
    riff_payload = b"WEBP" + chunk
    return b"RIFF" + len(riff_payload).to_bytes(4, "little") + riff_payload


def _apng():
    animation_control = (
        (8).to_bytes(4, "big")
        + b"acTL"
        + (2).to_bytes(4, "big")
        + (0).to_bytes(4, "big")
        + b"crc!"
    )
    return PNG_A + animation_control


class _Fetcher:
    def __init__(self):
        self.calls = []
        self.error = None

    def __call__(self, url, timeout, max_bytes):
        self.calls.append((url, timeout, max_bytes))
        if self.error is not None:
            raise self.error
        marker = urllib.parse.urlparse(url).query
        body = {"a": PNG_A, "b": PNG_B, "c": PNG_C}.get(marker, PNG_A)
        return "image/png", body


class _Response:
    def __init__(
        self,
        *,
        url=IMAGE_URL,
        mime_type="image/png",
        body=PNG_A,
        length=None,
        content_encoding=None,
    ):
        self._url = url
        self._body = body
        self.headers = Message()
        self.headers["Content-Type"] = mime_type
        if length is not None:
            self.headers["Content-Length"] = str(length)
        if content_encoding is not None:
            self.headers["Content-Encoding"] = content_encoding
        self.read = mock.Mock(return_value=body)

    def __enter__(self):
        return self

    def __exit__(self, _kind, _value, _traceback):
        return False

    def geturl(self):
        return self._url


class ImageUrlTests(unittest.TestCase):
    def test_canonicalizes_only_trusted_https_image_urls(self):
        self.assertEqual(
            canonical_image_url(
                "HTTPS://IMAGES.STEAMUSERCONTENT.COM.:443/ugc/a.png?x=1&y=2"
            ),
            "https://images.steamusercontent.com:443/ugc/a.png?x=1&y=2",
        )
        self.assertEqual(
            canonical_image_url("https://cdn.steamstatic.com"),
            "https://cdn.steamstatic.com/",
        )

        unsafe = (
            "data:image/png;base64,AAAA",
            "http://images.steamusercontent.com/a.png",
            "https://user@images.steamusercontent.com/a.png",
            "https://images.steamusercontent.com:444/a.png",
            "https://evilsteamusercontent.com/a.png",
            "https://steamusercontent.com.evil.example/a.png",
            "https://images.steamusercontent.com/a.png#fragment",
            "https://images.steamusercontent.com/a.png\r\nX-Test: bad",
        )
        for value in unsafe:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    canonical_image_url(value)

    def test_redirect_handler_revalidates_every_target(self):
        handler = _SafeImageRedirectHandler()
        request = urllib.request.Request(IMAGE_URL)

        with self.assertRaises(ImageDownloadError):
            handler.redirect_request(
                request,
                None,
                302,
                "Found",
                Message(),
                "https://169.254.169.254/latest/meta-data/",
            )

        with mock.patch.object(
            urllib.request.HTTPRedirectHandler,
            "redirect_request",
            return_value="safe",
        ) as parent:
            result = handler.redirect_request(
                request,
                None,
                302,
                "Found",
                Message(),
                "HTTPS://CDN.STEAMSTATIC.COM.:443/image.png",
            )

        self.assertEqual(result, "safe")
        self.assertEqual(
            parent.call_args.args[-1],
            "https://cdn.steamstatic.com:443/image.png",
        )


class ImageDownloadTests(unittest.TestCase):
    def _download_with(self, response):
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch(
            "guide_images.urllib.request.build_opener", return_value=opener
        ):
            result = GuideImageCache._download(IMAGE_URL, 1.0, len(PNG_A))
        return result, opener

    def test_accepts_only_matching_raster_mime_and_magic(self):
        result, _ = self._download_with(_Response())
        self.assertEqual(result, ("image/png", PNG_A))

        for response in (
            _Response(mime_type="image/svg+xml", body=b"<svg></svg>"),
            _Response(mime_type="image/png", body=b"not a png"),
            _Response(content_encoding="gzip"),
        ):
            with self.subTest(mime=response.headers.get_content_type()):
                with self.assertRaises(ImageDownloadError):
                    self._download_with(response)

    def test_rejects_images_with_an_excessive_decoded_canvas(self):
        with self.assertRaises(ImageDownloadError):
            self._download_with(
                _Response(body=_png(width=8_193), length=len(PNG_A))
            )

    def test_rejects_animated_gif_apng_and_webp(self):
        animated = (
            ("image/gif", _gif(frames=2)),
            ("image/png", _apng()),
            ("image/webp", _webp(animated=True)),
        )
        for mime_type, body in animated:
            with self.subTest(mime_type=mime_type):
                with self.assertRaisesRegex(
                    ImageDownloadError, "animated"
                ):
                    GuideImageCache._validate_download_result(
                        (mime_type, body), len(body)
                    )

        for mime_type, body in (
            ("image/gif", _gif()),
            ("image/png", PNG_A),
            ("image/webp", _webp()),
        ):
            with self.subTest(static=mime_type):
                self.assertEqual(
                    GuideImageCache._validate_download_result(
                        (mime_type, body), len(body)
                    ),
                    (mime_type, body),
                )

    def test_rejects_oversized_length_before_reading(self):
        response = _Response(length=len(PNG_A) + 1)

        with self.assertRaises(ImageDownloadError):
            self._download_with(response)

        response.read.assert_not_called()

    def test_rejects_unsafe_final_url(self):
        response = _Response(url="https://evil.example/image.png")

        with self.assertRaises(ImageDownloadError):
            self._download_with(response)


class GuideImageCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.directory = Path(self.temporary_directory.name) / "images"
        self.fetcher = _Fetcher()

    def _cache(self, **limits):
        return GuideImageCache(
            self.directory,
            fetcher=self.fetcher,
            max_image_bytes=limits.get("max_image_bytes", 1024),
            max_disk_bytes=limits.get("max_disk_bytes", 1024),
            max_memory_bytes=limits.get("max_memory_bytes", 1024),
        )

    def test_cache_only_miss_never_downloads_and_network_failure_is_soft(self):
        cache = self._cache()
        self.assertIsNone(cache.get(IMAGE_URL, False))
        self.assertEqual(self.fetcher.calls, [])

        self.fetcher.error = OSError("offline")
        self.assertIsNone(cache.get(IMAGE_URL, True))
        self.assertEqual(len(self.fetcher.calls), 1)

    def test_disk_cache_survives_a_new_offline_process(self):
        cache = self._cache(max_memory_bytes=0)
        downloaded = cache.get(IMAGE_URL)
        self.assertFalse(downloaded["fromCache"])
        self.assertEqual(base64.b64decode(downloaded["base64"]), PNG_A)
        self.assertEqual((downloaded["width"], downloaded["height"]), (1, 1))

        offline_fetcher = mock.Mock(side_effect=AssertionError("network used"))
        offline = GuideImageCache(
            self.directory,
            fetcher=offline_fetcher,
            max_image_bytes=1024,
            max_disk_bytes=1024,
            max_memory_bytes=1024,
        )
        cached = offline.get(IMAGE_URL, False)

        self.assertTrue(cached["fromCache"])
        self.assertEqual(base64.b64decode(cached["base64"]), PNG_A)
        self.assertIsNone(
            offline.get(
                "https://images.steamusercontent.com/ugc/missing.png",
                False,
            )
        )
        offline_fetcher.assert_not_called()

    def test_disk_quota_evicts_the_least_recently_used_file(self):
        cache = self._cache(
            max_disk_bytes=len(PNG_A) * 2,
            max_memory_bytes=0,
        )
        urls = [f"{IMAGE_URL}?{marker}" for marker in ("a", "b", "c")]
        cache.get(urls[0])
        cache.get(urls[1])
        first_path = next(
            path for _, path in cache._candidate_paths(urls[0]) if path.exists()
        )
        second_path = next(
            path for _, path in cache._candidate_paths(urls[1]) if path.exists()
        )
        os.utime(first_path, ns=(1, 1))
        os.utime(second_path, ns=(2, 2))

        cache.get(urls[2])

        self.assertIsNone(cache.get(urls[0], False))
        self.assertTrue(cache.get(urls[1], False)["fromCache"])
        self.assertTrue(cache.get(urls[2], False)["fromCache"])
        self.assertEqual(cache.stats()["files"], 2)
        self.assertLessEqual(cache.stats()["diskBytes"], len(PNG_A) * 2)

    def test_memory_lru_uses_recent_access_order(self):
        cache = self._cache(
            max_disk_bytes=0,
            max_memory_bytes=len(PNG_A) * 2,
        )
        urls = [f"{IMAGE_URL}?{marker}" for marker in ("a", "b", "c")]
        cache.get(urls[0])
        cache.get(urls[1])
        cache.get(urls[0], False)
        cache.get(urls[2])

        self.assertIsNone(cache.get(urls[1], False))
        self.assertTrue(cache.get(urls[0], False)["fromCache"])
        self.assertTrue(cache.get(urls[2], False)["fromCache"])
        self.assertEqual(cache.stats()["memoryEntries"], 2)

    def test_same_url_concurrent_requests_download_once(self):
        started = threading.Event()
        release = threading.Event()

        def blocking_fetcher(_url, _timeout, _max_bytes):
            started.set()
            release.wait(timeout=2)
            return "image/png", PNG_A

        cache = GuideImageCache(
            self.directory,
            fetcher=blocking_fetcher,
            max_image_bytes=1024,
            max_disk_bytes=1024,
            max_memory_bytes=1024,
        )
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(cache.get, IMAGE_URL)
            self.assertTrue(started.wait(timeout=1))
            second = executor.submit(cache.get, IMAGE_URL)
            release.set()
            results = (first.result(timeout=2), second.result(timeout=2))

        self.assertEqual(
            sorted(result["fromCache"] for result in results),
            [False, True],
        )

    def test_clear_during_download_prevents_late_repopulation(self):
        started = threading.Event()
        release = threading.Event()

        def blocking_fetcher(_url, _timeout, _max_bytes):
            started.set()
            release.wait(timeout=2)
            return "image/png", PNG_A

        cache = GuideImageCache(
            self.directory,
            fetcher=blocking_fetcher,
            max_image_bytes=1024,
            max_disk_bytes=1024,
            max_memory_bytes=1024,
        )
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(cache.get, IMAGE_URL)
            self.assertTrue(started.wait(timeout=1))
            cleared = cache.clear()
            release.set()
            result = future.result(timeout=2)

        self.assertFalse(result["fromCache"])
        self.assertEqual(cleared, {"filesRemoved": 0, "bytesRemoved": 0})
        self.assertEqual(cache.stats()["files"], 0)
        self.assertEqual(cache.stats()["memoryEntries"], 0)
        self.assertIsNone(cache.get(IMAGE_URL, False))

    def test_clear_and_stats_ignore_unmanaged_file_names(self):
        self.directory.mkdir(parents=True)
        unmanaged = self.directory / "metadata.json"
        unmanaged.write_text("do not trust or delete me", encoding="utf-8")
        cache = self._cache()
        cache.get(IMAGE_URL)

        self.assertEqual(cache.stats()["files"], 1)
        result = cache.clear()

        self.assertEqual(result["filesRemoved"], 1)
        self.assertTrue(unmanaged.exists())
        self.assertEqual(cache.stats()["files"], 0)


if __name__ == "__main__":
    unittest.main()
