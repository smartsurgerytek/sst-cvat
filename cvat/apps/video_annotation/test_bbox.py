import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from .playback import build_playback_snapshot, preview_masks
from .utils import initialize_prompt, prediction_geometry, validate_rectangle


class BoundingBoxTests(unittest.TestCase):
    def test_rectangle_uses_box_prompt_not_a_filled_mask(self):
        predictor = Mock()
        state = {"video_width": 100, "video_height": 50}
        prompt = {"type": "rectangle", "points": [1.5, 2, 99, 50]}
        initialize_prompt(predictor, state, prompt, 7)
        predictor.add_new_points_or_box.assert_called_once_with(
            state, frame_idx=0, obj_id=7, box=prompt["points"],
        )
        predictor.add_new_mask.assert_not_called()

    def test_segmentation_still_uses_mask_prompt(self):
        predictor = Mock()
        initialize_prompt(predictor, {"video_width": 10, "video_height": 10},
                          {"type": "polygon", "points": [1, 1, 5, 1, 5, 5]}, 0)
        predictor.add_new_mask.assert_called_once()
        predictor.add_new_points_or_box.assert_not_called()
        self.assertEqual(predictor.add_new_mask.call_args.kwargs["mask"].shape, (10, 10))

    def test_rejects_invalid_geometry(self):
        for points in ([1, 2, 3], [1, 2, 1, 4], [4, 2, 1, 4], [-1, 2, 4, 5],
                       [0, 0, 101, 50], [0, 0, 10, float('nan')], [0, 0, 10, float('inf')]):
            with self.subTest(points=points), self.assertRaises(ValueError):
                validate_rectangle(points, 100, 50)

    def test_tight_mask_bounds_become_pixel_edges_including_single_pixel(self):
        self.assertEqual(prediction_geometry({"type": "rectangle"}, [0, 1, 5, 7, 5, 7]),
                         ("rectangle", [5, 7, 6, 8]))
        self.assertEqual(prediction_geometry({"type": "rectangle"}, None), ("rectangle", None))
        points = [0, 4, 0, 0, 1, 1]
        self.assertEqual(prediction_geometry({"type": "polygon"}, points), ("mask", points))

    def test_ready_and_accepted_playback_use_rectangle_geometry(self):
        run = SimpleNamespace(start_frame=0, stop_frame=1, status="ready", accepted_shapes=[],
                              prompts=[{"object_id": "box", "label_id": 1, "type": "rectangle"}],
                              result={"width": 100, "height": 50, "frames": [
                                  {"frame": 1, "objects": [{"object_id": "box", "points": [0, 4, 1, 2, 2, 3]}]},
                              ]})
        obj = build_playback_snapshot(run, {})["frames"][1]["objects"][0]
        self.assertEqual(obj["type"], "rectangle")
        self.assertEqual(obj["points"], [1, 2, 3, 4])
        run.status = "accepted"
        run.accepted_shapes = [{"id": 8, "object_id": "box"}]
        edited = {"id": 8, "frame": 1, "label_id": 1, "type": "rectangle", "points": [4.5, 5, 9, 10]}
        obj = build_playback_snapshot(run, {}, [edited])["frames"][1]["objects"][0]
        self.assertEqual(obj["points"], edited["points"])
        self.assertEqual(build_playback_snapshot(run, {}, [])["frames"][1]["objects"], [])

    def test_low_resolution_preview_scales_boxes_without_decoding_as_rle(self):
        payload = {"width": 640, "height": 360, "objects": [
            {"type": "rectangle", "points": [10, 20, 100, 200]},
        ]}
        result = preview_masks(payload)
        self.assertEqual(result["objects"][0]["points"], [5, 10, 50, 100])
        self.assertEqual(payload["objects"][0]["points"], [10, 20, 100, 200])
