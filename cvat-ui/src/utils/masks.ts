// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export function isLikelyRle(points: number[]): boolean {
    if (!Array.isArray(points) || points.length < 5) return false;

    const [bboxLeft, bboxTop, bboxRight, bboxBottom] = points.slice(-4);
    if (![bboxLeft, bboxTop, bboxRight, bboxBottom].every(Number.isFinite)) return false;

    const width = bboxRight - bboxLeft + 1;
    const height = bboxBottom - bboxTop + 1;
    if (width <= 0 || height <= 0) return false;

    const rle = points.slice(0, -4);
    if (!rle.length || rle.some((value) => !Number.isFinite(value) || value < 0)) return false;

    const total = rle.reduce((acc, value) => acc + value, 0);
    return Math.abs(total - width * height) < 0.001;
}
