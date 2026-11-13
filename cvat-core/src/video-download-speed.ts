// SPDX-License-Identifier: MIT
interface Transfer { loaded: number; }
interface Meter {
    transfers: Set<Transfer>; samples: { time: number; bytes: number }[]; total: number; started: number;
}
const meters = new Map<string, Meter>();

export function startVideoDownload(key: string): { progress(bytes: number): void; finish(): void } {
    let meter = meters.get(key);
    if (!meter || !meter.transfers.size) {
        meter = {
            transfers: new Set(), samples: [], total: 0, started: performance.now(),
        };
        meters.set(key, meter);
        // Retain only a small number of recent job meters.
        if (meters.size > 16) meters.delete(meters.keys().next().value as string);
    }
    const state = meter;
    const transfer = { loaded: 0 };
    state.transfers.add(transfer);
    return {
        progress(bytes): void {
            if (!state.transfers.has(transfer)) return;
            state.total += Math.max(0, bytes - transfer.loaded);
            transfer.loaded = Math.max(bytes, transfer.loaded);
            const now = performance.now();
            state.samples.push({ time: now, bytes: state.total });
            while (state.samples.length > 1 && state.samples[1].time < now - 2000) state.samples.shift();
        },
        finish(): void { state.transfers.delete(transfer); },
    };
}

export function videoDownloadSpeed(key: string): { active: boolean; mbps: number | null } {
    const meter = meters.get(key);
    if (!meter?.transfers.size) return { active: false, mbps: null };
    const now = performance.now();
    const baseline = [...meter.samples].reverse().find((sample) => sample.time <= now - 2000);
    const elapsed = now - (baseline?.time ?? meter.started);
    const bytes = meter.total - (baseline?.bytes ?? 0);
    return { active: true, mbps: elapsed >= 250 ? (bytes * 8) / (elapsed * 1000) : null };
}
