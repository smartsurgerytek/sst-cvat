import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import av
import numpy as np

from .video_segments import cached_segment, encode_segment, segment_bounds


class VideoSegmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.folder = Path(cls.temporary.name)
        cls.codec = os.getenv("SAM2_TEST_CODEC", "libopenh264")
        cls.video = SimpleNamespace(path=cls.folder / "original.mp4", directory=cls.folder,
                                    width=640, height=360, duration=12,
                                    timestamps=[i / 25 for i in range(300)])
        with av.open(str(cls.video.path), "w") as container:
            stream = container.add_stream(cls.codec, rate=25)
            stream.width, stream.height, stream.pix_fmt = 640, 360, "yuv420p"
            for index in range(300):
                image = np.full((360, 640, 3), index % 256, dtype=np.uint8)
                frame = av.VideoFrame.from_ndarray(image, format="rgb24")
                for packet in stream.encode(frame):
                    container.mux(packet)
            for packet in stream.encode():
                container.mux(packet)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_bounds_and_final_short_segment(self):
        self.assertEqual(segment_bounds(self.video, 1), (125, 250, 5, 10))
        self.assertEqual(segment_bounds(self.video, 2), (250, 300, 10, 12))
        for index in (-1, 3):
            with self.assertRaises(ValueError):
                segment_bounds(self.video, index)

    def test_segment_preserves_timestamps_and_encodes_only_requested_range(self):
        destination = self.folder / "middle.mp4"
        start, end = encode_segment(self.video, 1, destination, codec=self.codec)
        with av.open(str(destination)) as container:
            frames = list(container.decode(video=0))
        self.assertEqual(len(frames), 125)
        self.assertEqual((start, end), (5, 10))
        for index, frame in enumerate(frames):
            self.assertAlmostEqual(float(frame.pts * frame.time_base) + start, (125 + index) / 25, places=4)
            self.assertEqual((frame.width, frame.height), (640, 360))
        self.assertIn(b"moof", destination.read_bytes())

    def test_server_cache_reuses_encoded_segment(self):
        real_encode = encode_segment
        with patch("cvat.apps.video_annotation.video_segments.encode_segment",
                   side_effect=lambda video, index, path: real_encode(video, index, path, codec=self.codec)) as encode:
            first = cached_segment(self.video, 2)
            second = cached_segment(self.video, 2)
        self.assertEqual(first, second)
        self.assertEqual(encode.call_count, 1)
        self.assertTrue(first[3].startswith("avc1."))

    def test_original_segments_preserve_pixels_and_can_be_reused(self):
        with av.open(str(self.video.path)) as container:
            original = {round(float(frame.pts * frame.time_base), 5): frame.to_ndarray(format="rgb24")
                        for frame in container.decode(video=0)}
        path, start, end, codec = cached_segment(self.video, 1, original=True)
        self.assertEqual(cached_segment(self.video, 1, original=True), (path, start, end, codec))
        checked = 0
        with av.open(str(path)) as container:
            for frame in container.decode(video=0):
                timestamp = round(float(frame.pts * frame.time_base) + start, 5)
                if 5 <= timestamp < 10:
                    np.testing.assert_array_equal(frame.to_ndarray(format="rgb24"), original[timestamp])
                    checked += 1
        self.assertEqual(checked, 125)
