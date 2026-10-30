import shutil
from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver
from .models import InferenceRun, OriginalVideo
from .worker import run_directory


@receiver(post_delete, sender=InferenceRun)
def remove_run_artifacts(sender, instance, **kwargs):
    directory = run_directory(instance)
    transaction.on_commit(lambda: shutil.rmtree(directory, ignore_errors=True))


@receiver(post_delete, sender=OriginalVideo)
def remove_original_video(sender, instance, **kwargs):
    directory = instance.directory
    transaction.on_commit(lambda: shutil.rmtree(directory, ignore_errors=True))
