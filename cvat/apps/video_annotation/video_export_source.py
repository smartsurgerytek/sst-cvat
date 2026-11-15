"""Stream original video once, without the interactive PNG/ZIP chunk round trip."""
import bisect

import av

from .export_hardware import detect_hardware


def source_frames(path, timestamps, frames, *, apply_rotation=True, threads=None):
    if not frames:
        return
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.codec_context.thread_count = threads or min(4, max(1, int(detect_hardware()["effective_cpus"])))
        stream.thread_type = "AUTO"
        origin = float((stream.start_time or 0) * stream.time_base)
        container.seek(int((timestamps[frames[0]] + origin) / stream.time_base), stream=stream, backward=True)
        wanted = iter(frames)
        target = next(wanted)
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            time = float(frame.pts * stream.time_base) - origin
            index = bisect.bisect_left(timestamps, time - 0.000001)
            if index < target:
                continue
            if index != target:
                raise ValueError(f"Could not decode source frame {target}")
            if apply_rotation and frame.rotation:
                from django.apps import apps
                if not apps.ready:
                    import django
                    django.setup()
                from PIL import Image
                from cvat.apps.engine.utils import rotate_image
                yield Image.fromarray(rotate_image(frame.to_ndarray(format="rgb24"), frame.rotation))
            else:
                yield frame.to_image()
            target = next(wanted, None)
            if target is None:
                return
        raise ValueError(f"Source video ended before frame {target}")
