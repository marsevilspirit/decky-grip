"""Bounded, local-only cache for images referenced by Steam guides."""

from __future__ import annotations

import base64
import hashlib
import http.client
import os
import re
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


ALLOWED_IMAGE_HOSTS = ("steamstatic.com", "steamusercontent.com")
ALLOWED_IMAGE_TYPES = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
EXTENSION_IMAGE_TYPES = {
    extension: mime_type
    for mime_type, extension in ALLOWED_IMAGE_TYPES.items()
}
UNSAFE_URL_PUNCTUATION = frozenset('<>"{}|\\^`')
CACHE_FILE_PATTERN = re.compile(
    r"^(?P<digest>[0-9a-f]{64})\.(?P<extension>gif|jpg|png|webp)$"
)
TEMP_FILE_PATTERN = re.compile(
    r"^\.[0-9a-f]{64}\.[A-Za-z0-9_-]{6,16}\.tmp$"
)


class ImageDownloadError(RuntimeError):
    """Raised internally when a remote image is not safe and usable."""


def _is_allowed_image_host(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    normalized = hostname.rstrip(".").lower()
    return any(
        normalized == suffix or normalized.endswith(f".{suffix}")
        for suffix in ALLOWED_IMAGE_HOSTS
    )


def canonical_image_url(value: Any) -> str:
    """Validate and normalize a remotely hosted Steam guide image URL."""

    if (
        not isinstance(value, str)
        or not value
        or len(value) > 4_096
        or any(
            ord(character) < 0x21
            or ord(character) > 0x7E
            or character in UNSAFE_URL_PUNCTUATION
            for character in value
        )
    ):
        raise ValueError("image URL is invalid")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError("image URL is invalid") from error
    if (
        parsed.scheme.lower() != "https"
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.fragment
        or not _is_allowed_image_host(parsed.hostname)
    ):
        raise ValueError("image URL is not an allowed Steam image URL")

    hostname = parsed.hostname.rstrip(".").lower()
    netloc = hostname if port is None else f"{hostname}:443"
    return urllib.parse.urlunsplit(
        ("https", netloc, parsed.path or "/", parsed.query, "")
    )


def _image_type_matches(mime_type: str, body: bytes) -> bool:
    if mime_type == "image/png":
        return body.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return body.startswith(b"\xff\xd8\xff")
    if mime_type == "image/gif":
        return body.startswith((b"GIF87a", b"GIF89a"))
    if mime_type == "image/webp":
        return (
            len(body) >= 12
            and body.startswith(b"RIFF")
            and body[8:12] == b"WEBP"
        )
    return False


def _gif_frame_count(body: bytes) -> int:
    """Count GIF image descriptors without scanning inside compressed blocks."""

    if len(body) < 13 or not body.startswith((b"GIF87a", b"GIF89a")):
        raise ImageDownloadError("Steam returned an invalid GIF structure")
    cursor = 13
    packed = body[10]
    if packed & 0x80:
        cursor += 3 * (1 << ((packed & 0x07) + 1))
    if cursor > len(body):
        raise ImageDownloadError("Steam returned an invalid GIF structure")

    def skip_sub_blocks(offset: int) -> int:
        while True:
            if offset >= len(body):
                raise ImageDownloadError(
                    "Steam returned an invalid GIF structure"
                )
            size = body[offset]
            offset += 1
            if size == 0:
                return offset
            if offset + size > len(body):
                raise ImageDownloadError(
                    "Steam returned an invalid GIF structure"
                )
            offset += size

    frames = 0
    while cursor < len(body):
        marker = body[cursor]
        if marker == 0x3B:
            if frames == 0:
                raise ImageDownloadError(
                    "Steam returned a GIF without an image frame"
                )
            return frames
        if marker == 0x21:
            if cursor + 2 > len(body):
                raise ImageDownloadError(
                    "Steam returned an invalid GIF structure"
                )
            cursor = skip_sub_blocks(cursor + 2)
            continue
        if marker != 0x2C or cursor + 10 > len(body):
            raise ImageDownloadError("Steam returned an invalid GIF structure")

        descriptor_packed = body[cursor + 9]
        cursor += 10
        if descriptor_packed & 0x80:
            cursor += 3 * (1 << ((descriptor_packed & 0x07) + 1))
        if cursor >= len(body):
            raise ImageDownloadError("Steam returned an invalid GIF structure")
        cursor += 1  # LZW minimum code size.
        cursor = skip_sub_blocks(cursor)
        frames += 1
        if frames > 1:
            return frames
    raise ImageDownloadError("Steam returned an unterminated GIF")


def _reject_animated_image(mime_type: str, body: bytes) -> None:
    """Reject animation before CEF can perform unbounded multi-frame decoding."""

    animated = False
    if mime_type == "image/gif":
        animated = _gif_frame_count(body) > 1
    elif mime_type == "image/png":
        # Every APNG contains an animation-control chunk. Also reject frame
        # chunks conservatively if a malformed encoder omitted that control.
        animated = any(
            marker in body[8:] for marker in (b"acTL", b"fcTL", b"fdAT")
        )
    elif mime_type == "image/webp":
        animated = (
            len(body) >= 21
            and body[12:16] == b"VP8X"
            and bool(body[20] & 0x02)
        ) or any(marker in body[12:] for marker in (b"ANIM", b"ANMF"))
    if animated:
        raise ImageDownloadError("animated Steam guide images are not supported")


def _image_dimensions(mime_type: str, body: bytes) -> Tuple[int, int]:
    """Read raster dimensions without invoking a decoder."""

    if mime_type == "image/png":
        if (
            len(body) < 33
            or body[8:12] != b"\x00\x00\x00\r"
            or body[12:16] != b"IHDR"
        ):
            raise ImageDownloadError("Steam returned an invalid PNG header")
        return (
            int.from_bytes(body[16:20], "big"),
            int.from_bytes(body[20:24], "big"),
        )
    if mime_type == "image/gif":
        if len(body) < 10:
            raise ImageDownloadError("Steam returned an invalid GIF header")
        return (
            int.from_bytes(body[6:8], "little"),
            int.from_bytes(body[8:10], "little"),
        )
    if mime_type == "image/jpeg":
        cursor = 2
        start_of_frame = {
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        }
        while cursor < len(body):
            while cursor < len(body) and body[cursor] != 0xFF:
                cursor += 1
            while cursor < len(body) and body[cursor] == 0xFF:
                cursor += 1
            if cursor >= len(body):
                break
            marker = body[cursor]
            cursor += 1
            if marker in (0x00, 0x01) or 0xD0 <= marker <= 0xD9:
                continue
            if cursor + 2 > len(body):
                break
            segment_length = int.from_bytes(body[cursor : cursor + 2], "big")
            if segment_length < 2 or cursor + segment_length > len(body):
                break
            if marker in start_of_frame:
                if segment_length < 7:
                    break
                return (
                    int.from_bytes(body[cursor + 5 : cursor + 7], "big"),
                    int.from_bytes(body[cursor + 3 : cursor + 5], "big"),
                )
            cursor += segment_length
        raise ImageDownloadError("Steam returned a JPEG without dimensions")
    if mime_type == "image/webp":
        if len(body) < 20:
            raise ImageDownloadError("Steam returned an invalid WebP header")
        kind = body[12:16]
        if kind == b"VP8X" and len(body) >= 30:
            return (
                int.from_bytes(body[24:27], "little") + 1,
                int.from_bytes(body[27:30], "little") + 1,
            )
        if kind == b"VP8L" and len(body) >= 25 and body[20] == 0x2F:
            dimensions = int.from_bytes(body[21:25], "little")
            return (
                (dimensions & 0x3FFF) + 1,
                ((dimensions >> 14) & 0x3FFF) + 1,
            )
        if kind == b"VP8 " and len(body) >= 30 and body[23:26] == b"\x9d\x01\x2a":
            return (
                int.from_bytes(body[26:28], "little") & 0x3FFF,
                int.from_bytes(body[28:30], "little") & 0x3FFF,
            )
        raise ImageDownloadError("Steam returned a WebP without dimensions")
    raise ImageDownloadError("Steam returned an unsupported image type")


class _SafeImageRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        try:
            safe_url = canonical_image_url(newurl)
        except ValueError as error:
            raise ImageDownloadError(
                "Steam redirected the image to an unsafe URL"
            ) from error
        return super().redirect_request(
            req, fp, code, msg, headers, safe_url
        )


ImageFetcher = Callable[[str, float, int], Tuple[str, bytes]]


class _KeyLockEntry:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.users = 0


class _KeyLockPool:
    """Retain one lock per URL only while a lookup is using it."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._entries: Dict[str, _KeyLockEntry] = {}

    def retain(self, key: str) -> _KeyLockEntry:
        with self._guard:
            entry = self._entries.get(key)
            if entry is None:
                entry = _KeyLockEntry()
                self._entries[key] = entry
            entry.users += 1
            return entry

    def release(self, key: str, entry: _KeyLockEntry) -> None:
        with self._guard:
            current = self._entries.get(key)
            if current is not entry or entry.users <= 0:
                raise RuntimeError("image lock pool state is inconsistent")
            entry.users -= 1
            if entry.users == 0:
                del self._entries[key]


class GuideImageCache:
    """Download trusted Steam images into bounded disk and memory LRUs."""

    MAX_IMAGE_BYTES = 8 * 1024 * 1024
    MAX_DISK_BYTES = 128 * 1024 * 1024
    MAX_MEMORY_BYTES = 24 * 1024 * 1024
    MAX_IMAGE_DIMENSION = 8_192
    MAX_IMAGE_PIXELS = 16_777_216
    REQUEST_TIMEOUT_SECONDS = 12.0

    def __init__(
        self,
        cache_directory: Path,
        *,
        fetcher: Optional[ImageFetcher] = None,
        max_image_bytes: int = MAX_IMAGE_BYTES,
        max_disk_bytes: int = MAX_DISK_BYTES,
        max_memory_bytes: int = MAX_MEMORY_BYTES,
    ) -> None:
        for label, value in (
            ("max_image_bytes", max_image_bytes),
            ("max_disk_bytes", max_disk_bytes),
            ("max_memory_bytes", max_memory_bytes),
        ):
            if type(value) is not int or value < 0:
                raise ValueError(f"{label} must be a non-negative integer")
        if max_image_bytes == 0:
            raise ValueError("max_image_bytes must be positive")

        self.cache_directory = Path(cache_directory)
        self.max_image_bytes = max_image_bytes
        self.max_disk_bytes = max_disk_bytes
        self.max_memory_bytes = max_memory_bytes
        self._fetcher = fetcher or self._download
        self._key_locks = _KeyLockPool()
        self._disk_lock = threading.RLock()
        self._state_lock = threading.RLock()
        self._memory: "OrderedDict[str, Tuple[str, bytes]]" = OrderedDict()
        self._memory_bytes = 0
        self._generation = 0
        self._clearing = False
        with self._disk_lock:
            self._prune_to_quota_locked()

    @staticmethod
    def _cache_digest(url: str) -> str:
        return hashlib.sha256(url.encode("utf-8")).hexdigest()

    def _candidate_paths(self, url: str) -> List[Tuple[str, Path]]:
        digest = self._cache_digest(url)
        return [
            (mime_type, self.cache_directory / f"{digest}.{extension}")
            for mime_type, extension in ALLOWED_IMAGE_TYPES.items()
        ]

    @classmethod
    def _validate_download_result(cls, value: Any, max_bytes: int) -> Tuple[str, bytes]:
        if (
            not isinstance(value, tuple)
            or len(value) != 2
            or not isinstance(value[0], str)
            or not isinstance(value[1], bytes)
        ):
            raise ImageDownloadError("Steam returned an invalid image response")
        mime_type = value[0].split(";", 1)[0].strip().lower()
        body = value[1]
        if mime_type not in ALLOWED_IMAGE_TYPES:
            raise ImageDownloadError("Steam returned an unsupported image type")
        if not body or len(body) > max_bytes:
            raise ImageDownloadError("Steam image exceeds the download size limit")
        if not _image_type_matches(mime_type, body):
            raise ImageDownloadError("Steam image content does not match its type")
        _reject_animated_image(mime_type, body)
        width, height = _image_dimensions(mime_type, body)
        if (
            width <= 0
            or height <= 0
            or width > cls.MAX_IMAGE_DIMENSION
            or height > cls.MAX_IMAGE_DIMENSION
            or width * height > cls.MAX_IMAGE_PIXELS
        ):
            raise ImageDownloadError("Steam image exceeds the decoded pixel limit")
        return mime_type, body

    @classmethod
    def _download(cls, url: str, timeout: float, max_bytes: int) -> Tuple[str, bytes]:
        safe_url = canonical_image_url(url)
        request = urllib.request.Request(
            safe_url,
            headers={
                "Accept": "image/webp,image/png,image/jpeg,image/gif;q=0.8",
                "Accept-Encoding": "identity",
                "User-Agent": "GRIP/1.0 Steam-Deck local guide reader",
            },
            method="GET",
        )
        opener = urllib.request.build_opener(_SafeImageRedirectHandler())
        try:
            with opener.open(request, timeout=timeout) as response:
                try:
                    canonical_image_url(response.geturl())
                except ValueError as error:
                    raise ImageDownloadError(
                        "Steam returned an unsafe final image URL"
                    ) from error

                content_encoding = response.headers.get("Content-Encoding")
                if content_encoding and content_encoding.lower() != "identity":
                    raise ImageDownloadError(
                        "Steam returned an encoded image response"
                    )
                mime_type = response.headers.get_content_type().lower()
                if mime_type not in ALLOWED_IMAGE_TYPES:
                    raise ImageDownloadError(
                        "Steam returned an unsupported image type"
                    )
                length = response.headers.get("Content-Length")
                if length is not None:
                    try:
                        parsed_length = int(length)
                    except ValueError as error:
                        raise ImageDownloadError(
                            "Steam returned an invalid image Content-Length"
                        ) from error
                    if parsed_length < 0 or parsed_length > max_bytes:
                        raise ImageDownloadError(
                            "Steam image exceeds the download size limit"
                        )
                body = response.read(max_bytes + 1)
        except ImageDownloadError:
            raise
        except (
            OSError,
            urllib.error.URLError,
            http.client.HTTPException,
        ) as error:
            raise ImageDownloadError("Could not download the Steam image") from error
        return cls._validate_download_result((mime_type, body), max_bytes)

    def _directory_is_safe(self) -> bool:
        try:
            metadata = self.cache_directory.lstat()
        except FileNotFoundError:
            return False
        except OSError:
            return False
        return stat.S_ISDIR(metadata.st_mode)

    def _ensure_directory(self) -> None:
        self.cache_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = self.cache_directory.lstat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise OSError("image cache path is not a directory")
        os.chmod(self.cache_directory, 0o700, follow_symlinks=False)

    def _memory_get(self, url: str) -> Optional[Tuple[str, bytes]]:
        with self._state_lock:
            value = self._memory.pop(url, None)
            if value is None:
                return None
            self._memory[url] = value
            return value

    def _memory_store_locked(self, url: str, mime_type: str, body: bytes) -> None:
        old = self._memory.pop(url, None)
        if old is not None:
            self._memory_bytes -= len(old[1])
        if not self.max_memory_bytes or len(body) > self.max_memory_bytes:
            return
        self._memory[url] = (mime_type, body)
        self._memory_bytes += len(body)
        while self._memory_bytes > self.max_memory_bytes and self._memory:
            _, removed = self._memory.popitem(last=False)
            self._memory_bytes -= len(removed[1])

    def _store_memory_if_current(
        self,
        url: str,
        mime_type: str,
        body: bytes,
        generation: int,
    ) -> None:
        with self._state_lock:
            if self._generation != generation or self._clearing:
                return
            self._memory_store_locked(url, mime_type, body)

    def _read_candidate_locked(
        self, path: Path, mime_type: str
    ) -> Optional[Tuple[str, bytes]]:
        descriptor = -1
        try:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(str(path), flags)
            metadata = os.fstat(descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_size <= 0
                or metadata.st_size > self.max_image_bytes
            ):
                raise OSError("invalid cached image file")
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = -1
                body = stream.read(self.max_image_bytes + 1)
            if len(body) != metadata.st_size:
                raise OSError("invalid cached image content")
            try:
                self._validate_download_result(
                    (mime_type, body), self.max_image_bytes
                )
            except ImageDownloadError as error:
                raise OSError("invalid cached image content") from error
        except (FileNotFoundError, OSError):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            try:
                path.unlink()
            except OSError:
                pass
            return None
        try:
            now_ns = time.time_ns()
            os.utime(path, ns=(now_ns, now_ns), follow_symlinks=False)
        except OSError:
            pass
        return mime_type, body

    def _read_disk(self, url: str) -> Optional[Tuple[str, bytes]]:
        with self._disk_lock:
            if not self._directory_is_safe():
                return None
            for mime_type, path in self._candidate_paths(url):
                value = self._read_candidate_locked(path, mime_type)
                if value is not None:
                    return value
        return None

    def _managed_entries_locked(self) -> List[Tuple[int, int, Path]]:
        if not self._directory_is_safe():
            return []
        entries: List[Tuple[int, int, Path]] = []
        try:
            iterator = os.scandir(self.cache_directory)
        except OSError:
            return entries
        with iterator:
            for entry in iterator:
                if CACHE_FILE_PATTERN.fullmatch(entry.name) is None:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    continue
                entries.append(
                    (metadata.st_mtime_ns, metadata.st_size, Path(entry.path))
                )
        return entries

    def _prune_to_quota_locked(self) -> None:
        entries = sorted(
            self._managed_entries_locked(),
            key=lambda entry: (entry[0], entry[2].name),
        )
        total = sum(entry[1] for entry in entries)
        for _, size, path in list(entries):
            if size <= self.max_image_bytes:
                continue
            try:
                path.unlink()
            except OSError:
                continue
            total -= size
            entries.remove((_, size, path))
        while total > self.max_disk_bytes and entries:
            _, size, path = entries.pop(0)
            try:
                path.unlink()
            except OSError:
                continue
            total -= size

        if not self._directory_is_safe():
            return
        try:
            iterator = os.scandir(self.cache_directory)
        except OSError:
            return
        with iterator:
            for entry in iterator:
                if TEMP_FILE_PATTERN.fullmatch(entry.name) is None:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    continue
                try:
                    os.unlink(entry.path)
                except OSError:
                    pass

    def _write_disk(
        self,
        url: str,
        mime_type: str,
        body: bytes,
        generation: int,
    ) -> bool:
        if not self.max_disk_bytes or len(body) > self.max_disk_bytes:
            return False
        digest = self._cache_digest(url)
        target = self.cache_directory / (
            f"{digest}.{ALLOWED_IMAGE_TYPES[mime_type]}"
        )
        replacing = {
            path.name for _, path in self._candidate_paths(url)
        }
        descriptor = -1
        temporary_name = ""
        with self._disk_lock:
            with self._state_lock:
                if self._generation != generation or self._clearing:
                    return False
            try:
                self._ensure_directory()
                entries = self._managed_entries_locked()
                total = sum(
                    size
                    for _, size, path in entries
                    if path.name not in replacing
                )
                candidates = sorted(
                    (entry for entry in entries if entry[2].name not in replacing),
                    key=lambda entry: (entry[0], entry[2].name),
                )
                while total + len(body) > self.max_disk_bytes and candidates:
                    _, size, path = candidates.pop(0)
                    try:
                        path.unlink()
                    except OSError:
                        continue
                    total -= size
                if total + len(body) > self.max_disk_bytes:
                    return False

                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f".{digest}.",
                    suffix=".tmp",
                    dir=str(self.cache_directory),
                )
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    descriptor = -1
                    stream.write(body)
                    stream.flush()
                    os.fsync(stream.fileno())
                with self._state_lock:
                    if self._generation != generation or self._clearing:
                        return False
                os.replace(temporary_name, target)
                temporary_name = ""
                for _, candidate in self._candidate_paths(url):
                    if candidate != target:
                        try:
                            candidate.unlink()
                        except OSError:
                            pass
                try:
                    directory_descriptor = os.open(
                        str(self.cache_directory),
                        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
                    )
                    try:
                        os.fsync(directory_descriptor)
                    finally:
                        os.close(directory_descriptor)
                except OSError:
                    pass
                return True
            except OSError:
                return False
            finally:
                if descriptor >= 0:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
                if temporary_name:
                    try:
                        os.unlink(temporary_name)
                    except OSError:
                        pass

    @staticmethod
    def _response(
        mime_type: str, body: bytes, *, from_cache: bool
    ) -> Dict[str, Any]:
        width, height = _image_dimensions(mime_type, body)
        return {
            "mimeType": mime_type,
            "base64": base64.b64encode(body).decode("ascii"),
            "fromCache": from_cache,
            "width": width,
            "height": height,
        }

    def get(
        self, url: str, allow_download: bool = True
    ) -> Optional[Dict[str, Any]]:
        normalized_url = canonical_image_url(url)
        if type(allow_download) is not bool:
            raise ValueError("allow_download must be a boolean")

        entry = self._key_locks.retain(normalized_url)
        try:
            with entry.lock:
                value = self._memory_get(normalized_url)
                if value is not None:
                    return self._response(*value, from_cache=True)

                with self._state_lock:
                    generation = self._generation
                value = self._read_disk(normalized_url)
                if value is not None:
                    self._store_memory_if_current(
                        normalized_url, value[0], value[1], generation
                    )
                    return self._response(*value, from_cache=True)
                if not allow_download:
                    return None

                try:
                    downloaded = self._fetcher(
                        normalized_url,
                        self.REQUEST_TIMEOUT_SECONDS,
                        self.max_image_bytes,
                    )
                    mime_type, body = self._validate_download_result(
                        downloaded, self.max_image_bytes
                    )
                except (
                    ImageDownloadError,
                    OSError,
                    urllib.error.URLError,
                    http.client.HTTPException,
                ):
                    return None
                self._write_disk(
                    normalized_url, mime_type, body, generation
                )
                self._store_memory_if_current(
                    normalized_url, mime_type, body, generation
                )
                return self._response(
                    mime_type, body, from_cache=False
                )
        finally:
            self._key_locks.release(normalized_url, entry)

    def clear(self) -> Dict[str, int]:
        with self._state_lock:
            self._generation += 1
            self._clearing = True
            self._memory.clear()
            self._memory_bytes = 0

        files_removed = 0
        bytes_removed = 0
        try:
            with self._disk_lock:
                for _, size, path in self._managed_entries_locked():
                    try:
                        path.unlink()
                    except OSError:
                        continue
                    files_removed += 1
                    bytes_removed += size
        finally:
            with self._state_lock:
                self._memory.clear()
                self._memory_bytes = 0
                self._clearing = False
        return {
            "filesRemoved": files_removed,
            "bytesRemoved": bytes_removed,
        }

    def stats(self) -> Dict[str, int]:
        with self._state_lock:
            memory_entries = len(self._memory)
            memory_bytes = self._memory_bytes
        with self._disk_lock:
            entries = self._managed_entries_locked()
        return {
            "files": len(entries),
            "diskBytes": sum(entry[1] for entry in entries),
            "diskLimitBytes": self.max_disk_bytes,
            "memoryEntries": memory_entries,
            "memoryBytes": memory_bytes,
            "memoryLimitBytes": self.max_memory_bytes,
        }
