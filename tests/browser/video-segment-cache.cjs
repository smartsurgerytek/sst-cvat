// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const http = require('node:http');
let server;
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-segment-cache-'));
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false,
        entry: path.join(__dirname, 'video-segment-cache-entry.ts'),
        output: { path: directory, filename: 'cache.js' },
        resolve: { extensions: ['.ts', '.js'] },
        module: { rules: [{ test: /\.ts$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const requests = []; const failures = []; const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => failures.push(request.url()));
        server = http.createServer(async (request, response) => {
            const url = new URL(request.url, 'http://cache.test');
            const match = /segments\/(\d+)$/.exec(url.pathname);
            if (!match) { response.end('<html></html>'); return; }
            const index = +match[1]; requests.push(index);
            if (url.pathname.startsWith('/shared/')) await new Promise(resolve => setTimeout(resolve, 200));
            response.on('close', () => { if (!response.writableEnded) failures.push(url.pathname); });
            if (index === 3 && requests.filter(value => value === 3).length === 1) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
            if (response.destroyed) return;
            response.writeHead(200, { 'Content-Type': 'video/mp4',
                'X-Video-Start': String(index * 5), 'X-Video-End': String((index + 1) * 5),
                'X-Video-Codec': 'avc1.42c01e',
            });
            response.end(Buffer.alloc(1024, index));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const open = async () => {
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            await page.addScriptTag({ content: fs.readFileSync(path.join(directory, 'cache.js'), 'utf8') });
            await page.evaluate(() => {
                window.source = { id: 'cache-example', url: '/video', duration: 25 };
                window.completed = [];
                window.stream = new window.segmentAPI.VideoSegmentStream(window.source, 'original-v1',
                    (_, index) => window.completed.push(index));
            });
        };
        await open();
        await page.evaluate(() => window.stream.focus(10).then(() => undefined));
        await page.waitForFunction(() => window.completed.includes(2));
        // Wait until the lookahead HTTP request has actually begun.
        while (!requests.includes(3)) await new Promise(resolve => setTimeout(resolve, 10));
        await page.evaluate(() => window.stream.focus(1, true).then(() => undefined));
        await page.waitForFunction(() => window.completed.includes(4));
        assert.deepEqual(requests, [2, 3, 0, 1, 3, 4], 'cached island at 10 seconds must be skipped');
        await new Promise(resolve => setTimeout(resolve, 1700));
        assert(failures.some(url => url.endsWith('/3')), 'obsolete download was not cancelled');
        await page.evaluate(() => window.stream.dispose());
        const count = requests.length;
        await open();
        await page.evaluate(() => window.stream.focus(10).then(() => undefined));
        await page.waitForFunction(() => window.completed.includes(4));
        assert.equal(requests.length, count, 'reload re-downloaded cached segments');
        await page.evaluate(() => window.stream.dispose());
        const sharedStart = requests.length;
        await page.evaluate(() => {
            const source = { id: 'shared-cache', url: '/shared/video', duration: 25 };
            window.a = new window.segmentAPI.VideoSegmentStream(source);
            window.b = new window.segmentAPI.VideoSegmentStream(source, 'original-v1', (_, index) => {
                if (index === 4) window.sharedComplete = true;
            });
            window.a.focus(10).catch(() => {});
            window.b.focus(10).catch(() => {});
        });
        while (requests.length === sharedStart) await new Promise(resolve => setTimeout(resolve, 10));
        await page.evaluate(() => window.a.dispose());
        await page.waitForFunction(() => window.sharedComplete);
        assert.deepEqual(requests.slice(sharedStart), [2, 3, 4], 'viewers must share in-flight downloads');
        await page.evaluate(() => window.b.dispose());
        const migrationContext = await browser.newContext();
        const migrationPage = await migrationContext.newPage();
        await migrationPage.goto(`http://127.0.0.1:${server.address().port}`);
        await migrationPage.evaluate(() => new Promise((resolve, reject) => {
            const request = indexedDB.open('cvat-sam2-playback-v1', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('segments', { keyPath: 'key' });
            request.onsuccess = () => {
                const db = request.result, transaction = db.transaction('segments', 'readwrite');
                transaction.objectStore('segments').put({ key: 'migration:original-v1:2', blob: new Blob(['cached']),
                    start: 10, end: 15, codec: 'avc1.42c01e', accessed: Date.now() });
                transaction.oncomplete = () => { db.close(); resolve(); };
                transaction.onerror = () => reject(transaction.error);
            };
        }));
        await migrationPage.addScriptTag({ content: fs.readFileSync(path.join(directory, 'cache.js'), 'utf8') });
        const beforeMigration = requests.length;
        await migrationPage.evaluate(async () => {
            const stream = new window.segmentAPI.VideoSegmentStream({ id: 'migration', url: '/video', duration: 15 });
            const segment = await stream.focus(10);
            if (await segment.blob.text() !== 'cached') throw new Error('Old cached blob lost during migration');
            stream.dispose();
        });
        assert.equal(requests.length, beforeMigration, 'cache upgrade re-downloaded existing video');
        await migrationContext.close();
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ result: 'PASS', requestOrder: requests,
            jumpBack: 'aborted obsolete download', cachedTenSeconds: 'not re-downloaded', reload: 'IndexedDB hit', simultaneousViewers: 'one download per segment', cacheUpgrade: 'existing blobs preserved' }));
    } finally { await browser.close(); server?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
