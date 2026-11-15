// SPDX-License-Identifier: MIT
import Axios from 'axios';

interface FileWriter {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
}
interface SavePicker {
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileWriter> }>;
}
export interface DownloadProgress { percent: number; loaded: number; browserManaged?: boolean }

export function downloadStatus(percent: number, browserManaged = false): string {
    if (browserManaged) return 'Download started — see browser downloads for progress';
    return percent === 100 ? 'Download complete' : 'Downloading…';
}

export default async function downloadWithProgress(
    endpoint: string, filename: string, onProgress: (progress: DownloadProgress) => void,
): Promise<boolean> {
    onProgress({ percent: 0, loaded: 0 });
    const picker = (window as unknown as SavePicker).showSaveFilePicker;
    let writer: FileWriter | undefined;
    try {
        if (picker && window.isSecureContext) {
            // Open the save dialog while the click still has browser user activation.
            const handle = await picker.call(window, { suggestedName: filename });
            const response = await Axios.get<ReadableStream<Uint8Array>>(endpoint, {
                adapter: 'fetch', responseType: 'stream', timeout: 0,
            });
            writer = await handle.createWritable();
            const total = Number(response.headers['content-length']) || 0;
            const reader = response.data.getReader();
            let loaded = 0;
            try {
                for (;;) {
                    const result = await reader.read();
                    if (result.done) break;
                    await writer.write(result.value);
                    loaded += result.value.byteLength;
                    onProgress({ percent: total ? Math.min(99, Math.floor((loaded * 100) / total)) : 0, loaded });
                }
            } finally { await reader.cancel(); }
            await writer.close();
            writer = undefined;
            onProgress({ percent: 100, loaded });
        } else {
            // Normal CVAT login creates a session cookie. Verify it without Axios's
            // token interceptor before handing the transfer to the browser.
            const endpointURL = new URL(endpoint, window.location.href);
            if (endpointURL.origin === window.location.origin) {
                const controller = new AbortController();
                const timeout = window.setTimeout(() => controller.abort(), 15000);
                let nativeDownload = false;
                try {
                    const response = await fetch(endpointURL.toString(), {
                        method: 'HEAD', credentials: 'same-origin', signal: controller.signal,
                    });
                    nativeDownload = response.ok &&
                        Boolean(response.headers.get('Content-Disposition')?.startsWith('attachment'));
                } catch {
                    // Token-only sessions retain the authenticated download below.
                } finally { window.clearTimeout(timeout); }
                if (nativeDownload) {
                    const anchor = document.createElement('a');
                    anchor.href = endpointURL.toString();
                    anchor.download = filename;
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                    onProgress({ percent: 100, loaded: 0, browserManaged: true });
                    return true;
                }
            }
            const { data } = await Axios.get<Blob>(endpoint, {
                responseType: 'blob',
                timeout: 0,
                onDownloadProgress: ({ loaded, total }) => onProgress({
                    percent: total ? Math.min(99, Math.floor((loaded * 100) / total)) : 0, loaded,
                }),
            });
            const url = URL.createObjectURL(data);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60000);
            onProgress({ percent: 100, loaded: data.size });
        }
        return true;
    } catch (reason) {
        await writer?.abort().catch(() => {});
        if (reason instanceof DOMException && reason.name === 'AbortError') return false;
        if (Axios.isAxiosError(reason) && reason.response?.data instanceof Blob) {
            throw new Error(await reason.response.data.text());
        }
        throw reason;
    }
}
