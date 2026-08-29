"""Small, conservative HTML tokenizer used by the bundled Decky backend.

Decky's PyInstaller runtime does not always include ``html.parser``.  This
module implements only the callback surface GRIP needs and always hands text
and parsed attributes to code that serializes a strict allowlist.  Malformed
markup is treated as text or ignored, never copied to output verbatim.
"""

from __future__ import annotations

import html
import re
from typing import List, Optional, Tuple


Attributes = List[Tuple[str, Optional[str]]]


class HTMLParseLimitError(ValueError):
    """Raised before a single malformed token can consume unbounded work."""


class HTMLParser:
    """Tolerant, incremental tokenizer with the subset of ``HTMLParser`` GRIP uses."""

    _TAG_NAME = re.compile(r"[A-Za-z][A-Za-z0-9._:-]*")
    MAX_MARKUP_CHARS = 16_384
    MAX_ATTRIBUTES = 256
    MAX_CHARACTER_REFERENCE_CHARS = 64
    _RAWTEXT_TAGS = {"script", "style"}
    _RAWTEXT_END = {
        tag: re.compile(
            r"</"
            + "".join(f"[{letter.lower()}{letter.upper()}]" for letter in tag)
            + r"(?=\s|>|$)"
        )
        for tag in _RAWTEXT_TAGS
    }

    def __init__(self, *, convert_charrefs: bool = True) -> None:
        self._convert_charrefs = convert_charrefs
        self._tokenizer_buffer = ""
        self._tokenizer_offset = 0
        self._tokenizer_rawtext_tag: Optional[str] = None
        self._tokenizer_deferred_data: List[str] = []

    def feed(self, data: str) -> None:
        if not isinstance(data, str):
            raise TypeError("HTML source must be text")
        self._tokenizer_buffer += data
        self._parse_available(final=False)

    def close(self) -> None:
        self._parse_available(final=True)
        self._emit_data("")

    def handle_starttag(self, tag: str, attrs: Attributes) -> None:
        pass

    def handle_startendtag(self, tag: str, attrs: Attributes) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        pass

    def handle_data(self, data: str) -> None:
        pass

    def _emit_data(self, data: str) -> None:
        if self._tokenizer_deferred_data:
            self._tokenizer_deferred_data.append(data)
            data = "".join(self._tokenizer_deferred_data)
            self._tokenizer_deferred_data.clear()
        if not data:
            return
        if self._convert_charrefs:
            data = html.unescape(data)
        self.handle_data(data)

    def _defer_data(self, data: str) -> None:
        if data:
            self._tokenizer_deferred_data.append(data)

    @classmethod
    def _tag_end(cls, source: str, start: int) -> Optional[int]:
        quote: Optional[str] = None
        scan_end = min(len(source), start + cls.MAX_MARKUP_CHARS + 1)
        for index in range(start, scan_end):
            character = source[index]
            if quote is not None:
                if character == quote:
                    quote = None
            elif character in ('"', "'"):
                quote = character
            elif character == ">":
                return index
        if len(source) - start > cls.MAX_MARKUP_CHARS:
            raise HTMLParseLimitError("HTML tag exceeds the size limit")
        return None

    @classmethod
    def _parse_attributes(cls, source: str) -> Attributes:
        if len(source) > cls.MAX_MARKUP_CHARS:
            raise HTMLParseLimitError("HTML tag exceeds the size limit")
        attributes: Attributes = []
        index = 0
        while index < len(source):
            while index < len(source) and source[index].isspace():
                index += 1
            if index >= len(source):
                break
            if source[index] == "/":
                index += 1
                continue

            name_start = index
            while (
                index < len(source)
                and not source[index].isspace()
                and source[index] not in "=/>\"'"
            ):
                index += 1
            if index == name_start:
                index += 1
                continue
            name = source[name_start:index].lower()

            while index < len(source) and source[index].isspace():
                index += 1
            value: Optional[str] = None
            if index < len(source) and source[index] == "=":
                index += 1
                while index < len(source) and source[index].isspace():
                    index += 1
                if index < len(source) and source[index] in ('"', "'"):
                    quote = source[index]
                    index += 1
                    value_start = index
                    while index < len(source) and source[index] != quote:
                        index += 1
                    value = source[value_start:index]
                    if index < len(source):
                        index += 1
                else:
                    value_start = index
                    while index < len(source) and not source[index].isspace():
                        index += 1
                    value = source[value_start:index]
                value = html.unescape(value)
            attributes.append((name, value))
            if len(attributes) > cls.MAX_ATTRIBUTES:
                raise HTMLParseLimitError("HTML tag contains too many attributes")
        return attributes

    @classmethod
    def _safe_text_end(cls, source: str, start: int) -> int:
        """Return text that cannot be part of a split character reference."""

        ampersand = source.rfind("&", start)
        if ampersand < 0:
            return len(source)
        candidate = source[ampersand:]
        if (
            len(candidate) <= cls.MAX_CHARACTER_REFERENCE_CHARS
            and re.fullmatch(
                r"&(?:#[xX]?[0-9A-Fa-f]*|[A-Za-z0-9]*)?", candidate
            )
        ):
            return ampersand
        return len(source)

    @staticmethod
    def _rawtext_safe_end(source: str, start: int, tag: str) -> int:
        """Keep only a suffix that can become a split raw-text closing tag."""

        closing = f"</{tag}"
        available = source[start:].lower()
        for size in range(min(len(closing), len(available)), 0, -1):
            if closing.startswith(available[-size:]):
                return len(source) - size
        return len(source)

    @classmethod
    def _find_rawtext_end(
        cls, source: str, start: int, tag: str, *, final: bool
    ) -> Optional[int]:
        match = cls._RAWTEXT_END[tag].search(source, start)
        if match is None:
            return None
        if not final and match.end() == len(source):
            return None
        return match.start()

    def _consume_markup(
        self, source: str, start: int, *, final: bool
    ) -> Optional[int]:
        """Consume markup at ``start`` and return the next scan position.

        ``None`` means that a later ``feed()`` call may complete the token.  The
        tokenizer buffer is deliberately not replaced here: advancing an index
        avoids copying the entire unconsumed suffix after every tag.
        """

        if source.startswith("<!--", start):
            end = source.find("-->", start + 4)
            if end < 0:
                if len(source) - start > self.MAX_MARKUP_CHARS:
                    raise HTMLParseLimitError("HTML comment exceeds the size limit")
                if final:
                    return len(source)
                return None
            return end + 3

        if source.startswith("<!", start) or source.startswith("<?", start):
            end = self._tag_end(source, start + 2)
            if end is None:
                if final:
                    self._emit_data("<")
                    return start + 1
                return None
            return end + 1

        if source.startswith("</", start):
            match = self._TAG_NAME.match(source, start + 2)
            if match is None:
                if not final and start + 2 == len(source):
                    return None
                self._emit_data("<")
                return start + 1
            end = self._tag_end(source, match.end())
            if end is None:
                if final:
                    self._emit_data("<")
                    return start + 1
                return None
            self.handle_endtag(match.group(0).lower())
            return end + 1

        match = self._TAG_NAME.match(source, start + 1)
        if match is None:
            if not final and start + 1 == len(source):
                return None
            self._emit_data("<")
            return start + 1
        end = self._tag_end(source, match.end())
        if end is None:
            if final:
                self._emit_data("<")
                return start + 1
            return None

        tag = match.group(0).lower()
        attribute_source = source[match.end() : end]
        stripped = attribute_source.rstrip()
        self_closing = bool(
            stripped.endswith("/")
            and (
                len(stripped) == 1
                or stripped[-2].isspace()
                or stripped[-2] in ('"', "'")
            )
        )
        if self_closing:
            attribute_source = stripped[:-1]
        attributes = self._parse_attributes(attribute_source)
        if self_closing:
            self.handle_startendtag(tag, attributes)
        else:
            self.handle_starttag(tag, attributes)
            if tag in self._RAWTEXT_TAGS:
                self._tokenizer_rawtext_tag = tag
        return end + 1

    def _compact_buffer(self) -> None:
        """Discard the consumed prefix at most once per parse pass."""

        if self._tokenizer_offset == 0:
            return
        if self._tokenizer_offset >= len(self._tokenizer_buffer):
            self._tokenizer_buffer = ""
        else:
            self._tokenizer_buffer = self._tokenizer_buffer[
                self._tokenizer_offset :
            ]
        self._tokenizer_offset = 0

    def _parse_available(self, *, final: bool) -> None:
        source = self._tokenizer_buffer
        offset = self._tokenizer_offset
        while offset < len(source):
            if self._tokenizer_rawtext_tag is not None:
                end = self._find_rawtext_end(
                    source,
                    offset,
                    self._tokenizer_rawtext_tag,
                    final=final,
                )
                if end is None:
                    if final:
                        self._emit_data(source[offset:])
                        offset = len(source)
                    else:
                        safe_end = self._rawtext_safe_end(
                            source,
                            offset,
                            self._tokenizer_rawtext_tag,
                        )
                        self._defer_data(source[offset:safe_end])
                        offset = safe_end
                    break
                self._emit_data(source[offset:end])
                offset = end
                self._tokenizer_rawtext_tag = None
                continue

            markup = source.find("<", offset)
            if markup < 0:
                if final:
                    self._emit_data(source[offset:])
                    offset = len(source)
                else:
                    safe_end = self._safe_text_end(source, offset)
                    self._defer_data(source[offset:safe_end])
                    offset = safe_end
                break
            if markup > offset:
                self._emit_data(source[offset:markup])
                offset = markup
            elif self._tokenizer_deferred_data:
                self._emit_data("")
            consumed = self._consume_markup(source, offset, final=final)
            if consumed is None:
                break
            offset = consumed

        self._tokenizer_offset = offset
        self._compact_buffer()
