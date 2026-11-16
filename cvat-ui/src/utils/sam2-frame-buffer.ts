// SPDX-License-Identifier: MIT
// Share in-flight requests and retain a bounded history for backward/forward seeking.
export class SAM2FrameBuffer<T> {
    private entries = new Map<number, {
        promise: Promise<T>; controller: AbortController; value?: T; ready: boolean; bytes: number;
    }>();

    private first = Infinity;
    private last = -Infinity;

    constructor(
        private readonly fetchFrame: (frame: number, signal: AbortSignal) => Promise<T>,
        private readonly release: (value: T) => void,
        private readonly sizeOf: (value: T) => number = () => 1,
        private readonly maxBytes = 128 * 1024 * 1024,
        private readonly maxEntries = 64,
    ) {}

    has(frame: number): boolean {
        return this.entries.get(frame)?.ready ?? false;
    }

    get(frame: number): Promise<T> {
        const cached = this.entries.get(frame);
        if (cached) {
            this.entries.delete(frame);
            this.entries.set(frame, cached);
            return cached.promise;
        }
        const controller = new AbortController();
        const entry: {
            controller: AbortController; promise: Promise<T>; value?: T; ready: boolean; bytes: number;
        } = {
            controller, promise: Promise.resolve(null as unknown as T), ready: false, bytes: 0,
        };
        entry.promise = this.fetchFrame(frame, controller.signal).then((value) => {
            if (controller.signal.aborted) {
                this.release(value);
                throw new Error('Frame request superseded');
            }
            entry.value = value;
            entry.ready = true;
            entry.bytes = this.sizeOf(value);
            this.prune(frame);
            return value;
        }).catch((error) => {
            if (this.entries.get(frame) === entry) this.entries.delete(frame);
            throw error;
        });
        this.entries.set(frame, entry);
        return entry.promise;
    }

    private prune(requested?: number): void {
        let bytes = 0;
        this.entries.forEach((entry) => { bytes += entry.bytes; });
        for (const [frame, entry] of this.entries) {
            if (bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
            if (entry.ready && frame !== requested && (frame < this.first || frame > this.last)) {
                this.entries.delete(frame);
                bytes -= entry.bytes;
                this.release(entry.value!);
            }
        }
    }

    retain(first: number, last: number): void {
        this.first = first;
        this.last = last;
        this.entries.forEach((entry, frame) => {
            if (!entry.ready && (frame < first || frame > last)) {
                this.entries.delete(frame);
                entry.controller.abort();
            }
        });
        this.prune();
    }

    dispose(): void {
        this.entries.forEach((entry) => {
            entry.controller.abort();
            if (entry.ready) this.release(entry.value!);
        });
        this.entries.clear();
    }
}
