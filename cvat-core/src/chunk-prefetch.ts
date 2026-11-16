// SPDX-License-Identifier: MIT

// Compressed bytes are inexpensive compared with decoded RGBA frames. Keep the
// network busy independently of the single decoder, with one transfer at a time.
interface ChunkEntry {
    promise: Promise<ArrayBuffer>;
    resolve(value: ArrayBuffer): void;
    reject(reason: unknown): void;
    data?: ArrayBuffer;
    required: boolean;
}

export default class ChunkPrefetch {
    private entries = new Map<number, ChunkEntry>();
    private queue: number[] = [];
    private active: number | null = null;
    private disposed = false;
    private bytes = 0;
    private focus = 0;
    private largestChunk = 0;

    constructor(private download: (index: number) => Promise<ArrayBuffer>, private budget = 64 * 1024 * 1024) {}

    get(index: number): Promise<ArrayBuffer> {
        if (this.disposed) return Promise.reject(new Error('Frame cache closed'));
        const entry = this.ensure(index, true);
        const position = this.queue.indexOf(index);
        if (position > 0) { this.queue.splice(position, 1); this.queue.unshift(index); }
        this.pump();
        return entry.promise;
    }

    ahead(index: number, count: number, chunkCount: number): void {
        if (this.disposed) return;
        this.focus = index;
        // Release compressed data behind playback so the forward buffer can refill.
        // Decoded frames have their own cache for stepping backwards.
        for (const [stored, entry] of this.entries) {
            if (entry.data && stored < index) {
                this.bytes -= entry.data.byteLength;
                this.entries.delete(stored);
            }
        }
        // Drop obsolete speculative work after seeking; never discard a waiting consumer.
        for (const queued of [...this.queue]) {
            const entry = this.entries.get(queued)!;
            if (!entry.required && (queued < index || queued > index + count)) {
                this.queue.splice(this.queue.indexOf(queued), 1);
                this.entries.delete(queued);
                entry.reject(new Error('Prefetch superseded'));
            }
        }
        for (let next = index; next < Math.min(chunkCount, index + count + 1); next++) this.ensure(next, false);
        this.trim();
        this.pump();
    }

    downloaded(): number[] {
        return [...this.entries].filter(([, entry]) => entry.data).map(([index]) => index).sort((a, b) => a - b);
    }

    invalidate(): void {
        if (this.disposed) return;
        this.clear();
        this.disposed = false;
    }

    clear(): void {
        this.disposed = true;
        this.entries.forEach((entry) => { if (!entry.data) entry.reject(new Error('Frame cache closed')); });
        this.entries.clear();
        this.queue = [];
        this.bytes = 0;
    }

    private ensure(index: number, required: boolean): ChunkEntry {
        const existing = this.entries.get(index);
        if (existing) { existing.required ||= required; return existing; }
        let resolve!: (data: ArrayBuffer) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; });
        // Speculative failures must not become unhandled rejections; foreground get still rejects.
        promise.catch(() => {});
        const entry = {
            promise, resolve, reject, required,
        };
        this.entries.set(index, entry);
        this.queue.push(index);
        return entry;
    }

    private trim(): void {
        const stored = [...this.entries.entries()].filter(([, entry]) => entry.data);
        stored.sort(([a], [b]) => Math.abs(b - this.focus) - Math.abs(a - this.focus));
        for (const [index, entry] of stored) {
            if (this.bytes <= this.budget) break;
            this.entries.delete(index);
            this.bytes -= entry.data!.byteLength;
        }
    }

    private pump(): void {
        if (this.disposed || this.active !== null || !this.queue.length) return;
        // Foreground seeks must never wait for buffer space. Speculation stops at
        // the byte budget and resumes as playback releases older compressed data.
        if (this.bytes > 0 && this.bytes + this.largestChunk > this.budget) {
            const required = this.queue.findIndex((index) => this.entries.get(index)!.required);
            if (required < 0) return;
            const [index] = this.queue.splice(required, 1);
            this.queue.unshift(index);
        }
        const index = this.queue.shift()!;
        const entry = this.entries.get(index)!;
        this.active = index;
        this.download(index).then((data) => {
            if (!this.disposed && this.entries.get(index) === entry) {
                this.largestChunk = Math.max(this.largestChunk, data.byteLength);
                entry.data = data;
                this.bytes += data.byteLength;
                entry.resolve(data);
                this.trim();
            }
        }, (error) => {
            if (this.entries.get(index) === entry) this.entries.delete(index);
            entry.reject(error);
        }).finally(() => { this.active = null; this.pump(); });
    }
}
