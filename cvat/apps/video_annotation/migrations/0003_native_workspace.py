from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("video_annotation", "0002_originalvideo")]
    operations = [
        migrations.AddField(model_name="originalvideo", name="task",
                            field=models.OneToOneField(null=True, on_delete=django.db.models.deletion.CASCADE,
                                                       related_name="original_video", to="engine.task")),
        migrations.AddField(model_name="originalvideo", name="timestamps", field=models.JSONField(default=list)),
    ]
