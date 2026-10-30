// SPDX-License-Identifier: MIT
// CVAT_BROWSER_TEST_DEPS=/path/to/playwright-project node tests/browser/original-video-buffer.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));

(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'original-video-buffer-'));
    let browser;
    try {
        const file = path.join(directory, 'video.mp4');
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
            'testsrc2=size=320x180:rate=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', file]);
        const source = fs.readFileSync(path.join(__dirname, '../../cvat-core/src/original-video.ts'), 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        browser = await chromium.launch({
            executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
            headless: true, args: ['--no-sandbox'],
        });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addScriptTag({ content: `window.exports = {};\n${compiled}` });
        const result = await page.evaluate(async (base64) => {
            const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
            const api = window.exports;
            let decoded = 0;
            try {
                for (let attempt = 0; attempt < 5; attempt++) {
                    api.registerOriginalVideo(4, {
                        id: 'test', url, duration: 2,
                        timestamps: Array.from({ length: 50 }, (_, frame) => frame / 25),
                    });
                    // Competing canvas and SAM2 requests before the first frame loads.
                    const frames = await Promise.all([0, 1, 2, 3, 20, 0].map(frame => (
                        api.originalVideoFrame(4, frame, true)
                    )));
                    for (const frame of frames) {
                        if (frame.imageData.width !== 320 || frame.imageData.height !== 180) {
                            throw new Error('Decoded frame is missing or closed');
                        }
                        frame.imageData.close();
                        decoded++;
                    }
                    api.clearOriginalVideo(4);
                }
            } finally {
                api.clearOriginalVideo(4);
                URL.revokeObjectURL(url);
            }
            return decoded;
        }, fs.readFileSync(file).toString('base64'));
        assert.equal(result, 30);
        assert.deepEqual(errors, []);
        console.log('PASS: 30 overlapping frame reads across 5 fresh video loads in Chrome');
    } finally {
        if (browser) await browser.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
