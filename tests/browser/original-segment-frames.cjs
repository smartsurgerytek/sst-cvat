// SPDX-License-Identifier: MIT
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', { paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()] }));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'original-segment-frames-'));
(async () => {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'testsrc2=size=640x360:rate=25', '-t', '12', '-c:v', 'libx264', '-g', '60', '-bf', '3',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', path.join(directory, 'video.mp4')]);
    execFileSync(process.env.PYAV_PYTHON || 'python3', [path.join(__dirname, 'create_sam2_segments.py'), directory]);
    await new Promise((resolve, reject) => webpack({ mode: 'development', devtool: false,
        entry: path.join(__dirname, 'video-segment-cache-entry.ts'), output: { path: directory, filename: 'test.js' },
        resolve: { extensions: ['.ts', '.js'] },
        module: { rules: [{ test: /\.ts$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage(); const requests = []; const errors = [];
        const segments = JSON.parse(fs.readFileSync(path.join(directory, 'original-segments.json')));
        page.on('pageerror', error => errors.push(error.message));
        await page.route('http://frames.test/**', async route => {
            const url = new URL(route.request().url());
            const match = /segments\/(\d+)$/.exec(url.pathname);
            if (match) {
                assert.equal(url.searchParams.get('profile'), 'original');
                const index = +match[1], segment = segments[index]; requests.push(index);
                return route.fulfill({ contentType: 'video/mp4', headers: {
                    'X-Video-Start': String(segment.start), 'X-Video-End': String(segment.end), 'X-Video-Codec': segment.codec,
                }, body: fs.readFileSync(path.join(directory, `original-${index}.mp4`)) }).catch(() => {});
            }
            if (url.pathname === '/reference') return route.fulfill({ contentType: 'video/mp4',
                body: fs.readFileSync(path.join(directory, 'video.mp4')) });
            assert.notEqual(url.pathname, '/video', 'main decoder downloaded whole video');
            return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
        });
        await page.goto('http://frames.test');
        await page.addScriptTag({ content: fs.readFileSync(path.join(directory, 'test.js'), 'utf8') });
        const result = await page.evaluate(async () => {
            const api = window.originalVideoAPI;
            api.registerOriginalVideo(4, { id: 'original-browser-test', url: '/video', duration: 12,
                timestamps: Array.from({ length: 300 }, (_, i) => i / 25) });
            const reference = document.createElement('video'); reference.muted = true;
            const loaded = new Promise(resolve => { reference.onloadeddata = resolve; });
            reference.src = URL.createObjectURL(await (await fetch('/reference')).blob()); await loaded;
            const pixels = image => {
                const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
                const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
                return [...context.getImageData(100, 100, 20, 20).data];
            };
            for (const frame of [250, 25, 125, 250]) {
                api.prioritizeOriginalVideoFrame(4, frame);
                const image = await api.originalVideoFrame(4, frame);
                const sought = new Promise(resolve => reference.addEventListener('seeked', resolve, { once: true }));
                reference.currentTime = frame / 25 + 0.0001; await sought;
                const expected = pixels(reference), actual = pixels(image.imageData); image.imageData.close();
                if (actual.some((value, i) => value !== expected[i])) {
                    throw new Error(`Pixel mismatch at frame ${frame}`);
                }
                if (image.renderWidth !== 640 || image.renderHeight !== 360) throw new Error('Original resolution changed');
            }
            api.clearOriginalVideo(4);
            return 'Original pixels match, including B frames and backward seeks';
        });
        assert.equal(requests.filter(index => index === 2).length, 1, '10-second segment downloaded twice');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ result: 'PASS', verification: result, requests }));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
