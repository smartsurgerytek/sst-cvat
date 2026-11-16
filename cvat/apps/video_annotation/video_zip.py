"""Build ZIP64 bundles of already rendered task MP4s on the export queue."""
import re
import shutil
import time
import uuid
import zipfile
from pathlib import Path

from rq import get_current_job
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from cvat.apps.engine import models
from cvat.apps.engine.permissions import TaskPermission
from cvat.apps.iam.permissions import get_iam_context
from .video_export import TTL, export_root, export_status, queue


def archive_root(project):
    return Path(project.get_dirname()) / 'video-zips'


def authorize_tasks(request, project, entries):
    tasks = {task.pk: task for task in models.Task.objects.filter(
        project=project, pk__in=[entry['task_id'] for entry in entries]).select_related('project', 'organization')}
    if len(tasks) != len(entries):
        raise ValidationError('All videos must be distinct tasks in this project.')
    for task in tasks.values():
        context = get_iam_context(request, task)
        for scope in (TaskPermission.Scopes.EXPORT_ANNOTATIONS, TaskPermission.Scopes.VIEW_ANNOTATIONS,
                      TaskPermission.Scopes.VIEW_DATA):
            if not TaskPermission(scope=scope, obj=task, location='local', **context).check_access().allow:
                raise PermissionDenied('You do not have permission to download every selected video.')
    return tasks


def create_archive(request, project, entries):
    tasks = authorize_tasks(request, project, entries)
    for entry in entries:
        if export_status(tasks[entry['task_id']], entry['export_id'], task_export=True)['state'] != 'ready':
            raise ValidationError('All selected videos must finish exporting before packaging.')
    identifier = str(uuid.uuid4())
    root = archive_root(project)
    root.mkdir(parents=True, exist_ok=True)
    for previous in root.iterdir():
        if previous.is_dir() and time.time() - previous.stat().st_mtime > TTL:
            shutil.rmtree(previous)
    directory = root / identifier
    directory.mkdir()
    try:
        queue().enqueue(build_archive, project.pk, identifier, entries,
                        job_id=f'video-zip-{project.pk}-{identifier}', job_timeout=3600,
                        result_ttl=TTL, failure_ttl=TTL,
                        meta={'project_id': project.pk, 'owner_id': request.user.pk, 'entries': entries, 'progress': 0})
    except Exception:
        shutil.rmtree(directory)
        raise
    return {'id': identifier, 'state': 'queued', 'progress': 0}


def archive_job(request, project, identifier):
    job = queue().fetch_job(f'video-zip-{project.pk}-{identifier}')
    if not job or job.meta.get('project_id') != project.pk or job.meta.get('owner_id') != request.user.pk:
        raise NotFound('The ZIP has expired or does not exist. Create a new ZIP.')
    return job


def archive_status(request, project, identifier):
    job = archive_job(request, project, identifier)
    state = job.get_status(refresh=True)
    state = str(getattr(state, 'value', state))
    if state == 'finished':
        state = 'ready' if (archive_root(project) / identifier / 'videos.zip').is_file() else 'failed'
    elif state == 'started':
        state = 'running'
    elif state in {'failed', 'stopped', 'canceled'}:
        state = 'failed'
    else:
        state = 'queued'
    return {'id': identifier, 'state': state, 'progress': job.meta.get('progress', 0),
            **({'error': 'ZIP packaging failed. A source export may have expired; export it again and retry.'}
               if state == 'failed' else {})}


def write_archive(path, files, progress):
    total = sum(source.stat().st_size for source, _ in files)
    completed, previous = 0, -1
    # MP4 is already compressed: storing it avoids a slow, ineffective second compression.
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for source, name in files:
            with source.open('rb') as incoming, archive.open(name, 'w', force_zip64=True) as outgoing:
                while block := incoming.read(1024 * 1024):
                    outgoing.write(block)
                    completed += len(block)
                    percent = min(99, int(completed * 100 / max(1, total)))
                    if percent != previous:
                        progress(percent)
                        previous = percent


def build_archive(project_id, identifier, entries):
    project = models.Project.objects.get(pk=project_id)
    directory = archive_root(project) / identifier
    temporary = directory / 'videos.part.zip'
    job = get_current_job()
    def progress(value):
        if job:
            job.meta['progress'] = value
            job.save_meta()
    try:
        files = []
        for entry in entries:
            task = models.Task.objects.get(pk=entry['task_id'], project=project)
            source = export_root(task) / entry['export_id'] / 'video.mp4'
            name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', task.name)[:100].strip('. ') or 'video'
            files.append((source, f'task-{task.pk}-{name}-A-B.mp4'))
        write_archive(temporary, files, progress)
        temporary.replace(directory / 'videos.zip')
        progress(100)
    finally:
        temporary.unlink(missing_ok=True)
