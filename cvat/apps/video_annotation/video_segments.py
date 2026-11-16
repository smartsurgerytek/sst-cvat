"""On-demand, independently cached low-bandwidth fragmented MP4 playback segments."""
import bisect
import fcntl
import os
import tempfile
from fractions import Fraction

import av

SEGMENT_SECONDS = 5
PROFILE = "360p-400k-v1"


def segment_bounds(video, index):
    if index < 0 or index * SEGMENT_SECONDS >= video.duration:
        raise ValueError("Segment is outside the video")
    first = bisect.bisect_left(video.timestamps, index * SEGMENT_SECONDS)
    last = bisect.bisect_left(video.timestamps, (index + 1) * SEGMENT_SECONDS)
    if first >= len(video.timestamps) or first == last:
        raise ValueError("Segment contains no video samples")
    start = video.timestamps[first]
    end = video.timestamps[last] if last < len(video.timestamps) else video.duration
    return first, last, start, end


def encode_segment(video, index, path, codec="libopenh264"):
    first, last, start, end = segment_bounds(video, index)
    clock = Fraction(1, 90000)
    with av.open(str(video.path)) as source:
        track = source.streams.video[0]
        origin = float((track.start_time or 0) * track.time_base)
        source.seek(int((start + origin) / track.time_base), stream=track, backward=True)
        height = max(2, min(360, video.height) // 2 * 2)
        width = max(2, round(video.width * height / video.height / 2) * 2)
        with av.open(str(path), "w", format="mp4", options={
            "movflags": "frag_keyframe+empty_moov+default_base_moof",
        }) as output:
            stream = output.add_stream(codec, rate=track.average_rate or 30)
            stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
            stream.bit_rate = 400000
            stream.codec_context.time_base = clock
            stream.codec_context.gop_size = 30
            stream.codec_context.max_b_frames = 0
            durations = {}
            count = 0

            def mux(packet):
                if packet.pts in durations:
                    packet.duration = durations[packet.pts]
                output.mux(packet)

            for image in source.decode(track):
                if image.pts is None:
                    continue
                timestamp = float(image.pts * track.time_base) - origin
                if timestamp < start - 0.000001:
                    continue
                if timestamp >= end - 0.000001:
                    break
                sample = bisect.bisect_left(video.timestamps, timestamp - 0.000001)
                if sample < first or sample >= last:
                    continue
                frame = image.reformat(width=width, height=height, format="yuv420p")
                frame.pts = round((timestamp - start) / clock)
                frame.time_base = clock
                next_time = video.timestamps[sample + 1] if sample + 1 < len(video.timestamps) else end
                durations[frame.pts] = max(1, round((min(next_time, end) - timestamp) / clock))
                for packet in stream.encode(frame):
                    mux(packet)
                count += 1
            for packet in stream.encode():
                mux(packet)
            if not count:
                raise ValueError("Could not decode this video segment")
    return start, end


def remux_segment(video, index, path):
    """Copy original packets from a preceding keyframe; never resize or re-encode."""
    _, _, start, end = segment_bounds(video, index)
    with av.open(str(video.path)) as source:
        track = source.streams.video[0]
        origin = float((track.start_time or 0) * track.time_base)
        source.seek(int((start + origin) / track.time_base), stream=track, backward=True)
        offset = None
        with av.open(str(path), "w", format="mp4", options={
            "movflags": "frag_keyframe+empty_moov+default_base_moof",
        }) as output:
            stream = output.add_stream_from_template(track)
            for packet in source.demux(track):
                if packet.dts is None or packet.pts is None:
                    continue
                if offset is None:
                    if not packet.is_keyframe:
                        continue
                    offset = packet.dts
                # DTS keeps all reference pictures needed to decode the end of the window.
                if float(packet.dts * track.time_base) - origin >= end:
                    break
                packet.pts -= offset
                packet.dts -= offset
                packet.stream = stream
                output.mux(packet)
        if offset is None:
            raise ValueError("Could not read original video segment")
        return float(offset * track.time_base) - origin, end


def cached_segment(video, index, original=False):
    _, _, start, end = segment_bounds(video, index)
    directory = video.directory / "playback" / ("original-v1" if original else PROFILE)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{index}.mp4"
    with (directory / f"{index}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not path.is_file() or (original and not path.with_suffix(".start").is_file()):
            with tempfile.NamedTemporaryFile(dir=directory, suffix=".mp4", delete=False) as temporary:
                temporary_path = temporary.name
            try:
                if original:
                    start, end = remux_segment(video, index, temporary_path)
                else:
                    encode_segment(video, index, temporary_path)
                os.replace(temporary_path, path)
                if original:
                    path.with_suffix(".start").write_text(str(start))
            finally:
                if os.path.exists(temporary_path):
                    os.unlink(temporary_path)
    if original:
        start = float(path.with_suffix(".start").read_text())
    # avcC contains configurationVersion, AVCProfileIndication, compatibility, level.
    with path.open("rb") as source:
        header = source.read(65536)
    config = header.find(b"avcC")
    if config < 0 and not original:
        raise ValueError("Playback codec configuration is missing")
    # Original blobs are decoded directly by <video>, including supported non-AVC MP4s.
    codec = "original" if config < 0 else "avc1." + header[config + 5:config + 8].hex()
    return path, start, end, codec
