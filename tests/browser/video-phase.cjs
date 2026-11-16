// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-phase-ui-'));
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false,
        entry: path.join(__dirname, 'video-phase-entry.tsx'),
        output: { path: directory, filename: 'phase.js' },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
            modules: [path.resolve(__dirname, '../../cvat-ui/src'), 'node_modules'],
            alias: {
                'cvat-core-wrapper$': path.join(__dirname, 'video-phase-mocks.tsx'),
                'actions/annotation-actions$': path.join(__dirname, 'video-phase-mocks.tsx'),
            },
        },
        plugins: [new webpack.NormalModuleReplacementPlugin(/\.\/video-range-selector$/,
            path.join(__dirname, 'video-phase-mocks.tsx'))],
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ path: path.join(directory, 'phase.js') });
        await page.getByRole('button', { name: 'Phase', exact: true }).click();
        await page.getByRole('button', { name: 'Add range', exact: true }).click();
        await page.getByText(/Automatic save failed/).waitFor();
        assert.deepEqual(await page.evaluate(() => [window.phaseTest.saves, window.phaseTest.tags.length,
            window.phaseTest.saved.length]), [1, 1, 0]);
        assert.equal(await page.getByText(/frame tags and saved automatically/).count(), 0);
        await page.evaluate(() => { window.phaseTest.failSave = false; });
        await page.getByRole('button', { name: 'Add range', exact: true }).click();
        await page.getByText('Added 0 frame tags and saved automatically.', { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => [window.phaseTest.saves, window.phaseTest.tags.length,
            window.phaseTest.saved.length]), [2, 1, 1], 'Retry saves without duplicate tags');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Phase', exact: true }).click();
        await page.getByRole('tab', { name: 'Manage ranges (1)' }).waitFor();
        assert.deepEqual(errors, []);
        console.log('PASS: Phase add autosaves, failure is visible, retry persists without duplicates, reopen retains range');
    } finally {
        await browser.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
