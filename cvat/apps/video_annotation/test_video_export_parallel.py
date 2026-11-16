import json
import tempfile
import unittest
from pathlib import Path

import av
from PIL import Image

from .video_export_parallel import concatenate, parallel_export
from .video_export_render import encode_video


class ParallelVideoExportTests(unittest.TestCase):
    def test_remux_preserves_all_frames_and_variable_durations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            durations = [[.04, .08], [.12, .04]]
            parts = [root / 'a.mp4', root / 'b.mp4']
            for part, lengths, color in zip(parts, durations, ('red', 'blue')):
                encode_video(part, [0, 1], lengths, lambda _: Image.new('RGB', (320, 240), color))
            concatenate(parts, root / 'video.mp4', durations)
            with av.open(str(root / 'video.mp4')) as result:
                frames = list(result.decode(video=0))
                self.assertEqual(len(frames), 4)
                self.assertEqual([round(float(f.pts*f.time_base), 3) for f in frames], [0, .04, .12, .24])
                self.assertAlmostEqual(result.duration / av.time_base, .28, places=3)
                self.assertGreater(frames[0].to_image().getpixel((0, 0))[0], 200)
                self.assertGreater(frames[2].to_image().getpixel((0, 0))[2], 200)

    def test_processes_render_and_merge_snapshot_without_losing_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.mp4'
            encode_video(source, list(range(65)), [.04]*65,
                         lambda _: Image.new('RGB', (320, 240), 'black'))
            frames = [i for i in range(65) if i != 2]
            snapshot = {'frames': frames, 'deleted_frames': [2], 'identities': {},
                        'timing': {'timestamps': [i*.04 for i in range(65)], 'duration': 2.6},
                        'options': {'start_frame': 0, 'stop_frame': 64, 'opacity': .5,
                                    'show_names': False, 'show_legend': False, 'show_phase': True},
                        'labels': {'1': {'name': 'Tool', 'color': '#ff0000'}},
                        'annotations': {'version': 0, 'tracks': [], 'tags': [], 'shapes': [
                            {'id': 1, 'frame': 64, 'type': 'rectangle', 'label_id': 1,
                             'points': [20, 20, 100, 100], 'z_order': 0, 'rotation': 0, 'attributes': []}]}}
            snapshot["labels"]["2"] = {"name": "Tracked tool", "color": "#0000ff"}
            keyframe = {"type": "rectangle", "rotation": 0, "occluded": False, "outside": False,
                        "z_order": 0, "attributes": []}
            snapshot["annotations"]["tracks"] = [
                {"id": 9, "label_id": 2, "group": 0, "source": "manual", "attributes": [], "frame": 0,
                 "shapes": [{**keyframe, "frame": 0, "points": [20, 40, 80, 100]},
                            {**keyframe, "frame": 64, "points": [180, 40, 240, 100]}]}]
            path = root / 'snapshot.json'
            path.write_text(json.dumps(snapshot))
            spec = {'path': str(source), 'timestamps': snapshot['timing']['timestamps'],
                    'start': 0, 'step': 1, 'rotate': False}
            progress = []
            parallel_export(path, spec, root / 'result.mp4', progress.append, 2)
            with av.open(str(root / 'result.mp4')) as result:
                decoded = list(result.decode(video=0))
                self.assertEqual(len(decoded), 64)
                self.assertAlmostEqual(result.duration / av.time_base, 2.56, places=3)
                self.assertGreater(decoded[-1].to_image().getpixel((370, 90))[0], 100)
                self.assertGreater(decoded[0].to_image().getpixel((370, 110))[2], 100)
                self.assertGreater(decoded[-1].to_image().getpixel((530, 110))[2], 100)
            self.assertFalse((root / 'parts').exists())
            self.assertEqual(progress[-1], 99)

    def test_process_budget_is_shared_between_active_exports(self):
        from unittest.mock import patch
        from .video_export_parallel import process_count
        with patch.dict('os.environ', {'CVAT_VIDEO_EXPORT_PROCESSES': '12'}), \
                patch('cvat.apps.video_annotation.video_export_parallel.detect_hardware',
                      return_value={'effective_cpus': 36, 'available_memory_bytes': 64*1024**3}), \
                patch('django_rq.get_queue'), \
                patch('rq.registry.StartedJobRegistry') as registry:
            registry.return_value.get_job_ids.return_value = ['a', 'b', 'c']
            self.assertEqual(process_count(600), 4)
            self.assertEqual(process_count(30), 1)
