"""Safe Steam Community guide download, cache, and reader bookmarks."""

from __future__ import annotations

import html
import http.client
import json
import math
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from grip_html_parser import HTMLParser


GUIDE_ID_PATTERN = re.compile(r"^[1-9][0-9]{0,19}$")
GUIDE_KEY_PATTERN = re.compile(r"^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}$")
SECTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONTROL_CHARACTER_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

GUIDE_CACHE_SCHEMA_VERSION = 1
READER_POSITION_SCHEMA_VERSION = 1


class GuideReaderError(RuntimeError):
    """Base class for guide reader failures safe to surface to the UI."""


class GuideDownloadError(GuideReaderError):
    """Raised when a Steam Community guide could not be downloaded safely."""


class GuideParseError(GuideReaderError):
    """Raised when a response is not a usable Steam Community guide."""


class GuideCacheError(GuideReaderError):
    """Raised when a guide cache entry is corrupt or cannot be replaced."""


class ReaderPositionError(GuideReaderError):
    """Raised when the independent reader position store is invalid."""


def _validate_guide_id(guide_id: Any) -> str:
    if not isinstance(guide_id, str) or not GUIDE_ID_PATTERN.fullmatch(guide_id):
        raise ValueError("guide_id must be a positive decimal string")
    return guide_id


def _validate_guide_key(guide_key: Any) -> str:
    if not isinstance(guide_key, str) or not GUIDE_KEY_PATTERN.fullmatch(guide_key):
        raise ValueError("guide_key must have the form <app_id>:<guide_id>")
    return guide_key


def _is_allowed_host(hostname: Optional[str], suffixes: Sequence[str]) -> bool:
    if not hostname:
        return False
    normalized = hostname.rstrip(".").lower()
    return any(
        normalized == suffix or normalized.endswith(f".{suffix}")
        for suffix in suffixes
    )


def _safe_url(value: str, *, image: bool) -> Optional[str]:
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() != "https"
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        return None
    allowed_hosts = (
        ("steamstatic.com", "steamusercontent.com")
        if image
        else (
            "steamcommunity.com",
            "steampowered.com",
            "steamstatic.com",
            "steamusercontent.com",
        )
    )
    if not _is_allowed_host(parsed.hostname, allowed_hosts):
        return None
    return urllib.parse.urlunsplit(parsed)


class _FragmentSanitizer(HTMLParser):
    """Canonical allowlist sanitizer for the small HTML subset guides use."""

    VOID_TAGS = {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
    DROP_CONTENT_TAGS = {
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "form",
        "svg",
        "math",
        "template",
    }
    ALLOWED_TAGS = {
        "a",
        "b",
        "blockquote",
        "br",
        "code",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "i",
        "img",
        "li",
        "ol",
        "p",
        "pre",
        "s",
        "span",
        "strike",
        "strong",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "u",
        "ul",
    }
    ALLOWED_CLASSES = {
        "bb_blockquote",
        "bb_code",
        "bb_h1",
        "bb_h2",
        "bb_h3",
        "bb_h4",
        "bb_h5",
        "bb_h6",
        "bb_img",
        "bb_link",
        "bb_ol",
        "bb_table",
        "bb_table_td",
        "bb_table_th",
        "bb_table_tr",
        "bb_ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: List[str] = []
        self._stack: List[Tuple[str, bool]] = []
        self._drop_depth = 0

    @staticmethod
    def _serialize_attributes(
        tag: str, attributes: Sequence[Tuple[str, Optional[str]]]
    ) -> Optional[str]:
        values: Dict[str, str] = {
            name.lower(): value
            for name, value in attributes
            if value is not None
        }
        serialized: List[Tuple[str, str]] = []

        classes = [
            token
            for token in values.get("class", "").split()
            if token in _FragmentSanitizer.ALLOWED_CLASSES
        ]
        if classes:
            serialized.append(("class", " ".join(sorted(set(classes)))))

        for name in ("title", "alt"):
            value = values.get(name)
            if value is not None and len(value) <= 1_024:
                serialized.append((name, value))

        for name in ("width", "height", "colspan", "rowspan"):
            value = values.get(name)
            if value and value.isdecimal() and 0 < int(value) <= 16_384:
                serialized.append((name, str(int(value))))

        if tag == "img":
            source = values.get("src")
            safe_source = _safe_url(source, image=True) if source else None
            if not safe_source:
                return None
            serialized.extend((("loading", "lazy"), ("src", safe_source)))

        return "".join(
            f' {name}="{html.escape(value, quote=True)}"'
            for name, value in sorted(serialized)
        )

    def handle_starttag(
        self, tag: str, attrs: List[Tuple[str, Optional[str]]]
    ) -> None:
        normalized = tag.lower()
        if self._drop_depth:
            if (
                normalized in self.DROP_CONTENT_TAGS
                and normalized not in self.VOID_TAGS
            ):
                self._drop_depth += 1
            if normalized not in self.VOID_TAGS:
                self._stack.append((normalized, False))
            return
        if normalized in self.DROP_CONTENT_TAGS:
            if normalized in self.VOID_TAGS:
                return
            self._drop_depth = 1
            self._stack.append((normalized, False))
            return

        emitted = normalized in self.ALLOWED_TAGS
        serialized = self._serialize_attributes(normalized, attrs) if emitted else ""
        if emitted and serialized is not None:
            self._parts.append(f"<{normalized}{serialized}>")
        else:
            emitted = False
        if normalized not in self.VOID_TAGS:
            self._stack.append((normalized, emitted))

    def handle_startendtag(
        self, tag: str, attrs: List[Tuple[str, Optional[str]]]
    ) -> None:
        self.handle_starttag(tag, attrs)
        normalized = tag.lower()
        if normalized not in self.VOID_TAGS:
            self.handle_endtag(normalized)

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.lower()
        match_index = next(
            (
                index
                for index in range(len(self._stack) - 1, -1, -1)
                if self._stack[index][0] == normalized
            ),
            None,
        )
        if match_index is None:
            return
        unwound = self._stack[match_index:]
        del self._stack[match_index:]
        if self._drop_depth:
            self._drop_depth = max(
                0,
                self._drop_depth
                - sum(1 for open_tag, _emitted in unwound if open_tag in self.DROP_CONTENT_TAGS),
            )
            return
        for open_tag, emitted in reversed(unwound):
            if emitted:
                self._parts.append(f"</{open_tag}>")

    def handle_data(self, data: str) -> None:
        if not self._drop_depth:
            self._parts.append(html.escape(data, quote=False))

    def finish(self) -> str:
        if not self._drop_depth:
            for tag, emitted in reversed(self._stack):
                if emitted:
                    self._parts.append(f"</{tag}>")
        self._stack.clear()
        self._drop_depth = 0
        return "".join(self._parts).strip()


def sanitize_fragment(fragment: str) -> str:
    if not isinstance(fragment, str):
        raise TypeError("guide HTML fragment must be a string")
    sanitizer = _FragmentSanitizer()
    try:
        sanitizer.feed(fragment)
        sanitizer.close()
    except Exception as error:  # pragma: no cover - tokenizer is deliberately tolerant
        raise GuideParseError("guide contains malformed HTML") from error
    return sanitizer.finish()


class _GuidePageParser(HTMLParser):
    MAX_SECTIONS = 512

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._stack: List[str] = []
        self._title_depth: Optional[int] = None
        self._author_depth: Optional[int] = None
        self._section_root_depth: Optional[int] = None
        self._section_title_depth: Optional[int] = None
        self._section_description_depth: Optional[int] = None
        self._title_parts: List[str] = []
        self._author_parts: List[str] = []
        self._section: Optional[Dict[str, Any]] = None
        self._section_title_parts: List[str] = []
        self._sanitizer: Optional[_FragmentSanitizer] = None
        self.title = ""
        self.author = ""
        self.sections: List[Dict[str, str]] = []

    @staticmethod
    def _attribute_map(
        attributes: Sequence[Tuple[str, Optional[str]]]
    ) -> Mapping[str, str]:
        return {
            name.lower(): value
            for name, value in attributes
            if value is not None
        }

    @staticmethod
    def _classes(attributes: Mapping[str, str]) -> set[str]:
        return set(attributes.get("class", "").split())

    @staticmethod
    def _normalize_text(parts: Sequence[str]) -> str:
        return " ".join("".join(parts).split())

    def handle_starttag(
        self, tag: str, attrs: List[Tuple[str, Optional[str]]]
    ) -> None:
        normalized = tag.lower()
        depth = len(self._stack)
        attributes = self._attribute_map(attrs)
        classes = self._classes(attributes)

        if (
            self._section is None
            and normalized == "div"
            and "subSection" in classes
            and GUIDE_ID_PATTERN.fullmatch(attributes.get("id", ""))
        ):
            if len(self.sections) >= self.MAX_SECTIONS:
                raise GuideParseError("guide contains too many sections")
            self._section = {"id": attributes["id"]}
            self._section_root_depth = depth

        if self._title_depth is None and "workshopItemTitle" in classes:
            self._title_depth = depth
            self._title_parts = []
        if self._author_depth is None and "guideAuthors" in classes:
            self._author_depth = depth
            self._author_parts = []

        if self._section is not None:
            if (
                self._section_title_depth is None
                and "subSectionTitle" in classes
            ):
                self._section_title_depth = depth
                self._section_title_parts = []
            elif (
                self._section_description_depth is None
                and "subSectionDesc" in classes
            ):
                self._section_description_depth = depth
                self._sanitizer = _FragmentSanitizer()
            elif (
                self._section_description_depth is not None
                and depth > self._section_description_depth
                and self._sanitizer is not None
            ):
                self._sanitizer.handle_starttag(normalized, attrs)

        if normalized not in _FragmentSanitizer.VOID_TAGS:
            self._stack.append(normalized)

    def handle_startendtag(
        self, tag: str, attrs: List[Tuple[str, Optional[str]]]
    ) -> None:
        self.handle_starttag(tag, attrs)
        normalized = tag.lower()
        if normalized not in _FragmentSanitizer.VOID_TAGS:
            self.handle_endtag(normalized)

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.lower()
        if normalized in _FragmentSanitizer.VOID_TAGS:
            return
        match_index = next(
            (
                index
                for index in range(len(self._stack) - 1, -1, -1)
                if self._stack[index] == normalized
            ),
            None,
        )
        if match_index is None:
            return
        depth = match_index

        if (
            self._section_description_depth is not None
            and depth > self._section_description_depth
            and self._sanitizer is not None
        ):
            self._sanitizer.handle_endtag(normalized)
        elif depth == self._section_description_depth:
            assert self._section is not None
            assert self._sanitizer is not None
            self._section["html"] = self._sanitizer.finish()
            self._sanitizer = None
            self._section_description_depth = None

        if depth == self._section_title_depth:
            assert self._section is not None
            self._section["title"] = self._normalize_text(self._section_title_parts)
            self._section_title_parts = []
            self._section_title_depth = None
        if depth == self._title_depth:
            self.title = self._normalize_text(self._title_parts)
            self._title_parts = []
            self._title_depth = None
        if depth == self._author_depth:
            author = self._normalize_text(self._author_parts)
            self.author = re.sub(r"^By\s+", "", author, flags=re.IGNORECASE)
            self._author_parts = []
            self._author_depth = None

        if depth == self._section_root_depth:
            assert self._section is not None
            section = self._section
            if section.get("title") and section.get("html") is not None:
                self.sections.append(
                    {
                        "id": section["id"],
                        "title": section["title"],
                        "html": section["html"],
                    }
                )
            self._section = None
            self._section_root_depth = None
            self._section_title_depth = None
            self._section_description_depth = None
            self._sanitizer = None

        del self._stack[match_index:]

    def handle_data(self, data: str) -> None:
        depth = len(self._stack) - 1
        if self._title_depth is not None and depth >= self._title_depth:
            self._title_parts.append(data)
        if self._author_depth is not None and depth >= self._author_depth:
            self._author_parts.append(data)
        if (
            self._section_title_depth is not None
            and depth >= self._section_title_depth
        ):
            self._section_title_parts.append(data)
        if self._section_description_depth is not None and self._sanitizer:
            self._sanitizer.handle_data(data)


def parse_guide_html(guide_id: str, source: str) -> Dict[str, Any]:
    normalized_guide_id = _validate_guide_id(guide_id)
    if not isinstance(source, str):
        raise TypeError("guide source must be text")
    parser = _GuidePageParser()
    try:
        parser.feed(source)
        parser.close()
    except GuideParseError:
        raise
    except Exception as error:
        raise GuideParseError("Steam returned malformed guide HTML") from error
    if not parser.title or not parser.author or not parser.sections:
        raise GuideParseError(
            "Steam guide content was unavailable or its page format changed"
        )
    return {
        "guideId": normalized_guide_id,
        "title": parser.title,
        "author": parser.author,
        "sourceUrl": GuideReader.source_url(normalized_guide_id),
        "sections": parser.sections,
    }


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802
        try:
            parsed = urllib.parse.urlsplit(newurl)
            port = parsed.port
        except ValueError as error:
            raise GuideDownloadError(
                "Steam redirected the guide to an unsafe URL"
            ) from error
        if (
            parsed.scheme.lower() != "https"
            or parsed.username
            or parsed.password
            or port not in (None, 443)
            or not _is_allowed_host(parsed.hostname, ("steamcommunity.com",))
        ):
            raise GuideDownloadError("Steam redirected the guide to an unsafe URL")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


Fetcher = Callable[[str, float, int], bytes]
CacheFileSignature = Tuple[int, int, int, int, int]


class GuideReader:
    MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024
    MAX_CACHE_BYTES = 20 * 1024 * 1024
    REQUEST_TIMEOUT_SECONDS = 12.0
    CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1_000

    def __init__(
        self,
        cache_directory: Path,
        *,
        fetcher: Optional[Fetcher] = None,
        now_ms: Optional[Callable[[], int]] = None,
    ) -> None:
        self.cache_directory = Path(cache_directory)
        self._fetcher = fetcher or self._download
        self._now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._lock = threading.RLock()
        self._cache_memo: Dict[
            str, Tuple[CacheFileSignature, Dict[str, Any]]
        ] = {}

    @staticmethod
    def source_url(guide_id: str) -> str:
        normalized = _validate_guide_id(guide_id)
        return (
            "https://steamcommunity.com/sharedfiles/filedetails/"
            f"?id={normalized}&l=schinese"
        )

    @classmethod
    def _download(cls, url: str, timeout: float, max_bytes: int) -> bytes:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
                "User-Agent": "GRIP/1.0 Steam-Deck local guide reader",
            },
            method="GET",
        )
        opener = urllib.request.build_opener(_SafeRedirectHandler())
        try:
            with opener.open(request, timeout=timeout) as response:
                final_url = response.geturl()
                try:
                    final = urllib.parse.urlsplit(final_url)
                    final_port = final.port
                except ValueError as error:
                    raise GuideDownloadError(
                        "Steam returned an unsafe final URL"
                    ) from error
                if (
                    final.scheme.lower() != "https"
                    or final.username
                    or final.password
                    or final_port not in (None, 443)
                    or not _is_allowed_host(
                        final.hostname, ("steamcommunity.com",)
                    )
                ):
                    raise GuideDownloadError("Steam returned an unsafe final URL")
                content_type = response.headers.get_content_type().lower()
                if content_type not in ("text/html", "application/xhtml+xml"):
                    raise GuideDownloadError("Steam returned a non-HTML response")
                length = response.headers.get("Content-Length")
                if length is not None:
                    try:
                        if int(length) > max_bytes:
                            raise GuideDownloadError(
                                "Steam guide exceeds the download size limit"
                            )
                    except ValueError as error:
                        raise GuideDownloadError(
                            "Steam returned an invalid Content-Length"
                        ) from error
                body = response.read(max_bytes + 1)
        except GuideDownloadError:
            raise
        except (
            OSError,
            urllib.error.URLError,
            http.client.HTTPException,
        ) as error:
            raise GuideDownloadError("Could not download the Steam guide") from error
        if len(body) > max_bytes:
            raise GuideDownloadError("Steam guide exceeds the download size limit")
        return body

    def _cache_path(self, guide_id: str) -> Path:
        return self.cache_directory / f"{_validate_guide_id(guide_id)}.json"

    @staticmethod
    def _cache_file_signature(metadata: os.stat_result) -> CacheFileSignature:
        return (
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        )

    def _stat_cache_file(self, path: Path) -> Optional[CacheFileSignature]:
        try:
            metadata = path.stat()
        except FileNotFoundError:
            return None
        except OSError as error:
            raise GuideCacheError("cached guide could not be inspected") from error
        if metadata.st_size > self.MAX_CACHE_BYTES:
            raise GuideCacheError("cached guide exceeds the size limit")
        return self._cache_file_signature(metadata)

    def _validate_cached_document(
        self, guide_id: str, value: Any
    ) -> Dict[str, Any]:
        if not isinstance(value, dict) or set(value) != {
            "schemaVersion",
            "guideId",
            "title",
            "author",
            "sourceUrl",
            "fetchedAt",
            "sections",
        }:
            raise GuideCacheError("cached guide has unknown or missing fields")
        if type(value["schemaVersion"]) is not int or value["schemaVersion"] != GUIDE_CACHE_SCHEMA_VERSION:
            raise GuideCacheError("cached guide uses an unsupported schema")
        if value["guideId"] != guide_id:
            raise GuideCacheError("cached guide id does not match its file name")
        if value["sourceUrl"] != self.source_url(guide_id):
            raise GuideCacheError("cached guide contains an invalid source URL")
        for field in ("title", "author"):
            if (
                not isinstance(value[field], str)
                or not value[field]
                or len(value[field]) > 4_096
                or CONTROL_CHARACTER_PATTERN.search(value[field])
            ):
                raise GuideCacheError(f"cached guide contains an invalid {field}")
        if (
            type(value["fetchedAt"]) is not int
            or value["fetchedAt"] < 0
            or value["fetchedAt"] > self._now_ms() + 24 * 60 * 60 * 1_000
        ):
            raise GuideCacheError("cached guide contains an invalid timestamp")
        sections = value["sections"]
        if not isinstance(sections, list) or not sections or len(sections) > 512:
            raise GuideCacheError("cached guide contains invalid sections")
        normalized_sections: List[Dict[str, str]] = []
        identifiers: set[str] = set()
        for section in sections:
            if not isinstance(section, dict) or set(section) != {"id", "title", "html"}:
                raise GuideCacheError("cached guide contains an invalid section")
            section_id = section["id"]
            title = section["title"]
            fragment = section["html"]
            if (
                not isinstance(section_id, str)
                or not GUIDE_ID_PATTERN.fullmatch(section_id)
                or section_id in identifiers
            ):
                raise GuideCacheError("cached guide contains an invalid section id")
            if not isinstance(title, str) or not title or len(title) > 4_096:
                raise GuideCacheError("cached guide contains an invalid section title")
            if not isinstance(fragment, str) or len(fragment.encode("utf-8")) > self.MAX_DOWNLOAD_BYTES:
                raise GuideCacheError("cached guide contains invalid section HTML")
            if sanitize_fragment(fragment) != fragment:
                raise GuideCacheError("cached guide contains unsafe section HTML")
            identifiers.add(section_id)
            normalized_sections.append(
                {"id": section_id, "title": title, "html": fragment}
            )
        return {
            "schemaVersion": GUIDE_CACHE_SCHEMA_VERSION,
            "guideId": guide_id,
            "title": value["title"],
            "author": value["author"],
            "sourceUrl": value["sourceUrl"],
            "fetchedAt": value["fetchedAt"],
            "sections": normalized_sections,
        }

    def _read_cache(self, guide_id: str) -> Optional[Dict[str, Any]]:
        path = self._cache_path(guide_id)
        for attempt in range(2):
            signature = self._stat_cache_file(path)
            if signature is None:
                self._cache_memo.pop(guide_id, None)
                return None

            memoized = self._cache_memo.get(guide_id)
            if memoized is not None and memoized[0] == signature:
                return memoized[1]

            try:
                with path.open("r", encoding="utf-8") as stream:
                    document = self._validate_cached_document(
                        guide_id, json.load(stream)
                    )
            except GuideCacheError:
                self._cache_memo.pop(guide_id, None)
                raise
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                self._cache_memo.pop(guide_id, None)
                raise GuideCacheError("cached guide could not be read") from error

            final_signature = self._stat_cache_file(path)
            if final_signature == signature:
                self._cache_memo[guide_id] = (signature, document)
                return document
            self._cache_memo.pop(guide_id, None)
            if attempt == 1:
                raise GuideCacheError("cached guide changed while being read")

        raise AssertionError("unreachable cache read state")

    def _write_cache(self, document: Mapping[str, Any]) -> None:
        payload = json.dumps(
            document,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
        if len(payload.encode("utf-8")) > self.MAX_CACHE_BYTES:
            raise GuideCacheError("cached guide would exceed the size limit")
        try:
            self.cache_directory.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=".guide-", suffix=".tmp", dir=str(self.cache_directory)
            )
        except OSError as error:
            raise GuideCacheError("could not create a guide cache file") from error
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                descriptor = -1
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            cache_path = self._cache_path(document["guideId"])
            os.replace(temporary_name, cache_path)
            temporary_name = ""
        except OSError as error:
            raise GuideCacheError("could not atomically replace guide cache") from error
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
        directory_descriptor = -1
        try:
            directory_descriptor = os.open(
                str(self.cache_directory),
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
            os.fsync(directory_descriptor)
        except OSError as error:
            raise GuideCacheError(
                "guide cache was replaced but its directory could not be synced"
            ) from error
        finally:
            if directory_descriptor >= 0:
                try:
                    os.close(directory_descriptor)
                except OSError:
                    pass
        try:
            signature = self._stat_cache_file(cache_path)
        except GuideCacheError:
            self._cache_memo.pop(document["guideId"], None)
        else:
            if signature is not None:
                self._cache_memo[document["guideId"]] = (signature, dict(document))

    @staticmethod
    def _with_cache_status(
        document: Mapping[str, Any], *, from_cache: bool, stale: bool
    ) -> Dict[str, Any]:
        result = {
            key: value
            for key, value in document.items()
            if key not in {"schemaVersion", "sections"}
        }
        result["sections"] = [dict(section) for section in document["sections"]]
        result["fromCache"] = from_cache
        result["stale"] = stale
        return result

    def get(self, guide_id: str, force_refresh: bool = False) -> Dict[str, Any]:
        normalized_guide_id = _validate_guide_id(guide_id)
        if type(force_refresh) is not bool:
            raise ValueError("force_refresh must be a boolean")
        with self._lock:
            try:
                cached = self._read_cache(normalized_guide_id)
            except GuideCacheError:
                if not force_refresh:
                    raise
                cached = None
            now = self._now_ms()
            if cached is not None and not force_refresh:
                return self._with_cache_status(
                    cached,
                    from_cache=True,
                    stale=now - cached["fetchedAt"] > self.CACHE_MAX_AGE_MS,
                )

            try:
                try:
                    body = self._fetcher(
                        self.source_url(normalized_guide_id),
                        self.REQUEST_TIMEOUT_SECONDS,
                        self.MAX_DOWNLOAD_BYTES,
                    )
                except (GuideDownloadError, GuideParseError):
                    raise
                except (
                    OSError,
                    urllib.error.URLError,
                    http.client.HTTPException,
                ) as error:
                    raise GuideDownloadError(
                        "Could not download the Steam guide"
                    ) from error
                if not isinstance(body, bytes) or len(body) > self.MAX_DOWNLOAD_BYTES:
                    raise GuideDownloadError("Steam returned an invalid response body")
                try:
                    source = body.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise GuideDownloadError(
                        "Steam returned guide HTML that was not UTF-8"
                    ) from error
                parsed = parse_guide_html(normalized_guide_id, source)
                document = {
                    "schemaVersion": GUIDE_CACHE_SCHEMA_VERSION,
                    **parsed,
                    "fetchedAt": now,
                }
                validated = self._validate_cached_document(
                    normalized_guide_id, document
                )
                self._write_cache(validated)
                return self._with_cache_status(
                    validated, from_cache=False, stale=False
                )
            except (GuideDownloadError, GuideParseError):
                if cached is not None:
                    return self._with_cache_status(
                        cached, from_cache=True, stale=True
                    )
                raise


class ReaderPositionStore:
    MAX_FILE_BYTES = 4 * 1024 * 1024
    MAX_POSITIONS = 10_000
    MAX_SCROLL_TOP = 1_000_000_000.0
    MAX_ANCHOR_OFFSET = 1_000_000_000.0
    MAX_ANCHOR_TEXT = 512

    def __init__(
        self, path: Path, *, now_ms: Optional[Callable[[], int]] = None
    ) -> None:
        self.path = Path(path)
        self._now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._lock = threading.RLock()

    @staticmethod
    def _empty_document() -> Dict[str, Any]:
        return {"schema_version": READER_POSITION_SCHEMA_VERSION, "positions": {}}

    @classmethod
    def _validate_number(
        cls, label: str, value: Any, minimum: float, maximum: float
    ) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{label} must be a finite number")
        normalized = float(value)
        if not math.isfinite(normalized) or not minimum <= normalized <= maximum:
            raise ValueError(f"{label} must be a finite number in range")
        return normalized

    @staticmethod
    def _validate_section_id(value: Any) -> Optional[str]:
        if value is None:
            return None
        if not isinstance(value, str) or not SECTION_ID_PATTERN.fullmatch(value):
            raise ValueError("section_id is invalid")
        return value

    @classmethod
    def _validate_anchor_text(cls, value: Any) -> Optional[str]:
        if value is None:
            return None
        if (
            not isinstance(value, str)
            or not value
            or len(value) > cls.MAX_ANCHOR_TEXT
            or CONTROL_CHARACTER_PATTERN.search(value)
        ):
            raise ValueError("anchor_text is invalid")
        return value

    def _validate_position(self, value: Any, *, stored: bool) -> Dict[str, Any]:
        expected = {
            "scroll_top",
            "section_id",
            "anchor_text",
            "anchor_offset",
            "updated_at_ms",
        }
        if not isinstance(value, dict) or set(value) != expected:
            error = ReaderPositionError if stored else ValueError
            raise error("reader position contains unknown or missing fields")
        try:
            normalized = {
                "scroll_top": self._validate_number(
                    "scroll_top", value["scroll_top"], 0, self.MAX_SCROLL_TOP
                ),
                "section_id": self._validate_section_id(value["section_id"]),
                "anchor_text": self._validate_anchor_text(value["anchor_text"]),
                "anchor_offset": self._validate_number(
                    "anchor_offset",
                    value["anchor_offset"],
                    -self.MAX_ANCHOR_OFFSET,
                    self.MAX_ANCHOR_OFFSET,
                ),
            }
        except ValueError as error:
            if stored:
                raise ReaderPositionError("stored reader position is invalid") from error
            raise
        timestamp = value["updated_at_ms"]
        if type(timestamp) is not int or timestamp < 0:
            if stored:
                raise ReaderPositionError("stored reader timestamp is invalid")
            raise ValueError("updated_at_ms is invalid")
        normalized["updated_at_ms"] = timestamp
        return normalized

    def _read_document(self) -> Dict[str, Any]:
        if not self.path.exists():
            return self._empty_document()
        try:
            if self.path.stat().st_size > self.MAX_FILE_BYTES:
                raise ReaderPositionError("reader_positions.json exceeds the size limit")
            with self.path.open("r", encoding="utf-8") as stream:
                value = json.load(stream)
        except ReaderPositionError:
            raise
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ReaderPositionError("reader_positions.json could not be read") from error
        if not isinstance(value, dict) or set(value) != {"schema_version", "positions"}:
            raise ReaderPositionError(
                "reader_positions.json has unknown or missing fields"
            )
        if type(value["schema_version"]) is not int or value["schema_version"] != READER_POSITION_SCHEMA_VERSION:
            raise ReaderPositionError("reader_positions.json uses an unsupported schema")
        if not isinstance(value["positions"], dict) or len(value["positions"]) > self.MAX_POSITIONS:
            raise ReaderPositionError("reader_positions.json has invalid positions")
        positions: Dict[str, Dict[str, Any]] = {}
        for raw_key, raw_position in value["positions"].items():
            try:
                key = _validate_guide_key(raw_key)
            except ValueError as error:
                raise ReaderPositionError("reader_positions.json has an invalid key") from error
            positions[key] = self._validate_position(raw_position, stored=True)
        return {"schema_version": READER_POSITION_SCHEMA_VERSION, "positions": positions}

    def _write_document(self, document: Mapping[str, Any]) -> None:
        payload = json.dumps(
            document,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ) + "\n"
        if len(payload.encode("utf-8")) > self.MAX_FILE_BYTES:
            raise ReaderPositionError("reader_positions.json would exceed the size limit")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=".reader-positions-", suffix=".tmp", dir=str(self.path.parent)
            )
        except OSError as error:
            raise ReaderPositionError(
                "could not create a reader position file"
            ) from error
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                descriptor = -1
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, self.path)
            temporary_name = ""
        except OSError as error:
            raise ReaderPositionError(
                "could not atomically replace reader_positions.json"
            ) from error
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
        directory_descriptor = -1
        try:
            directory_descriptor = os.open(
                str(self.path.parent),
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
            os.fsync(directory_descriptor)
        except OSError as error:
            raise ReaderPositionError(
                "reader_positions.json was replaced but its directory could not be synced"
            ) from error
        finally:
            if directory_descriptor >= 0:
                try:
                    os.close(directory_descriptor)
                except OSError:
                    pass

    def get(self, guide_key: str) -> Optional[Dict[str, Any]]:
        key = _validate_guide_key(guide_key)
        with self._lock:
            value = self._read_document()["positions"].get(key)
            return None if value is None else dict(value)

    def save(
        self,
        guide_key: str,
        scroll_top: float,
        section_id: Optional[str],
        anchor_text: Optional[str],
        anchor_offset: float,
    ) -> Dict[str, Any]:
        key = _validate_guide_key(guide_key)
        position = self._validate_position(
            {
                "scroll_top": scroll_top,
                "section_id": section_id,
                "anchor_text": anchor_text,
                "anchor_offset": anchor_offset,
                "updated_at_ms": self._now_ms(),
            },
            stored=False,
        )
        with self._lock:
            document = self._read_document()
            document["positions"][key] = position
            if len(document["positions"]) > self.MAX_POSITIONS:
                raise ReaderPositionError("reader position limit reached")
            self._write_document(document)
            return dict(position)
