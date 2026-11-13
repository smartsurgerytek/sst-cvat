import json
import tempfile
import unittest
from pathlib import Path

import av
import numpy as np

from .scrub_preview import build_preview, sample_frames


class ScrubPreviewTests(unittest.TestCase):
    def test_sample_boundaries_and_variable_rate(self):
        self.assertEqual(sample_frames([0, .1, .2, .7, .8, 1.3], 1, 5), [1, 3, 5])
        self.assertEqual(sample_frames([0, .1, .2], 1, 1), [1])

    def test_contact_sheet_preserves_frame_indices_and_reuses_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'source.mp4'
            directory = Path(temporary) / 'preview'
            with av.open(str(source), 'w') as container:
                stream = container.add_stream('libopenh264', rate=25)
                stream.width, stream.height, stream.pix_fmt = 64, 48, 'yuv420p'
                for index in range(50):
                    frame = av.VideoFrame.from_ndarray(np.full((48, 64, 3), index * 4, dtype=np.uint8), format='rgb24')
                    for packet in stream.encode(frame):
                        container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)
            times = [index / 25 for index in range(50)]
            build_preview(source, directory, times, 5, 40)
            manifest = json.loads((directory / 'manifest.json').read_text())
            self.assertEqual(manifest['frames'], [5, 18, 31, 40])
            self.assertEqual(manifest['sheets'], ['0.jpg'])
            self.assertLess((directory / '0.jpg').stat().st_size, 100000)
            modified = (directory / 'manifest.json').stat().st_mtime_ns
            build_preview(source, directory, times, 5, 40)
            self.assertEqual((directory / 'manifest.json').stat().st_mtime_ns, modified)
