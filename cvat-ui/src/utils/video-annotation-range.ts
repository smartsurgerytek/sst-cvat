// SPDX-License-Identifier: MIT

export function constrainVideoRange(
    next: number[], previous: [number, number], min: number, max: number, maxFrames: number, minGap = 0,
): [number, number] {
    let start = Math.min(max, Math.max(min, Math.round(next[0])));
    let stop = Math.min(max, Math.max(min, Math.round(next[1])));
    const gap = Math.min(minGap, max - min);
    if (start !== previous[0]) {
        start = Math.min(start, max - gap);
        stop = Math.max(start + gap, Math.min(stop, start + maxFrames - 1));
    } else {
        stop = Math.max(min + gap, stop);
        start = Math.min(stop - gap, Math.max(start, stop - maxFrames + 1));
    }
    return [start, stop];
}
