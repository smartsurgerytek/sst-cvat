from rest_framework import serializers
from .models import InferenceRun


class PromptSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["shape", "track"])
    id = serializers.IntegerField(min_value=1)
    label_id = serializers.IntegerField(min_value=1)
    type = serializers.ChoiceField(choices=["polygon", "mask"])
    points = serializers.ListField(child=serializers.FloatField(), min_length=5, max_length=4000000)
    attributes = serializers.ListField(child=serializers.DictField(), default=list)


class CreateRunSerializer(serializers.Serializer):
    start_frame = serializers.IntegerField(min_value=0)
    stop_frame = serializers.IntegerField(min_value=0)
    prompts = PromptSerializer(many=True, allow_empty=False, max_length=10)


class RunSerializer(serializers.ModelSerializer):
    class Meta:
        model = InferenceRun
        fields = [
            "id",
            "created_date",
            "status",
            "progress",
            "error",
            "start_frame",
            "stop_frame",
            "model",
        ]


class DeleteResultsSerializer(serializers.Serializer):
    run_id = serializers.UUIDField()
    label_id = serializers.IntegerField(min_value=1)
    version = serializers.CharField(min_length=64, max_length=64)


class DeleteMaskSerializer(serializers.Serializer):
    shape_id = serializers.IntegerField(min_value=1)
    version = serializers.CharField(min_length=64, max_length=64)


class UpdateMaskSerializer(DeleteMaskSerializer):
    points = serializers.ListField(child=serializers.FloatField(), min_length=5, max_length=4000000)
