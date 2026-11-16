// SPDX-License-Identifier: MIT
// CVAT mask RLE uses row-major counts followed by an inclusive bounding box.
export function decodeMask(points: number[]): {
    pixels: Uint8Array; width: number; height: number; x: number; y: number;
} {
    const [x, y, right, bottom] = points.slice(-4);
    const width = right - x + 1;
    const height = bottom - y + 1;
    const pixels = new Uint8Array(width * height);
    let offset = 0;
    points.slice(0, -4).forEach((count, index) => {
        if (index % 2) pixels.fill(1, offset, offset + count);
        offset += count;
    });
    return {
        pixels, width, height, x, y,
    };
}

export function smoothMask(points: number[], radius: number, imageWidth: number, imageHeight: number): number[] | null {
    if (!radius) return points;
    const source = decodeMask(points);
    const x = Math.max(0, source.x - radius);
    const y = Math.max(0, source.y - radius);
    const width = Math.min(imageWidth, source.x + source.width + radius) - x;
    const height = Math.min(imageHeight, source.y + source.height + radius) - y;
    const pixels = new Uint8Array(width * height);
    for (let row = 0; row < source.height; row++) {
        pixels.set(source.pixels.subarray(row * source.width, (row + 1) * source.width),
            (source.y - y + row) * width + source.x - x);
    }
    const sums = new Uint16Array(width * height);
    for (let row = 0; row < height; row++) {
        let sum = 0;
        for (let col = 0; col <= radius && col < width; col++) sum += pixels[row * width + col];
        for (let col = 0; col < width; col++) {
            sums[row * width + col] = sum;
            if (col - radius >= 0) sum -= pixels[row * width + col - radius];
            if (col + radius + 1 < width) sum += pixels[row * width + col + radius + 1];
        }
    }
    const threshold = ((radius * 2 + 1) ** 2) / 2;
    let left = width; let right = -1; let top = height; let bottom = -1;
    for (let col = 0; col < width; col++) {
        let sum = 0;
        for (let row = 0; row <= radius && row < height; row++) sum += sums[row * width + col];
        for (let row = 0; row < height; row++) {
            const value = Number(sum >= threshold);
            pixels[row * width + col] = value;
            if (value) {
                left = Math.min(left, col); right = Math.max(right, col);
                top = Math.min(top, row); bottom = Math.max(bottom, row);
            }
            if (row - radius >= 0) sum -= sums[(row - radius) * width + col];
            if (row + radius + 1 < height) sum += sums[(row + radius + 1) * width + col];
        }
    }
    if (right < left) return null;
    const counts = [0];
    let last = 0;
    for (let row = top; row <= bottom; row++) {
        for (let col = left; col <= right; col++) {
            const value = pixels[row * width + col];
            if (value !== last) { counts.push(0); last = value; }
            counts[counts.length - 1]++;
        }
    }
    return [...counts, x + left, y + top, x + right, y + bottom];
}

// Inference scores are full-resolution, little-endian float32 logits (not probabilities).
export function decodeLogits(encoded: string, width: number, height: number): Float32Array {
    const binary = atob(encoded);
    if (binary.length !== width * height * 4) throw new Error('Invalid SAM2 score dimensions');
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const values = new Float32Array(width * height);
    for (let i = 0; i < values.length; i++) {
        values[i] = view.getFloat32(i * 4, true);
        if (!Number.isFinite(values[i])) throw new Error('Invalid SAM2 score');
    }
    return values;
}

export function thresholdMask(scores: Float32Array, threshold: number, width: number, height: number): number[] | null {
    let left = width; let right = -1; let top = height; let bottom = -1;
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            if (scores[row * width + col] > threshold) {
                left = Math.min(left, col); right = Math.max(right, col);
                top = Math.min(top, row); bottom = Math.max(bottom, row);
            }
        }
    }
    if (right < left) return null;
    const counts = [0];
    let last = 0;
    for (let row = top; row <= bottom; row++) {
        for (let col = left; col <= right; col++) {
            const value = Number(scores[row * width + col] > threshold);
            if (value !== last) { counts.push(0); last = value; }
            counts[counts.length - 1]++;
        }
    }
    return [...counts, left, top, right, bottom];
}

type Point = [number, number];

// Trace every boundary (including holes), fit closed corner-cutting curves, then
// rasterize with the even/odd rule so independent islands and holes stay separate.
export function curveSmoothMask(
    points: number[], strength: number, imageWidth: number, imageHeight: number,
    iterations = 0,
): number[] | null {
    if (!strength && !iterations) return points;
    const source = decodeMask(points);
    // Match the smoothing scale across full-resolution masks and 180px score previews.
    // At 1080p, levels 1–5 sample the boundary every 12–60 pixels instead of 2–10.
    const sampleSpacing = Math.max(1, strength * 2 * Math.max(1, imageHeight / 180));
    const edges = new Map<number, number[]>();
    const stride = source.width + 1;
    const vertex = (x: number, y: number): number => y * stride + x;
    const add = (a: number, b: number): void => { edges.set(a, [...(edges.get(a) || []), b]); };
    const filled = (x: number, y: number): boolean => x >= 0 && y >= 0 &&
        x < source.width && y < source.height && Boolean(source.pixels[y * source.width + x]);
    for (let y = 0; y < source.height; y++) {
        for (let x = 0; x < source.width; x++) {
            if (!filled(x, y)) continue;
            if (!filled(x, y - 1)) add(vertex(x, y), vertex(x + 1, y));
            if (!filled(x + 1, y)) add(vertex(x + 1, y), vertex(x + 1, y + 1));
            if (!filled(x, y + 1)) add(vertex(x + 1, y + 1), vertex(x, y + 1));
            if (!filled(x - 1, y)) add(vertex(x, y + 1), vertex(x, y));
        }
    }
    const intersections: number[][] = Array.from({ length: source.height }, () => []);
    while (edges.size) {
        const first = edges.keys().next().value as number;
        let current = first;
        let previousDirection = 0;
        let contour: Point[] = [];
        do {
            contour.push([current % stride, Math.floor(current / stride)]);
            const next = edges.get(current)!;
            const position = current;
            const direction = (target: number): number => {
                const dx = (target % stride) - (position % stride);
                const dy = Math.floor(target / stride) - Math.floor(position / stride);
                if (dy > 0) return 1;
                if (dy < 0) return 3;
                return dx > 0 ? 0 : 2;
            };
            const incoming = previousDirection;
            const order = [1, 0, 3, 2];
            next.sort((a, b) => order.indexOf((direction(a) - incoming + 4) % 4) -
                order.indexOf((direction(b) - incoming + 4) % 4));
            const target = next.shift()!;
            previousDirection = direction(target);
            if (!next.length) edges.delete(current);
            current = target;
        } while (current !== first);
        // Keep tiny contours intact; otherwise sample uniformly around the loop.
        const tinyContour = contour.length <= 4;
        const count = Math.max(4, Math.ceil(contour.length / sampleSpacing));
        if (count < contour.length) {
            const original = contour;
            contour = Array.from({ length: count }, (_, index) => (
                original[Math.floor((index * original.length) / count)]
            ));
        }
        for (let pass = 0; pass < (tinyContour ? 0 : iterations); pass++) {
            const next: Point[] = [];
            const previous = contour;
            previous.forEach((a, index) => {
                const b = previous[(index + 1) % previous.length];
                next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
                    [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
            });
            contour = next;
        }
        contour.forEach((a, index) => {
            const b = contour[(index + 1) % contour.length];
            const low = Math.min(a[1], b[1]); const high = Math.max(a[1], b[1]);
            for (let row = Math.max(0, Math.ceil(low - 0.5)); row + 0.5 < high; row++) {
                intersections[row].push(a[0] + ((row + 0.5 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
            }
        });
    }
    const scores = new Float32Array(imageWidth * imageHeight);
    intersections.forEach((xs, row) => {
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            for (let col = Math.max(0, Math.ceil(xs[i] - 0.5)); col + 0.5 < xs[i + 1]; col++) {
                scores[(source.y + row) * imageWidth + source.x + col] = 1;
            }
        }
    });
    return thresholdMask(scores, 0, imageWidth, imageHeight);
}
