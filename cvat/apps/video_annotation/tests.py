import base64
import gzip
import io
import os
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from django.test import SimpleTestCase
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.test import APIRequestFactory

from cvat.apps.engine.permissions import JobPermission
from .serializers import CreateRunSerializer
from .utils import coco_rle, decode_mask, encode_mask, fingerprint, prompt_mask, shape_signature
from .views import VideoInferenceMixin, media_response


class EncodingTests(SimpleTestCase):
    def test_coco_rle_preserves_holes_and_disconnected_regions(self):
        masks = [np.zeros((3, 5), bool), np.ones((3, 5), bool), np.eye(5, dtype=bool)]
        mask = np.ones((7, 9), bool)
        mask[2:5, 2:5] = False
        masks.append(mask)
        for mask in masks:
            encoded = coco_rle(mask)
            restored = np.repeat(np.arange(len(encoded["counts"])) % 2, encoded["counts"]).reshape(
                mask.shape, order="F"
            )
            np.testing.assert_array_equal(mask, restored)

    def test_gpu_mask_encoding_matches_cvat_decoding(self):
        for seed in range(10):
            mask = np.random.default_rng(seed).random((13, 17)) > 0.5
            np.testing.assert_array_equal(decode_mask(encode_mask(mask), 17, 13), mask)
        self.assertIsNone(encode_mask(np.zeros((3, 4), bool)))
        mask = prompt_mask({"type": "polygon", "points": [1, 1, 5, 1, 5, 5, 1, 5]}, 8, 8)
        np.testing.assert_array_equal(decode_mask(encode_mask(mask), 8, 8), mask)

    def test_cvat_mask_offset_and_validation(self):
        mask = decode_mask([0, 2, 1, 1, 2, 1], 4, 3)
        self.assertEqual(int(mask.sum()), 2)
        self.assertTrue(mask[1, 1] and mask[1, 2])
        for invalid in (
            [0, 200, 1, 1, 2, 1],
            [0, 2, -1, 1, 0, 1],
            [1.5, 1, 1, 1, 1],
            [-1, 2, 0, 0, 0, 0],
        ):
            with self.assertRaises(ValueError):
                decode_mask(invalid, 4, 3)

    def test_fingerprint_and_manual_edit_detection(self):
        self.assertEqual(fingerprint({"a": 1, "b": 2}), fingerprint({"b": 2, "a": 1}))
        self.assertNotEqual(
            shape_signature({"points": [1, 2]}), shape_signature({"points": [1, 3]})
        )
        self.assertNotEqual(
            shape_signature({"source": "auto"}), shape_signature({"source": "manual"})
        )


class PermissionTests(SimpleTestCase):
    def test_original_video_requires_job_data_access(self):
        scopes = JobPermission._get_scopes(
            SimpleNamespace(method="GET"), SimpleNamespace(action="original_video_media"), None
        )
        self.assertEqual(scopes, [JobPermission.Scopes.VIEW_DATA])
        view = VideoInferenceMixin()
        view.get_object = Mock(side_effect=PermissionDenied())
        with self.assertRaises(PermissionDenied):
            view.original_video_media(SimpleNamespace(method="GET"), pk=1)
        segment_scopes = JobPermission._get_scopes(
            SimpleNamespace(method="GET"), SimpleNamespace(action="original_video_segment"), None
        )
        self.assertEqual(segment_scopes, [JobPermission.Scopes.VIEW_DATA])
        with self.assertRaises(PermissionDenied):
            view.original_video_segment(SimpleNamespace(method="GET"), pk=1, segment_index="0")

    def test_mutations_require_annotation_write_and_data_read(self):
        for action, method in [
            ("sam1", "POST"),
            ("video_inference", "POST"),
            ("video_inference_accept", "POST"),
            ("video_inference_run", "DELETE"),
            ("video_inference_results", "DELETE"),
            ("video_inference_masks", "PATCH"),
            ("video_inference_masks", "DELETE"),
        ]:
            scopes = JobPermission._get_scopes(
                SimpleNamespace(method=method), SimpleNamespace(action=action), None
            )
            self.assertIn(JobPermission.Scopes.UPDATE_ANNOTATIONS, scopes)
            self.assertIn(JobPermission.Scopes.VIEW_DATA, scopes)

    def test_export_checks_export_permission(self):
        scopes = JobPermission._get_scopes(
            SimpleNamespace(method="GET"), SimpleNamespace(action="video_inference_export"), None
        )
        self.assertIn(JobPermission.Scopes.EXPORT_ANNOTATIONS, scopes)

    def test_all_endpoints_check_job_access_before_run_lookup(self):
        view = VideoInferenceMixin()
        view.get_object = Mock(side_effect=PermissionDenied())
        for method in [
            "video_inference",
            "video_inference_run",
            "video_inference_accept",
            "video_inference_preview",
            "video_inference_export",
            "video_inference_results",
            "video_inference_masks",
            "video_inference_playback",
        ]:
            with self.assertRaises(PermissionDenied):
                getattr(view, method)(SimpleNamespace(method="GET"))


class ValidationTests(SimpleTestCase):
    def test_prompt_limits(self):
        prompt = {
            "kind": "shape",
            "id": 1,
            "label_id": 1,
            "type": "polygon",
            "points": [0, 0, 10, 0, 10, 10],
        }
        self.assertTrue(
            CreateRunSerializer(
                data={"start_frame": 0, "stop_frame": 5, "prompts": [prompt]}
            ).is_valid()
        )
        for prompts in ([], [prompt] * 11):
            self.assertFalse(
                CreateRunSerializer(
                    data={"start_frame": 0, "stop_frame": 5, "prompts": prompts}
                ).is_valid()
            )

    def test_invalid_range_rejected_before_media_access(self):
        view = VideoInferenceMixin()
        view.get_object = Mock(
            return_value=SimpleNamespace(
                type="annotation",
                segment=SimpleNamespace(
                    start_frame=10, stop_frame=20, task=SimpleNamespace(dimension="2d")
                ),
            )
        )
        request = SimpleNamespace(
            method="POST",
            data={
                "start_frame": 0,
                "stop_frame": 30,
                "prompts": [
                    {"kind": "shape", "id": 1, "label_id": 1, "type": "polygon", "points": [0] * 6}
                ],
            },
        )
        with self.assertRaises(ValidationError):
            view.video_inference(request)

    def test_media_range_and_unsatisfiable_range(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preview.mp4"
            path.write_bytes(b"0123456789")
            response = media_response(path, SimpleNamespace(headers={"Range": "bytes=2-5"}))
            self.assertEqual(response.status_code, 206)
            self.assertEqual(b"".join(response.streaming_content), b"2345")
            self.assertEqual(response["Content-Range"], "bytes 2-5/10")
            response.close()
            self.assertEqual(
                media_response(path, SimpleNamespace(headers={"Range": "bytes=20-"})).status_code,
                416,
            )


from django.contrib.auth import get_user_model
from django.test import TestCase
from cvat.apps.engine import models
from cvat.apps.dataset_manager import task as annotations
from cvat.apps.video_annotation.models import InferenceRun


class ReviewIntegrationTests(TestCase):
    def setUp(self):
        self.queue_patch = patch("django_rq.get_queue", return_value=Mock())
        self.queue_patch.start()
        self.addCleanup(self.queue_patch.stop)
        self.user = get_user_model().objects.create_user("video-test")
        data = models.Data.objects.create(size=4, start_frame=0, stop_frame=3, image_quality=70)
        task = models.Task.objects.create(name="video-test", owner=self.user, data=data)
        segment = models.Segment.objects.create(task=task, start_frame=0, stop_frame=3)
        self.job = models.Job.objects.create(segment=segment)
        self.label = models.Label.objects.create(task=task, name="object", type="any")
        self.seed = models.LabeledShape.objects.create(
            job=self.job,
            frame=0,
            label=self.label,
            type="polygon",
            points=[0, 0, 2, 0, 2, 2],
            source="manual",
        )
        self.view = VideoInferenceMixin()
        self.view.get_object = Mock(return_value=self.job)

    def make_run(self):
        return InferenceRun.objects.create(
            job=self.job,
            owner=self.user,
            start_frame=0,
            stop_frame=3,
            fingerprint=fingerprint(annotations.get_job_data(self.job.pk)),
            model="test",
            status="ready",
            prompts=[
                {"object_id": f"shape:{self.seed.id}", "label_id": self.label.pk, "attributes": []}
            ],
            result={
                "width": 3,
                "height": 3,
                "frames": [
                    {
                        "frame": f,
                        "objects": [
                            {"object_id": f"shape:{self.seed.id}", "points": [0, 4, 0, 0, 1, 1]}
                        ],
                    }
                    for f in range(4)
                ],
            },
        )

    def test_accept_preserves_prompt_is_idempotent_and_rerun_replaces_predictions(self):
        run = self.make_run()
        response = self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(models.LabeledShape.objects.filter(job=self.job).count(), 4)
        self.seed.refresh_from_db()
        self.assertEqual(self.seed.type, "polygon")
        run.refresh_from_db()
        self.assertEqual(len(run.accepted_shapes), 3)
        self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        self.assertEqual(models.LabeledShape.objects.filter(job=self.job).count(), 4)
        next_run = self.make_run()
        response = self.view.video_inference_accept(SimpleNamespace(), run_id=next_run.id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(models.LabeledShape.objects.filter(job=self.job).count(), 4)

    def test_management_deletes_only_this_run_and_label_and_keeps_seed(self):
        run = self.make_run()
        self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        # An unrelated auto shape must not be mistaken for SAM2 provenance.
        other = models.LabeledShape.objects.create(job=self.job, label=self.label, frame=2,
                                                  type="mask", source="auto", points=[0, 1, 0, 0, 0, 0])
        listing = self.view.video_inference_results(SimpleNamespace(method="GET")).data
        self.assertEqual(listing["groups"][0]["count"], 3)
        response = self.view.video_inference_results(SimpleNamespace(method="DELETE", data={
            "run_id": str(run.id), "label_id": self.label.id, "version": listing["version"],
        }))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["groups"], [])
        self.assertEqual(set(models.LabeledShape.objects.filter(job=self.job).values_list("id", flat=True)),
                         {self.seed.id, other.id})

    def test_management_rejects_stale_and_foreign_run_deletion(self):
        from django.http import Http404
        run = self.make_run()
        self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        listing = self.view.video_inference_results(SimpleNamespace(method="GET")).data
        self.seed.points = [0, 0, 1, 0, 1, 1]
        self.seed.save()
        request = SimpleNamespace(method="DELETE", data={"run_id": str(run.id),
                                  "label_id": self.label.id, "version": listing["version"]})
        self.assertEqual(self.view.video_inference_results(request).status_code, 409)
        other = models.Job.objects.create(segment=self.job.segment)
        self.view.get_object.return_value = other
        with self.assertRaises(Http404):
            self.view.video_inference_results(request)

    def test_live_masks_edit_delete_and_conflict_protection(self):
        run = self.make_run()
        with patch("cvat.apps.video_annotation.views.annotations.get_job_data") as load_annotations:
            initial = self.view.video_inference_masks(
                SimpleNamespace(method="GET", query_params={"frame": "1"}), run_id=run.id).data
            load_annotations.assert_not_called()
        self.assertEqual(len(initial["objects"]), 1)
        self.assertIsNone(initial["objects"][0]["shape_id"])
        self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        result = self.view.video_inference_masks(
            SimpleNamespace(method="GET", query_params={"frame": "1"}), run_id=run.id).data
        obj = result["objects"][0]
        payload = {"shape_id": obj["shape_id"], "version": obj["version"], "points": [0, 1, 0, 0, 0, 0]}
        response = self.view.video_inference_masks(SimpleNamespace(method="PATCH", data=payload), run_id=run.id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(models.LabeledShape.objects.get(pk=obj["shape_id"]).points, payload["points"])
        self.assertEqual(self.view.video_inference_masks(SimpleNamespace(method="PATCH", data=payload),
                                                         run_id=run.id).status_code, 409)
        listing = self.view.video_inference_results(SimpleNamespace(method="GET")).data
        self.assertEqual(listing["groups"][0]["edited_count"], 1)
        result = self.view.video_inference_masks(
            SimpleNamespace(method="GET", query_params={"frame": "1"}), run_id=run.id).data
        obj = result["objects"][0]
        response = self.view.video_inference_masks(SimpleNamespace(method="DELETE", data={
            "shape_id": obj["shape_id"], "version": obj["version"],
        }), run_id=run.id)
        self.assertEqual(response.status_code, 200)
        result = self.view.video_inference_masks(
            SimpleNamespace(method="GET", query_params={"frame": "1"}), run_id=run.id).data
        self.assertEqual(result["objects"], [])
        self.assertTrue(models.LabeledShape.objects.filter(pk=self.seed.id).exists())

    def test_live_masks_cannot_modify_prompt_or_foreign_job(self):
        from django.http import Http404
        run = self.make_run()
        self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        request = SimpleNamespace(method="DELETE", data={"shape_id": self.seed.id, "version": "0" * 64})
        self.assertEqual(self.view.video_inference_masks(request, run_id=run.id).status_code, 404)
        other = models.Job.objects.create(segment=self.job.segment)
        self.view.get_object.return_value = other
        with self.assertRaises(Http404):
            self.view.video_inference_masks(request, run_id=run.id)

    def test_accept_refuses_stale_snapshot(self):
        run = self.make_run()
        self.seed.points = [0, 0, 1, 0, 1, 1]
        self.seed.save()
        response = self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(models.LabeledShape.objects.filter(job=self.job).count(), 1)

    def test_rerun_preserves_manual_correction(self):
        run = self.make_run()
        self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
        shape = models.LabeledShape.objects.get(job=self.job, frame=1)
        shape.points = [0, 1, 0, 0, 0, 0]
        shape.save()
        next_run = self.make_run()
        response = self.view.video_inference_accept(SimpleNamespace(), run_id=next_run.id)
        self.assertEqual(response.status_code, 409)
        shape.refresh_from_db()
        self.assertEqual(shape.points, [0, 1, 0, 0, 0, 0])

    def test_cross_job_run_not_found(self):
        from django.http import Http404

        run = self.make_run()
        # The lookup is scoped by the actual job object, not just the run UUID.
        other = models.Job.objects.create(segment=self.job.segment)
        self.view.get_object = Mock(return_value=other)
        with self.assertRaises(Http404):
            self.view.video_inference_run(SimpleNamespace(method="GET"), run_id=run.id)

    def test_export_contains_roundtrippable_masks_and_stable_ids(self):
        run = self.make_run()
        response = self.view.video_inference_export(SimpleNamespace(), run_id=run.id)
        import zipfile

        with zipfile.ZipFile(io.BytesIO(b"".join(response.streaming_content))) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["schema_version"], "1.0")
            rows = [json.loads(line) for line in archive.read("annotations.jsonl").splitlines()]
            self.assertEqual(len(rows), 4)
            self.assertEqual(rows[0]["object_id"], f"shape:{self.seed.id}")
            self.assertEqual(sum(rows[0]["segmentation"]["counts"]), 9)
        response.close()

    def test_worker_streams_editable_masks_without_rendering_video(self):
        import av
        from PIL import Image
        from unittest.mock import MagicMock
        from .worker import execute, run_directory

        run = self.make_run()
        run.status = "queued"
        run.save()
        provider = Mock()
        provider.get_frame.return_value = SimpleNamespace(data=Image.new("RGB", (32, 24), "white"))
        response = MagicMock()
        response.__enter__.return_value = response
        entries = [
            {"frame": i, "objects": frame["objects"]}
            for i, frame in enumerate(run.result["frames"])
        ]
        score_bytes = np.linspace(-2, 2, 32 * 24, dtype="<f4").tobytes()
        encoded_scores = base64.b64encode(score_bytes).decode("ascii")
        for entry in entries:
            for obj in entry["objects"]:
                obj["logits"] = encoded_scores
        wire = b"\n".join(json.dumps(entry).encode() for entry in entries) + b"\n"
        response.iter_content.return_value = [wire[i:i + 37] for i in range(0, len(wire), 37)]

        def start_inference(*args, **kwargs):
            run.refresh_from_db()
            self.assertEqual(run.progress, 20)
            return response

        with tempfile.TemporaryDirectory() as directory, self.settings(DATA_ROOT=Path(directory)):
            with (
                patch("cvat.apps.video_annotation.worker.JobFrameProvider", return_value=provider),
                patch("cvat.apps.video_annotation.worker.requests.post", side_effect=start_inference),
            ):
                execute(str(run.id))
            run.refresh_from_db()
            self.assertEqual(run.status, "ready", run.error)
            self.assertEqual(run.progress, 100)
            self.assertFalse((run_directory(run) / "preview.mp4").exists())
            self.assertEqual(run.result["width"], 32)
            self.assertEqual(len(run.result["frames"]), 4)
            self.assertNotIn("logits", run.result["frames"][1]["objects"][0])
            with gzip.open(run_directory(run) / "logits-1.json.gz", "rt") as source:
                stored = json.load(source)
            self.assertEqual(base64.b64decode(stored[f"shape:{self.seed.id}"]), score_bytes)
            request = SimpleNamespace(method="GET", query_params={"frame": "1"})
            before = self.view.video_inference_masks(request, run_id=run.id).data
            self.assertEqual(before["objects"][0]["logits"], encoded_scores)
            self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
            after = self.view.video_inference_masks(request, run_id=run.id).data
            self.assertEqual(after["objects"][0]["logits"], encoded_scores)

    def test_cancelled_run_never_calls_gpu(self):
        from .worker import execute

        run = self.make_run()
        run.status = "cancelled"
        run.save()
        with patch("cvat.apps.video_annotation.worker.requests.post") as gpu:
            execute(str(run.id))
            gpu.assert_not_called()

    def test_create_uses_video_metadata_saved_geometry_and_enqueues_after_commit(self):
        from PIL import Image

        models.Video.objects.create(data=self.job.segment.task.data, width=32, height=24)
        view = self.view
        provider = Mock()
        provider.get_frame.return_value = SimpleNamespace(data=Image.new("RGB", (32, 24)))
        health = Mock()
        health.json.return_value = {"model": "test-model"}
        request = SimpleNamespace(
            method="POST",
            user=self.user,
            data={
                "start_frame": 0,
                "stop_frame": 3,
                "prompts": [
                    {
                        "kind": "shape",
                        "id": self.seed.id,
                        "label_id": self.label.id,
                        "type": "polygon",
                        "points": [9999] * 6,
                    }
                ],
            },
        )
        with (
            self.settings(SAM2_MODEL="test-model"),
            patch("cvat.apps.video_annotation.views.JobFrameProvider", return_value=provider),
            patch("cvat.apps.video_annotation.views.requests.get", return_value=health),
        ):
            with self.captureOnCommitCallbacks(execute=True):
                response = view.video_inference(request)
        provider.get_frame.assert_not_called()
        self.assertEqual(response.status_code, 202)
        run = InferenceRun.objects.get(pk=response.data["id"])
        self.assertEqual(run.prompts[0]["points"], self.seed.points)
        self.assertEqual(run.prompts[0]["object_id"], f"shape:{self.seed.id}")

    @unittest.skipUnless(os.getenv("SAM2_TEST_URL"), "Set SAM2_TEST_URL to test a real GPU service")
    def test_real_gpu_create_review_accept_export(self):
        from PIL import Image, ImageDraw
        from .worker import execute, run_directory
        import av
        import zipfile

        self.seed.points = [20, 20, 60, 20, 60, 65, 20, 65]
        self.seed.save()

        def frame_image(frame, **kwargs):
            image = Image.new("RGB", (128, 96), "white")
            ImageDraw.Draw(image).rectangle((20 + frame * 2, 20, 60 + frame * 2, 65), fill="red")
            return SimpleNamespace(data=image)

        provider = Mock()
        provider.get_frame.side_effect = frame_image
        request = SimpleNamespace(
            method="POST",
            user=self.user,
            data={
                "start_frame": 0,
                "stop_frame": 3,
                "prompts": [
                    {
                        "kind": "shape",
                        "id": self.seed.id,
                        "label_id": self.label.id,
                        "type": "polygon",
                        "points": self.seed.points,
                    }
                ],
            },
        )
        with (
            tempfile.TemporaryDirectory() as directory,
            self.settings(DATA_ROOT=Path(directory), SAM2_URL=os.environ["SAM2_TEST_URL"]),
            patch("cvat.apps.video_annotation.views.JobFrameProvider", return_value=provider),
            patch("cvat.apps.video_annotation.worker.JobFrameProvider", return_value=provider),
        ):
            response = self.view.video_inference(request)
            self.assertEqual(response.status_code, 202, response.data)
            run = InferenceRun.objects.get(pk=response.data["id"])
            execute(str(run.id))
            run.refresh_from_db()
            self.assertEqual(run.status, "ready", run.error)
            self.assertTrue(all(f["objects"][0]["points"] for f in run.result["frames"]))
            self.assertFalse((run_directory(run) / "preview.mp4").exists())
            response = self.view.video_inference_accept(SimpleNamespace(), run_id=run.id)
            self.assertEqual(response.status_code, 200, response.data)
            self.assertEqual(
                models.LabeledShape.objects.filter(job=self.job, type="mask").count(), 3
            )
            response = self.view.video_inference_export(SimpleNamespace(), run_id=run.id)
            with zipfile.ZipFile(io.BytesIO(b"".join(response.streaming_content))) as archive:
                self.assertNotIn("preview.mp4", archive.namelist())
                self.assertEqual(json.loads(archive.read("manifest.json"))["status"], "accepted")
            response.close()
