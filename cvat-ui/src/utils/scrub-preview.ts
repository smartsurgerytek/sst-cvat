// SPDX-License-Identifier: MIT
import Axios from 'axios';
import { getCore } from 'cvat-core-wrapper';

interface Manifest {
    state: 'ready' | 'preparing' | 'error';
    frames: number[];
    sheets: string[];
    cell: number;
    columns: number;
    per_sheet: number;
}

export class ScrubPreview {
    private blobs = new Map<number, Promise<Blob>>();
    private images = new Map<number, Promise<ImageBitmap>>();

    constructor(private manifest: Manifest, private signal: AbortSignal) {
        signal.addEventListener('abort', () => {
            this.images.forEach((image) => image.then((bitmap) => bitmap.close(), () => {}));
            this.images.clear();
            this.blobs.clear();
        }, { once: true });
    }

    private blob(index: number): Promise<Blob> {
        let promise = this.blobs.get(index);
        if (promise) this.blobs.delete(index);
        else {
            promise = Axios.get<Blob>(this.manifest.sheets[index], {
                responseType: 'blob', signal: this.signal,
            }).then(({ data }) => data);
            promise.catch(() => { this.blobs.delete(index); });
        }
        this.blobs.set(index, promise);
        while (this.blobs.size > 32) this.blobs.delete(this.blobs.keys().next().value as number);
        return promise;
    }

    async prepare(): Promise<void> {
        // A typical ten-minute video fits in a few MB of compressed contact sheets.
        // Bound preloading for long jobs; they fetch other sheets on demand.
        for (let index = 0; index < Math.min(24, this.manifest.sheets.length); index++) {
            if (this.signal.aborted) return;
            await this.blob(index);
        }
    }

    async draw(canvas: HTMLCanvasElement, frame: number, current: () => boolean): Promise<number | undefined> {
        const {
            frames, per_sheet: perSheet, cell, columns,
        } = this.manifest;
        let low = 0;
        let high = frames.length - 1;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (frames[middle] <= frame) low = middle;
            else high = middle - 1;
        }
        const sheet = Math.floor(low / perSheet);
        let image = this.images.get(sheet);
        if (image) this.images.delete(sheet);
        else image = this.blob(sheet).then((blob) => createImageBitmap(blob));
        this.images.set(sheet, image);
        while (this.images.size > 3) {
            const oldest = this.images.keys().next().value as number;
            this.images.get(oldest)!.then((bitmap) => bitmap.close(), () => {});
            this.images.delete(oldest);
        }
        const bitmap = await image;
        if (this.signal.aborted || !current()) return undefined;
        canvas.width = cell;
        canvas.height = cell;
        const position = low % perSheet;
        canvas.getContext('2d')!.drawImage(
            bitmap, (position % columns) * cell, Math.floor(position / columns) * cell, cell, cell, 0, 0, cell, cell,
        );
        canvas.dataset.frame = String(frames[low]);
        canvas.dataset.preview = 'fast';
        return frames[low];
    }
}

export async function prepareScrubPreview(jobID: number, signal: AbortSignal): Promise<ScrubPreview> {
    while (!signal.aborted) {
        const { data } = await Axios.get<Manifest>(
            `${getCore().config.backendAPI}/jobs/${jobID}/scrub-preview`, { signal },
        );
        if (data.state === 'error') throw new Error('Could not prepare video previews');
        if (data.state === 'ready') {
            const preview = new ScrubPreview(data, signal);
            await preview.prepare();
            return preview;
        }
        await new Promise<void>((resolve) => {
            let timer: number;
            const done = (): void => { signal.removeEventListener('abort', done); window.clearTimeout(timer); resolve(); };
            timer = window.setTimeout(done, 1000);
            signal.addEventListener('abort', done, { once: true });
        });
    }
    throw new Error('Preview closed');
}
