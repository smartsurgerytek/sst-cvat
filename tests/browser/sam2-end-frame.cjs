// SPDX-License-Identifier: MIT
const fs = require('fs'), assert = require('assert/strict'), path = require('path'), os = require('os');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const root = path.resolve(__dirname, '../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sam2-end-frame-'));
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false, entry: path.join(__dirname, 'sam2-end-frame-entry.tsx'),
        output: { path: directory, filename: 'test.js' },
        resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(root, 'node_modules')],
            alias: { 'cvat-core': path.join(root, 'cvat-core') } },
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage(); const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ content: fs.readFileSync(path.join(directory, 'test.js'), 'utf8') });
        await page.getByText('Preview: 0.600 s · frame 3', { exact: true }).waitFor();
        const slider = page.getByRole('slider');
        await slider.focus(); await slider.press('ArrowRight');
        // Let the slow request start, then select a newer frame before it completes.
        await page.waitForTimeout(150); await slider.press('ArrowRight');
        await page.getByText('Preview: 2.000 s · frame 5', { exact: true }).waitFor();
        await page.waitForTimeout(300);
        assert.equal(await page.locator('canvas').evaluate(c => c.getContext('2d').getImageData(0, 0, 1, 1).data[0]), 100);
        assert((await page.locator('body').innerText()).includes('Starting: 0.100 s · frame 1'));
        await slider.press('End');
        await page.getByText('Preview: 7.500 s · frame 9', { exact: true }).waitFor();
        await slider.press('Home');
        await page.getByText('Preview: 0.300 s · frame 2', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        console.log('PASS: VFR seconds, preview synchronization, stale request protection, range bounds, fixed seed frame');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
