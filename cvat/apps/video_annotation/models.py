import uuid

from django.conf import settings
from django.db import models
from pathlib import Path


class OriginalVideo(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey("engine.Project", on_delete=models.CASCADE, related_name="original_videos")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    name = models.CharField(max_length=256)
    filename = models.CharField(max_length=256)
    created_date = models.DateTimeField(auto_now_add=True)
    updated_date = models.DateTimeField(auto_now=True)
    duration = models.FloatField()
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    size = models.PositiveBigIntegerField()
    annotations = models.JSONField(default=list)
    version = models.PositiveIntegerField(default=0)
    task = models.OneToOneField("engine.Task", null=True, on_delete=models.CASCADE,
                               related_name="original_video")
    timestamps = models.JSONField(default=list)

    @property
    def directory(self):
        return Path(settings.DATA_ROOT) / "original_videos" / str(self.id)

    @property
    def path(self):
        return self.directory / "source.mp4"

    class Meta:
        ordering = ["-created_date"]


class InferenceRun(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    job = models.ForeignKey("engine.Job", on_delete=models.CASCADE, related_name="video_runs")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL)
    created_date = models.DateTimeField(auto_now_add=True)
    updated_date = models.DateTimeField(auto_now=True)
    status = models.CharField(max_length=16, default="queued")
    progress = models.PositiveIntegerField(default=0)
    error = models.TextField(blank=True)
    start_frame = models.PositiveIntegerField()
    stop_frame = models.PositiveIntegerField()
    fingerprint = models.CharField(max_length=64)
    prompts = models.JSONField(default=list)
    model = models.CharField(max_length=128)
    result = models.JSONField(default=dict)
    accepted_shapes = models.JSONField(default=list)

    class Meta:
        ordering = ["-created_date"]
