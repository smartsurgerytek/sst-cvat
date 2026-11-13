"""Presentation timestamps for standard video tasks, independent of native playback."""
import math
from functools import lru_cache
from pathlib import Path

import av

from django.conf import settings
from rest_framework.exceptions import NotFound, ValidationError


def parse_timing(probe):
    frames = probe.get("frames", [])
    timestamps = [float(frame["best_effort_timestamp_time"]) for frame in frames]
    if not timestamps or any(not math.isfinite(t) for t in timestamps):
        raise ValueError("Video timestamps are unavailable")
    origin = timestamps[0]
    timestamps = [t - origin for t in timestamps]
    if any(b < a for a, b in zip(timestamps, timestamps[1:])):
        raise ValueError("Video timestamps are not ordered")
    last_duration = float(frames[-1].get("pkt_duration_time", 0))
    if last_duration <= 0 and len(timestamps) > 1:
        last_duration = timestamps[-1] - timestamps[-2]
    duration = max(timestamps[-1] + last_duration, float(probe.get("format", {}).get("duration", 0)))
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Video duration is unavailable")
    return timestamps, duration


@lru_cache(maxsize=8)
def probe_timing(path, modified_ns, size):
    # Read presentation times from encoded packets, without decoding every pixel.
    with av.open(path) as container:
        stream = container.streams.video[0]
        packets = sorted(
            (float(packet.pts * stream.time_base), float(packet.duration * stream.time_base))
            for packet in container.demux(stream) if packet.pts is not None
        )
        duration = float(stream.duration * stream.time_base) if stream.duration else 0
    return parse_timing({
        "frames": [{"best_effort_timestamp_time": time, "pkt_duration_time": duration}
                   for time, duration in packets],
        "format": {"duration": duration},
    })


def job_video_timing(job):
    task = job.segment.task
    native = getattr(task, "original_video", None)
    if native is not None:
        return {"timestamps": native.timestamps, "duration": native.duration}
    data = task.data
    video = getattr(data, "video", None)
    if video is None:
        raise NotFound("This task has no source video.")
    root = Path(settings.SHARE_ROOT) if data.storage == "share" else data.get_upload_dirname()
    path = root / video.path
    if not path.is_file():
        raise NotFound("The source video is unavailable.")
    stat = path.stat()
    try:
        timestamps, duration = probe_timing(str(path), stat.st_mtime_ns, stat.st_size)
        selected = timestamps[data.start_frame::data.get_frame_step()][:data.size]
        if len(selected) != data.size:
            raise ValueError("Video timestamps do not match task frames")
    except (OSError, ValueError, KeyError, IndexError) as exc:
        raise ValidationError("Could not read the source video timing.") from exc
    return {"timestamps": selected, "duration": duration}
