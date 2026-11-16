import asyncio
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from rest_framework.exceptions import NotFound, ValidationError
from . import video_zip
from .downloads import video_download_response


class VideoZipTests(unittest.TestCase):
    def test_archive_preserves_bytes_unicode_names_and_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'video.mp4'
            content = b'mp4' * 800000
            source.write_bytes(content)
            progress = []
            video_zip.write_archive(root / 'videos.zip', [(source, 'task-1-椎間盤-A-B.mp4')], progress.append)
            with zipfile.ZipFile(root / 'videos.zip') as archive:
                self.assertEqual(archive.read('task-1-椎間盤-A-B.mp4'), content)
                self.assertEqual(archive.infolist()[0].compress_type, zipfile.ZIP_STORED)
            self.assertEqual(progress[-1], 99)
            self.assertEqual(progress, sorted(progress))

    def test_build_publishes_complete_archive_and_cleans_failed_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'export').mkdir()
            (root / 'export' / 'video.mp4').write_bytes(b'video')
            (root / 'zip').mkdir()
            task = SimpleNamespace(pk=1, name='椎間盤/a')
            job = Mock(meta={})
            with patch.object(video_zip.models.Project.objects, 'get'), \
                 patch.object(video_zip.models.Task.objects, 'get', return_value=task), \
                 patch.object(video_zip, 'archive_root', return_value=root), \
                 patch.object(video_zip, 'export_root', return_value=root), \
                 patch.object(video_zip, 'get_current_job', return_value=job):
                entries = [{'task_id': 1, 'export_id': 'export'}]
                video_zip.build_archive(1, 'zip', entries)
                self.assertEqual(job.meta['progress'], 100)
                with zipfile.ZipFile(root / 'zip' / 'videos.zip') as archive:
                    self.assertEqual(archive.read('task-1-椎間盤_a-A-B.mp4'), b'video')
                (root / 'zip' / 'videos.zip').unlink()
                (root / 'export' / 'video.mp4').unlink()
                with self.assertRaises(FileNotFoundError):
                    video_zip.build_archive(1, 'zip', entries)
                self.assertEqual(list((root / 'zip').iterdir()), [])

    def test_export_permission_has_local_destination(self):
        task = Mock(pk=1, project_id=3, owner_id=1, assignee_id=None, organization_id=None)
        task.project = Mock(owner_id=1, assignee_id=None, organization_id=None)
        request = SimpleNamespace(user=SimpleNamespace(id=1), iam_context={'privilege': 'admin'})
        with patch.object(video_zip.models.Task.objects, 'filter') as query, \
             patch.object(video_zip, 'get_iam_context', return_value={
                 'user_id': 1, 'group_name': 'admin', 'org_id': None,
                 'org_owner_id': None, 'org_role': None}), \
             patch.object(video_zip.TaskPermission, 'check_access', autospec=True) as check:
            query.return_value.select_related.return_value = [task]
            def allowed(permission):
                if permission.scope == video_zip.TaskPermission.Scopes.EXPORT_ANNOTATIONS:
                    self.assertEqual(permission.get_resource()['destination'], 'local')
                return SimpleNamespace(allow=True)
            check.side_effect = allowed
            self.assertEqual(video_zip.authorize_tasks(request, Mock(), [{'task_id': 1}]), {1: task})
            self.assertEqual(check.call_count, 3)

    def test_other_users_cannot_access_archive(self):
        job = Mock(meta={'project_id': 1, 'owner_id': 2})
        with patch.object(video_zip, 'queue') as queue:
            queue.return_value.fetch_job.return_value = job
            with self.assertRaises(NotFound):
                video_zip.archive_job(SimpleNamespace(user=SimpleNamespace(pk=3)), SimpleNamespace(pk=1), 'id')

    def test_cannot_package_unfinished_exports(self):
        with patch.object(video_zip, 'authorize_tasks', return_value={1: Mock()}), \
             patch.object(video_zip, 'export_status', return_value={'state': 'running'}):
            with self.assertRaises(ValidationError):
                video_zip.create_archive(Mock(), Mock(), [{'task_id': 1, 'export_id': 'id'}])

    def test_async_download_stream_and_missing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'video.zip'
            data = b'x' * (1024 * 1024 + 19)
            path.write_bytes(data)
            response = video_download_response(path, '椎間盤.zip', 'application/zip')
            from django.middleware.gzip import GZipMiddleware
            response = GZipMiddleware(lambda r: None).process_response(
                SimpleNamespace(META={'HTTP_ACCEPT_ENCODING': 'gzip'}), response)
            self.assertEqual(response['Content-Encoding'], 'identity')
            self.assertEqual(response['X-Accel-Buffering'], 'no')
            self.assertTrue(response.is_async)
            self.assertEqual(int(response['Content-Length']), len(data))
            self.assertIn("filename*=utf-8''", response['Content-Disposition'])
            async def collect():
                return [chunk async for chunk in response.streaming_content]
            chunks = asyncio.run(collect())
            self.assertEqual(len(chunks), 2)
            self.assertEqual(b''.join(chunks), data)
            path.unlink()
            with self.assertRaises(NotFound):
                video_download_response(path, 'video.zip', 'application/zip')
