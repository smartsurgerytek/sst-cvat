// SPDX-License-Identifier: MIT
import { VideoSegmentStream, cachedVideoRanges, SEGMENT_SECONDS } from './video-segments';

export interface OriginalVideoSource {
    id: string;
    project_id: number;
    filename: string;
    duration: number;
    timestamps: number[];
    url: string;
}

export class OriginalVideoFrameSupersededError extends Error {
    constructor() { super('Frame request superseded'); }
}

interface DecodedFrame { renderWidth: number; renderHeight: number; imageData: ImageBitmap }
interface CachedFrame { promise: Promise<DecodedFrame>; value?: DecodedFrame; readers: number }
// Per-job decoded-frame LRU. Network/decoder buffers are managed separately by the browser.
const FRAME_CACHE_BYTES = 256 * 1024 * 1024;
const bufferedFrames = new Map<number, Map<number, CachedFrame>>();

const sources = new Map<number, OriginalVideoSource>();
const players = new Map<number, {
    video: HTMLVideoElement; ready: Promise<void>; index: number; offset: number; url: string; cancel(): void;
}>();

const streams = new Map<number, VideoSegmentStream>();
const queues = new Map<number, Promise<unknown>>();

export function originalVideoSource(jobID: number): OriginalVideoSource | undefined {
    return sources.get(jobID);
}

// Downloaded media and decoded images are independent caches. Report their union in seconds.
export function originalVideoCachedRanges(jobID: number): [number, number][] {
    const source = sources.get(jobID);
    if (!source) return [];
    const ranges: [number, number][] = cachedVideoRanges(source);
    bufferedFrames.get(jobID)?.forEach((entry, frame) => {
        if (entry.value) ranges.push([source.timestamps[frame], source.timestamps[frame + 1] ?? source.duration]);
    });
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range[0] <= previous[1] + 0.000001) previous[1] = Math.max(previous[1], range[1]);
        else merged.push([...range]);
    }
    return merged;
}

// A user seek takes priority over all work for the previous position. Keep decoded
// images, but detach an unbuffered/busy decoder to abort its HTTP range request now.
export function prioritizeOriginalVideoFrame(jobID: number, frame: number): void {
    const source = sources.get(jobID);
    if (!source) return;
    const player = players.get(jobID);
    queues.delete(jobID);
    if (!streams.has(jobID)) streams.set(jobID, new VideoSegmentStream(source));
    streams.get(jobID)!.focus(source.timestamps[frame], true).catch(() => {});
    const frames = bufferedFrames.get(jobID);
    frames?.forEach((entry, number) => {
        if (!entry.value) {
            frames.delete(number);
            if (!entry.readers) entry.promise.then((value) => value.imageData.close()).catch(() => {});
        }
    });
    if (player && (player.index !== Math.floor(source.timestamps[frame] / SEGMENT_SECONDS) || player.video.seeking)) {
        players.delete(jobID);
        player.cancel();
        player.video.pause();
        player.video.removeAttribute('src');
        player.video.load();
        URL.revokeObjectURL(player.url);
    }
}

export function clearOriginalVideo(jobID: number): void {
    streams.get(jobID)?.dispose();
    streams.delete(jobID);
    queues.delete(jobID);
    const frames = bufferedFrames.get(jobID);
    bufferedFrames.delete(jobID);
    frames?.forEach((entry) => {
        if (!entry.readers) entry.promise.then((value) => value.imageData.close()).catch(() => {});
    });
    frames?.clear();
    const player = players.get(jobID);
    if (player) {
        players.delete(jobID);
        player.cancel();
        player.video.pause();
        player.video.removeAttribute('src');
        player.video.load();
        URL.revokeObjectURL(player.url);
    }
}

export function registerOriginalVideo(jobID: number, source: OriginalVideoSource): void {
    if (source) {
        const previous = sources.get(jobID);
        if (previous && (previous.id !== source.id || previous.url !== source.url)) clearOriginalVideo(jobID);
        sources.set(jobID, source);
    }
}

function createVideoDecoder(url: string): {
    video: HTMLVideoElement; ready: Promise<void>; cancel(): void;
} {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    let cancel = (): void => {};
    const ready = new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const cleanup = (): void => {
            clearTimeout(timeout);
            video.onloadedmetadata = null;
            video.onerror = null;
        };
        cancel = () => { cleanup(); reject(new OriginalVideoFrameSupersededError()); };
        timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Original MP4 loading timed out'));
        }, 30000);
        video.onloadedmetadata = () => { cleanup(); resolve(); };
        video.onerror = () => { cleanup(); reject(new Error('Could not decode original MP4')); };
    });
    video.src = url;
    return { video, ready, cancel };
}

function seekVideoFrame(video: HTMLVideoElement, target: number, needed: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        let poll: ReturnType<typeof setInterval>;
        let check: () => void;
        const cleanup = (): void => {
            clearTimeout(timeout);
            clearInterval(poll);
            video.removeEventListener('seeked', check);
            video.removeEventListener('loadeddata', check);
            video.removeEventListener('error', check);
        };
        check = (): void => {
            if (!needed()) {
                cleanup();
                reject(new OriginalVideoFrameSupersededError());
            } else if (video.error) {
                cleanup();
                reject(new Error(`Could not seek original MP4: ${video.error.message}`));
            } else if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.002) {
                // currentTime changes before decoding completes. Never copy a stale image.
                cleanup();
                resolve();
            }
        };
        video.addEventListener('seeked', check);
        video.addEventListener('loadeddata', check);
        video.addEventListener('error', check);
        // Also detect a completed seek if the browser does not deliver seeked, and
        // release obsolete lookahead work without blocking the next requested frame.
        poll = setInterval(check, 100);
        timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Original MP4 seeking timed out'));
        }, 30000);
        try {
            if (video.seeking || Math.abs(video.currentTime - target) > 0.00001) video.currentTime = target;
            check();
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

async function decodeOriginalVideoFrame(
    jobID: number, frame: number, needed: () => boolean,
): Promise<DecodedFrame> {
    const source = sources.get(jobID)!;
    if (!streams.has(jobID)) streams.set(jobID, new VideoSegmentStream(source));
    const stream = streams.get(jobID)!;
    const current = (): boolean => needed() && streams.get(jobID) === stream;
    const result = (queues.get(jobID) || Promise.resolve()).catch(() => {}).then(async () => {
        if (!current()) throw new OriginalVideoFrameSupersededError();
        let segment;
        try { segment = await stream.focus(source.timestamps[frame]); } catch (error) {
            if (!current()) throw new OriginalVideoFrameSupersededError();
            throw error;
        }
        const index = Math.floor(source.timestamps[frame] / SEGMENT_SECONDS);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!current()) throw new OriginalVideoFrameSupersededError();
            let player = players.get(jobID);
            if (!player || player.index !== index || attempt > 0) {
                if (player) {
                    player.cancel(); player.video.pause(); player.video.removeAttribute('src'); player.video.load();
                    URL.revokeObjectURL(player.url);
                }
                const url = URL.createObjectURL(segment.blob);
                player = {
                    ...createVideoDecoder(url), url, index, offset: segment.start,
                };
                players.set(jobID, player);
            }
            const active = (): boolean => current() && players.get(jobID) === player;
            try {
                await player.ready;
                if (!active()) throw new OriginalVideoFrameSupersededError();
                const duration = Number.isFinite(player.video.duration) ? player.video.duration : source.duration;
                const target = Math.max(0, Math.min(duration - 0.0001,
                    source.timestamps[frame] - player.offset + 0.0001));
                await seekVideoFrame(player.video, target, active);
                if (!active()) throw new OriginalVideoFrameSupersededError();
                return {
                    renderWidth: player.video.videoWidth,
                    renderHeight: player.video.videoHeight,
                    imageData: await createImageBitmap(player.video),
                };
            } catch (error) {
                if (!active() || attempt === 1) throw error;
            }
        }
        throw new Error('Could not decode original MP4');
    });
    queues.set(jobID, result);
    return result;
}

export async function originalVideoFrame(jobID: number, frame: number, playing = false): Promise<DecodedFrame> {
    if (!bufferedFrames.has(jobID)) bufferedFrames.set(jobID, new Map());
    const frames = bufferedFrames.get(jobID)!;
    // Only cancel speculative work. The canvas and SAM2 may still be reading
    // different frames from this same decoder, especially during initial loading.
    frames.forEach((entry, number) => {
        if (!entry.readers && !entry.value && (number < frame || number > frame + (playing ? 1 : 0))) {
            frames.delete(number);
            entry.promise.then((value) => value.imageData.close()).catch(() => {});
        }
    });
    const request = (number: number, reading = false): CachedFrame => {
        let entry = frames.get(number);
        if (!entry) {
            const created: CachedFrame = {
                promise: Promise.resolve(null as unknown as DecodedFrame), readers: 0,
            };
            created.promise = decodeOriginalVideoFrame(
                jobID, number, () => frames.get(number) === created,
            ).then((value) => {
                created.value = value;
                let bytes = 0;
                frames.forEach((cached) => {
                    if (cached.value) bytes += cached.value.renderWidth * cached.value.renderHeight * 4;
                });
                // Keep the requested frame even if it alone exceeds the budget.
                for (const [key, cached] of frames) {
                    if (bytes <= FRAME_CACHE_BYTES) break;
                    if (key !== number && key !== frame && !cached.readers && cached.value) {
                        frames.delete(key);
                        bytes -= cached.value.renderWidth * cached.value.renderHeight * 4;
                        cached.value.imageData.close();
                    }
                }
                return value;
            }).catch((error) => {
                if (frames.get(number) === created) frames.delete(number);
                throw error;
            });
            entry = created;
        }
        // Map order is least-recently-used first, including cache hits.
        frames.delete(number);
        frames.set(number, entry);
        if (reading) entry.readers += 1;
        return entry;
    };
    const entry = request(frame, true);
    // Video segments are prefetched separately. Speculative single-frame seeks
    // delay the next wall-clock-selected frame and are usually discarded during playback.
    try {
        const result = await entry.promise;
        // Pin the cached bitmap until the asynchronous copy completes.
        return { ...result, imageData: await createImageBitmap(result.imageData) };
    } finally {
        entry.readers -= 1;
        if (!entry.readers && frames.get(frame) !== entry) entry.value?.imageData.close();
    }
}
