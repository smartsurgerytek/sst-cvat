"""Stream large downloads under ASGI without buffering the whole file in memory."""
import asyncio
from pathlib import Path

from django.http import StreamingHttpResponse
from django.utils.http import content_disposition_header
from rest_framework.exceptions import NotFound


def video_download_response(path, filename, content_type):
    path = Path(path)
    try:
        size = path.stat().st_size
    except FileNotFoundError as error:
        raise NotFound('This export has expired. Create a new export.') from error

    async def chunks():
        with path.open('rb') as source:
            while block := await asyncio.to_thread(source.read, 1024 * 1024):
                yield block

    response = StreamingHttpResponse(chunks(), content_type=content_type)
    response['Content-Length'] = size
    response['Content-Disposition'] = content_disposition_header(True, filename)
    # Already compressed MP4/ZIP: bypass Django gzip and preserve transfer length.
    response['Content-Encoding'] = 'identity'
    response['X-Accel-Buffering'] = 'no'
    response['Cache-Control'] = 'private, no-store, no-transform'
    return response
