// SPDX-License-Identifier: MIT
const fs = require('fs'), assert = require('assert/strict'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sam2-live-overlay-'));
(async () => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'testsrc2=size=640x360:rate=25', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-y', path.join(directory, 'video.mp4')]);
    execFileSync(process.env.PYAV_PYTHON || 'python3', [path.join(__dirname, 'create_sam2_segments.py'), directory]);
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false, entry: path.join(__dirname, 'sam2-overlay-entry.tsx'),
        output: { path: directory, filename: 'overlay.js' },
        resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(root, 'node_modules')],
            alias: { utils: path.join(root, 'cvat-ui/src/utils') } },
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage(); const requests = []; const errors = [];
        const clips = JSON.parse(fs.readFileSync(path.join(directory, 'original-segments.json')));
        const mask = { object_id: 'one', points: [0, 576, 0, 0, 31, 17], label_color: '#00ff00' };
        const logits = Buffer.from(new Float32Array(576).fill(2).buffer).toString('base64');
        page.on('pageerror', error => errors.push(error.message));
        await page.route('http://overlay.test/**', async route => {
            const url = new URL(route.request().url()); requests.push({ path: url.pathname, method: route.request().method() });
            const match = /segments\/(\d+)$/.exec(url.pathname);
            if (match) {
                const index = +match[1], clip = clips[index];
                return route.fulfill({ contentType: 'video/mp4', headers: {
                    'X-Video-Start': String(clip.start), 'X-Video-End': String(clip.end), 'X-Video-Codec': clip.codec,
                }, body: fs.readFileSync(path.join(directory, `original-${index}.mp4`)) });
            }
            if (url.pathname === '/playback') return route.fulfill({ json: { width: 32, height: 18,
                frames: Array.from({ length: 300 }, (_, frame) => ({ frame, objects: [mask] })) } });
            if (url.pathname === '/masks') return route.fulfill({ json: {
                width: 32, height: 18, source_height: 18, objects: [{ ...mask, logits }],
            } });
            return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
        });
        await page.goto('http://overlay.test');
        await page.addScriptTag({ content: fs.readFileSync(path.join(directory, 'overlay.js'), 'utf8') });
        await page.evaluate(() => window.warmMain());
        await page.waitForFunction(() => window.mainCacheReady());
        const downloadsBeforeSAM2 = requests.filter(request => request.path.includes('/segments/')).length;
        await page.evaluate(() => window.startOverlay());
        await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.5);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('video').paused);
        const pausedOverlay = await page.locator('canvas').evaluate(canvas => canvas.toDataURL());
        const pausedTime = await page.locator('video').evaluate(video => video.currentTime);
        // Parameter changes can arrive while a paused seek is still decoding.
        await page.locator('video').evaluate(video => Object.defineProperty(video, 'seeking', {
            configurable: true, value: true,
        }));
        await page.getByRole('button', { name: 'Curve', exact: true }).click();
        await page.locator('video').evaluate(video => { delete video.seeking; });
        await page.waitForFunction(() => {
            const canvas = document.querySelector('canvas');
            return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some(value => value);
        });
        assert.notEqual(await page.locator('canvas').evaluate(canvas => canvas.toDataURL()), pausedOverlay);
        assert.equal(await page.locator('video').evaluate(video => video.currentTime), pausedTime);
        await page.getByRole('button', { name: 'Reset', exact: true }).click();
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await page.evaluate(() => {
            window.originalVideo = document.querySelector('video'); window.seeks = 0;
            window.originalVideo.addEventListener('seeking', () => window.seeks++);
            window.beforeTime = window.originalVideo.currentTime;
        });
        const alpha = () => page.evaluate(() => {
            const canvas = document.querySelector('canvas');
            return canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3];
        });
        assert(Math.abs(await alpha() - 127) <= 1);
        const originalOverlay = await page.locator('canvas').evaluate(canvas => canvas.toDataURL());
        await page.getByRole('button', { name: 'Curve', exact: true }).click();
        assert.notEqual(await page.locator('canvas').evaluate(canvas => canvas.toDataURL()), originalOverlay);
        await page.getByRole('button', { name: 'Threshold', exact: true }).click();
        await page.waitForFunction(() => !document.body.textContent.includes('Loading adjusted overlay'));
        assert.equal(await alpha(), 0);
        await page.getByRole('button', { name: 'Smooth', exact: true }).click();
        assert.equal(await alpha(), 0);
        await page.getByRole('button', { name: 'Reset', exact: true }).click();
        assert(Math.abs(await alpha() - 127) <= 1);
        await page.getByRole('button', { name: 'Opacity', exact: true }).click();
        assert(Math.abs(await alpha() - 51) <= 1);
        await page.getByRole('button', { name: 'Hide', exact: true }).click();
        assert.equal(await alpha(), 0);
        await page.waitForFunction(() => window.originalVideo.currentTime > window.beforeTime + 0.4);
        assert(await page.evaluate(() => window.originalVideo === document.querySelector('video') && window.seeks === 0));
        assert.equal(requests.filter(request => request.path === '/playback').length, 1);
        assert(requests.every(request => request.method === 'GET'));
        assert(!requests.some(request => request.path === '/video.mp4'));
        assert.equal(requests.filter(request => request.path.includes('/segments/')).length, downloadsBeforeSAM2);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ result: 'PASS', threshold: 'live', smoothing: 'live',
            opacity: 'live', hidden: 'live', videoRestarts: 0, inferenceRequests: 0, extraVideoDownloadsAfterMainPlayer: 0, curveFit: 'live' }));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
