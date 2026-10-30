"""Exercise the real SAM1 proxy/serializer with mocked CVAT media and inference."""
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

from django.conf import settings
from PIL import Image
from rest_framework.exceptions import ValidationError

if not settings.configured:
    settings.configure(USE_I18N=False, REST_FRAMEWORK={}, SAM1_URL="http://sam1:8000")

# Isolate this module so it also runs without CVAT's database/AV dependencies.
engine = ModuleType("cvat.apps.engine")
engine.models = SimpleNamespace(DimensionType=SimpleNamespace(DIM_2D="2d"),
                                JobType=SimpleNamespace(ANNOTATION="annotation"))
frames = ModuleType("cvat.apps.engine.frame_provider")
frames.FrameOutputType = SimpleNamespace(PIL="pil")
frames.JobFrameProvider = Mock()
spec = importlib.util.spec_from_file_location(
    "sam1_proxy_under_test", Path(__file__).resolve().parents[2] / "cvat/apps/video_annotation/sam1.py"
)
proxy = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"cvat.apps.engine": engine, "cvat.apps.engine.frame_provider": frames}):
    spec.loader.exec_module(proxy)


class SAM1ProxyTests(unittest.TestCase):
    def setUp(self):
        self.job = SimpleNamespace(type="annotation", segment=SimpleNamespace(
            start_frame=10, stop_frame=20,
            task=SimpleNamespace(dimension="2d", data=SimpleNamespace(deleted_frames=[12])),
        ))
        self.provider = Mock()
        self.provider.get_frame.return_value.data = Image.new("RGB", (16, 12))
        frames.JobFrameProvider.reset_mock()
        frames.JobFrameProvider.return_value = self.provider
        self.body = {"frame": 11, "pos_points": [[3, 4]], "neg_points": [[7, 8]]}

    def test_frame_and_mouse_prompts_forwarded_without_saving_annotations(self):
        result = {"mask": [[1]], "bounds": [3, 4, 3, 4]}
        with patch.object(proxy.requests, "post", return_value=Mock(status_code=200, json=lambda: result)) as post:
            response = proxy.infer(self.job, self.body)
        self.assertEqual(response.data, result)
        self.provider.get_frame.assert_called_once_with(11, out_type="pil")
        self.provider.unload.assert_called_once()
        args = post.call_args.kwargs
        self.assertEqual(json.loads(args["data"]["prompts"]), {
            "pos_points": [[3.0, 4.0]], "neg_points": [[7.0, 8.0]],
        })
        with Image.open(io.BytesIO(args["files"]["image"][1])) as image:
            self.assertEqual(image.size, (16, 12))

    def test_rejects_frames_outside_job_and_deleted_frames_before_reading_media(self):
        for frame in [0, 9, 12, 21]:
            with self.subTest(frame=frame), self.assertRaises(ValidationError):
                proxy.infer(self.job, {**self.body, "frame": frame})
        frames.JobFrameProvider.assert_not_called()

    def test_rejects_invalid_and_excessive_points(self):
        for points in [[], [[1]], [[1, 2, 3]], [[-1, 2]], [[float("nan"), 2]],
                       [[float("inf"), 2]], [[1, 2]] * 256]:
            with self.subTest(points=points[:2]), self.assertRaises(ValidationError):
                proxy.infer(self.job, {**self.body, "pos_points": points})
        frames.JobFrameProvider.assert_not_called()

    def test_rejects_out_of_image_points_and_releases_frame_provider(self):
        with self.assertRaises(ValidationError):
            proxy.infer(self.job, {**self.body, "neg_points": [[16, 1]]})
        self.provider.unload.assert_called_once()

    def test_model_service_unavailable_is_actionable(self):
        with patch.object(proxy.requests, "post", side_effect=proxy.requests.ConnectionError()):
            response = proxy.infer(self.job, self.body)
        self.assertEqual(response.status_code, 503)
        self.assertIn("sam1 service", response.data["detail"])

    def test_no_mask_and_busy_errors_are_preserved(self):
        for code in [422, 503]:
            with self.subTest(code=code), patch.object(proxy.requests, "post", return_value=Mock(
                status_code=code, json=lambda: {"detail": "Try another point"},
            )):
                response = proxy.infer(self.job, self.body)
                self.assertEqual(response.status_code, code)
                self.assertEqual(response.data["detail"], "Try another point")


if __name__ == "__main__":
    unittest.main()
