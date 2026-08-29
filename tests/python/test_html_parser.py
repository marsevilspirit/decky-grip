import ast
import inspect
import sys
import textwrap
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "py_modules"))

from grip_html_parser import HTMLParseLimitError, HTMLParser  # noqa: E402


class RecordingParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events = []

    def handle_starttag(self, tag, attrs):
        self.events.append(("start", tag, attrs))

    def handle_startendtag(self, tag, attrs):
        self.events.append(("startend", tag, attrs))

    def handle_endtag(self, tag):
        self.events.append(("end", tag))

    def handle_data(self, data):
        self.events.append(("data", data))


def parse(source, chunks=None):
    parser = RecordingParser()
    if chunks is None:
        parser.feed(source)
    else:
        offset = 0
        for size in chunks:
            parser.feed(source[offset : offset + size])
            offset += size
        parser.feed(source[offset:])
    parser.close()
    return parser.events


class HTMLParserIncrementalTests(unittest.TestCase):
    def test_chunked_feed_matches_single_feed_across_token_boundaries(self):
        source = (
            "text &amp; more<div DATA-X='1>2' disabled>body"
            "<script>if (left < right) { value = '&amp;'; }</ScRiPt >"
            "<br /></div>tail"
        )
        expected = parse(source)

        for chunks in (
            [1] * len(source),
            [4, 7, 2, 19, 1, 3, 11, 5, 23],
            [source.index("<script>") + 3, 2, 4, 9, 1, 17],
        ):
            with self.subTest(chunks=chunks[:10]):
                self.assertEqual(parse(source, chunks), expected)

    def test_incomplete_quoted_tag_waits_for_feed_and_close_emits_text(self):
        parser = RecordingParser()

        parser.feed("<div title='left>")
        self.assertEqual(parser.events, [])
        parser.feed("right'>body")
        self.assertEqual(
            parser.events,
            [("start", "div", [("title", "left>right")])],
        )
        parser.close()

        self.assertEqual(
            parser.events,
            [
                ("start", "div", [("title", "left>right")]),
                ("data", "body"),
            ],
        )

    def test_rawtext_does_not_tokenize_nested_markup_or_false_end_prefixes(self):
        source = (
            "<script><img onerror=bad></scriptx></ſcript>safe</SCRIPT ><p>after"
        )
        events = parse(source)

        self.assertEqual(
            events,
            [
                ("start", "script", []),
                ("data", "<img onerror=bad></scriptx></ſcript>safe"),
                ("end", "script"),
                ("start", "p", []),
                ("data", "after"),
            ],
        )
        split = source.index("</scriptx>") + len("</script")
        self.assertEqual(parse(source, [split]), events)

    def test_unclosed_rawtext_and_malformed_markup_keep_safe_callbacks(self):
        self.assertEqual(
            parse("before<!-- ignored forever"),
            [("data", "before")],
        )
        self.assertEqual(
            parse("<style>a < b &amp; c"),
            [("start", "style", []), ("data", "a < b & c")],
        )
        self.assertEqual(
            parse("x<!broken"),
            [("data", "x"), ("data", "<"), ("data", "!broken")],
        )


class HTMLParserLinearScanTests(unittest.TestCase):
    def test_completed_token_stream_compacts_once_per_feed(self):
        class CompactionCountingParser(RecordingParser):
            def __init__(self):
                super().__init__()
                self.compactions = 0

            def _compact_buffer(self):
                if self._tokenizer_offset:
                    self.compactions += 1
                super()._compact_buffer()

        for token_count in (1_000, 8_000):
            with self.subTest(token_count=token_count):
                parser = CompactionCountingParser()
                parser.feed("<b>x</b>" * token_count)

                self.assertEqual(parser.compactions, 1)
                self.assertEqual(parser._tokenizer_buffer, "")
                self.assertEqual(len(parser.events), token_count * 3)

    def test_markup_consumer_advances_an_index_without_replacing_buffer(self):
        tree = ast.parse(
            textwrap.dedent(inspect.getsource(HTMLParser._consume_markup))
        )
        buffer_writes = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and node.attr == "_tokenizer_buffer"
            and isinstance(node.ctx, ast.Store)
        ]

        self.assertEqual(buffer_writes, [])

    def test_incremental_plain_text_is_buffered_as_chunks_not_one_growing_string(self):
        parser = RecordingParser()
        maximum_buffer = 0

        for character in "x" * 20_000:
            parser.feed(character)
            maximum_buffer = max(maximum_buffer, len(parser._tokenizer_buffer))
        parser.close()

        self.assertEqual(maximum_buffer, 0)
        self.assertEqual(parser.events, [("data", "x" * 20_000)])

    def test_one_malformed_markup_token_has_a_hard_size_limit(self):
        parser = RecordingParser()

        with self.assertRaisesRegex(HTMLParseLimitError, "size limit"):
            parser.feed("<div title='" + "x" * (HTMLParser.MAX_MARKUP_CHARS + 1))


if __name__ == "__main__":
    unittest.main()
