// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-overlay-export-ui-'));
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false,
        entry: path.join(__dirname, 'video-overlay-export-entry.tsx'),
        output: { path: directory, filename: 'export.js' },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
            alias: {
                utils: path.join(process.cwd(), "cvat-ui/src/utils"),
                'cvat-core-wrapper$': path.join(__dirname, 'video-overlay-export-mocks.tsx'),
                'actions/annotation-actions$': path.join(__dirname, 'video-overlay-export-mocks.tsx'),
            },
        },
        plugins: [new webpack.NormalModuleReplacementPlugin(/\.\/video-range-selector$/,
            path.join(__dirname, 'video-overlay-export-mocks.tsx'))],
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
        const errors = [], posts = [], previews = [];
        page.on('pageerror', error => errors.push(error.message));
        let state = 'queued';
        let rejectPost = false;
        await page.route('http://cvat-export.test/**', async route => {
            const request = route.request();
            if (!request.url().includes('/api/')) {
                await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
            } else if (request.url().endsWith('/preview')) {
                previews.push(request.postDataJSON());
                await route.fulfill({ contentType: 'image/png', body: Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
            } else if (request.method() === 'POST') {
                posts.push(request.postDataJSON());
                if (rejectPost) await route.fulfill({ status: 400, json: { detail: 'Invalid export range' } });
                else await route.fulfill({ status: 202, json: { id: 'export-1', state: 'queued', progress: 0 } });
            } else if (request.url().endsWith('/download')) {
                await route.fulfill({ contentType: 'video/mp4', body: Buffer.alloc(65536),
                    headers: { 'content-length': '65536' } });
            } else {
                await route.fulfill({ json: { id: 'export-1', state, progress: state === 'ready' ? 100 : 25 } });
            }
        });
        await page.goto('http://cvat-export.test/');
        await page.addScriptTag({ path: path.join(directory, 'export.js') });
        await page.getByRole('button', { name: 'Export annotated video', exact: true }).click();
        await page.getByRole('img', { name: 'A + B export preview · Frame 10' }).waitFor();
        assert.equal(previews.at(-1).opacity, .35);
        assert.equal(previews.at(-1).shapes[0].id, 7);
        assert.equal(previews.at(-1).tags[0].label_id, 2);
        assert.equal(await page.evaluate(() => window.exportTest.saves), 0, 'Preview must not save annotations');
        await page.locator('.ant-slider [role=slider]').focus();
        const changedOpacity = page.waitForRequest(request => request.url().endsWith('/preview') &&
            request.postDataJSON().opacity === .36);
        await page.keyboard.press('ArrowRight');
        await changedOpacity;
        await page.getByRole('img', { name: 'A + B export preview · Frame 10' }).waitFor();
        assert.equal(previews.at(-1).opacity, .36);
        await page.keyboard.press('ArrowLeft');
        await page.getByRole('img', { name: 'A + B export preview · Frame 10' }).waitFor();
        await page.getByLabel('Preview frame', { exact: true }).fill('15');
        await page.getByRole('img', { name: 'A + B export preview · Frame 15' }).waitFor();
        assert.equal(previews.at(-1).frame, 15);
        assert.equal(await page.getByLabel('Export start').inputValue(), '10');
        assert.equal(await page.getByLabel('Export stop').inputValue(), '30');
        await page.getByRole('button', { name: 'Save and export', exact: true }).click();
        await page.getByText('Save failed', { exact: true }).waitFor();
        assert.equal(posts.length, 0, 'Must not export stale annotations when saving fails');
        await page.evaluate(() => { window.exportTest.failSave = false; });
        await page.getByLabel('Export start').fill('12');
        await page.getByLabel('Export stop').fill('20');
        await page.getByLabel('Object names and IDs', { exact: true }).uncheck();
        rejectPost = true;
        await page.getByRole('button', { name: 'Save and export', exact: true }).click();
        await page.getByText('Invalid export range', { exact: true }).waitFor();
        rejectPost = false;
        await page.getByRole('button', { name: 'Save and export', exact: true }).click();
        await page.getByText('Waiting for video export to start…', { exact: true }).waitFor();
        assert.deepEqual(posts.at(-1), { start_frame: 12, stop_frame: 20, opacity: .35,
            show_names: false, show_legend: true, show_phase: true });
        assert.equal(await page.getByLabel('Export start').isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Save and export', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        state = 'ready';
        await page.getByRole('button', { name: 'Export annotated video', exact: true }).click();
        await page.getByText('Video ready. Download it within 24 hours.', { exact: true }).waitFor();
        const downloadEvent = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download A + B MP4' }).click();
        const download = await downloadEvent;
        assert.equal(download.suggestedFilename(), 'job-4-A-B-export-1.mp4');
        await page.getByText('Download complete', { exact: true }).waitFor();
        assert.equal(fs.statSync(await download.path()).size, 65536);
        assert.equal(await page.evaluate(() => window.exportTest.saves), 3);
        assert.deepEqual(errors, []);
        console.log('PASS: export saves annotations first, handles failures, sends settings, polls, reopens and downloads');
    } finally {
        await browser.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
