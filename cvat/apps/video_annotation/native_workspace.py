"""Native CVAT jobs backed by an original MP4, without pre-extracted images."""
import bisect
import os
from io import BytesIO
import zipfile

import av
from django.db import transaction
from rest_framework.exceptions import ValidationError

from cvat.apps.engine import models
from .models import OriginalVideo
from .video_jobs import time_job_ranges


def source_info(video, job_id):
    return {
        "id": str(video.id), "project_id": video.project_id,
        "duration": video.duration, "filename": video.filename,
        "timestamps": video.timestamps,
        "url": f"/api/jobs/{job_id}/original-video",
    }


def link_original(video, data):
    raw = data.get_upload_dirname()
    raw.mkdir(parents=True, exist_ok=True)
    source = raw / "source.mp4"
    if not source.exists():
        os.link(video.path, source)
    models.Video.objects.filter(data=data).update(path="source.mp4")
    models.ClientFile.objects.get_or_create(data=data, file=str(source))


@transaction.atomic
def ensure_workspace(video_id, segment_duration=None):
    video = OriginalVideo.objects.select_for_update().select_related("project").get(pk=video_id)
    if video.task_id:
        link_original(video, video.task.data)
        job = models.Job.objects.filter(segment__task_id=video.task_id).order_by("segment__start_frame", "id").first()
        return video, job
    with av.open(str(video.path)) as container:
        stream = container.streams.video[0]
        # MP4 packet presentation timestamps provide an index without decoding frames.
        timestamps = sorted({float(packet.pts * stream.time_base)
                             for packet in container.demux(stream) if packet.pts is not None})
    if not timestamps:
        raise ValidationError("Cannot index the original video's presentation timestamps.")
    origin = timestamps[0]
    video.timestamps = [value - origin for value in timestamps]
    try:
        ranges = time_job_ranges(video.timestamps, segment_duration)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    data = models.Data.objects.create(size=len(timestamps), chunk_size=8, image_quality=85,
                                      start_frame=0, stop_frame=len(timestamps) - 1,
                                      compressed_chunk_type=models.DataChoice.IMAGESET,
                                      original_chunk_type=models.DataChoice.IMAGESET)
    data.make_dirs()
    models.Video.objects.create(data=data, path=str(video.path), width=video.width, height=video.height)
    link_original(video, data)
    task = models.Task.objects.create(project=video.project, owner=video.owner, name=video.name,
                                      mode="interpolation", data=data, overlap=0,
                                      segment_size=max(stop - start + 1 for start, stop in ranges),
                                      organization=video.project.organization)
    task.get_dirname().mkdir(parents=True, exist_ok=True)
    jobs = []
    for start, stop in ranges:
        segment = models.Segment.objects.create(task=task, start_frame=start, stop_frame=stop)
        job = models.Job.objects.create(segment=segment)
        job.get_dirname().mkdir(parents=True, exist_ok=True)
        jobs.append(job)
    job = jobs[0]
    video.task = task
    video.save(update_fields=["task", "timestamps"])
    # Preserve annotations made in the earlier interval-based editor as native tracks.
    if video.annotations:
        from cvat.apps.dataset_manager import task as annotations
        tracks = []
        for shape in video.annotations:
            start = min(bisect.bisect_left(video.timestamps, shape["start"]), data.stop_frame)
            end = bisect.bisect_left(video.timestamps, shape["end"])
            points = [value * (video.width if index % 2 == 0 else video.height)
                      for index, value in enumerate(shape["points"])]
            keyframe = dict(type=shape["type"], frame=start, points=points,
                            occluded=False, outside=False, z_order=0, rotation=0, attributes=[])
            keyframes = [keyframe]
            if end <= data.stop_frame:
                keyframes.append({**keyframe, "frame": max(start + 1, end), "outside": True})
            tracks.append(dict(label_id=shape["label_id"], frame=start, group=0,
                               source="manual", attributes=[], shapes=keyframes))
        annotations.put_task_data(task.id, {"version": 0, "tags": [], "shapes": [], "tracks": tracks})
    return video, job


def original_chunk(video, segment, chunk_number, quality):
    """Decode only requested frames for server tools/export; never persist frame files."""
    indices = sorted(segment.frame_set)[chunk_number * 8:(chunk_number + 1) * 8]
    if not indices:
        raise ValidationError("Invalid video chunk.")
    wanted = set(indices)
    output = BytesIO()
    with av.open(str(video.path)) as container, zipfile.ZipFile(output, "w") as archive:
        stream = container.streams.video[0]
        origin = float((stream.start_time or 0) * stream.time_base)
        target = video.timestamps[indices[0]] + origin
        container.seek(int(target / stream.time_base), stream=stream, backward=True)
        found = set()
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            timestamp = float(frame.pts * stream.time_base) - origin
            index = bisect.bisect_left(video.timestamps, timestamp - 0.000001)
            if index > indices[-1]:
                break
            if index not in wanted or index in found:
                continue
            encoded = BytesIO()
            original = quality == models.FrameQuality.ORIGINAL
            frame.to_image().save(encoded, format="PNG" if original else "JPEG", quality=85, compress_level=0)
            archive.writestr(f"{index:06d}.{'png' if original else 'jpg'}", encoded.getvalue())
            found.add(index)
        if found != wanted:
            raise ValidationError("Could not decode the requested original-video timestamps.")
    output.seek(0)
    return output, "application/zip"
