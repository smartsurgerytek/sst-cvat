"""Authenticated, frame-scoped proxy for interactive SAM1 inference."""
import io
import json
import math

import requests
from django.conf import settings
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from cvat.apps.engine import models
from cvat.apps.engine.frame_provider import FrameOutputType, JobFrameProvider


class PointPromptsSerializer(serializers.Serializer):
    frame = serializers.IntegerField(min_value=0)
    pos_points = serializers.ListField(
        child=serializers.ListField(child=serializers.FloatField(), min_length=2, max_length=2),
        min_length=1, max_length=256,
    )
    neg_points = serializers.ListField(
        child=serializers.ListField(child=serializers.FloatField(), min_length=2, max_length=2),
        max_length=255, default=list,
    )

    def validate(self, attrs):
        points = attrs["pos_points"] + attrs["neg_points"]
        if len(points) > 256 or any(not math.isfinite(v) or v < 0 for p in points for v in p):
            raise ValidationError("Use at most 256 finite, nonnegative point coordinates.")
        return attrs


def infer(job, data):
    serializer = PointPromptsSerializer(data=data)
    serializer.is_valid(raise_exception=True)
    prompts = serializer.validated_data
    frame = prompts.pop("frame")
    if job.segment.task.dimension != models.DimensionType.DIM_2D:
        raise ValidationError("SAM1 requires a 2D job.")
    if job.type != models.JobType.ANNOTATION:
        raise ValidationError("Use a regular annotation job.")
    if not job.segment.start_frame <= frame <= job.segment.stop_frame:
        raise ValidationError("Frame is outside this job.")
    if frame in job.segment.task.data.deleted_frames:
        raise ValidationError("Frame is deleted.")
    provider = JobFrameProvider(job)
    try:
        image = provider.get_frame(frame, out_type=FrameOutputType.PIL).data.convert("RGB")
        if image.width * image.height > 3840 * 2160:
            raise ValidationError("Maximum frame size is 4K.")
        if any(x >= image.width or y >= image.height for x, y in prompts["pos_points"] + prompts["neg_points"]):
            raise ValidationError("Point is outside the image.")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
    finally:
        provider.unload()
    try:
        response = requests.post(
            settings.SAM1_URL + "/infer",
            files={"image": ("frame.png", buffer.getvalue(), "image/png")},
            data={"prompts": json.dumps(prompts)}, timeout=(5, 150),
        )
        if response.status_code in {400, 422, 503}:
            return Response({"detail": response.json().get("detail", "SAM1 inference failed")},
                            status=response.status_code)
        response.raise_for_status()
        return Response(response.json())
    except (requests.RequestException, ValueError):
        return Response({"detail": "SAM1 is unavailable. Check the sam1 service and retry."}, status=503)
