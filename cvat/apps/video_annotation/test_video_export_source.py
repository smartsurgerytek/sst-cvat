import tempfile
import unittest
from pathlib import Path

from PIL import Image

from .video_export_render import encode_video
from .video_export_source import source_frames


class ExportSourceTests(unittest.TestCase):
    def test_sequential_decoder_preserves_nonzero_start_gaps_and_variable_timing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.mp4'
            encode_video(path, list(range(5)), [.04, .08, .12, .04, .08],
                         lambda number: Image.new('RGB', (320, 240), (number * 40, 0, 0)))
            frames = list(source_frames(path, [0, .04, .12, .24, .28], [1, 3, 4]))
            self.assertEqual(len(frames), 3)
            for image, expected in zip(frames, (40, 120, 160)):
                self.assertAlmostEqual(image.getpixel((100, 100))[0], expected, delta=5)
            with self.assertRaises(ValueError):
                list(source_frames(path, [0, .04, .12, .24, .28, .36], [5]))
