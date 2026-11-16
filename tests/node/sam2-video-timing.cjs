// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../cvat-ui/src/utils/sam2-video-timing.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const api = { exports: {} };
new Function('exports', 'module', compiled.outputText)(api.exports, api);
const { videoFrameAtTime } = api.exports;

test('matches VFR timestamps rather than assuming a fixed frame rate', () => {
    const timestamps = [0, 0.033, 0.070, 0.15, 0.21];
    assert.equal(videoFrameAtTime(timestamps, 0.06), 1);
    assert.equal(videoFrameAtTime(timestamps, 0.149), 2);
    assert.equal(videoFrameAtTime(timestamps, 0.15), 3);
    assert.equal(videoFrameAtTime(timestamps, 0.209), 3);
    assert.equal(videoFrameAtTime(timestamps, 1), 4);
});

test('tolerates presentation timestamp rounding at sample boundaries', () => {
    assert.equal(videoFrameAtTime([0, 1 / 30, 2 / 30], 0.033333), 1);
    assert.equal(videoFrameAtTime([0, 1 / 30, 2 / 30], -1), 0);
});
