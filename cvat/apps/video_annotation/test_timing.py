import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from .timing import job_video_timing, parse_timing


class VideoTimingTest(unittest.TestCase):
    def test_variable_rate_and_nonzero_origin(self):
        timestamps, duration = parse_timing({"frames": [
            {"best_effort_timestamp_time": 5, "pkt_duration_time": 0.04},
            {"best_effort_timestamp_time": 5.04, "pkt_duration_time": 0.09},
            {"best_effort_timestamp_time": 5.13, "pkt_duration_time": 0.07},
        ]})
        self.assertAlmostEqual(timestamps[1], 0.04)
        self.assertAlmostEqual(timestamps[2], 0.13)
        self.assertAlmostEqual(duration, 0.2)

    def test_task_trim_and_frame_step(self):
        data = SimpleNamespace(video=SimpleNamespace(path="video.mp4"), storage="local",
                               get_upload_dirname=lambda: Path("/data"), start_frame=2,
                               get_frame_step=lambda: 2, size=3)
        job = SimpleNamespace(segment=SimpleNamespace(task=SimpleNamespace(data=data)))
        with patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "stat", return_value=SimpleNamespace(st_mtime_ns=1, st_size=1)), \
                patch("cvat.apps.video_annotation.timing.probe_timing", return_value=(list(range(10)), 10)):
            self.assertEqual(job_video_timing(job), {"timestamps": [2, 4, 6], "duration": 10})

    def test_native_video(self):
        video = SimpleNamespace(timestamps=[0, 0.04], duration=0.08)
        job = SimpleNamespace(segment=SimpleNamespace(task=SimpleNamespace(original_video=video)))
        self.assertEqual(job_video_timing(job), {"timestamps": [0, 0.04], "duration": 0.08})

    def test_invalid_timestamps(self):
        for frames in ([], [{"best_effort_timestamp_time": float("nan")}],
                       [{"best_effort_timestamp_time": 1}, {"best_effort_timestamp_time": 0}]):
            with self.assertRaises(ValueError):
                parse_timing({"frames": frames})
