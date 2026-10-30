// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

function setup(beforeClone = async () => {}, options = {}) {
    const seeks = [];
    const videos = [];
    const bitmaps = [];
    class Video extends EventTarget {
        videoWidth = 1920;
        videoHeight = 1080;
        time = 0;
        readyState = 2;
        seeking = false;
        duration = 10;
        error = null;
        set src(value) { queueMicrotask(() => this.onloadedmetadata?.()); }
        get currentTime() { return this.time; }
        set currentTime(value) {
            this.time = value;
            seeks.push(value);
            this.seeking = true;
            if (options.seek) { options.seek(this, videos.indexOf(this)); return; }
            setTimeout(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); }, 2);
        }
        pause() {}
        removeAttribute() {}
        load() {}
    }
    const api = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('cvat-core/src/original-video.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, {
        exports: api,
        require: () => ({
            SEGMENT_SECONDS: 5,
            cachedVideoRanges: () => [],
            VideoSegmentStream: class {
                focus(time) { return Promise.resolve({ start: Math.floor(time / 5) * 5, blob: {} }); }
                dispose() {}
            },
        }),
        URL: { createObjectURL: () => '/cached-segment', revokeObjectURL: () => {} },
        setTimeout: (callback, delay) => setTimeout(callback, delay === 30000 ? (options.timeout || delay) : delay),
        clearTimeout, setInterval, clearInterval,
        document: { createElement: () => { const video = new Video(); videos.push(video); return video; } },
        createImageBitmap: async source => {
            if (!(source instanceof Video)) await beforeClone(source);
            assert(!source.closed, 'cannot clone an evicted bitmap');
            const bitmap = { closed: false, close() { this.closed = true; } };
            bitmaps.push(bitmap);
            return bitmap;
        },
    });
    api.registerOriginalVideo(4, { url: '/video', duration: 10, timestamps: Array.from({ length: 250 }, (_, i) => i / 25) });
    return { api, seeks, bitmaps, videos };
}

test('repeated reads share a decode and callers own independent bitmaps', async () => {
    const { api, seeks } = setup();
    const [first, second] = await Promise.all([api.originalVideoFrame(4, 10), api.originalVideoFrame(4, 10)]);
    assert.equal(seeks.length, 1);
    assert.notEqual(first.imageData, second.imageData);
    first.imageData.close();
    assert.equal(second.imageData.closed, false);
    api.clearOriginalVideo(4);
    second.imageData.close();
});

test('playback leaves decoding free for the next requested frame and releases images on teardown', async () => {
    const { api, seeks, bitmaps } = setup();
    const first = await api.originalVideoFrame(4, 10, true);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(seeks.length, 1, 'unused adjacent frames must not occupy the decoder');
    const second = await api.originalVideoFrame(4, 11);
    assert.equal(seeks.length, 2);
    first.imageData.close();
    second.imageData.close();
    api.clearOriginalVideo(4);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(bitmaps.every(bitmap => bitmap.closed));
});

test('a jump cancels speculative decoding without cancelling another reader', async () => {
    const { api, seeks } = setup();
    const old = api.originalVideoFrame(4, 10, true);
    const jumped = api.originalVideoFrame(4, 100);
    const results = await Promise.all([old, jumped]);
    assert.equal(seeks.length, 2);
    assert(Math.abs(seeks[1] - 4) < 0.001);
    results.forEach(result => result.imageData.close());
    api.clearOriginalVideo(4);
});

test('canvas and SAM2 lookahead can request different frames while video loads', async () => {
    const { api, seeks } = setup();
    const results = await Promise.all([0, 1, 2, 3].map(frame => api.originalVideoFrame(4, frame)));
    assert.equal(seeks.length, 4);
    results.forEach(result => result.imageData.close());
    api.clearOriginalVideo(4);
});

test('teardown waits for an active bitmap copy before releasing the cached image', async () => {
    let releaseCopy;
    let started;
    const copying = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { releaseCopy = resolve; });
    const { api, bitmaps } = setup(async () => { started(); await gate; });
    const pending = api.originalVideoFrame(4, 10);
    await copying;
    api.clearOriginalVideo(4);
    releaseCopy();
    const result = await pending;
    assert.equal(result.imageData.closed, false);
    result.imageData.close();
    assert(bitmaps.every(bitmap => bitmap.closed));
});

test('jumping forward then back reuses a decoded frame without another seek', async () => {
    const { api, seeks } = setup();
    for (const frame of [10, 100, 10]) {
        (await api.originalVideoFrame(4, frame)).imageData.close();
    }
    assert.equal(seeks.length, 2);
    api.clearOriginalVideo(4);
});

test('decoded history is bounded and recently read frames survive eviction', async () => {
    const { api, seeks, bitmaps } = setup();
    for (let frame = 1; frame <= 32; frame++) (await api.originalVideoFrame(4, frame)).imageData.close();
    (await api.originalVideoFrame(4, 1)).imageData.close(); // Touch frame 1 before pressure.
    for (let frame = 33; frame <= 40; frame++) (await api.originalVideoFrame(4, frame)).imageData.close();
    const before = seeks.length;
    (await api.originalVideoFrame(4, 1)).imageData.close();
    assert.equal(seeks.length, before);
    (await api.originalVideoFrame(4, 2)).imageData.close();
    assert.equal(seeks.length, before + 1, 'evicted frame must decode again');
    assert(bitmaps.filter(bitmap => !bitmap.closed).length <= 32);
    api.clearOriginalVideo(4);
});

test('changing source invalidates the old decoded history', async () => {
    const { api, seeks } = setup();
    (await api.originalVideoFrame(4, 10)).imageData.close();
    api.registerOriginalVideo(4, { id: 'new', url: '/replacement', duration: 10,
        timestamps: Array.from({ length: 250 }, (_, i) => i / 25) });
    (await api.originalVideoFrame(4, 10)).imageData.close();
    assert.equal(seeks.length, 2);
    api.clearOriginalVideo(4);
});


test('download indicators include decoded images and clear them on teardown', async () => {
    const { api, videos } = setup();
    assert.equal(api.originalVideoCachedRanges(4).length, 0);
    (await api.originalVideoFrame(4, 10)).imageData.close();
    (await api.originalVideoFrame(4, 11)).imageData.close();
    (await api.originalVideoFrame(4, 100)).imageData.close();
    videos[0].buffered = { length: 1, start: () => 0, end: () => 0.42 };
    assert.equal(JSON.stringify(api.originalVideoCachedRanges(4)), JSON.stringify([[0.4, 0.48], [4, 4.04]]));
    api.clearOriginalVideo(4);
    assert.equal(api.originalVideoCachedRanges(4).length, 0);
});


test('a completed seek without a seeked event is recovered from media state', async () => {
    const { api, videos } = setup(undefined, { seek: video => {
        setTimeout(() => { video.seeking = false; }, 2);
    } });
    (await api.originalVideoFrame(4, 10)).imageData.close();
    assert.equal(videos.length, 1, 'completed seek must not recreate decoder');
    api.clearOriginalVideo(4);
});

test('a timed out decoder is recreated once without losing queued readers', async () => {
    const { api, videos } = setup(undefined, { timeout: 30, seek: (video, index) => {
        if (index === 0) return;
        setTimeout(() => { video.seeking = false; video.dispatchEvent(new Event('seeked')); }, 2);
    } });
    const results = await Promise.all([api.originalVideoFrame(4, 10), api.originalVideoFrame(4, 100)]);
    assert.equal(videos.length, 2);
    results.forEach(result => result.imageData.close());
    api.clearOriginalVideo(4);
});

test('persistent seek failure stops after one retry and never copies an undecoded frame', async () => {
    const { api, videos, bitmaps } = setup(undefined, { timeout: 20, seek: () => {} });
    await assert.rejects(api.originalVideoFrame(4, 10), /seeking timed out/);
    assert.equal(videos.length, 2);
    assert.equal(bitmaps.length, 0);
    api.clearOriginalVideo(4);
});

test('media errors trigger immediate decoder recovery', async () => {
    const { api, videos } = setup(undefined, { seek: (video, index) => {
        setTimeout(() => {
            if (index === 0) {
                video.error = { message: 'decoder failed' };
                video.dispatchEvent(new Event('error'));
            } else { video.seeking = false; video.dispatchEvent(new Event('seeked')); }
        }, 2);
    } });
    (await api.originalVideoFrame(4, 10)).imageData.close();
    assert.equal(videos.length, 2);
    api.clearOriginalVideo(4);
});

test('obsolete stalled lookahead releases the queue for a manual jump', async () => {
    const { api, videos } = setup(undefined, { seek: video => {
        if (Math.abs(video.currentTime - 0.4401) < 0.00001) return;
        setTimeout(() => { video.seeking = false; video.dispatchEvent(new Event('seeked')); }, 2);
    } });
    (await api.originalVideoFrame(4, 10, true)).imageData.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    (await api.originalVideoFrame(4, 100)).imageData.close();
    assert.equal(videos.length, 1);
    api.clearOriginalVideo(4);
});


test('manual jump aborts a stalled active read and immediately starts the new decoder', async () => {
    const { api, videos } = setup(undefined, { seek: (video, index) => {
        if (index === 0) return;
        setTimeout(() => { video.seeking = false; video.dispatchEvent(new Event('seeked')); }, 2);
    } });
    const old = api.originalVideoFrame(4, 10);
    const cancelled = assert.rejects(old, error => error instanceof api.OriginalVideoFrameSupersededError);
    await new Promise(resolve => setTimeout(resolve, 5));
    api.prioritizeOriginalVideoFrame(4, 200);
    (await api.originalVideoFrame(4, 200)).imageData.close();
    assert.equal(videos.length, 2);
    await cancelled;
    api.clearOriginalVideo(4);
});

test('manual jump retains previously decoded images', async () => {
    const { api, seeks } = setup();
    (await api.originalVideoFrame(4, 10)).imageData.close();
    api.prioritizeOriginalVideoFrame(4, 200);
    (await api.originalVideoFrame(4, 200)).imageData.close();
    api.prioritizeOriginalVideoFrame(4, 10);
    (await api.originalVideoFrame(4, 10)).imageData.close();
    assert.equal(seeks.length, 2);
    api.clearOriginalVideo(4);
});
