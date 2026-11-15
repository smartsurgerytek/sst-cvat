import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import av
from django.test import SimpleTestCase
from PIL import Image
from rest_framework.exceptions import NotFound, ValidationError

from .serializers import OverlayVideoExportSerializer, OverlayVideoPreviewSerializer
from .video_export import create_export, export_status, generate_export, preview_export, export_key


class OverlayVideoExportTests(SimpleTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = SimpleNamespace(start_frame=0, deleted_frames=[2], get_frame_step=lambda: 1)
        self.job = SimpleNamespace(
            pk=4, get_dirname=lambda: str(self.root),
            segment=SimpleNamespace(start_frame=1, stop_frame=3, frame_set=range(1, 4),
                                    task=SimpleNamespace(dimension="2d", data=self.data,
                                                         original_video=SimpleNamespace())),
            get_labels=lambda: [SimpleNamespace(id=1, name="Phase A", color="#ff0000")],
            video_runs=Mock(),
        )
        self.job.video_runs.filter.return_value = []
        self.options = {"start_frame": 1, "stop_frame": 3, "opacity": .35,
                        "show_names": True, "show_legend": True, "show_phase": True}
        self.current = {"version": 1, "shapes": [], "tracks": [],
                        "tags": [{"frame": 1, "label_id": 1}]}
        self.timing = {"timestamps": [0, .1, .2, .3], "duration": .4}

    def test_snapshot_excludes_deleted_frames_and_queues_on_export_worker(self):
        with patch("cvat.apps.video_annotation.video_export.annotations.get_job_data", return_value=self.current), \
                patch("cvat.apps.video_annotation.video_export.job_video_timing", return_value=self.timing), \
                patch("cvat.apps.video_annotation.video_export.queue") as queue:
            result = create_export(self.job, self.options)
        snapshot = json.loads((self.root / "overlay-exports" / result["id"] / "snapshot.json").read_text())
        self.assertEqual(snapshot["frames"], [1, 3])
        self.assertEqual(snapshot["deleted_frames"], [2])
        self.assertEqual(snapshot["annotations"]["tags"], self.current["tags"])
        self.assertEqual(snapshot["labels"]["1"]["name"], "Phase A")
        args, kwargs = queue.return_value.enqueue.call_args
        self.assertEqual(args, (generate_export, 4, result["id"]))
        self.assertEqual(kwargs["meta"]["job_id"], 4)
        self.assertEqual(result["state"], "queued")

    def test_range_validation_and_empty_deleted_range(self):
        for start, stop in [(0, 3), (1, 4), (3, 1)]:
            with self.assertRaises(ValidationError):
                create_export(self.job, {**self.options, "start_frame": start, "stop_frame": stop})
        with patch("cvat.apps.video_annotation.video_export.job_video_timing", return_value=self.timing):
            with self.assertRaises(ValidationError):
                create_export(self.job, {**self.options, "start_frame": 2, "stop_frame": 2})

    def test_enqueue_failure_removes_snapshot(self):
        with patch("cvat.apps.video_annotation.video_export.annotations.get_job_data", return_value=self.current), \
                patch("cvat.apps.video_annotation.video_export.job_video_timing", return_value=self.timing), \
                patch("cvat.apps.video_annotation.video_export.queue") as queue:
            queue.return_value.enqueue.side_effect = RuntimeError("queue offline")
            with self.assertRaises(RuntimeError):
                create_export(self.job, self.options)
        self.assertEqual(list((self.root / "overlay-exports").iterdir()), [])

    def test_trimmed_source_does_not_hold_last_frame_until_original_video_end(self):
        del self.job.segment.task.original_video
        self.data.start_frame = 2
        self.data.size = 2
        self.data.deleted_frames = []
        self.data.get_frame_step = lambda: 2
        self.data.storage = "local"
        self.data.video = SimpleNamespace(path="source.mp4")
        self.data.get_upload_dirname = lambda: self.root
        (self.root / "source.mp4").write_bytes(b"source")
        self.job.segment.start_frame, self.job.segment.stop_frame = 0, 1
        self.job.segment.frame_set = [2, 4]
        with patch("cvat.apps.video_annotation.video_export.annotations.get_job_data", return_value=self.current), \
                patch("cvat.apps.video_annotation.video_export.job_video_timing",
                      return_value={"timestamps": [2, 4], "duration": 10}), \
                patch("cvat.apps.video_annotation.video_export.probe_timing", return_value=(list(range(10)), 10)), \
                patch("cvat.apps.video_annotation.video_export.queue"):
            result = create_export(self.job, {**self.options, "start_frame": 0, "stop_frame": 1})
        snapshot = json.loads((self.root / "overlay-exports" / result["id"] / "snapshot.json").read_text())
        self.assertEqual(snapshot["frames"], [0, 1])
        self.assertEqual(snapshot["timing"]["duration"], 6)

    def test_status_rejects_missing_and_cross_job_results(self):
        with patch("cvat.apps.video_annotation.video_export.queue") as queue:
            queue.return_value.fetch_job.return_value = None
            with self.assertRaises(NotFound):
                export_status(self.job, "identifier")
            queue.return_value.fetch_job.return_value = Mock(meta={"job_id": 5})
            with self.assertRaises(NotFound):
                export_status(self.job, "identifier")

    def test_finished_requires_output_file_and_failures_are_reported(self):
        run = Mock(meta={"job_id": 4, "progress": 100})
        run.get_status.return_value = "finished"
        with patch("cvat.apps.video_annotation.video_export.queue") as queue:
            queue.return_value.fetch_job.return_value = run
            self.assertEqual(export_status(self.job, "identifier")["state"], "failed")
            directory = self.root / "overlay-exports" / "identifier"
            directory.mkdir(parents=True)
            (directory / "video.mp4").write_bytes(b"video")
            self.assertEqual(export_status(self.job, "identifier")["state"], "ready")
            run.get_status.return_value = "failed"
            self.assertIn("error", export_status(self.job, "identifier"))

    def test_serializer_rejects_invalid_opacity(self):
        for opacity in [-1, 2, float("nan"), float("inf")]:
            serializer = OverlayVideoExportSerializer(data={**self.options, "opacity": opacity})
            self.assertFalse(serializer.is_valid())
        serializer = OverlayVideoExportSerializer(data={"start_frame": 1, "stop_frame": 3})
        self.assertTrue(serializer.is_valid())
        self.assertTrue(serializer.validated_data["show_phase"])

    def test_task_export_snapshots_full_task_and_uses_separate_queue_identity(self):
        self.data.size = 4
        task = SimpleNamespace(pk=4, dimension="2d", data=self.data, original_video=SimpleNamespace(),
                               get_dirname=self.job.get_dirname, get_labels=self.job.get_labels)
        with patch("cvat.apps.video_annotation.video_export.annotations.get_task_data", return_value=self.current), \
                patch("cvat.apps.video_annotation.video_export.task_video_timing", return_value=self.timing), \
                patch("cvat.apps.video_annotation.models.InferenceRun.objects.filter", return_value=[]), \
                patch("cvat.apps.video_annotation.video_export.queue") as queue:
            result = create_export(task, {**self.options, "start_frame": 0}, task_export=True)
        snapshot = json.loads((self.root / "overlay-exports" / result["id"] / "snapshot.json").read_text())
        self.assertEqual(snapshot["frames"], [0, 1, 3])
        self.assertTrue(queue.return_value.enqueue.call_args.kwargs["task_export"])
        self.assertNotEqual(export_key(task, result["id"], True), export_key(self.job, result["id"]))
        task.original_video.path = "source.mp4"
        def decoded():
            for _ in snapshot["frames"]:
                yield Image.new("RGB", (320, 240))
        with patch("cvat.apps.video_annotation.video_export.models.Task.objects") as objects, \
                patch("cvat.apps.video_annotation.video_export_source.source_frames", return_value=decoded()) as source, \
                patch("cvat.apps.video_annotation.video_export.get_current_job", return_value=Mock(meta={})):
            objects.select_related.return_value.get.return_value = task
            generate_export(task.pk, result["id"], task_export=True)
        self.assertEqual(source.call_args.args[2], [0, 1, 3])
        with av.open(str(self.root / "overlay-exports" / result["id"] / "video.mp4")) as video:
            self.assertEqual(len(list(video.decode(video=0))), 3)

    def test_preview_uses_client_shapes_without_saving_and_releases_provider(self):
        provider = Mock()
        provider.get_frame.return_value = SimpleNamespace(data=Image.new("RGB", (320, 240)))
        options = {**self.options, "frame": 1, "show_names": False,
                   "shapes": [{"id": 7, "frame": 1, "label_id": 1, "type": "rectangle",
                               "points": [30, 60, 80, 100]}], "tags": [{"frame": 1, "label_id": 1}]}
        serializer = OverlayVideoPreviewSerializer(data=options)
        self.assertTrue(serializer.is_valid(), serializer.errors)
        with patch("cvat.apps.video_annotation.video_export.JobFrameProvider", return_value=provider), \
                patch("cvat.apps.video_annotation.video_export.annotations.get_job_data") as saved:
            result = preview_export(self.job, serializer.validated_data)
        self.assertEqual(result.getpixel((40, 120)), (0, 0, 0))
        self.assertGreater(result.getpixel((360, 120))[0], 60)
        saved.assert_not_called()
        provider.unload.assert_called_once()

    def test_preview_rejects_deleted_frames_ranges_labels_and_invalid_masks(self):
        options = {**self.options, "frame": 1, "shapes": [], "tags": []}
        for invalid in ({"frame": 2}, {"frame": 4}, {"tags": [{"label_id": 99}]}):
            with self.assertRaises(ValidationError):
                preview_export(self.job, {**options, **invalid})
        provider = Mock()
        provider.get_frame.return_value = SimpleNamespace(data=Image.new("RGB", (320, 240)))
        with patch("cvat.apps.video_annotation.video_export.JobFrameProvider", return_value=provider):
            with self.assertRaises(ValidationError):
                preview_export(self.job, {**options, "shapes": [
                    {"label_id": 1, "type": "mask", "points": [0, 5, 0, 0, 400, 240]}]})
        provider.unload.assert_called_once()

    def test_worker_interpolates_tracks_encodes_video_and_releases_frames(self):
        keyframe = {"type": "rectangle", "rotation": 0, "occluded": False, "outside": False,
                    "z_order": 0, "attributes": []}
        self.current["tracks"] = [{"id": 9, "label_id": 1, "group": 0, "source": "manual",
                                   "attributes": [], "frame": 1, "shapes": [
                                       {**keyframe, "frame": 1, "points": [30, 60, 50, 100]},
                                       {**keyframe, "frame": 3, "points": [100, 60, 120, 100]},
                                   ]}]
        with patch("cvat.apps.video_annotation.video_export.annotations.get_job_data", return_value=self.current), \
                patch("cvat.apps.video_annotation.video_export.job_video_timing", return_value=self.timing), \
                patch("cvat.apps.video_annotation.video_export.queue"):
            result = create_export(self.job, {**self.options, "show_names": False})
        provider = Mock()
        provider.get_frame.return_value = SimpleNamespace(data=Image.new("RGB", (320, 240)))
        self.job.segment.task.original_video = None
        worker = Mock(meta={})
        with patch("cvat.apps.video_annotation.video_export.models.Job.objects") as objects, \
                patch("cvat.apps.video_annotation.video_export.JobFrameProvider", return_value=provider), \
                patch("cvat.apps.video_annotation.video_export.get_current_job", return_value=worker):
            objects.select_related.return_value.get.return_value = self.job
            generate_export(4, result["id"])
        directory = self.root / "overlay-exports" / result["id"]
        with av.open(str(directory / "video.mp4")) as video:
            frames = list(video.decode(video=0))
            self.assertEqual(len(frames), 2)
            self.assertGreater(frames[0].to_image().getpixel((360, 120))[0], 60)
            self.assertGreater(frames[1].to_image().getpixel((430, 120))[0], 60)
            self.assertLess(frames[1].to_image().getpixel((360, 120))[0], 10)
        self.assertEqual([call.args[0] for call in provider.get_frame.call_args_list], [1, 3])
        self.assertEqual(worker.meta["progress"], 100)
        provider.unload.assert_called_once()
        self.assertFalse((directory / "snapshot.json").exists())
        self.assertFalse((directory / "video.part.mp4").exists())
