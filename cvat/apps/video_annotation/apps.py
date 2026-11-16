from django.apps import AppConfig


class VideoAnnotationConfig(AppConfig):
    name = "cvat.apps.video_annotation"

    def ready(self):
        from . import signals  # noqa: F401
