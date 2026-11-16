"""Small, cached contact sheets for scrubbing; never used as annotation frames."""
import bisect
import fcntl
import hashlib
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import av
from PIL import Image
from django.conf import settings
from rest_framework.exceptions import NotFound

from .timing import job_video_timing

CELL = 160
COLUMNS = 10
PER_SHEET = 100
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cvat-scrub-preview")
_pending = set()
_pending_lock = Lock()
logger = logging.getLogger(__name__)


def sample_frames(timestamps, start, stop, interval=0.5):
    selected = [start]
    while selected[-1] < stop:
        next_frame = bisect.bisect_left(timestamps, timestamps[selected[-1]] + interval,
                                      selected[-1] + 1, stop + 1)
        selected.append(min(next_frame, stop))
    return selected


def preview_location(job):
    task = job.segment.task
    native = getattr(task, "original_video", None)
    data = task.data
    if native is not None:
        source = native.path
    else:
        video = getattr(data, "video", None)
        if video is None:
            raise NotFound("This task has no source video.")
        root = Path(settings.SHARE_ROOT) if data.storage == "share" else data.get_upload_dirname()
        source = root / video.path
    if not source.is_file():
        raise NotFound("The source video is unavailable.")
    stat = source.stat()
    identity = ("scrub-v1", str(source), stat.st_mtime_ns, stat.st_size, data.start_frame,
                data.get_frame_step(), job.segment.start_frame, job.segment.stop_frame)
    version = hashlib.sha256(repr(identity).encode()).hexdigest()[:16]
    return source, Path(job.get_dirname()) / "scrub-preview" / version, version


def build_preview(source, directory, timestamps, start, stop):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "build.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if (directory / "manifest.json").exists():
            return
        try:
            targets = sample_frames(timestamps, start, stop)
            frames, sheets = [], []
            sheet = Image.new("RGB", (CELL * COLUMNS, CELL * COLUMNS))

            def save_sheet():
                name = f"{len(sheets)}.jpg"
                temporary = directory / f"{name}.{os.getpid()}.tmp"
                sheet.save(temporary, format="JPEG", quality=65, optimize=True)
                temporary.replace(directory / name)
                sheets.append(name)

            with av.open(str(source)) as container:
                stream = container.streams.video[0]
                stream.thread_type = "AUTO"
                stream.codec_context.thread_count = 4
                origin = float((stream.start_time or 0) * stream.time_base)
                container.seek(int((timestamps[start] + origin) / stream.time_base), stream=stream, backward=True)
                wanted = 0
                for decoded in container.decode(stream):
                    if decoded.pts is None:
                        continue
                    time = float(decoded.pts * stream.time_base) - origin
                    if time < timestamps[targets[wanted]] - 0.00001:
                        continue
                    actual = bisect.bisect_left(timestamps, time - 0.00001, start, stop + 1)
                    if actual > stop:
                        break
                    scale = min(CELL / decoded.width, CELL / decoded.height)
                    thumb = decoded.reformat(width=max(1, int(decoded.width * scale)),
                                             height=max(1, int(decoded.height * scale)), format="rgb24").to_image()
                    position = len(frames) % PER_SHEET
                    sheet.paste(thumb, ((position % COLUMNS) * CELL + (CELL - thumb.width) // 2,
                                        (position // COLUMNS) * CELL + (CELL - thumb.height) // 2))
                    frames.append(actual)
                    wanted += 1
                    if len(frames) % PER_SHEET == 0:
                        save_sheet()
                        sheet = Image.new("RGB", (CELL * COLUMNS, CELL * COLUMNS))
                    if wanted == len(targets):
                        break
                if wanted != len(targets):
                    raise ValueError("Source timestamps did not match preview samples")
            if len(frames) % PER_SHEET:
                save_sheet()
            manifest = {"frames": frames, "sheets": sheets, "cell": CELL, "columns": COLUMNS,
                        "per_sheet": PER_SHEET}
            temporary = directory / "manifest.tmp"
            temporary.write_text(json.dumps(manifest))
            temporary.replace(directory / "manifest.json")
        except Exception:
            logger.exception("Could not prepare scrub preview")
            (directory / "error.json").write_text(json.dumps({"state": "error"}))


def preview_state(job):
    source, directory, version = preview_location(job)
    manifest_path = directory / "manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text())
        manifest["sheets"] = [f"/api/jobs/{job.pk}/scrub-preview/{version}/{index}"
                              for index in range(len(manifest["sheets"]))]
        return {"state": "ready", **manifest}
    if (directory / "error.json").exists():
        return {"state": "error"}
    key = str(directory)
    with _pending_lock:
        if key not in _pending and len(_pending) < 2:
            timing = job_video_timing(job)
            _pending.add(key)
            future = _executor.submit(build_preview, source, directory, timing["timestamps"],
                                      job.segment.start_frame, job.segment.stop_frame)
            def finished(_future):
                with _pending_lock:
                    _pending.discard(key)
            # Registration must happen outside the lock: an already-completed future
            # invokes the callback synchronously.
        else:
            future = None
    if future is not None:
        future.add_done_callback(finished)
    return {"state": "preparing"}


def preview_sheet(job, version, index):
    _, directory, expected = preview_location(job)
    if version != expected or not (directory / "manifest.json").is_file():
        raise NotFound("Preview is not ready.")
    manifest = json.loads((directory / "manifest.json").read_text())
    if index < 0 or index >= len(manifest["sheets"]):
        raise NotFound("Invalid preview sheet.")
    return directory / f"{index}.jpg"
