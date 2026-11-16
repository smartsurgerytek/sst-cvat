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
from cvat.apps.engine.frame_provider import FrameOutputType, JobFrameProvider, TaskFrameProvider
from .timing import job_video_timing, task_video_timing, probe_timing
from .video_export_render import encode_video, frame_durations, render_comparison

logger = logging.getLogger(__name__)
SUPPORTED = {"rectangle", "mask", "polygon", "polyline", "points", "ellipse"}
TTL = 86400


def export_root(job):
    return Path(job.get_dirname()) / "overlay-exports"


def queue():
    return django_rq.get_queue("export")


def create_export(job, options, *, task_export=False):
    task = job if task_export else job.segment.task
    if task.dimension != models.DimensionType.DIM_2D:
        raise ValidationError("Only 2D video jobs can be exported.")
    start, stop = options["start_frame"], options["stop_frame"]
    first, last = (0, task.data.size - 1) if task_export else (job.segment.start_frame, job.segment.stop_frame)
    if start < first or stop > last or start > stop:
        raise ValidationError("Choose an inclusive frame range within this job.")
    timing = task_video_timing(task) if task_export else job_video_timing(job)
    data = task.data
    if getattr(task, "original_video", None) is None:
        root = Path(settings.SHARE_ROOT) if data.storage == "share" else data.get_upload_dirname()
        source = root / data.video.path
        stat = source.stat()
        source_times, source_duration = probe_timing(str(source), stat.st_mtime_ns, stat.st_size)
        next_source_frame = data.start_frame + data.size * data.get_frame_step()
        timing["duration"] = source_times[next_source_frame] if next_source_frame < len(source_times) else source_duration
    deleted = set(data.deleted_frames)
    included = range(data.size) if task_export else sorted(
        (absolute - data.start_frame) // data.get_frame_step() for absolute in job.segment.frame_set)
    frames = [frame for frame in included if start <= frame <= stop and frame not in deleted]
    if not frames:
        raise ValidationError("This range has no available frames.")
    current = annotations.get_task_data(job.pk) if task_export else annotations.get_job_data(job.pk)
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
    if task_export:
        from .models import InferenceRun
        runs = InferenceRun.objects.filter(job__segment__task=task, status="accepted")
    else:
        runs = job.video_runs.filter(status="accepted")
    identities = {str(saved["id"]): saved["object_id"] for run in runs for saved in run.accepted_shapes}
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
        queue().enqueue(generate_export, job.pk, identifier, job_id=export_key(job, identifier, task_export),
                        job_timeout=3600, result_ttl=TTL, failure_ttl=TTL,
                        meta={"job_id": job.pk, "progress": 0}, **({"task_export": True} if task_export else {}))
    except Exception:
        shutil.rmtree(directory)
        raise
    return {"id": identifier, "state": "queued", "progress": 0}


def export_key(job, identifier, task_export=False):
    return f"overlay-{'task-' if task_export else ''}{job.pk}-{identifier}"


def export_status(job, identifier, *, task_export=False):
    try:
        queued = queue().fetch_job(export_key(job, identifier, task_export))
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


def preview_export(job, options):
    """Render current client annotations without saving or starting an export worker."""
    frame = options["frame"]
    if job.segment.task.dimension != models.DimensionType.DIM_2D:
        raise ValidationError("Only 2D video jobs can be previewed.")
    if not job.segment.start_frame <= options["start_frame"] <= frame <= options["stop_frame"] <= job.segment.stop_frame:
        raise ValidationError("Choose a preview frame within the export range.")
    if frame in job.segment.task.data.deleted_frames:
        raise ValidationError("This frame is deleted. Choose another preview frame.")
    shapes, tags = options["shapes"], options["tags"]
    labels = {label.id: {"name": label.name, "color": label.color} for label in job.get_labels()}
    if any(item["label_id"] not in labels for item in shapes + tags):
        raise ValidationError("Preview labels must belong to this job.")
    if any(shape["type"] not in SUPPORTED for shape in shapes):
        raise ValidationError("Unsupported preview geometry.")
    identities = {str(saved["id"]): saved["object_id"]
                  for run in job.video_runs.filter(status="accepted") for saved in run.accepted_shapes}
    provider = JobFrameProvider(job)
    try:
        image = provider.get_frame(frame, out_type=FrameOutputType.PIL).data
        result = render_comparison(image, shapes, tags, labels, options, frame, identities)
        result.thumbnail((1600, 900))
        return result
    except ValueError as error:
        raise ValidationError(str(error)) from error
    finally:
        provider.unload()


def export_source_spec(task, timing):
    native = getattr(task, "original_video", None)
    if native is not None:
        return {"path": str(native.path), "timestamps": timing["timestamps"], "start": 0, "step": 1, "rotate": False}
    data = task.data
    if getattr(data, "video", None) is None:
        return None
    root = Path(settings.SHARE_ROOT) if data.storage == "share" else Path(data.get_upload_dirname())
    path = root / data.video.path
    stat = path.stat()
    timestamps, _ = probe_timing(str(path), stat.st_mtime_ns, stat.st_size)
    return {"path": str(path), "timestamps": timestamps, "start": data.start_frame,
            "step": data.get_frame_step(), "rotate": True}


def generate_export(job_id, identifier, *, task_export=False):
    job = (models.Task.objects.select_related("data").get(pk=job_id) if task_export else
           models.Job.objects.select_related("segment__task__data").get(pk=job_id))
    task = job if task_export else job.segment.task
    directory = export_root(job) / identifier
    temporary = directory / "video.part.mp4"
    queued = get_current_job()
    provider = None
    source = None
    try:
        snapshot = json.loads((directory / "snapshot.json").read_text())
        frames, options = snapshot["frames"], snapshot["options"]
        last_progress = -1

        def progress(value):
            nonlocal last_progress
            if queued and value != last_progress:
                queued.meta["progress"] = value
                queued.save_meta()
                last_progress = value

        source_spec = export_source_spec(task, snapshot["timing"])
        from .video_export_parallel import parallel_export, process_count
        video = getattr(task.data, "video", None)
        workers = process_count(len(frames), getattr(video, "width", 1920), getattr(video, "height", 1080)) \
            if source_spec and len(frames) >= 240 else 1
        if workers > 1:
            parallel_export(directory / "snapshot.json", source_spec, temporary, progress, workers)
        else:
            labels = {int(key): value for key, value in snapshot["labels"].items()}
            current = snapshot["annotations"]
            manager = AnnotationManager(AnnotationIR(models.DimensionType.DIM_2D, current),
                                        dimension=models.DimensionType.DIM_2D)
            shapes = iter(manager.to_shapes(options["stop_frame"] + 1, included_frames=set(frames),
                                           deleted_frames=snapshot["deleted_frames"], use_server_track_ids=True))
            next_shape = next(shapes, None)
            tags = defaultdict(list)
            for tag in current["tags"]:
                tags[tag["frame"]].append(tag)
            if source_spec:
                from .video_export_source import source_frames
                source = source_frames(source_spec["path"], source_spec["timestamps"],
                                       [source_spec["start"] + number * source_spec["step"] for number in frames],
                                       apply_rotation=source_spec["rotate"])
            else:
                provider = TaskFrameProvider(job) if task_export else JobFrameProvider(job)

            def image_at(number):
                nonlocal next_shape
                visible = []
                while next_shape is not None and next_shape["frame"] <= number:
                    if next_shape["frame"] == number:
                        visible.append(next_shape)
                    next_shape = next(shapes, None)
                image = next(source) if source is not None else provider.get_frame(number, out_type=FrameOutputType.PIL).data
                return render_comparison(image, visible, tags[number], labels, options, number, snapshot["identities"])

            durations = frame_durations(frames, snapshot["timing"]["timestamps"], snapshot["timing"]["duration"])
            encode_video(temporary, frames, durations, image_at, lambda value: progress(min(99, value)))
        temporary.replace(directory / "video.mp4")
        progress(100)
    except Exception:
        logger.exception("Overlay video export failed for job %s", job_id)
        raise
    finally:
        if source is not None:
            source.close()
        if provider is not None:
            provider.unload()
        temporary.unlink(missing_ok=True)
        (directory / "snapshot.json").unlink(missing_ok=True)
