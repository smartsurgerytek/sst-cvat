import tempfile
import unittest
from pathlib import Path

import av
import numpy as np
from PIL import Image

from .utils import encode_mask
from .video_export_render import encode_video, frame_durations, render_frame


class OverlayVideoRenderTests(unittest.TestCase):
    def setUp(self):
        self.image = Image.new("RGB", (320, 240), "black")
        self.labels = {1: {"name": "Instrument", "color": "#ff0000"},
                       2: {"name": "Preparation", "color": "#00ff00"}}
        self.options = {"opacity": 0.5, "show_names": False, "show_legend": False, "show_phase": False}

    def test_mask_opacity_and_unmodified_background(self):
        bitmap = np.zeros((240, 320), dtype=bool)
        bitmap[50:80, 50:80] = True
        shape = {"id": 3, "type": "mask", "label_id": 1, "points": encode_mask(bitmap)}
        result = render_frame(self.image, [shape], [], self.labels, self.options, 0)
        self.assertEqual(result.getpixel((60, 60)), (128, 0, 0))
        self.assertEqual(result.getpixel((10, 10)), (0, 0, 0))
        self.assertEqual(self.image.getpixel((60, 60)), (0, 0, 0))

    def test_rotated_rectangle_and_polygon_keep_label_colors(self):
        shape = {"type": "rectangle", "label_id": 1, "points": [100, 80, 200, 120], "rotation": 90}
        result = render_frame(self.image, [shape], [], self.labels, self.options, 0)
        self.assertEqual(result.getpixel((150, 60)), (128, 0, 0))
        self.assertEqual(result.getpixel((110, 100)), (0, 0, 0))
        shape = {"type": "polygon", "label_id": 2, "points": [20, 20, 80, 20, 50, 80]}
        result = render_frame(self.image, [shape], [], self.labels, self.options, 0)
        self.assertEqual(result.getpixel((50, 40)), (0, 128, 0))

    def test_phase_changes_and_legend_do_not_cover_source_image(self):
        options = {**self.options, "show_phase": True, "show_legend": True}
        no_phase = render_frame(self.image, [], [], self.labels, options, 5)
        with_phase = render_frame(self.image, [], [{"label_id": 2}], self.labels, options, 5)
        self.assertEqual(with_phase.size, no_phase.size)
        self.assertGreater(with_phase.width, self.image.width)
        self.assertEqual(with_phase.crop((0, 0, 320, 240)).tobytes(), self.image.tobytes())
        self.assertNotEqual(with_phase.tobytes(), no_phase.tobytes())
        self.assertIn((0, 255, 0), with_phase.getdata())

    def test_object_names_use_stable_sam2_identity(self):
        shape = {"id": 13, "type": "rectangle", "label_id": 1, "points": [50, 100, 100, 180]}
        options = {**self.options, "show_names": True}
        first = render_frame(self.image, [shape], [], self.labels, options, 0, {"13": 99})
        second = render_frame(self.image, [{**shape, "id": 14}], [], self.labels, options, 0, {"14": 99})
        self.assertEqual(first.tobytes(), second.tobytes())
        self.assertNotEqual(first.tobytes(), render_frame(self.image, [shape], [], self.labels, self.options, 0).tobytes())

    def test_odd_dimensions_are_padded(self):
        result = render_frame(Image.new("RGB", (101, 99)), [], [], self.labels, self.options, 0)
        self.assertEqual(result.size, (102, 100))

    def test_deleted_frames_and_nonzero_start_preserve_individual_durations(self):
        self.assertEqual(frame_durations([1, 3], [0, .1, .25, .5], .75), [.15, .25])

    def test_mp4_decodes_with_variable_timing_phase_and_overlay(self):
        frames, durations = [10, 11, 13], [.04, .08, .12]
        options = {**self.options, "show_phase": True, "show_legend": True}
        shape = {"type": "rectangle", "label_id": 1, "points": [50, 80, 100, 160]}
        calls, progress = [], []

        def image_at(number):
            calls.append(number)
            return render_frame(self.image, [shape], [{"label_id": 2}] if number == 11 else [],
                                self.labels, options, number)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "export.mp4"
            encode_video(path, frames, durations, image_at, progress.append)
            with av.open(str(path)) as video:
                decoded = list(video.decode(video=0))
                self.assertEqual(len(decoded), 3)
                self.assertEqual(video.streams.video[0].codec_context.name, "h264")
                self.assertEqual(len(video.streams.audio), 0)
                self.assertAlmostEqual(float(video.duration / av.time_base), .24, places=3)
                self.assertEqual([round(float(frame.pts * frame.time_base), 3) for frame in decoded], [0, .04, .12])
                self.assertGreater(decoded[0].to_image().getpixel((70, 120))[0], 100)
                self.assertNotEqual(decoded[0].to_image().tobytes(), decoded[1].to_image().tobytes())
        self.assertEqual(calls, frames)
        self.assertEqual(progress[-1], 100)
