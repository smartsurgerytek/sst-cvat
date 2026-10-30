from contextlib import nullcontext
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.http import Http404
from django.test import TestCase, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from cvat.apps.engine.models import Project, Label, Task
from cvat.apps.engine.permissions import ProjectPermission
from .models import OriginalVideo
from .original_views import OriginalVideoMixin


def make_mp4():
    return (Path(__file__).parent / "test_assets" / "original.mp4").read_bytes()


class OriginalVideoTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings_override = override_settings(DATA_ROOT=Path(self.directory.name))
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.user = get_user_model().objects.create_user('original-video-test')
        self.project = Project.objects.create(name='Original video', owner=self.user)
        self.label = Label.objects.create(name='Object', type='any', project=self.project)
        self.view = OriginalVideoMixin()
        self.view.get_object = lambda: self.project
        self.content = make_mp4()

    def upload(self, native=False, segment_duration=None):
        # Legacy fixtures exercise migration and the old versioned interval API.
        context = nullcontext() if native else patch(
            'cvat.apps.video_annotation.native_workspace.ensure_workspace'
        )
        with context:
            response = self.view.original_videos(SimpleNamespace(
                method='POST', user=self.user, data={'name': 'Original clip',
                    **({'segment_duration': segment_duration} if segment_duration is not None else {})},
                FILES={'file': SimpleUploadedFile('clip.mp4', self.content, content_type='video/mp4')},
            ))
        self.assertEqual(response.status_code, 201)
        return OriginalVideo.objects.get(pk=response.data['id'])

    def shape(self):
        return dict(id=str(uuid.uuid4()), label_id=self.label.id, type='rectangle',
                    start=0, end=1, points=[0.1, 0.2, 0.5, 0.6])

    def save(self, video, annotations, version=0):
        return self.view.original_video(SimpleNamespace(method='PATCH', data={
            'version': version, 'annotations': annotations,
        }), video_id=video.id)

    def test_original_bytes_preserved_without_tasks_or_frames(self):
        count = Task.objects.count()
        video = self.upload()
        self.assertEqual(video.path.read_bytes(), self.content)
        self.assertEqual(list(video.directory.iterdir()), [video.path])
        self.assertEqual(Task.objects.count(), count)
        self.assertEqual((video.width, video.height), (64, 48))
        self.assertAlmostEqual(video.duration, 2, places=2)

    def test_save_reload_and_conflict(self):
        video = self.upload()
        shape = self.shape()
        self.assertEqual(self.save(video, [shape]).status_code, 200)
        video.refresh_from_db()
        self.assertEqual(video.annotations, [shape])
        self.assertEqual(video.version, 1)
        self.assertEqual(self.save(video, []).status_code, 409)
        self.assertEqual(self.save(video, [], version=1).status_code, 200)

    def test_reject_bad_intervals_coordinates_labels_and_duplicates(self):
        video = self.upload()
        other = Project.objects.create(name='Other project', owner=self.user)
        foreign_label = Label.objects.create(name='Other label', type='any', project=other)
        for changes in [dict(end=3), dict(end=0), dict(start=float('nan')),
                        dict(points=[0, 0, 2, 1]), dict(label_id=foreign_label.id),
                        dict(type='polygon', points=[0, 0, 1, 1])]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.save(video, [{**self.shape(), **changes}])
        shape = self.shape()
        with self.assertRaises(ValidationError):
            self.save(video, [shape, shape])

    def test_reject_invalid_mp4_and_remove_partial_file(self):
        with self.assertRaises(ValidationError):
            self.view.original_videos(SimpleNamespace(method='POST', user=self.user, data={},
                FILES={'file': SimpleUploadedFile('fake.mp4', b'not video')}))
        self.assertFalse(OriginalVideo.objects.exists())
        self.assertEqual(list((Path(self.directory.name) / 'original_videos').iterdir()), [])

    def test_ranges_support_seeking_and_suffix(self):
        video = self.upload()
        for header, expected in [('bytes=0-9', self.content[:10]), ('bytes=-12', self.content[-12:])]:
            response = self.view.original_video_media(SimpleNamespace(headers={'Range': header}), video_id=video.id)
            self.assertEqual(response.status_code, 206)
            self.assertEqual(b''.join(response.streaming_content), expected)
        response = self.view.original_video_media(SimpleNamespace(headers={'Range': 'bytes=99999999-'}), video_id=video.id)
        self.assertEqual(response.status_code, 416)

    def test_project_isolation_and_permissions_before_access(self):
        video = self.upload()
        other = Project.objects.create(name='Other project', owner=self.user)
        self.view.get_object = lambda: other
        with self.assertRaises(Http404):
            self.view.original_video(SimpleNamespace(method='GET'), video_id=video.id)
        self.view.get_object = Mock(side_effect=PermissionDenied())
        for action in ['original_videos', 'original_video', 'original_video_media']:
            with self.assertRaises(PermissionDenied):
                getattr(self.view, action)(SimpleNamespace(method='GET'))
        for action in ['original_videos', 'original_video', 'original_video_media']:
            scopes = ProjectPermission._get_scopes(SimpleNamespace(method='GET'), SimpleNamespace(action=action), None)
            self.assertEqual(scopes, [ProjectPermission.Scopes.VIEW])
        scopes = ProjectPermission._get_scopes(SimpleNamespace(method='PATCH'), SimpleNamespace(action='original_video'), None)
        self.assertIn(ProjectPermission.Scopes.UPDATE_DESC, scopes)

    def test_delete_removes_original_file(self):
        video = self.upload()
        directory = video.directory
        with self.captureOnCommitCallbacks(execute=True):
            response = self.view.original_video(SimpleNamespace(method='DELETE'), video_id=video.id)
        self.assertEqual(response.status_code, 204)
        self.assertFalse(directory.exists())

    def test_catalog_filters_projects_before_listing_and_searching(self):
        video = self.upload()
        other = Project.objects.create(name='Hidden project', owner=self.user)
        OriginalVideo.objects.create(project=other, name='Hidden video', filename='hidden.mp4',
                                     duration=1, width=64, height=48, size=100)
        self.view.get_queryset = lambda: Project.objects.all()
        self.view.detail = False
        self.view.iam_organization_field = 'organization'
        self.view.paginate_queryset = lambda queryset: list(queryset[:5])
        self.view.get_paginated_response = lambda rows: Response({'results': rows})
        request = SimpleNamespace(query_params={'org': ''}, headers={}, iam_context={'organization': None})
        permission = Mock()
        permission.filter.return_value = Project.objects.filter(pk=self.project.pk)
        with patch.object(ProjectPermission, 'create_scope_list', return_value=permission):
            response = self.view.original_video_catalog(request)
            rows = response.data['results']
            self.assertEqual([row['id'] for row in rows], [str(video.id)])
            self.assertEqual(rows[0]['project_name'], self.project.name)
            self.assertNotIn('annotations', rows[0])
            request.query_params['video_search'] = 'missing'
            self.assertEqual(self.view.original_video_catalog(request).data['results'], [])
        self.assertEqual(ProjectPermission._get_scopes(
            SimpleNamespace(method='GET'), SimpleNamespace(action='original_video_catalog'), None,
        ), [ProjectPermission.Scopes.LIST])

    def test_native_workspace_is_idempotent_and_keeps_original_media(self):
        from .native_workspace import ensure_workspace
        from cvat.apps.engine.frame_provider import JobFrameProvider, FrameOutputType
        video = self.upload()
        initial = self.shape()
        self.save(video, [initial])
        video, job = ensure_workspace(video.id)
        again, same_job = ensure_workspace(video.id)
        self.assertEqual(same_job.id, job.id)
        self.assertEqual(again.task_id, video.task_id)
        self.assertEqual(video.path.read_bytes(), self.content)
        self.assertEqual(list(video.directory.iterdir()), [video.path])
        self.assertFalse(video.task.data.images.exists())
        raw = video.task.data.get_upload_dirname() / "source.mp4"
        self.assertTrue(raw.samefile(video.path))
        self.assertEqual(list(video.task.data.get_upload_dirname().iterdir()), [raw])
        self.assertEqual(job.labeledtrack_set.count(), 1)
        provider = JobFrameProvider(job)
        decoded = provider.get_frame(0, out_type=FrameOutputType.PIL).data
        self.assertEqual(decoded.size, (64, 48))
        self.assertEqual(len(video.timestamps), job.segment.frame_count)
        self.assertEqual(self.save(video, [], version=1).status_code, 409)

    def test_native_mask_uses_standard_annotation_storage(self):
        from .native_workspace import ensure_workspace
        from cvat.apps.dataset_manager import task as annotations
        video, job = ensure_workspace(self.upload().id)
        label = Label.objects.create(project=self.project, name='Mask', type='mask')
        # Standard CVAT mask RLE plus inclusive bounding box: a filled 2x2 mask.
        payload = {'version': 0, 'tags': [], 'tracks': [], 'shapes': [{
            'type': 'mask', 'label_id': label.id, 'frame': 0,
            'points': [0, 4, 1, 1, 2, 2], 'occluded': False,
            'z_order': 0, 'rotation': 0, 'attributes': [], 'group': 0,
            'source': 'manual',
        }]}
        annotations.put_job_data(job.id, payload)
        saved = annotations.get_job_data(job.id)
        self.assertEqual(saved['shapes'][0]['type'], 'mask')
        self.assertEqual(saved['shapes'][0]['points'], payload['shapes'][0]['points'])

    def test_upload_creates_native_task_before_returning(self):
        video = self.upload(native=True)
        self.assertIsNotNone(video.task_id)
        self.assertEqual(video.task.project_id, self.project.id)
        self.assertFalse(video.task.data.images.exists())

    def test_upload_splits_one_task_into_time_based_jobs(self):
        from cvat.apps.engine.models import Job
        from cvat.apps.engine.frame_provider import JobFrameProvider, FrameOutputType
        from .native_workspace import ensure_workspace
        from .original_views import OriginalVideoSerializer
        video = self.upload(native=True, segment_duration=1)
        jobs = list(Job.objects.filter(segment__task_id=video.task_id).order_by("segment__start_frame"))
        self.assertEqual(len(jobs), 2)
        self.assertEqual(jobs[0].segment.start_frame, 0)
        self.assertEqual(jobs[0].segment.stop_frame + 1, jobs[1].segment.start_frame)
        self.assertEqual(jobs[-1].segment.stop_frame, len(video.timestamps) - 1)
        boundary = jobs[1].segment.start_frame
        self.assertLess(video.timestamps[boundary - 1], 1)
        self.assertGreaterEqual(video.timestamps[boundary], 1)
        self.assertEqual(ensure_workspace(video.id)[1].id, jobs[0].id)
        self.assertEqual(OriginalVideoSerializer(video).data["job_count"], 2)
        self.assertEqual(video.path.read_bytes(), self.content)
        image = JobFrameProvider(jobs[1]).get_frame(boundary, out_type=FrameOutputType.PIL).data
        self.assertEqual(image.size, (64, 48))

    def test_invalid_split_duration_does_not_create_video(self):
        for duration in (0, -2, 1.5, "nan", 86401):
            with self.subTest(duration=duration), self.assertRaises(ValidationError):
                self.view.original_videos(SimpleNamespace(
                    method="POST", user=self.user, data={"segment_duration": duration},
                    FILES={"file": SimpleUploadedFile("clip.mp4", self.content)},
                ))
        self.assertFalse(OriginalVideo.objects.exists())

    def test_split_jobs_receive_legacy_annotations_across_boundary(self):
        from .native_workspace import ensure_workspace
        from cvat.apps.engine.models import Job
        video = self.upload()
        self.save(video, [{**self.shape(), "end": 1.8}])
        video, _ = ensure_workspace(video.id, segment_duration=1)
        jobs = list(Job.objects.filter(segment__task_id=video.task_id))
        self.assertEqual(len(jobs), 2)
        self.assertTrue(all(job.labeledtrack_set.exists() for job in jobs))
