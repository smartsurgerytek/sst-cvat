// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../cvat-ui/src/utils/sam2-frame-buffer.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const api = { exports: {} };
new Function('exports', 'module', compiled.outputText)(api.exports, api);
const { SAM2FrameBuffer } = api.exports;

test('playback consumes prefetched frames without duplicate requests', async () => {
    const calls = [];
    const buffer = new SAM2FrameBuffer(async frame => { calls.push(frame); return { frame }; }, () => {});
    const pending = buffer.get(1);
    assert.equal(buffer.get(1), pending);
    await Promise.all([pending, buffer.get(2), buffer.get(3)]);
    assert.equal((await buffer.get(2)).frame, 2);
    assert.deepEqual(calls, [1, 2, 3]);
    buffer.dispose();
});

test('seeking keeps completed frames but discards a late response', async () => {
    let finish;
    const released = [];
    const buffer = new SAM2FrameBuffer(frame => frame === 1 ? new Promise(r => { finish = r; }) : Promise.resolve(frame),
        value => released.push(value));
    const old = buffer.get(1);
    await buffer.get(2);
    buffer.retain(10, 12);
    finish(1);
    await assert.rejects(old, /superseded/);
    assert.deepEqual(released, [1]);
    assert.equal(await buffer.get(2), 2);
    buffer.dispose();
    assert.deepEqual(released, [1, 2]);
});

test('failed speculative requests can retry when the frame is needed', async () => {
    let calls = 0;
    const buffer = new SAM2FrameBuffer(async () => {
        if (++calls === 1) throw new Error('temporary error');
        return 7;
    }, () => {});
    await assert.rejects(buffer.get(7));
    assert.equal(await buffer.get(7), 7);
    assert.equal(calls, 2);
    buffer.dispose();
});

test('forward then backward navigation reuses masks and images without refetching', async () => {
    const calls = [];
    const buffer = new SAM2FrameBuffer(async frame => { calls.push(frame); return frame; }, () => {});
    for (const frame of [1, 100, 1]) {
        buffer.retain(frame, frame);
        await buffer.get(frame);
    }
    assert.deepEqual(calls, [1, 100]);
    assert(buffer.has(1));
    buffer.dispose();
    assert(!buffer.has(1));
});

test('weighted LRU evicts the least recently used frame and releases it once', async () => {
    const calls = [];
    const released = [];
    const buffer = new SAM2FrameBuffer(async frame => { calls.push(frame); return frame; },
        value => released.push(value), () => 10, 20);
    for (const frame of [1, 2, 1, 3]) {
        buffer.retain(frame, frame);
        await buffer.get(frame);
    }
    assert.deepEqual(released, [2]);
    assert(buffer.has(1));
    assert(!buffer.has(2));
    buffer.retain(2, 2);
    await buffer.get(2);
    assert.deepEqual(calls, [1, 2, 3, 2]);
    buffer.dispose();
    assert.deepEqual(released, [2, 1, 3, 2]);
});
