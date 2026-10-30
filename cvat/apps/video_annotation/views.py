import gzip
import json
import math
import re
import tempfile
import zipfile

import django_rq
import requests
from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.http import FileResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from cvat.apps.dataset_manager import task as annotations
from cvat.apps.engine import models
from cvat.apps.engine.frame_provider import FrameOutputType, JobFrameProvider
from cvat.apps.engine.serializers import LabeledDataSerializer
from .models import InferenceRun
from .serializers import CreateRunSerializer, DeleteMaskSerializer, DeleteResultsSerializer, RunSerializer, UpdateMaskSerializer
from .utils import coco_rle, decode_mask, fingerprint, shape_signature
from .worker import execute, run_directory


def describe(run):
    return RunSerializer(run).data


def managed_results(job, current):
    """Join live annotations with recorded SAM2 provenance, never just source=auto."""
    shapes = {shape["id"]: shape for shape in current["shapes"]}
    labels = {label.id: label for label in job.get_labels()}
    groups = []
    for run in job.video_runs.filter(status="accepted"):
        by_label = {}
        for saved in run.accepted_shapes:
            shape = shapes.get(saved["id"])
            if shape is None:
                continue
            label_id = shape["label_id"]
            label = labels.get(label_id)
            group = by_label.setdefault(label_id, {
                "run_id": str(run.id), "created_date": run.created_date,
                "label_id": label_id, "label_name": label.name if label else str(label_id),
                "label_color": label.color if label else "#808080",
                "count": 0, "edited_count": 0, "frames": [],
            })
            group["count"] += 1
            group["edited_count"] += int(shape_signature(shape) != saved["signature"])
            group["frames"].append(shape["frame"])
        for group in by_label.values():
            group["frames"] = sorted(set(group["frames"]))
            groups.append(group)
    return {"version": fingerprint(current), "groups": groups}


def media_response(path, request):
    size = path.stat().st_size
    range_header = request.headers.get("Range")
    if not range_header:
        response = FileResponse(path.open("rb"), content_type="video/mp4")
        response["Accept-Ranges"] = "bytes"
        return response
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
    if not match or not any(match.groups()) or not size:
        response = Response(status=416)
        response["Content-Range"] = f"bytes */{size}"
        return response
    if match[1]:
        start = int(match[1])
        end = min(int(match[2]) if match[2] else size - 1, size - 1)
    else:
        start = max(0, size - int(match[2]))
        end = size - 1
    if start > end:
        response = Response(status=416)
        response["Content-Range"] = f"bytes */{size}"
        return response

    def chunks():
        with path.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    response = StreamingHttpResponse(chunks(), status=206, content_type="video/mp4")
    response["Content-Length"] = end - start + 1
    response["Content-Range"] = f"bytes {start}-{end}/{size}"
    response["Accept-Ranges"] = "bytes"
    return response


class VideoInferenceMixin:
    @action(detail=True, methods=["post"], url_path="sam1")
    def sam1(self, request, pk=None):
        from .sam1 import infer
        return infer(self.get_object(), request.data)

    @action(detail=True, methods=["get"], url_path="original-video")
    def original_video_media(self, request, pk=None):
        job = self.get_object()
        video = getattr(job.segment.task, "original_video", None)
        if video is None or not video.path.is_file():
            raise NotFound("The original video file is missing.")
        response = media_response(video.path, request)
        response["Cache-Control"] = "private, no-store"
        return response

    @action(detail=True, methods=["get"], url_path=r"original-video/segments/(?P<segment_index>[0-9]+)")
    def original_video_segment(self, request, pk=None, segment_index=None):
        job = self.get_object()
        video = getattr(job.segment.task, "original_video", None)
        if video is None or not video.path.is_file():
            raise NotFound("The original video file is missing.")
        from .video_segments import cached_segment
        try:
            profile = request.query_params.get("profile", "preview")
            if profile not in {"original", "preview"}:
                raise ValueError("Invalid video profile")
            path, start, end, codec = cached_segment(video, int(segment_index), original=profile == "original")
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        response = media_response(path, request)
        response["X-Video-Start"] = str(start)
        response["X-Video-End"] = str(end)
        response["X-Video-Codec"] = codec
        response["Cache-Control"] = "private, no-store"
        return response

    @action(detail=True, methods=["get", "delete"], url_path="video-inference/results")
    def video_inference_results(self, request, pk=None):
        job = self.get_object()
        with transaction.atomic():
            models.Job.objects.select_for_update().get(pk=job.pk)
            current = annotations.get_job_data(job.pk)
            if request.method == "DELETE":
                serializer = DeleteResultsSerializer(data=request.data)
                serializer.is_valid(raise_exception=True)
                params = serializer.validated_data
                run = get_object_or_404(
                    InferenceRun, pk=params["run_id"], job=job, status="accepted",
                )
                if params["version"] != fingerprint(current):
                    return Response({"detail": "Annotations changed. Refresh the results before deleting."}, status=409)
                generated_ids = {entry["id"] for entry in run.accepted_shapes}
                remove = [shape for shape in current["shapes"]
                          if shape["id"] in generated_ids and shape["label_id"] == params["label_id"]]
                if remove:
                    annotations.patch_job_data(
                        job.pk, {"shapes": remove, "tracks": [], "tags": []}, annotations.PatchAction.DELETE,
                    )
                current = annotations.get_job_data(job.pk)
            return Response(managed_results(job, current))

    @action(detail=True, methods=["get"],
            url_path=r"video-inference/(?P<run_id>[0-9a-f-]{36})/playback")
    def video_inference_playback(self, request, pk=None, run_id=None):
        job = self.get_object()
        run = get_object_or_404(InferenceRun, pk=run_id, job=job, status__in=["ready", "accepted"])
        from .playback import build_playback_snapshot

        labels = {label.id: label for label in job.get_labels()}
        current = annotations.get_job_data(job.pk)["shapes"] if run.status == "accepted" else None
        response = Response(build_playback_snapshot(run, labels, current))
        response["Cache-Control"] = "private, no-store"
        return response

    @action(detail=True, methods=["get", "patch", "delete"],
            url_path=r"video-inference/(?P<run_id>[0-9a-f-]{36})/masks")
    def video_inference_masks(self, request, pk=None, run_id=None):
        job = self.get_object()
        with transaction.atomic():
            if request.method != "GET":
                models.Job.objects.select_for_update().get(pk=job.pk)
            run = get_object_or_404(
                InferenceRun.objects.defer("result"), pk=run_id, job=job, status__in=["ready", "accepted"],
            )
            current = annotations.get_job_data(job.pk) if run.status == "accepted" else {"shapes": []}
            shapes = {shape["id"]: shape for shape in current["shapes"]}
            if request.method in {"PATCH", "DELETE"}:
                serializer_class = UpdateMaskSerializer if request.method == "PATCH" else DeleteMaskSerializer
                serializer = serializer_class(data=request.data)
                serializer.is_valid(raise_exception=True)
                params = serializer.validated_data
                generated = {saved["id"] for saved in run.accepted_shapes}
                shape = shapes.get(params["shape_id"])
                if run.status != "accepted" or shape is None or shape["id"] not in generated:
                    return Response({"detail": "This mask is no longer an accepted result."}, status=404)
                if shape_signature(shape) != params["version"]:
                    return Response({"detail": "This mask changed. Reload before applying adjustments."}, status=409)
                if request.method == "DELETE":
                    annotations.patch_job_data(job.pk, {"shapes": [shape], "tracks": [], "tags": []},
                                               annotations.PatchAction.DELETE)
                    return Response({"deleted": shape["id"]})
                try:
                    mask = decode_mask(params["points"], run.result["width"], run.result["height"])
                except ValueError as exc:
                    raise ValidationError(str(exc)) from exc
                if not mask.any():
                    raise ValidationError("Post-processing removed the whole mask. Adjust the parameters or delete it explicitly.")
                shape["points"] = params["points"]
                payload = LabeledDataSerializer(data={"shapes": [shape], "tracks": [], "tags": []},
                                               context={"annotation_action": annotations.PatchAction.UPDATE})
                payload.is_valid(raise_exception=True)
                annotations.patch_job_data(job.pk, payload.validated_data, annotations.PatchAction.UPDATE)
                return Response({"updated": shape["id"]})
            try:
                frame = int(request.query_params.get("frame", run.start_frame))
            except (ValueError, TypeError) as exc:
                raise ValidationError("Invalid frame.") from exc
            if not run.start_frame <= frame <= run.stop_frame:
                raise ValidationError("Frame is outside this run.")
            # Read only this frame from JSONB, not every mask in the entire run.
            result = InferenceRun.objects.filter(pk=run.pk).annotate(
                review_width=F("result__width"), review_height=F("result__height"),
                review_frame=F(f"result__frames__{frame - run.start_frame}"),
            ).values("review_width", "review_height", "review_frame").get()
            run.result = {"width": result["review_width"], "height": result["review_height"],
                          "frames": [result["review_frame"]] if result["review_frame"] else []}
            labels = {label.id: label for label in job.get_labels()}
            objects = []
            if run.status == "accepted":
                for saved in run.accepted_shapes:
                    shape = shapes.get(saved["id"])
                    if shape is not None and shape["frame"] == frame:
                        objects.append({"object_id": saved["object_id"], "shape_id": shape["id"],
                                        "label_id": shape["label_id"], "points": shape["points"],
                                        "version": shape_signature(shape)})
            else:
                prompts = {prompt["object_id"]: prompt for prompt in run.prompts}
                for entry in run.result["frames"]:
                    if entry["frame"] == frame:
                        objects = [{**obj, "label_id": prompts[obj["object_id"]]["label_id"],
                                    "shape_id": None, "version": None}
                                   for obj in entry["objects"] if obj["points"] is not None]
                        break
            scores_path = run_directory(run) / f"logits-{frame}.json.gz"
            scores = {}
            if scores_path.is_file():
                with gzip.open(scores_path, "rt") as source:
                    scores = json.load(source)
            for obj in objects:
                obj["logits"] = scores.get(obj["object_id"])
                label = labels.get(obj["label_id"])
                obj["label_name"] = label.name if label else str(obj["label_id"])
                obj["label_color"] = label.color if label else "#808080"
            payload = {"frame": frame, "width": run.result["width"],
                       "height": run.result["height"], "objects": objects}
            if request.query_params.get("preview") == "1":
                from .playback import preview_masks
                payload = preview_masks(payload)
            return Response(payload)

    @action(detail=True, methods=["get", "post"], url_path="video-inference")
    def video_inference(self, request, pk=None):
        job = self.get_object()  # Enforce existing job/org permissions before reading anything.
        if request.method == "GET":
            return Response(RunSerializer(job.video_runs.defer("result", "prompts", "accepted_shapes")[:20], many=True).data)
        serializer = CreateRunSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        params = serializer.validated_data
        start, stop = params["start_frame"], params["stop_frame"]
        if job.segment.task.dimension != models.DimensionType.DIM_2D:
            raise ValidationError("SAM2 requires a 2D job.")
        if job.type != models.JobType.ANNOTATION:
            raise ValidationError("Use a regular annotation job.")
        if not job.segment.start_frame <= start < stop <= job.segment.stop_frame:
            raise ValidationError("Select at least two frames inside this job.")
        if stop - start + 1 > settings.SAM2_MAX_FRAMES:
            raise ValidationError(f"Select at most {settings.SAM2_MAX_FRAMES} frames per run.")
        deleted = set(job.segment.task.data.deleted_frames)
        if any(frame in deleted for frame in range(start, stop + 1)):
            raise ValidationError("The selected range contains deleted frames.")
        # Video dimensions are indexed at upload. Decoding a frame here can wait
        # for chunk generation before the request has even created a queued run.
        video = models.Video.objects.filter(data_id=job.segment.task.data_id).first()
        if video is not None:
            width, height = video.width, video.height
        else:
            provider = JobFrameProvider(job)
            try:
                width, height = provider.get_frame(start, out_type=FrameOutputType.PIL).data.size
            finally:
                provider.unload()
        if width * height > 3840 * 2160:
            raise ValidationError("Maximum frame resolution is 4K for this version.")
        snapshot = annotations.get_job_data(job.pk)
        known_objects = {}
        for previous in job.video_runs.filter(status="accepted").order_by("created_date"):
            for saved in previous.accepted_shapes:
                known_objects[saved["id"]] = saved["object_id"]
        seen = set()
        for prompt in params["prompts"]:
            object_id = known_objects.get(prompt["id"]) if prompt["kind"] == "shape" else None
            object_id = object_id or f'{prompt["kind"]}:{prompt["id"]}'
            if object_id in seen:
                raise ValidationError("Each object may be selected only once.")
            seen.add(object_id)
            candidates = snapshot["shapes" if prompt["kind"] == "shape" else "tracks"]
            seed = next((s for s in candidates if s["id"] == prompt["id"]), None)
            if not seed or seed["label_id"] != prompt["label_id"]:
                raise ValidationError("Save the selected objects before running SAM2.")
            if prompt["kind"] == "shape" and (
                seed["frame"] != start or seed["type"] != prompt["type"]
            ):
                raise ValidationError("Selected shapes must belong to the starting frame.")
            if prompt["kind"] == "track":
                raise ValidationError(
                    "First version: use standalone polygon or mask shapes, not tracks."
                )
            # Use the persisted geometry/attributes, never an uncommitted client copy.
            prompt["points"] = seed["points"]
            prompt["attributes"] = seed["attributes"]
            points = prompt["points"]
            if prompt["type"] == "mask":
                try:
                    decode_mask(points, width, height)
                except ValueError as exc:
                    raise ValidationError(str(exc)) from exc
            elif (
                len(points) < 6
                or len(points) % 2
                or any(
                    not math.isfinite(v) or not 0 <= v <= (width if i % 2 == 0 else height)
                    for i, v in enumerate(points)
                )
            ):
                raise ValidationError("Polygon coordinates exceed the image bounds.")
            prompt["object_id"] = object_id
        try:
            health = requests.get(settings.SAM2_URL + "/health", timeout=3)
            health.raise_for_status()
            if health.json().get("model") != settings.SAM2_MODEL:
                raise ValidationError("SAM2 service model does not match the configured model.")
        except requests.RequestException:
            return Response(
                {"detail": "SAM2 is unavailable. Start the SAM2 Docker Compose profile."},
                status=503,
            )
        with transaction.atomic():
            models.Job.objects.select_for_update().get(pk=job.pk)
            if job.video_runs.filter(status__in=["queued", "running"]).exists():
                return Response(
                    {"detail": "This job already has an active inference run."}, status=409
                )
            run = InferenceRun.objects.create(
                job=job,
                owner=request.user,
                model=settings.SAM2_MODEL,
                fingerprint=fingerprint(snapshot),
                **params,
            )

            def enqueue():
                try:
                    django_rq.get_queue("annotation").enqueue(
                        execute,
                        str(run.id),
                        job_id=f"video-inference-{run.id}",
                        job_timeout=7200,
                        result_ttl=86400,
                        on_failure=inference_failure,
                    )
                except Exception:
                    InferenceRun.objects.filter(pk=run.pk).update(
                        status="failed", error="Could not enqueue inference."
                    )

            transaction.on_commit(enqueue)
        run.refresh_from_db()
        return Response(describe(run), status=202)

    @action(
        detail=True,
        methods=["get", "delete"],
        url_path=r"video-inference/(?P<run_id>[0-9a-f-]{36})",
    )
    def video_inference_run(self, request, pk=None, run_id=None):
        job = self.get_object()
        run = get_object_or_404(InferenceRun, pk=run_id, job=job)
        if request.method == "DELETE":
            InferenceRun.objects.filter(
                pk=run.pk, status__in=["queued", "running", "ready"]
            ).update(status="cancelled")
            run.refresh_from_db()
        return Response(describe(run))

    @action(
        detail=True, methods=["post"], url_path=r"video-inference/(?P<run_id>[0-9a-f-]{36})/accept"
    )
    def video_inference_accept(self, request, pk=None, run_id=None):
        job = self.get_object()
        with transaction.atomic():
            models.Job.objects.select_for_update().get(pk=job.pk)
            run = get_object_or_404(InferenceRun.objects.select_for_update(), pk=run_id, job=job)
            if run.status == "accepted":
                return Response(describe(run))
            if run.status != "ready":
                raise ValidationError("Only completed runs can be accepted.")
            current = annotations.get_job_data(job.pk)
            if fingerprint(current) != run.fingerprint:
                return Response(
                    {
                        "detail": "Annotations changed after inference started. Save your edits and run again."
                    },
                    status=409,
                )
            by_id = {s["id"]: s for s in current["shapes"]}
            selected = {p["object_id"] for p in run.prompts}
            remove = {}
            for previous in job.video_runs.filter(status="accepted"):
                for saved in previous.accepted_shapes:
                    if (
                        saved["object_id"] not in selected
                        or not run.start_frame < saved["frame"] <= run.stop_frame
                    ):
                        continue
                    shape = by_id.get(saved["id"])
                    if not shape:
                        continue
                    if shape_signature(shape) != saved["signature"]:
                        return Response(
                            {
                                "detail": "This range contains edited predictions. Choose a range that preserves those edits."
                            },
                            status=409,
                        )
                    remove[shape["id"]] = shape
            if remove:
                annotations.patch_job_data(
                    job.pk,
                    {"shapes": list(remove.values()), "tracks": [], "tags": []},
                    annotations.PatchAction.DELETE,
                )
            prompts = {p["object_id"]: p for p in run.prompts}
            shapes, identities = [], []
            for frame in run.result["frames"]:
                if frame["frame"] == run.start_frame:
                    continue  # Preserve the user's original prompt.
                for obj in frame["objects"]:
                    if obj["points"] is None:
                        continue
                    prompt = prompts[obj["object_id"]]
                    shapes.append(
                        {
                            "type": "mask",
                            "frame": frame["frame"],
                            "label_id": prompt["label_id"],
                            "points": obj["points"],
                            "source": "auto",
                            "occluded": False,
                            "z_order": 0,
                            "rotation": 0,
                            "attributes": prompt["attributes"],
                        }
                    )
                    identities.append(obj["object_id"])
            payload = LabeledDataSerializer(
                data={"shapes": shapes, "tracks": [], "tags": []},
                context={"annotation_action": annotations.PatchAction.CREATE},
            )
            payload.is_valid(raise_exception=True)
            created = annotations.patch_job_data(
                job.pk, payload.validated_data, annotations.PatchAction.CREATE
            )
            # Sign the database representation (FloatArray fields normalize numbers on read).
            persisted = {s["id"]: s for s in annotations.get_job_data(job.pk)["shapes"]}
            run.accepted_shapes = [
                {
                    "id": s["id"],
                    "frame": s["frame"],
                    "object_id": oid,
                    "signature": shape_signature(persisted[s["id"]]),
                }
                for s, oid in zip(created["shapes"], identities)
            ]
            run.status = "accepted"
            run.save(update_fields=["status", "accepted_shapes", "updated_date"])
        return Response(describe(run))

    @action(
        detail=True, methods=["get"], url_path=r"video-inference/(?P<run_id>[0-9a-f-]{36})/preview"
    )
    def video_inference_preview(self, request, pk=None, run_id=None):
        job = self.get_object()
        run = get_object_or_404(InferenceRun, pk=run_id, job=job, status__in=["ready", "accepted"])
        path = run_directory(run) / "preview.mp4"
        if not path.is_file():
            return Response({"detail": "Preview is not available."}, status=404)
        return media_response(path, request)

    @action(
        detail=True, methods=["get"], url_path=r"video-inference/(?P<run_id>[0-9a-f-]{36})/export"
    )
    def video_inference_export(self, request, pk=None, run_id=None):
        job = self.get_object()
        run = get_object_or_404(InferenceRun, pk=run_id, job=job, status__in=["ready", "accepted"])
        stream = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)
        labels = {label.id: label.name for label in job.get_labels()}
        manifest = {
            "schema_version": "1.0",
            "kind": "sam2-inference-snapshot",
            "run_id": str(run.id),
            "job_id": job.pk,
            "task_id": job.segment.task_id,
            "model": run.model,
            "sam2_revision": "2b90b9f5ceec907a1c18123530e92e794ad901a4",
            "data_id": job.segment.task.data_id,
            "source_start_frame": job.segment.task.data.start_frame,
            "source_frame_filter": job.segment.task.data.frame_filter,
            "annotation_fingerprint": run.fingerprint,
            "status": run.status,
            "start_frame": run.start_frame,
            "stop_frame": run.stop_frame,
            "width": run.result["width"],
            "height": run.result["height"],
            "frame_numbering": "CVAT task-relative, zero-based",
            "preview_fps": 10,
            "source_timestamps": None,
            "note": "Inference snapshot; subsequent manual edits are exported through CVAT Export job dataset.",
        }
        rows = []
        for entry in run.result["frames"]:
            for obj in entry["objects"]:
                mask = (
                    None
                    if obj["points"] is None
                    else decode_mask(obj["points"], run.result["width"], run.result["height"])
                )
                rows.append(
                    {
                        "frame_index": entry["frame"],
                        "object_id": obj["object_id"],
                        "segmentation": None if mask is None else coco_rle(mask),
                        "source": "sam2",
                        "visibility": "absent" if mask is None else "visible",
                    }
                )
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            archive.writestr("prompts.json", json.dumps(run.prompts))
            archive.writestr(
                "objects.json",
                json.dumps(
                    [
                        {
                            "object_id": p["object_id"],
                            "label_id": p["label_id"],
                            "label_name": labels.get(p["label_id"]),
                        }
                        for p in run.prompts
                    ]
                ),
            )
            archive.writestr("annotations.jsonl", "\n".join(json.dumps(row) for row in rows))
            archive.writestr("cvat_masks.json", json.dumps(run.result))
            path = run_directory(run) / "preview.mp4"
            if path.is_file():
                archive.write(path, "preview.mp4")
        stream.seek(0)
        return FileResponse(
            stream,
            as_attachment=True,
            filename=f"sam2-{run.id}.zip",
            content_type="application/zip",
        )


def inference_failure(rq_job, connection, exc_type, exc_value, traceback):
    # Also handles RQ timeout / worker termination without leaving a permanent running badge.
    InferenceRun.objects.filter(pk=rq_job.args[0], status__in=["queued", "running"]).update(
        status="failed", error="Inference worker failed or timed out. Retry with a shorter range."
    )
