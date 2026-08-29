"""Safe Steam Community guide download, cache, and reader bookmarks."""

from __future__ import annotations

import html
import http.client
import json
import math
import os
import re
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from grip_html_parser import HTMLParser
from guide_images import GuideImageCache, canonical_image_url
from store_repair import (
    FileSignature,
    ManagedFileChangedError,
    ManagedFileTooLargeError,
    backup_corrupt_file,
    read_bounded_regular_file,
)


GUIDE_ID_PATTERN = re.compile(r"^[1-9][0-9]{0,19}$")
GUIDE_KEY_PATTERN = re.compile(r"^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}$")
SECTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CONTROL_CHARACTER_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

GUIDE_CACHE_SCHEMA_VERSION = 1
READER_POSITION_SCHEMA_VERSION = 1
JAVASCRIPT_MAX_SAFE_INTEGER = (1 << 53) - 1


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
    if image:
        try:
            return canonical_image_url(value)
        except ValueError:
            return None
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
        "steamcommunity.com",
        "steampowered.com",
        "steamstatic.com",
        "steamusercontent.com",
    )
    if not _is_allowed_host(parsed.hostname, allowed_hosts):
        return None
    return urllib.parse.urlunsplit(parsed)


class _FragmentSanitizer(HTMLParser):
    """Canonical allowlist sanitizer for the small HTML subset guides use."""

    # One sanitizer instance represents one guide section. Keep its limits well
    # below the whole-page budgets because the first rendered section is parsed
    # and mounted synchronously before progressive rendering can yield.
    MAX_NODES = 8_000
    MAX_DEPTH = 128
    MAX_TEXT_CHARS = 1 * 1024 * 1024
    MAX_OUTPUT_BYTES = 2 * 1024 * 1024

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
        self._open_counts: Dict[str, int] = {}
        self._drop_depth = 0
        self._node_count = 0
        self._text_chars = 0
        self._output_bytes = 0

    @property
    def node_count(self) -> int:
        return self._node_count

    @property
    def text_chars(self) -> int:
        return self._text_chars

    @property
    def output_bytes(self) -> int:
        return self._output_bytes

    def _record_node(self) -> None:
        self._node_count += 1
        if self._node_count > self.MAX_NODES:
            raise GuideParseError("guide HTML exceeds the node budget")

    def _record_text(self, data: str) -> None:
        self._text_chars += len(data)
        if self._text_chars > self.MAX_TEXT_CHARS:
            raise GuideParseError("guide HTML exceeds the text budget")

    def _append(self, part: str) -> None:
        self._output_bytes += len(part.encode("utf-8"))
        if self._output_bytes > self.MAX_OUTPUT_BYTES:
            raise GuideParseError("guide HTML exceeds the output budget")
        self._parts.append(part)

    def _push(self, tag: str, emitted: bool) -> None:
        if len(self._stack) >= self.MAX_DEPTH:
            raise GuideParseError("guide HTML exceeds the nesting depth budget")
        self._stack.append((tag, emitted))
        self._open_counts[tag] = self._open_counts.get(tag, 0) + 1

    def _pop(self) -> Tuple[str, bool]:
        tag, emitted = self._stack.pop()
        remaining = self._open_counts[tag] - 1
        if remaining:
            self._open_counts[tag] = remaining
        else:
            del self._open_counts[tag]
        return tag, emitted

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
        self._record_node()
        normalized = tag.lower()
        if self._drop_depth:
            if (
                normalized in self.DROP_CONTENT_TAGS
                and normalized not in self.VOID_TAGS
            ):
                self._drop_depth += 1
            if normalized not in self.VOID_TAGS:
                self._push(normalized, False)
            return
        if normalized in self.DROP_CONTENT_TAGS:
            if normalized in self.VOID_TAGS:
                return
            self._drop_depth = 1
            self._push(normalized, False)
            return

        emitted = normalized in self.ALLOWED_TAGS
        serialized = self._serialize_attributes(normalized, attrs) if emitted else ""
        if emitted and serialized is not None:
            self._append(f"<{normalized}{serialized}>")
        else:
            emitted = False
        if normalized not in self.VOID_TAGS:
            self._push(normalized, emitted)

    def handle_startendtag(
        self, tag: str, attrs: List[Tuple[str, Optional[str]]]
    ) -> None:
        self.handle_starttag(tag, attrs)
        normalized = tag.lower()
        if normalized not in self.VOID_TAGS:
            self.handle_endtag(normalized)

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.lower()
        if self._open_counts.get(normalized, 0) == 0:
            return
        while self._stack:
            open_tag, emitted = self._pop()
            if self._drop_depth:
                if open_tag in self.DROP_CONTENT_TAGS:
                    self._drop_depth -= 1
            elif emitted:
                self._append(f"</{open_tag}>")
            if open_tag == normalized:
                return

    def handle_data(self, data: str) -> None:
        if not data:
            return
        self._record_node()
        self._record_text(data)
        if not self._drop_depth:
            self._append(html.escape(data, quote=False))

    def finish(self) -> str:
        while self._stack:
            tag, emitted = self._pop()
            if self._drop_depth:
                if tag in self.DROP_CONTENT_TAGS:
                    self._drop_depth -= 1
            elif emitted:
                self._append(f"</{tag}>")
        self._drop_depth = 0
        return "".join(self._parts).strip()


def _sanitize_fragment_with_stats(
    fragment: str,
) -> Tuple[str, int, int, int]:
    if not isinstance(fragment, str):
        raise TypeError("guide HTML fragment must be a string")
    sanitizer = _FragmentSanitizer()
    try:
        sanitizer.feed(fragment)
        sanitizer.close()
    except GuideParseError:
        raise
    except Exception as error:  # pragma: no cover - tokenizer is deliberately tolerant
        raise GuideParseError("guide contains malformed HTML") from error
    result = sanitizer.finish()
    return (
        result,
        sanitizer.node_count,
        sanitizer.text_chars,
        sanitizer.output_bytes,
    )


def sanitize_fragment(fragment: str) -> str:
    return _sanitize_fragment_with_stats(fragment)[0]


class _ImageTagParser(HTMLParser):
    """Parse exactly one image tag before it is made network-inert."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.attributes: Optional[List[Tuple[str, Optional[str]]]] = None
        self.invalid = False

    def handle_starttag(
        self, tag: str, attrs: List[Tuple[str, Optional[str]]]
    ) -> None:
        if tag != "img" or self.attributes is not None:
            self.invalid = True
            return
        self.attributes = attrs

    def handle_startendtag(
        self, tag: str, attrs: List[Tuple[str, Optional[str]]]
    ) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, _tag: str) -> None:
        self.invalid = True

    def handle_data(self, data: str) -> None:
        if data:
            self.invalid = True


_IMAGE_TAG_START_PATTERN = re.compile(r"<img(?=\s|/?>)", re.IGNORECASE)
_LOCALIZED_IMAGE_ATTRIBUTES = {
    "alt",
    "class",
    "height",
    "loading",
    "src",
    "title",
    "width",
}


def _localized_image_tag(source: str) -> str:
    parser = _ImageTagParser()
    try:
        parser.feed(source)
        parser.close()
    except Exception:
        return ""
    attributes = parser.attributes
    if parser.invalid or attributes is None:
        return ""

    values: Dict[str, str] = {}
    for name, value in attributes:
        normalized_name = name.lower()
        if (
            normalized_name not in _LOCALIZED_IMAGE_ATTRIBUTES
            or normalized_name in values
            or value is None
        ):
            return ""
        values[normalized_name] = value
    if values.get("loading") != "lazy":
        return ""
    try:
        safe_source = canonical_image_url(values.get("src"))
    except ValueError:
        return ""

    classes = values.get("class")
    if classes is not None:
        tokens = classes.split()
        if (
            not tokens
            or any(
                token not in _FragmentSanitizer.ALLOWED_CLASSES
                for token in tokens
            )
        ):
            return ""
        values["class"] = " ".join(sorted(set(tokens)))
    for name in ("title", "alt"):
        if name in values and len(values[name]) > 1_024:
            return ""
    for name in ("width", "height"):
        value = values.get(name)
        if value is not None:
            if not value.isdecimal() or not 0 < int(value) <= 16_384:
                return ""
            values[name] = str(int(value))

    del values["src"]
    values["data-grip-image-url"] = safe_source
    return "<img" + "".join(
        f' {name}="{html.escape(value, quote=True)}"'
        for name, value in sorted(values.items())
    ) + ">"


def localize_guide_images(fragment: str) -> str:
    """Replace validated remote image sources with inert local-cache keys."""

    if not isinstance(fragment, str):
        raise TypeError("guide HTML fragment must be a string")
    parts: List[str] = []
    offset = 0
    while True:
        match = _IMAGE_TAG_START_PATTERN.search(fragment, offset)
        if match is None:
            parts.append(fragment[offset:])
            break
        parts.append(fragment[offset : match.start()])
        quote: Optional[str] = None
        end: Optional[int] = None
        for index in range(match.end(), len(fragment)):
            character = fragment[index]
            if quote is not None:
                if character == quote:
                    quote = None
            elif character in ('"', "'"):
                quote = character
            elif character == ">":
                end = index + 1
                break
        if end is None:
            break
        parts.append(_localized_image_tag(fragment[match.start() : end]))
        offset = end
    return "".join(parts)


class _GuidePageParser(HTMLParser):
    MAX_SECTIONS = 512
    MAX_NODES = 200_000
    MAX_DEPTH = 128
    MAX_TEXT_CHARS = 8 * 1024 * 1024
    MAX_LABEL_CHARS = 4_096
    MAX_SANITIZED_HTML_BYTES = 12 * 1024 * 1024

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._stack: List[str] = []
        self._open_counts: Dict[str, int] = {}
        self._title_depth: Optional[int] = None
        self._author_depth: Optional[int] = None
        self._section_root_depth: Optional[int] = None
        self._section_title_depth: Optional[int] = None
        self._section_description_depth: Optional[int] = None
        self._title_parts: List[str] = []
        self._author_parts: List[str] = []
        self._title_chars = 0
        self._author_chars = 0
        self._section: Optional[Dict[str, Any]] = None
        self._section_title_parts: List[str] = []
        self._section_title_chars = 0
        self._sanitizer: Optional[_FragmentSanitizer] = None
        self._node_count = 0
        self._text_chars = 0
        self._sanitized_html_bytes = 0
        self.title = ""
        self.author = ""
        self.sections: List[Dict[str, str]] = []

    def _record_node(self) -> None:
        self._node_count += 1
        if self._node_count > self.MAX_NODES:
            raise GuideParseError("guide exceeds the node budget")

    def _record_text(self, data: str) -> None:
        self._text_chars += len(data)
        if self._text_chars > self.MAX_TEXT_CHARS:
            raise GuideParseError("guide exceeds the text budget")

    def _push(self, tag: str) -> None:
        if len(self._stack) >= self.MAX_DEPTH:
            raise GuideParseError("guide exceeds the nesting depth budget")
        self._stack.append(tag)
        self._open_counts[tag] = self._open_counts.get(tag, 0) + 1

    def _pop(self) -> str:
        tag = self._stack.pop()
        remaining = self._open_counts[tag] - 1
        if remaining:
            self._open_counts[tag] = remaining
        else:
            del self._open_counts[tag]
        return tag

    def _append_label(
        self,
        parts: List[str],
        current_chars: int,
        data: str,
        label: str,
    ) -> int:
        next_chars = current_chars + len(data)
        if next_chars > self.MAX_LABEL_CHARS:
            raise GuideParseError(f"guide {label} exceeds the text budget")
        parts.append(data)
        return next_chars

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
        self._record_node()
        normalized = tag.lower()
        depth = len(self._stack)
        if (
            normalized not in _FragmentSanitizer.VOID_TAGS
            and depth >= self.MAX_DEPTH
        ):
            raise GuideParseError("guide exceeds the nesting depth budget")
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
            self._title_chars = 0
        if self._author_depth is None and "guideAuthors" in classes:
            self._author_depth = depth
            self._author_parts = []
            self._author_chars = 0

        if self._section is not None:
            if (
                self._section_title_depth is None
                and "subSectionTitle" in classes
            ):
                self._section_title_depth = depth
                self._section_title_parts = []
                self._section_title_chars = 0
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
            self._push(normalized)

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
        if self._open_counts.get(normalized, 0) == 0:
            return
        while self._stack:
            depth = len(self._stack) - 1
            open_tag = self._pop()
            self._close_at_depth(open_tag, depth)
            if open_tag == normalized:
                return

    def _close_at_depth(self, tag: str, depth: int) -> None:

        if (
            self._section_description_depth is not None
            and depth > self._section_description_depth
            and self._sanitizer is not None
        ):
            self._sanitizer.handle_endtag(tag)
        elif depth == self._section_description_depth:
            assert self._section is not None
            assert self._sanitizer is not None
            sanitizer = self._sanitizer
            self._section["html"] = sanitizer.finish()
            self._sanitized_html_bytes += sanitizer.output_bytes
            if self._sanitized_html_bytes > self.MAX_SANITIZED_HTML_BYTES:
                raise GuideParseError("guide exceeds the sanitized HTML budget")
            self._sanitizer = None
            self._section_description_depth = None

        if depth == self._section_title_depth:
            assert self._section is not None
            self._section["title"] = self._normalize_text(self._section_title_parts)
            self._section_title_parts = []
            self._section_title_chars = 0
            self._section_title_depth = None
        if depth == self._title_depth:
            self.title = self._normalize_text(self._title_parts)
            self._title_parts = []
            self._title_chars = 0
            self._title_depth = None
        if depth == self._author_depth:
            author = self._normalize_text(self._author_parts)
            self.author = re.sub(r"^By\s+", "", author, flags=re.IGNORECASE)
            self._author_parts = []
            self._author_chars = 0
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

    def handle_data(self, data: str) -> None:
        if not data:
            return
        self._record_node()
        self._record_text(data)
        depth = len(self._stack) - 1
        if self._title_depth is not None and depth >= self._title_depth:
            self._title_chars = self._append_label(
                self._title_parts,
                self._title_chars,
                data,
                "title",
            )
        if self._author_depth is not None and depth >= self._author_depth:
            self._author_chars = self._append_label(
                self._author_parts,
                self._author_chars,
                data,
                "author",
            )
        if (
            self._section_title_depth is not None
            and depth >= self._section_title_depth
        ):
            self._section_title_chars = self._append_label(
                self._section_title_parts,
                self._section_title_chars,
                data,
                "section title",
            )
        if self._section_description_depth is not None and self._sanitizer:
            self._sanitizer.handle_data(data)

    def finish(self) -> None:
        while self._stack:
            depth = len(self._stack) - 1
            self._close_at_depth(self._pop(), depth)


def parse_guide_html(guide_id: str, source: str) -> Dict[str, Any]:
    normalized_guide_id = _validate_guide_id(guide_id)
    if not isinstance(source, str):
        raise TypeError("guide source must be text")
    parser = _GuidePageParser()
    try:
        parser.feed(source)
        parser.close()
        parser.finish()
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
CacheFileSignature = FileSignature


class _GuideLockEntry:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.users = 0


class _GuideLockPool:
    """Retain one lock per guide only while an operation is using it."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._entries: Dict[str, _GuideLockEntry] = {}

    def retain(self, guide_id: str) -> _GuideLockEntry:
        with self._guard:
            entry = self._entries.get(guide_id)
            if entry is None:
                entry = _GuideLockEntry()
                self._entries[guide_id] = entry
            entry.users += 1
            return entry

    def release(self, guide_id: str, entry: _GuideLockEntry) -> None:
        with self._guard:
            current = self._entries.get(guide_id)
            if current is not entry or entry.users <= 0:
                raise RuntimeError("guide lock pool state is inconsistent")
            entry.users -= 1
            if entry.users == 0:
                del self._entries[guide_id]


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
        image_cache: Optional[GuideImageCache] = None,
    ) -> None:
        self.cache_directory = Path(cache_directory)
        self._fetcher = fetcher or self._download
        self._now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._image_cache = image_cache or GuideImageCache(
            self.cache_directory.parent / "images"
        )
        self._guide_locks = _GuideLockPool()
        self._memo_lock = threading.Lock()
        self._guide_cache_disk_lock = threading.RLock()
        self._guide_cache_state_lock = threading.Lock()
        self._guide_cache_generation = 0
        self._cache_memo: Dict[
            str, Tuple[CacheFileSignature, Dict[str, Any]]
        ] = {}

    def _memo_get(
        self, guide_id: str
    ) -> Optional[Tuple[CacheFileSignature, Dict[str, Any]]]:
        with self._memo_lock:
            return self._cache_memo.get(guide_id)

    def _memo_remove(self, guide_id: str) -> None:
        with self._memo_lock:
            self._cache_memo.pop(guide_id, None)

    def _memo_store(
        self,
        guide_id: str,
        signature: CacheFileSignature,
        document: Mapping[str, Any],
    ) -> None:
        with self._memo_lock:
            self._cache_memo[guide_id] = (signature, dict(document))

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
            metadata = os.stat(path, follow_symlinks=False)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise GuideCacheError("cached guide could not be inspected") from error
        if not stat.S_ISREG(metadata.st_mode):
            raise GuideCacheError("cached guide is not a regular file")
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
        total_html_nodes = 0
        total_text_chars = 0
        total_html_bytes = 0
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
            try:
                (
                    sanitized,
                    fragment_nodes,
                    fragment_text_chars,
                    fragment_bytes,
                ) = _sanitize_fragment_with_stats(fragment)
            except GuideParseError as error:
                raise GuideCacheError(
                    "cached guide exceeds the HTML parsing budget"
                ) from error
            total_html_nodes += fragment_nodes
            total_text_chars += fragment_text_chars
            total_html_bytes += fragment_bytes
            if (
                total_html_nodes > _GuidePageParser.MAX_NODES
                or total_text_chars > _GuidePageParser.MAX_TEXT_CHARS
                or total_html_bytes > _GuidePageParser.MAX_SANITIZED_HTML_BYTES
            ):
                raise GuideCacheError("cached guide exceeds the HTML parsing budget")
            if sanitized != fragment:
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
            memoized = self._memo_get(guide_id)
            try:
                payload, signature = read_bounded_regular_file(
                    path,
                    self.MAX_CACHE_BYTES,
                    known_signature=(
                        memoized[0] if memoized is not None else None
                    ),
                )
            except FileNotFoundError:
                self._memo_remove(guide_id)
                return None
            except ManagedFileTooLargeError as error:
                self._memo_remove(guide_id)
                raise GuideCacheError(
                    "cached guide exceeds the size limit"
                ) from error
            except ManagedFileChangedError as error:
                self._memo_remove(guide_id)
                if attempt == 0:
                    continue
                raise GuideCacheError(
                    "cached guide changed while being read"
                ) from error
            except OSError as error:
                self._memo_remove(guide_id)
                raise GuideCacheError(
                    "cached guide could not be read safely"
                ) from error

            if payload is None:
                assert memoized is not None and memoized[0] == signature
                return memoized[1]

            try:
                document = self._validate_cached_document(
                    guide_id,
                    json.loads(payload.decode("utf-8")),
                )
            except GuideCacheError:
                self._memo_remove(guide_id)
                raise
            except (UnicodeError, json.JSONDecodeError) as error:
                self._memo_remove(guide_id)
                raise GuideCacheError("cached guide could not be read") from error

            self._memo_store(guide_id, signature, document)
            return document

        raise AssertionError("unreachable cache read state")

    def _write_cache_unlocked(self, document: Mapping[str, Any]) -> None:
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
            self._memo_remove(document["guideId"])
        else:
            if signature is not None:
                self._memo_store(document["guideId"], signature, document)

    def _write_cache(
        self, document: Mapping[str, Any], expected_generation: int
    ) -> None:
        with self._guide_cache_disk_lock:
            with self._guide_cache_state_lock:
                if self._guide_cache_generation != expected_generation:
                    return
            self._write_cache_unlocked(document)

    def _with_cache_status(
        self,
        document: Mapping[str, Any],
        *,
        from_cache: bool,
        stale: bool,
    ) -> Dict[str, Any]:
        result = {
            key: value
            for key, value in document.items()
            if key not in {"schemaVersion", "sections"}
        }
        result["sections"] = [
            {
                **section,
                "html": localize_guide_images(section["html"]),
            }
            for section in document["sections"]
        ]
        result["fromCache"] = from_cache
        result["stale"] = stale
        return result

    def get_guide_image(
        self, url: str, allow_download: bool = True
    ) -> Optional[Dict[str, Any]]:
        return self._image_cache.get(url, allow_download)

    def clear_image_cache(self) -> Dict[str, int]:
        return self._image_cache.clear()

    def clear_guide_cache(self) -> Dict[str, int]:
        with self._guide_cache_state_lock:
            self._guide_cache_generation += 1
        files_removed = 0
        bytes_removed = 0
        with self._guide_cache_disk_lock:
            try:
                iterator = os.scandir(self.cache_directory)
            except (FileNotFoundError, NotADirectoryError):
                iterator = None
            except OSError as error:
                raise GuideCacheError(
                    "guide cache could not be inspected"
                ) from error
            if iterator is not None:
                with iterator:
                    for entry in iterator:
                        name = entry.name
                        if not name.endswith(".json"):
                            continue
                        guide_id = name[:-5]
                        if GUIDE_ID_PATTERN.fullmatch(guide_id) is None:
                            continue
                        try:
                            metadata = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        try:
                            if stat.S_ISDIR(metadata.st_mode):
                                os.rmdir(entry.path)
                            else:
                                os.unlink(entry.path)
                        except OSError as error:
                            raise GuideCacheError(
                                "guide cache could not be cleared"
                            ) from error
                        files_removed += 1
                        if stat.S_ISREG(metadata.st_mode):
                            bytes_removed += metadata.st_size
            with self._memo_lock:
                self._cache_memo.clear()
        return {
            "filesRemoved": files_removed,
            "bytesRemoved": bytes_removed,
        }

    def cache_stats(self) -> Dict[str, Any]:
        guide_files = 0
        guide_bytes = 0
        with self._guide_cache_disk_lock:
            try:
                iterator = os.scandir(self.cache_directory)
            except (FileNotFoundError, NotADirectoryError):
                iterator = None
            except OSError as error:
                raise GuideCacheError(
                    "guide cache could not be inspected"
                ) from error
            if iterator is not None:
                with iterator:
                    for entry in iterator:
                        name = entry.name
                        if not name.endswith(".json"):
                            continue
                        if GUIDE_ID_PATTERN.fullmatch(name[:-5]) is None:
                            continue
                        try:
                            metadata = entry.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        if not stat.S_ISREG(metadata.st_mode):
                            continue
                        guide_files += 1
                        guide_bytes += metadata.st_size
        return {
            "guides": {"files": guide_files, "bytes": guide_bytes},
            "images": self._image_cache.stats(),
        }

    def get_cached(self, guide_id: str) -> Optional[Dict[str, Any]]:
        normalized_guide_id = _validate_guide_id(guide_id)
        # Cache files are atomically replaced, and _read_cache verifies the file
        # signature before and after validation. A best-effort preload can read
        # that stable snapshot without taking the foreground guide lock.
        cached = self._read_cache(normalized_guide_id)
        if cached is None:
            return None
        now = self._now_ms()
        return self._with_cache_status(
            cached,
            from_cache=True,
            stale=now - cached["fetchedAt"] > self.CACHE_MAX_AGE_MS,
        )

    def get(self, guide_id: str, force_refresh: bool = False) -> Dict[str, Any]:
        normalized_guide_id = _validate_guide_id(guide_id)
        if type(force_refresh) is not bool:
            raise ValueError("force_refresh must be a boolean")
        entry = self._guide_locks.retain(normalized_guide_id)
        try:
            with entry.lock:
                return self._get_locked(normalized_guide_id, force_refresh)
        finally:
            self._guide_locks.release(normalized_guide_id, entry)

    def _get_locked(
        self, normalized_guide_id: str, force_refresh: bool
    ) -> Dict[str, Any]:
        with self._guide_cache_state_lock:
            cache_generation = self._guide_cache_generation
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
            self._write_cache(validated, cache_generation)
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
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError("anchor_text is invalid") from error
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
        if (
            type(timestamp) is not int
            or timestamp < 0
            or timestamp > JAVASCRIPT_MAX_SAFE_INTEGER
        ):
            if stored:
                raise ReaderPositionError("stored reader timestamp is invalid")
            raise ValueError("updated_at_ms is invalid")
        normalized["updated_at_ms"] = timestamp
        return normalized

    def _read_document(self) -> Dict[str, Any]:
        try:
            payload, _signature = read_bounded_regular_file(
                self.path, self.MAX_FILE_BYTES
            )
        except FileNotFoundError:
            return self._empty_document()
        except ManagedFileTooLargeError as error:
            raise ReaderPositionError(
                "reader_positions.json exceeds the size limit"
            ) from error
        except OSError as error:
            raise ReaderPositionError(
                "reader_positions.json could not be read safely"
            ) from error
        assert payload is not None
        try:
            value = json.loads(payload.decode("utf-8"))
        except ReaderPositionError:
            raise
        except (UnicodeError, json.JSONDecodeError) as error:
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

    def repair(self) -> Dict[str, Any]:
        """Back up and reset this store only when validation fails."""

        with self._lock:
            try:
                self._read_document()
            except ReaderPositionError:
                try:
                    backup = backup_corrupt_file(self.path)
                except OSError as error:
                    raise ReaderPositionError(
                        "could not back up corrupt reader_positions.json"
                    ) from error
                self._write_document(self._empty_document())
                return {"repaired": True, "backup": str(backup)}
            return {"repaired": False, "backup": None}
