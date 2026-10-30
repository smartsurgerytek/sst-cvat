// SPDX-License-Identifier: MIT
// Exercises the actual loading component with fast/slow frame readiness transitions.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-loading-'));
const source = fs.readFileSync(path.join(root,
    'cvat-ui/src/components/annotation-page/canvas/views/canvas2d/canvas-wrapper.tsx'), 'utf8');
const start = source.indexOf('const CanvasLoading =');
const end = source.indexOf('\nclass CanvasWrapperComponent', start);
assert(start >= 0 && end > start);
const entry = path.join(directory, 'entry.tsx');
fs.writeFileSync(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
const Spin = (props) => <span {...props}>Buffering</span>;
${source.slice(start, end)}
const root = createRoot(document.getElementById('root'));
window.renderLoading = (loading, playing) => root.render(loading ? <CanvasLoading playing={playing} /> : null);
`);
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false, entry,
        output: { path: directory, filename: 'test.js' },
        resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(root, 'node_modules')] },
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ path: path.join(directory, 'test.js') });
        for (let frame = 0; frame < 4; frame++) {
            await page.evaluate(() => window.renderLoading(true, true));
            await page.waitForTimeout(250);
            assert.equal(await page.locator('.cvat-spinner-container, .cvat-playback-buffering').count(), 0);
            await page.evaluate(() => window.renderLoading(false, true));
            await page.waitForTimeout(20);
        }
        await page.evaluate(() => window.renderLoading(true, true));
        await page.locator('.cvat-playback-buffering').waitFor();
        assert.equal(await page.locator('.cvat-spinner-container').count(), 0);
        await page.evaluate(() => window.renderLoading(true, false));
        await page.locator('.cvat-spinner-container').waitFor();
        assert.equal(await page.locator('.cvat-playback-buffering').count(), 0);
        await page.evaluate(() => window.renderLoading(false, false));
        await page.locator('.cvat-spinner-container').waitFor({ state: 'detached' });
        console.log('PASS: cached frame transitions do not flash; slow playback keeps a corner indicator; paused loads remain blocked');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
