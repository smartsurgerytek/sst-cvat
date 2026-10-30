import math
import shutil
from pathlib import Path

import av
from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.response import Response

from .models import OriginalVideo
from .views import media_response


class OriginalVideoSerializer(serializers.ModelSerializer):
    job_id = serializers.SerializerMethodField()
    job_count = serializers.SerializerMethodField()

    def get_job_count(self, obj):
        if not obj.task_id:
            return 0
        from cvat.apps.engine.models import Job
        return Job.objects.filter(segment__task_id=obj.task_id).count()

    def get_job_id(self, obj):
        if not obj.task_id:
            return None
        from cvat.apps.engine.models import Job
        return Job.objects.filter(segment__task_id=obj.task_id).order_by("segment__start_frame", "id").values_list("id", flat=True).first()

    class Meta:
        model = OriginalVideo
        fields = ["id", "project_id", "name", "filename", "duration", "width", "height", "size",
                  "created_date", "updated_date", "version", "annotations", "task_id", "job_id", "job_count"]


class OriginalVideoListSerializer(OriginalVideoSerializer):
    project_name = serializers.CharField(source="project.name", read_only=True)

    class Meta(OriginalVideoSerializer.Meta):
        fields = [field for field in OriginalVideoSerializer.Meta.fields if field != "annotations"] + ["project_name"]


class OriginalVideoUploadSerializer(serializers.Serializer):
    segment_duration = serializers.IntegerField(min_value=1, max_value=86400, required=False)


class VideoShapeSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    label_id = serializers.IntegerField(min_value=1)
    type = serializers.ChoiceField(choices=["rectangle", "polygon"])
    start = serializers.FloatField(min_value=0)
    end = serializers.FloatField(min_value=0)
    points = serializers.ListField(child=serializers.FloatField(min_value=0, max_value=1),
                                   min_length=4, max_length=2000)

    def validate(self, attrs):
        points = attrs["points"]
        if not all(math.isfinite(v) for v in [attrs["start"], attrs["end"], *points]):
            raise ValidationError("Coordinates and times must be finite.")
        if attrs["end"] <= attrs["start"]:
            raise ValidationError("End must be after start.")
        if attrs["type"] == "rectangle":
            if len(points) != 4 or points[0] >= points[2] or points[1] >= points[3]:
                raise ValidationError("Rectangle must have positive width and height.")
        elif len(points) < 6 or len(points) % 2:
            raise ValidationError("A polygon needs at least three coordinate pairs.")
        attrs["id"] = str(attrs["id"])
        return attrs


class VideoAnnotationsSerializer(serializers.Serializer):
    version = serializers.IntegerField(min_value=0)
    annotations = VideoShapeSerializer(many=True, max_length=10000)


class OriginalVideoMixin:
    def _original_video_page(self, request, videos):
        videos = videos.select_related("project").defer("annotations").order_by("-created_date", "-id")
        if search := request.query_params.get("video_search", "").strip():
            videos = videos.filter(Q(name__icontains=search) | Q(filename__icontains=search) | Q(project__name__icontains=search))
        page = self.paginate_queryset(videos)
        items = OriginalVideoListSerializer(page if page is not None else videos, many=True).data
        return self.get_paginated_response(items) if page is not None else Response(items)

    @action(detail=False, methods=["get"], url_path="original-videos")
    def original_video_catalog(self, request):
        # Reuse the project list's OPA and organization filters before pagination.
        from cvat.apps.engine.permissions import ProjectPermission
        from cvat.apps.iam.filters import OrganizationFilterBackend

        projects = ProjectPermission.create_scope_list(request).filter(self.get_queryset())
        projects = OrganizationFilterBackend().filter_queryset(request, projects, self)
        return self._original_video_page(request, OriginalVideo.objects.filter(project__in=projects))

    @action(detail=True, methods=["get", "post"], url_path="original-videos",
            parser_classes=[MultiPartParser, FormParser])
    def original_videos(self, request, pk=None):
        project = self.get_object()
        if request.method == "GET":
            return self._original_video_page(request, project.original_videos.all())

        options = OriginalVideoUploadSerializer(data=request.data)
        options.is_valid(raise_exception=True)
        source = request.FILES.get("file")
        if not source or Path(source.name).suffix.lower() != ".mp4":
            raise ValidationError("Select one local MP4 file.")
        name = str(request.data.get("name", "")).strip() or Path(source.name).stem
        if len(name) > 256 or len(source.name) > 256:
            raise ValidationError("Video name and filename must be at most 256 characters.")
        video = OriginalVideo(project=project, owner=request.user, name=name,
                              filename=source.name, size=source.size)
        video.directory.mkdir(parents=True)
        try:
            with video.path.open("wb") as target:
                for chunk in source.chunks():
                    target.write(chunk)
            try:
                with av.open(str(video.path)) as container:
                    if "mp4" not in container.format.name or not container.streams.video:
                        raise ValidationError("The file must contain an MP4 video stream.")
                    stream = container.streams.video[0]
                    if stream.codec_context.name != "h264":
                        raise ValidationError("Original video playback currently requires H.264 MP4.")
                    video.width, video.height = stream.width, stream.height
                    video.duration = (float(stream.duration * stream.time_base)
                                      if stream.duration is not None else float(container.duration or 0) / av.time_base)
                    if not math.isfinite(video.duration) or video.duration <= 0 or not video.width or not video.height:
                        raise ValidationError("The MP4 has invalid video metadata.")
            except (av.error.FFmpegError, ValueError) as exc:
                raise ValidationError("Could not read this MP4 file.") from exc
            video.save()
            from .native_workspace import ensure_workspace
            try:
                ensure_workspace(video.id, segment_duration=options.validated_data.get("segment_duration"))
            except Exception:
                video.delete()
                raise
        except Exception:
            shutil.rmtree(video.directory, ignore_errors=True)
            raise
        video.refresh_from_db()
        return Response(OriginalVideoSerializer(video).data, status=201)

    @action(detail=True, methods=["get", "post", "patch", "delete"],
            url_path=r"original-videos/(?P<video_id>[0-9a-f-]{36})")
    def original_video(self, request, pk=None, video_id=None):
        project = self.get_object()
        if request.method == "POST":
            from .native_workspace import ensure_workspace
            video = get_object_or_404(OriginalVideo, project=project, pk=video_id)
            video, job = ensure_workspace(video.id)
            return Response(OriginalVideoSerializer(video).data)
        if request.method == "PATCH":
            serializer = VideoAnnotationsSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            data = serializer.validated_data
            with transaction.atomic():
                video = get_object_or_404(OriginalVideo.objects.select_for_update(), project=project, pk=video_id)
                if video.task_id:
                    return Response({"detail": "Use the native video workspace to edit annotations."}, status=409)
                if video.version != data["version"]:
                    return Response({"detail": "Annotations changed in another window. Reload before saving."}, status=409)
                labels = {label.id: label.type for label in project.label_set.all()}
                ids = set()
                for shape in data["annotations"]:
                    if shape["label_id"] not in labels or labels[shape["label_id"]] not in ("any", shape["type"]):
                        raise ValidationError("Choose a compatible label from this project.")
                    if shape["end"] > video.duration or shape["id"] in ids:
                        raise ValidationError("Invalid time interval or duplicate annotation ID.")
                    ids.add(shape["id"])
                video.annotations = data["annotations"]
                video.version += 1
                video.save(update_fields=["annotations", "version", "updated_date"])
                return Response(OriginalVideoSerializer(video).data)
        video = get_object_or_404(OriginalVideo, project=project, pk=video_id)
        if request.method == "DELETE":
            video.delete()
            return Response(status=204)
        return Response(OriginalVideoSerializer(video).data)

    @action(detail=True, methods=["get"],
            url_path=r"original-videos/(?P<video_id>[0-9a-f-]{36})/media")
    def original_video_media(self, request, pk=None, video_id=None):
        project = self.get_object()
        video = get_object_or_404(OriginalVideo, project=project, pk=video_id)
        if video.task_id and video.task.project_id != project.id:
            return Response(status=404)
        if not video.path.is_file():
            raise ValidationError("The original video file is missing.")
        response = media_response(video.path, request)
        response["Cache-Control"] = "private, no-store"
        return response
