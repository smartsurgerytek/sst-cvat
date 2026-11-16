import unittest

from .video_jobs import time_job_ranges


class TimeJobRangesTests(unittest.TestCase):
    def test_fixed_rate_and_short_final_job(self):
        times = [frame / 25 for frame in range(325)]
        self.assertEqual(time_job_ranges(times, 5), [(0, 124), (125, 249), (250, 324)])

    def test_variable_rate_uses_time_not_average_fps(self):
        times = [0, 0.1, 0.8, 1, 1.02, 1.9, 2.8]
        self.assertEqual(time_job_ranges(times, 1), [(0, 2), (3, 5), (6, 6)])

    def test_sparse_timestamps_do_not_create_empty_jobs(self):
        self.assertEqual(time_job_ranges([0, 0.1, 7, 7.1], 1), [(0, 1), (2, 3)])

    def test_no_split_and_short_video(self):
        self.assertEqual(time_job_ranges([0, 0.1]), [(0, 1)])
        self.assertEqual(time_job_ranges([0, 0.1], 60), [(0, 1)])

    def test_invalid_duration_and_excessive_jobs(self):
        for duration in (0, -1, True, 1.5, float('nan'), float('inf'), 86401):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                time_job_ranges([0, 1], duration)
        with self.assertRaises(ValueError):
            time_job_ranges(list(range(1001)), 1)
