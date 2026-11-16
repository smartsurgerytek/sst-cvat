// SPDX-License-Identifier: MIT
import type { OriginalVideoSource } from 'cvat-core/src/original-video';
import { VideoSegmentStream, VideoSegment, SEGMENT_SECONDS } from 'cvat-core/src/video-segments';

// A single MSE decoder; downloaded blobs outlive this player in the shared cache.
export async function prepareSegmentedVideo(
    video: HTMLVideoElement,
    source: OriginalVideoSource,
    start: number,
    stop: number,
    signal: AbortSignal,
    status: (message: string) => void,
): Promise<void> {
    if (typeof MediaSource === 'undefined') throw new Error('Segment playback requires MediaSource support.');
    const media = new MediaSource();
    const url = URL.createObjectURL(media);
    let buffer: SourceBuffer;
    let disposed = false;
    let queue = Promise.resolve();
    const appended = new Set<number>();
    let retry: ReturnType<typeof setInterval>;
    const update = (operation: () => void): Promise<void> => new Promise((resolve, reject) => {
        let done: () => void;
        let fail: () => void;
        const cleanup = (): void => {
            buffer.removeEventListener('updateend', done);
            buffer.removeEventListener('error', fail);
            signal.removeEventListener('abort', fail);
        };
        done = (): void => { cleanup(); resolve(); };
        fail = (): void => { cleanup(); reject(new Error('Video buffering interrupted')); };
        if (signal.aborted) { fail(); return; }
        buffer.addEventListener('updateend', done, { once: true });
        buffer.addEventListener('error', fail, { once: true });
        signal.addEventListener('abort', fail, { once: true });
        try { operation(); } catch (error) { cleanup(); reject(error); }
    });
    const append = async (segment: VideoSegment, index: number): Promise<void> => {
        if (disposed || appended.has(index)) return;
        const current = video.currentTime;
        if (segment.end < current - SEGMENT_SECONDS || segment.start > current + 25) return;
        if (!buffer) {
            const mime = `video/mp4; codecs="${segment.codec}"`;
            if (!MediaSource.isTypeSupported(mime)) throw new Error('Unsupported video codec');
            buffer = media.addSourceBuffer(mime);
        }
        const bytes = await segment.blob.arrayBuffer();
        if (disposed) return;
        buffer.timestampOffset = segment.start;
        await update(() => buffer.appendBuffer(bytes));
        appended.add(index);
        if (current > 30) {
            const before = (Math.floor(current / SEGMENT_SECONDS) - 3) * SEGMENT_SECONDS;
            await update(() => buffer.remove(0, before));
            for (const previous of appended) if ((previous + 1) * SEGMENT_SECONDS <= before) appended.delete(previous);
        }
        if (!disposed && segment.end >= source.duration - 0.001 && media.readyState === 'open') {
            media.endOfStream();
        }
    };
    const stream = new VideoSegmentStream(source, 'original-v1', (segment, index) => {
        queue = queue.catch(() => {}).then(() => append(segment, index));
        queue.catch((error) => { if (!disposed) status(String(error)); });
    });
    const focus = (prioritize = false): void => {
        if (!disposed) {
            stream.focus(Math.min(video.currentTime, stop - 0.000001), prioritize).catch((error) => {
                if (!disposed && error?.name !== 'AbortError' && error?.code !== 'ERR_CANCELED') {
                    if (video.seeking || video.readyState < 2) status('Buffering video…');
                }
            });
        }
    };
    const seek = (): void => focus(true);
    const advance = (): void => focus();
    const dispose = (): void => {
        disposed = true;
        stream.dispose();
        clearInterval(retry);
        video.removeEventListener('seeking', seek);
        video.removeEventListener('timeupdate', advance);
        if (buffer?.updating) buffer.abort();
        video.pause(); video.removeAttribute('src'); video.load();
        URL.revokeObjectURL(url);
    };
    signal.addEventListener('abort', dispose, { once: true });
    const opened = new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(new Error('Playback cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        media.addEventListener('sourceopen', () => {
            signal.removeEventListener('abort', abort); resolve();
        }, { once: true });
    });
    if (signal.aborted) { dispose(); throw new Error('Playback cancelled'); }
    video.src = url;
    await opened;
    try {
        media.duration = source.duration;
        status('Buffering video…');
        video.currentTime = start;
        video.addEventListener('seeking', seek);
        video.addEventListener('timeupdate', advance);
        while (!disposed) {
            try {
                const position = video.currentTime;
                await stream.focus(position);
                const next = (Math.floor(position / SEGMENT_SECONDS) + 1) * SEGMENT_SECONDS;
                if (next < stop) await stream.readAhead(next);
                await queue;
                if (Math.floor(position / SEGMENT_SECONDS) === Math.floor(video.currentTime / SEGMENT_SECONDS)) break;
            } catch (error) {
                if (signal.aborted || !(error instanceof Error) ||
                    (error.name !== 'AbortError' && !('code' in error && error.code === 'ERR_CANCELED'))) throw error;
            }
        }
        if (disposed) return;
        retry = setInterval(advance, 1000);
        status('');
    } catch (error) { dispose(); throw error; }
}
