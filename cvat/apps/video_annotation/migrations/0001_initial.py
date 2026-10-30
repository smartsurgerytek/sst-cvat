import uuid
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("engine", "0096_issue_is_mask_issue"),
    ]
    operations = [
        migrations.CreateModel(
            name="InferenceRun",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        primary_key=True, default=uuid.uuid4, editable=False, serialize=False
                    ),
                ),
                ("created_date", models.DateTimeField(auto_now_add=True)),
                ("updated_date", models.DateTimeField(auto_now=True)),
                ("status", models.CharField(max_length=16, default="queued")),
                ("progress", models.PositiveIntegerField(default=0)),
                ("error", models.TextField(blank=True)),
                ("start_frame", models.PositiveIntegerField()),
                ("stop_frame", models.PositiveIntegerField()),
                ("fingerprint", models.CharField(max_length=64)),
                ("prompts", models.JSONField(default=list)),
                ("model", models.CharField(max_length=128)),
                ("result", models.JSONField(default=dict)),
                ("accepted_shapes", models.JSONField(default=list)),
                (
                    "job",
                    models.ForeignKey(
                        to="engine.job",
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="video_runs",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        to=settings.AUTH_USER_MODEL,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                    ),
                ),
            ],
            options={"ordering": ["-created_date"]},
        )
    ]
