import copy
import unittest
from types import SimpleNamespace

from .playback import build_playback_snapshot


class PlaybackSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.labels = {1: SimpleNamespace(color="#123456")}
        self.run = SimpleNamespace(
            start_frame=10, stop_frame=12, status="ready", accepted_shapes=[],
            prompts=[{"object_id": "a", "label_id": 1}],
            result={"width": 1920, "height": 1080, "frames": [
                {"frame": 10, "objects": [{"object_id": "a", "points": [0, 1, 0, 0, 0, 0], "logits": "large"}]},
                {"frame": 11, "objects": [{"object_id": "a", "points": None}]},
            ]},
        )

    def test_ready_snapshot_omits_scores_and_includes_empty_frames(self):
        before = copy.deepcopy(self.run.result)
        snapshot = build_playback_snapshot(self.run, self.labels)
        self.assertEqual([frame["frame"] for frame in snapshot["frames"]], [10, 11, 12])
        obj = snapshot["frames"][0]["objects"][0]
        self.assertEqual(obj["label_color"], "#123456")
        self.assertNotIn("logits", obj)
        self.assertEqual(snapshot["frames"][1]["objects"], [])
        self.assertEqual(snapshot["frames"][2]["objects"], [])
        self.assertEqual(before, self.run.result)

    def test_accepted_snapshot_uses_live_edits_and_excludes_deleted_or_unrelated_shapes(self):
        self.run.status = "accepted"
        self.run.accepted_shapes = [{"id": 3, "object_id": "a"}, {"id": 4, "object_id": "b"}]
        corrected = [0, 4, 10, 10, 11, 11]
        shapes = [
            {"id": 3, "frame": 11, "label_id": 1, "type": "mask", "points": corrected},
            {"id": 5, "frame": 11, "label_id": 1, "type": "mask", "points": corrected},
        ]
        snapshot = build_playback_snapshot(self.run, self.labels, shapes)
        self.assertEqual(snapshot["frames"][0]["objects"], [])
        self.assertEqual(snapshot["frames"][1]["objects"], [
            {"object_id": "a", "label_color": "#123456", "points": corrected},
        ])

    def test_missing_label_has_fallback_color(self):
        snapshot = build_playback_snapshot(self.run, {})
        self.assertEqual(snapshot["frames"][0]["objects"][0]["label_color"], "#808080")


class PlaybackPreviewTests(unittest.TestCase):
    def test_preview_resizes_scores_without_changing_saved_masks(self):
        import base64
        import copy
        import numpy as np
        from .playback import preview_masks
        from .utils import decode_mask, encode_mask
        values = np.arange(640 * 360, dtype='<f4').reshape(360, 640)
        points = encode_mask(values > 1000)
        payload = {"frame": 10, "width": 640, "height": 360,
                   "objects": [{"object_id": "one", "points": points,
                                "logits": base64.b64encode(values.tobytes()).decode('ascii')}]}
        saved = copy.deepcopy(payload)
        result = preview_masks(payload)
        self.assertEqual((result['width'], result['height']), (320, 180))
        decoded = np.frombuffer(base64.b64decode(result['objects'][0]['logits']), dtype='<f4').reshape(180, 320)
        np.testing.assert_array_equal(decoded, values[::2, ::2])
        np.testing.assert_array_equal(decode_mask(result['objects'][0]['points'], 320, 180),
                                      (values > 1000)[::2, ::2])
        self.assertEqual(payload, saved)
