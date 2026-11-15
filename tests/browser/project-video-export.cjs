// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const http = require('node:http');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-overlay-export-ui-'));
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false,
        entry: path.join(__dirname, 'project-video-export-entry.tsx'),
        output: { path: directory, filename: 'export.js' },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
            alias: {
                utils: path.join(process.cwd(), 'cvat-ui/src/utils'),
                'cvat-core-wrapper$': path.join(__dirname, 'video-overlay-export-mocks.tsx'),
                'actions/annotation-actions$': path.join(__dirname, 'video-overlay-export-mocks.tsx'),
            },
        },
        plugins: [new webpack.NormalModuleReplacementPlugin(/\.\/video-range-selector$/,
            path.join(__dirname, 'video-overlay-export-mocks.tsx'))],
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1024,
            'Content-Disposition': 'attachment; filename=task-11-A-B.mp4' });
        response.end(Buffer.alloc(1024));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
        const errors = [], posts = [], archives = [];
        let nativeDownload = false;
        page.on('pageerror', error => errors.push(error.message));
        let active = 0, peak = 0, ready = false, fail = true;
        await page.route(`${origin}/**`, async route => {
            const request = route.request(), url = new URL(request.url());
            if (!url.pathname.startsWith('/api/')) {
                await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
            } else if (url.pathname === '/api/tasks') {
                assert.equal(url.searchParams.get('project_id'), '3');
                const first = url.searchParams.get('page') === '1';
                await route.fulfill({ json: { next: first ? 'next-page' : null, results: first ? [
                    { id: 11, name: 'Video One', size: 100, mode: 'interpolation', dimension: '2d' },
                    { id: 12, name: 'Images', size: 100, mode: 'annotation', dimension: '2d' },
                ] : [{ id: 13, name: 'Video Two', size: 200, mode: 'interpolation', dimension: '2d' }] } });
            } else if (url.pathname === '/api/projects/3/video-zip') {
                archives.push(request.postDataJSON());
                await route.fulfill({ status: 202, json: { id: 'zip-1', state: 'queued', progress: 0 } });
            } else if (url.pathname.includes('/video-zip/') && !url.pathname.endsWith('/download')) {
                await route.fulfill({ json: { id: 'zip-1', state: 'ready', progress: 100 } });
            } else if (request.method() === 'POST') {
                posts.push(url.pathname); active++; peak = Math.max(peak, active);
                await new Promise(resolve => setTimeout(resolve, 100));
                active--;
                if (url.pathname.includes('/13/') && fail) {
                    await route.fulfill({ status: 400, json: { detail: 'Test export failure' } });
                } else await route.fulfill({ status: 202, json: { id: 'run-1', state: 'queued', progress: 0 } });
            } else if (url.pathname.endsWith('/download')) {
                if (nativeDownload && request.method() === 'GET') return route.continue();
                await route.fulfill({ contentType: 'video/mp4', body: Buffer.alloc(1024),
                    headers: { 'content-length': '1024', ...(nativeDownload ? {
                        'content-disposition': 'attachment; filename=task-11-A-B.mp4' } : {}) } });
            } else await route.fulfill({ json: { id: 'run-1', state: ready ? 'ready' : 'running', progress: ready ? 100 : 30 } });
        });
        await page.goto(`${origin}/`);
        await page.evaluate(() => { window.showSaveFilePicker = undefined; });
        await page.addScriptTag({ path: path.join(directory, 'export.js') });
        await page.getByRole('button', { name: 'Export videos', exact: true }).click();
        await page.getByText('#13 Video Two', { exact: true }).waitFor();
        const tasks = page.getByRole('table').first();
        assert.equal(await tasks.getByRole('row').filter({ hasText: '#12 Images' }).getByRole('checkbox').isDisabled(), true);
        await tasks.getByRole('row').filter({ hasText: '#11 Video One' }).getByRole('checkbox').check();
        await tasks.getByRole('row').filter({ hasText: '#13 Video Two' }).getByRole('checkbox').check();
        await page.getByRole('button', { name: 'Export selected videos (2)', exact: true }).click();
        await page.getByText('Test export failure', { exact: true }).waitFor();
        assert.equal(peak, 2, 'Selected tasks should be submitted concurrently');
        assert.deepEqual(posts.sort(), ['/api/tasks/11/overlay-video', '/api/tasks/13/overlay-video']);
        fail = false;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        ready = true;
        await page.getByRole('button', { name: 'Export videos', exact: true }).click();
        await page.getByRole('button', { name: 'Download MP4', exact: true }).nth(1).waitFor();
        const event = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download MP4', exact: true }).first().click();
        const download = await event;
        assert.equal(download.suggestedFilename(), 'task-11-A-B.mp4');
        assert.equal(fs.statSync(await download.path()).size, 1024);
        nativeDownload = true;
        const nativeEvent = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download MP4', exact: true }).first().click();
        const nativeFile = await nativeEvent;
        await page.getByText('Download started — see browser downloads for progress', { exact: true }).waitFor();
        assert.equal(fs.statSync(await nativeFile.path()).size, 1024);
        nativeDownload = false;
        await page.getByRole('button', { name: 'Package ready videos as ZIP (2)', exact: true }).click();
        await page.getByRole('button', { name: 'Download ZIP', exact: true }).waitFor();
        assert.deepEqual(archives[0].exports.map(item => item.task_id).sort(), [11, 13]);
        await page.evaluate(() => {
            Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
            window.savedFile = { bytes: 0, closed: false, name: '' };
            window.showSaveFilePicker = async options => {
                window.savedFile.name = options.suggestedName;
                return { createWritable: async () => ({
                    write: async data => { window.savedFile.bytes += data.byteLength; },
                    close: async () => { window.savedFile.closed = true; }, abort: async () => {},
                }) };
            };
        });
        await page.getByRole('button', { name: 'Download ZIP', exact: true }).click();
        await page.waitForFunction(() => window.savedFile.closed);
        assert.deepEqual(await page.evaluate(() => window.savedFile), {
            bytes: 1024, closed: true, name: 'project-3-videos.zip',
        });
        await page.reload();
        await page.addScriptTag({ path: path.join(directory, 'export.js') });
        await page.getByRole('button', { name: 'Export videos', exact: true }).click();
        await page.getByRole('button', { name: 'Download MP4', exact: true }).nth(1).waitFor();
        assert.deepEqual(errors, []);
        console.log('PASS: paginated task selection, parallel submission, retry, polling, downloads and reload recovery');
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
