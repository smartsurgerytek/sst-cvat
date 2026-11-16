// SPDX-License-Identifier: MIT
// Select the sample being presented; works for variable frame rate timestamps.
export function videoFrameAtTime(timestamps: number[], time: number): number {
    let left = 0;
    let right = timestamps.length;
    while (left < right) {
        const middle = Math.floor((left + right) / 2);
        if (timestamps[middle] <= time + 0.000001) left = middle + 1;
        else right = middle;
    }
    return Math.max(0, left - 1);
}
