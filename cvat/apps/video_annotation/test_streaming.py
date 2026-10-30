"""Streaming framing checks without a database or a GPU."""
import unittest

from .utils import iter_ndjson_lines


class StreamingTests(unittest.TestCase):
    def test_fragmented_and_combined_records(self):
        wire = b'{"frame":0}\r\n\n{"frame":1}\n{"frame":2}'
        expected = [b'{"frame":0}\r', b'', b'{"frame":1}', b'{"frame":2}']
        for size in [1, 2, 7, 64]:
            with self.subTest(size=size):
                self.assertEqual(list(iter_ndjson_lines(
                    wire[i:i + size] for i in range(0, len(wire), size)
                )), expected)

    def test_empty_stream_and_chunks(self):
        self.assertEqual(list(iter_ndjson_lines([])), [])
        self.assertEqual(list(iter_ndjson_lines([b'', b'a', b'', b'\n', b''])), [b'a'])

    def test_large_score_record_is_unchanged(self):
        record = b'{"logits":"' + b'A' * (8 * 1024 * 1024) + b'"}'
        wire = record + b'\n'
        self.assertEqual(list(iter_ndjson_lines(
            wire[i:i + 65536] for i in range(0, len(wire), 65536)
        )), [record])
