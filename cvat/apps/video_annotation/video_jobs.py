"""Partition original-video timestamps into contiguous, non-overlapping jobs."""
import math


def time_job_ranges(timestamps, segment_duration=None):
    if not timestamps:
        raise ValueError("The video contains no frames.")
    if segment_duration is None:
        return [(0, len(timestamps) - 1)]
    if (isinstance(segment_duration, bool) or not isinstance(segment_duration, int)
            or not 1 <= segment_duration <= 86400):
        raise ValueError("Job duration must be a whole number from 1 to 86400 seconds.")
    ranges = []
    start = 0
    bucket = math.floor(timestamps[0] / segment_duration)
    for frame, timestamp in enumerate(timestamps):
        current = math.floor(timestamp / segment_duration)
        if current != bucket:
            ranges.append((start, frame - 1))
            start, bucket = frame, current
    ranges.append((start, len(timestamps) - 1))
    if len(ranges) > 1000:
        raise ValueError("This would create more than 1000 jobs. Increase the duration per job.")
    return ranges
