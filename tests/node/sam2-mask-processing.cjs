// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../cvat-ui/src/utils/sam2-mask-processing.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const api = { exports: {} };
new Function('exports', 'module', compiled.outputText)(api.exports, api);
const { decodeLogits, thresholdMask, decodeMask, smoothMask } = api.exports;
const encode = (values) => {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    return bytes.toString('base64');
};

test('float32 scores roundtrip, reject invalid dimensions and non-finite values', () => {
    assert.deepEqual([...decodeLogits(encode([-2, 0, 0.25, 3]), 2, 2)], [-2, 0, 0.25, 3]);
    assert.throws(() => decodeLogits(encode([1]), 2, 2));
    assert.throws(() => decodeLogits(encode([NaN]), 1, 1));
});

test('default threshold is strictly positive and preserves disconnected pixels and holes', () => {
    const scores = new Float32Array([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const mask = decodeMask(thresholdMask(scores, 0, 3, 3));
    assert.deepEqual([...mask.pixels], [1, 1, 1, 1, 0, 1, 1, 1, 1]);
    assert.equal(thresholdMask(scores, 1, 3, 3), null);
    assert.deepEqual([...decodeMask(thresholdMask(scores, -0.1, 3, 3)).pixels], Array(9).fill(1));
});

test('threshold crops accurately and radius zero preserves the prediction', () => {
    const scores = new Float32Array([-1, -1, -1, -1, 2, -1, -1, -1, -1]);
    const points = thresholdMask(scores, 0, 3, 3);
    assert.deepEqual(points, [0, 1, 1, 1, 1, 1]);
    assert.deepEqual(smoothMask(points, 0, 3, 3), points);
    assert.equal(smoothMask(points, 1, 3, 3), null);
    assert.deepEqual([...scores], [-1, -1, -1, -1, 2, -1, -1, -1, -1]);
});

test('smoothing removes an isolated speck while retaining the large object', () => {
    const scores = new Float32Array(81).fill(-1);
    for (let y = 2; y <= 6; y++) for (let x = 2; x <= 6; x++) scores[y * 9 + x] = 1;
    scores[0] = 1;
    const points = thresholdMask(scores, 0, 9, 9);
    const mask = decodeMask(smoothMask(points, 1, 9, 9));
    assert.equal(mask.x, 2);
    assert.equal(mask.y, 2);
    assert.equal(mask.pixels.reduce((a, b) => a + b, 0), 21);
});

test('corner-cutting smoothing rounds corners without logits and retains separated objects and holes', () => {
    const width = 40, height = 30;
    const pixels = new Float32Array(width * height);
    for (let y = 2; y < 26; y++) for (let x = 2; x < 26; x++) {
        pixels[y * width + x] = (x >= 9 && x < 19 && y >= 9 && y < 19) ? 0 : 1;
    }
    for (let y = 3; y < 10; y++) for (let x = 31; x < 38; x++) pixels[y * width + x] = 1;
    const original = thresholdMask(pixels, 0, width, height);
    assert.deepEqual(api.exports.curveSmoothMask(original, 0, width, height), original);
    const result = api.exports.curveSmoothMask(original, 2, width, height, 2);
    assert.notDeepEqual(result, original);
    const mask = decodeMask(result);
    const at = (x, y) => mask.pixels[(y - mask.y) * mask.width + x - mask.x];
    assert.equal(at(5, 5), 1);
    assert.equal(at(14, 14), 0);
    assert.equal(at(34, 6), 1);
    assert.equal(at(28, 6), 0);
    assert.ok(mask.x >= 0 && mask.y >= 0 && mask.x + mask.width <= width && mask.y + mask.height <= height);
});

test('corner-cutting smoothing handles single pixels, diagonal contacts and image-edge contours', () => {
    for (const pixels of [[1], [1, 0, 0, 1], [1, 1, 1, 1]]) {
        const size = Math.sqrt(pixels.length);
        const original = thresholdMask(new Float32Array(pixels), 0, size, size);
        const result = api.exports.curveSmoothMask(original, 1, size, size, 5);
        assert.ok(result);
        assert.deepEqual([...decodeMask(result).pixels], pixels);
    }
});

test('contour sampling and smoothing passes independently control the boundary', () => {
    const width = 1080, height = 1080;
    const pixels = new Float32Array(width * height);
    for (let y = 100; y < 980; y++) for (let x = 100; x < 980; x++) pixels[y * width + x] = 1;
    const original = thresholdMask(pixels, 0, width, height);
    const curve = (sampling, passes) => api.exports.curveSmoothMask(original, sampling, width, height, passes);
    assert.deepEqual(curve(0, 0), original);
    const sampled = curve(5, 0);
    const smooth = curve(5, 2);
    assert.notDeepEqual(smooth, sampled, 'passes must change the contour with sampling held fixed');
    assert.notDeepEqual(curve(5, 5), smooth, 'additional passes must affect the result');
    assert.notDeepEqual(curve(1, 2), smooth, 'sampling must affect the result with passes held fixed');
    assert.notDeepEqual(curve(1.25, 2), curve(1, 2), 'fractional strength is not rounded to an integer');
    assert.ok(curve(0, 5), 'smoothing accepts the full contour without reducing sample points');
});
