"""Queued exports use an immutable saved annotation snapshot, scoped to one job."""
import json
import logging
import shutil
import time
import uuid
from collections import defaultdict
from pathlib import Path

import django_rq
from django.conf import settings
from rq import get_current_job
from rq.exceptions import NoSuchJobError
from rest_framework.exceptions import NotFound, ValidationError

from cvat.apps.dataset_manager import task as annotations
from cvat.apps.dataset_manager.annotation import AnnotationIR, AnnotationManager
from cvat.apps.engine import models
from cvat.apps.engine.frame_provider import FrameOutputType, JobFrameProvider
from .timing import job_video_timing, probe_timing
from .video_export_render import encode_video, frame_durations, render_frame

logger = logging.getLogger(__name__)
SUPPORTED = {"rectangle", "mask", "polygon", "polyline", "points", "ellipse"}
TTL = 86400


def export_root(job):
    return Path(job.get_dirname()) / "overlay-exports"


def queue():
    return django_rq.get_queue("export")


def create_export(job, options):
    if job.segment.task.dimension != models.DimensionType.DIM_2D:
        raise ValidationError("Only 2D video jobs can be exported.")
    start, stop = options["start_frame"], options["stop_frame"]
    if start < job.segment.start_frame or stop > job.segment.stop_frame or start > stop:
        raise ValidationError("Choose an inclusive frame range within this job.")
    timing = job_video_timing(job)
    data = job.segment.task.data
    if getattr(job.segment.task, "original_video", None) is None:
        root = Path(settings.SHARE_ROOT) if data.storage == "share" else data.get_upload_dirname()
        source = root / data.video.path
        stat = source.stat()
        source_times, source_duration = probe_timing(str(source), stat.st_mtime_ns, stat.st_size)
        next_source_frame = data.start_frame + data.size * data.get_frame_step()
        timing["duration"] = source_times[next_source_frame] if next_source_frame < len(source_times) else source_duration
    deleted = set(data.deleted_frames)
    included = sorted((absolute - data.start_frame) // data.get_frame_step()
                      for absolute in job.segment.frame_set)
    frames = [frame for frame in included if start <= frame <= stop and frame not in deleted]
    if not frames:
        raise ValidationError("This range has no available frames.")
    current = annotations.get_job_data(job.pk)
    unsupported = {shape["type"] for shape in current["shapes"] if start <= shape["frame"] <= stop} - SUPPORTED
    unsupported.update(shape["type"] for track in current["tracks"] for shape in track["shapes"]
                       if shape["type"] not in SUPPORTED)
    if unsupported:
        raise ValidationError(f'Unsupported video geometry: {", ".join(sorted(unsupported))}.')
    used_labels = {item["label_id"] for item in current["shapes"] + current["tags"]
                   if start <= item["frame"] <= stop}
    used_labels.update(track["label_id"] for track in current["tracks"])
    labels = {label.id: {"name": label.name, "color": label.color} for label in job.get_labels()
              if label.id in used_labels}
    identities = {str(saved["id"]): saved["object_id"]
                  for run in job.video_runs.filter(status="accepted") for saved in run.accepted_shapes}
    identifier = str(uuid.uuid4())
    root = export_root(job)
    root.mkdir(parents=True, exist_ok=True)
    # Retain completed downloads for one day. No user data outside this export cache is touched.
    for previous in root.iterdir():
        if previous.is_dir() and time.time() - previous.stat().st_mtime > TTL:
            shutil.rmtree(previous)
    directory = root / identifier
    directory.mkdir()
    snapshot = {"annotations": current, "labels": labels, "identities": identities,
                "frames": frames, "deleted_frames": sorted(deleted), "timing": timing, "options": options}
    try:
        (directory / "snapshot.json").write_text(json.dumps(snapshot))
        queue().enqueue(generate_export, job.pk, identifier, job_id=f"overlay-{job.pk}-{identifier}",
                        job_timeout=3600, result_ttl=TTL, failure_ttl=TTL,
                        meta={"job_id": job.pk, "progress": 0})
    except Exception:
        shutil.rmtree(directory)
        raise
    return {"id": identifier, "state": "queued", "progress": 0}


def export_status(job, identifier):
    try:
        queued = queue().fetch_job(f"overlay-{job.pk}-{identifier}")
    except NoSuchJobError:
        queued = None
    if queued is None or queued.meta.get("job_id") != job.pk:
        raise NotFound("The video export has expired or does not exist. Create a new export.")
    status = queued.get_status(refresh=True)
    state = str(getattr(status, "value", status))
    if state == "finished":
        state = "ready" if (export_root(job) / identifier / "video.mp4").is_file() else "failed"
    elif state in {"failed", "stopped", "canceled"}:
        state = "failed"
    elif state == "started":
        state = "running"
    else:
        state = "queued"
    result = {"id": identifier, "state": state, "progress": queued.meta.get("progress", 0)}
    if state == "failed":
        result["error"] = "Video export failed or timed out. Retry with a shorter range."
    return result


def generate_export(job_id, identifier):
    job = models.Job.objects.select_related("segment__task__data").get(pk=job_id)
    directory = export_root(job) / identifier
    temporary = directory / "video.part.mp4"
    queued = get_current_job()
    provider = None
    try:
        snapshot = json.loads((directory / "snapshot.json").read_text())
        frames, options = snapshot["frames"], snapshot["options"]
        labels = {int(key): value for key, value in snapshot["labels"].items()}
        current = snapshot["annotations"]
        manager = AnnotationManager(AnnotationIR(models.DimensionType.DIM_2D, current),
                                    dimension=models.DimensionType.DIM_2D)
        shapes = iter(manager.to_shapes(options["stop_frame"] + 1, included_frames=set(frames),
                                       deleted_frames=snapshot["deleted_frames"],
                                       use_server_track_ids=True))
        next_shape = next(shapes, None)
        tags = defaultdict(list)
        for tag in current["tags"]:
            tags[tag["frame"]].append(tag)
        provider = JobFrameProvider(job)

        def image_at(number):
            nonlocal next_shape
            visible = []
            while next_shape is not None and next_shape["frame"] <= number:
                if next_shape["frame"] == number:
                    visible.append(next_shape)
                next_shape = next(shapes, None)
            image = provider.get_frame(number, out_type=FrameOutputType.PIL).data
            return render_frame(image, visible, tags[number], labels, options, number, snapshot["identities"])

        last_progress = -1

        def progress(value):
            nonlocal last_progress
            if queued and value != last_progress:
                queued.meta["progress"] = value
                queued.save_meta()
                last_progress = value

        durations = frame_durations(frames, snapshot["timing"]["timestamps"], snapshot["timing"]["duration"])
        encode_video(temporary, frames, durations, image_at, progress)
        temporary.replace(directory / "video.mp4")
    except Exception:
        logger.exception("Overlay video export failed for job %s", job_id)
        raise
    finally:
        if provider is not None:
            provider.unload()
        temporary.unlink(missing_ok=True)
        (directory / "snapshot.json").unlink(missing_ok=True)
