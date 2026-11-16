// SPDX-License-Identifier: MIT
export function originalVideoSource(): { timestamps: number[] } {
    return { timestamps: Array.from({ length: 501 }, (_, frame) => frame / 25) };
}
