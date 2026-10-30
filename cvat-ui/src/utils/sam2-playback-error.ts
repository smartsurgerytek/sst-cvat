// SPDX-License-Identifier: MIT
import Axios from 'axios';

export async function playbackErrorMessage(reason: unknown): Promise<string> {
    if (!Axios.isAxiosError(reason)) return String(reason);
    const status = reason.response?.status;
    const url = reason.config?.url?.split('?')[0];
    let body: unknown = reason.response?.data;
    try {
        // Segment requests use responseType=blob, including JSON error responses.
        if (body instanceof Blob) body = await body.text();
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch { /* Plain-text server response. */ }
        }
        if (body && typeof body === 'object' && 'detail' in body) body = body.detail;
        if (Array.isArray(body)) body = body.join('; ');
        else if (body && typeof body === 'object') body = JSON.stringify(body);
    } catch { body = undefined; }
    const detail = typeof body === 'string' && body.trim() ? body.slice(0, 2000) : reason.message;
    return `${status ? `HTTP ${status}` : 'Request failed'}${url ? ` · ${url}` : ''}: ${detail}`;
}
