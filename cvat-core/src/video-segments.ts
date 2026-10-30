// SPDX-License-Identifier: MIT
import Axios from 'axios';
import type { OriginalVideoSource } from './original-video';

export const SEGMENT_SECONDS = 5;
const CACHE_LIMIT = 256 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
export interface VideoSegment { key: string; blob: Blob; start: number; end: number; codec: string; accessed: number }

const memory = new Map<string, VideoSegment>();
const ranges = new Map<string, [number, number]>();

interface SegmentMetadata { key: string; size: number; start: number; end: number; accessed: number }
const metadata = (segment: VideoSegment): SegmentMetadata => ({
    key: segment.key, size: segment.blob.size, start: segment.start, end: segment.end, accessed: segment.accessed,
});

function database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('cvat-sam2-playback-v1', 2);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('segments')) db.createObjectStore('segments', { keyPath: 'key' });
            const info = db.createObjectStore('metadata', { keyPath: 'key' });
            const cursor = request.transaction!.objectStore('segments').openCursor();
            cursor.onsuccess = () => {
                if (cursor.result) { info.put(metadata(cursor.result.value)); cursor.result.continue(); }
            };
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function cached(key: string): Promise<VideoSegment | undefined> {
    const db = await database();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction(['segments', 'metadata'], 'readwrite');
            const store = transaction.objectStore('segments');
            const info = transaction.objectStore('metadata');
            let segment: VideoSegment | undefined;
            const request = info.get(key);
            request.onsuccess = () => {
                const entry: SegmentMetadata | undefined = request.result;
                if (entry && Date.now() - entry.accessed <= MAX_AGE) {
                    const read = store.get(key);
                    read.onsuccess = () => { segment = read.result; };
                    info.put({ ...entry, accessed: Date.now() });
                } else { store.delete(key); info.delete(key); }
            };
            transaction.oncomplete = () => resolve(segment);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } finally { db.close(); }
}

async function remember(segment: VideoSegment): Promise<void> {
    const db = await database();
    try {
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(['segments', 'metadata'], 'readwrite');
            const store = transaction.objectStore('segments');
            const info = transaction.objectStore('metadata');
            store.put(segment); info.put(metadata(segment));
            // Eviction and inventory never deserialize every cached video blob.
            const request = info.getAll();
            request.onsuccess = () => {
                const entries: SegmentMetadata[] = request.result;
                entries.sort((a, b) => b.accessed - a.accessed);
                let size = 0;
                entries.forEach((entry) => {
                    size += entry.size;
                    if (size > CACHE_LIMIT || Date.now() - entry.accessed > MAX_AGE) {
                        store.delete(entry.key); info.delete(entry.key);
                        if (!memory.has(entry.key)) ranges.delete(entry.key);
                    }
                });
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    } finally { db.close(); }
}

function keep(segment: VideoSegment): void {
    memory.delete(segment.key);
    memory.set(segment.key, segment);
    ranges.set(segment.key, [segment.start, segment.end]);
    let bytes = 0;
    [...memory.values()].reverse().forEach((entry) => {
        bytes += entry.blob.size;
        if (bytes > CACHE_LIMIT) memory.delete(entry.key);
    });
}

interface Download {
    controller: AbortController; promise: Promise<VideoSegment>; users: Set<symbol>;
}
const downloads = new Map<string, Download>();

function sharedDownload(
    source: OriginalVideoSource, profile: string, index: number, signal: AbortSignal,
): Promise<VideoSegment> {
    const key = `${source.id}:${profile}:${index}`;
    let job = downloads.get(key);
    if (!job) {
        const controller = new AbortController();
        const promise = Axios.get<Blob>(`${source.url}/segments/${index}`, {
            params: profile === 'original-v1' ? { profile: 'original' } : undefined,
            responseType: 'blob',
            signal: controller.signal,
            timeout: 120000,
        }).then((response) => {
            const segment: VideoSegment = {
                key,
                blob: response.data,
                start: Number(response.headers['x-video-start']),
                end: Number(response.headers['x-video-end']),
                codec: response.headers['x-video-codec'],
                accessed: Date.now(),
            };
            if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) {
                throw new Error('Invalid video segment metadata');
            }
            keep(segment);
            // Playback can use the bytes immediately; persistence runs independently.
            remember(segment).catch(() => {});
            return segment;
        });
        job = { controller, promise, users: new Set() };
        downloads.set(key, job);
        const created = job;
        promise.finally(() => { if (downloads.get(key) === created) downloads.delete(key); }).catch(() => {});
    }
    const shared = job;
    return new Promise((resolve, reject) => {
        const user = Symbol('video consumer');
        let abort: () => void;
        shared.users.add(user);
        const release = (): void => {
            signal.removeEventListener('abort', abort);
            shared.users.delete(user);
        };
        abort = (): void => {
            release();
            if (!shared.users.size) {
                shared.controller.abort();
                if (downloads.get(key) === shared) downloads.delete(key);
            }
            reject(new DOMException('Video download cancelled', 'AbortError'));
        };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        shared.promise.then((segment) => { release(); resolve(segment); }, (error) => { release(); reject(error); });
    });
}

export function cachedVideoRanges(source: OriginalVideoSource, profile = 'original-v1'): [number, number][] {
    const prefix = `${source.id}:${profile}:`;
    return [...ranges].filter(([key]) => key.startsWith(prefix)).map(([, range]) => range);
}

// One active download per viewer. Completed segments live independently of viewers.
export class VideoSegmentStream {
    private controller = new AbortController();
    private generation = 0;
    private index = -1;
    private ready!: Promise<VideoSegment>;
    private active: { index: number; promise: Promise<VideoSegment> } | null = null;

    constructor(
        private source: OriginalVideoSource,
        private profile = 'original-v1',
        private onSegment: (segment: VideoSegment, index: number) => void = () => {},
    ) {
        database().then((db) => {
            const transaction = db.transaction('metadata', 'readonly');
            const request = transaction.objectStore('metadata').openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const entry: SegmentMetadata = cursor.value;
                    if (entry.key.startsWith(`${source.id}:${profile}:`) && Date.now() - entry.accessed <= MAX_AGE) {
                        ranges.set(entry.key, [entry.start, entry.end]);
                    }
                    cursor.continue();
                }
            };
            transaction.oncomplete = () => db.close();
            transaction.onabort = () => db.close();
        }).catch(() => {});
    }

    private download(index: number): Promise<VideoSegment> {
        if (this.active?.index === index && !this.controller.signal.aborted) return this.active.promise;
        const { signal } = this.controller;
        const key = `${this.source.id}:${this.profile}:${index}`;
        const inMemory = memory.get(key);
        if (inMemory) {
            keep(inMemory);
            this.onSegment(inMemory, index);
            return Promise.resolve(inMemory);
        }
        const promise = (async (): Promise<VideoSegment> => {
            const stored = await cached(key).catch(() => undefined);
            const saved = memory.get(key) || stored;
            if (signal.aborted) throw new DOMException('Video download cancelled', 'AbortError');
            if (saved) { keep(saved); return saved; }
            return sharedDownload(this.source, this.profile, index, signal);
        })();
        promise.then((segment) => {
            if (!signal.aborted) this.onSegment(segment, index);
        }).catch(() => {});
        const active = { index, promise };
        this.active = active;
        promise.finally(() => { if (this.active === active) this.active = null; }).catch(() => {});
        return promise;
    }

    readAhead(time: number): Promise<VideoSegment> {
        return this.download(Math.floor(time / SEGMENT_SECONDS));
    }

    focus(time: number, prioritize = false): Promise<VideoSegment> {
        const index = Math.floor(time / SEGMENT_SECONDS);
        if (index === this.index && this.ready) return this.ready;
        this.index = index;
        const generation = ++this.generation;
        const useful = this.active && !prioritize && this.active.index >= index && this.active.index <= index + 4;
        if (this.active?.index !== index && !useful) {
            this.controller.abort();
            this.controller = new AbortController();
            this.active = null;
        }
        this.ready = this.download(index);
        this.ready.then(async () => {
            // Only look ahead from the current position. Cached islands require no network.
            for (let next = index + 1; next <= index + 4 && next * SEGMENT_SECONDS < this.source.duration; next++) {
                if (generation !== this.generation) return;
                await this.download(next);
            }
        }).catch(() => { if (generation === this.generation) this.index = -1; });
        this.ready.catch(() => { if (generation === this.generation) this.index = -1; });
        return this.ready;
    }

    dispose(): void {
        this.generation++;
        this.controller.abort();
        this.index = -1;
        this.active = null;
    }
}
