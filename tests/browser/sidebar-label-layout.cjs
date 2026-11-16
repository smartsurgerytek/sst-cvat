// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const sass = require('sass');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-label-ui-'));
(async () => {
    const css = sass.compile(path.resolve(__dirname,
        '../../cvat-ui/src/components/annotation-page/standard-workspace/objects-side-bar/styles.scss'), {
        loadPaths: [path.resolve(__dirname, '../../cvat-ui/src')], logger: sass.Logger.silent,
    }).css;
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false,
        entry: path.join(__dirname, 'sidebar-label-layout-entry.tsx'),
        output: { path: directory, filename: 'sidebar.js' },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
            modules: [path.resolve(__dirname, '../../cvat-ui/src'), 'node_modules'],
        },
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 700, height: 400 } });
        await page.setContent('<div id="root"></div>');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ path: path.join(directory, 'sidebar.js') });
        await page.locator('.cvat-label-item-button-lock').first().waitFor();
        for (const width of [300, 240, 180]) {
            await page.locator('#sidebar').evaluate((element, value) => { element.style.width = `${value}px`; }, width);
            const rows = await page.locator('.cvat-objects-sidebar-label-item').evaluateAll(elements => elements.map(row => {
                const box = row.getBoundingClientRect();
                const name = row.querySelector('.cvat-label-item-name').getBoundingClientRect();
                const lock = row.querySelector('.cvat-label-item-button-lock').getBoundingClientRect();
                const eye = row.querySelector('.cvat-label-item-button-hidden').getBoundingClientRect();
                return { nameRight: name.right, lockX: lock.x, lockBottom: lock.bottom,
                    rowBottom: box.bottom, eyeRight: eye.right, rowRight: box.right };
            }));
            for (const row of rows) {
                assert.ok(Math.abs(row.lockX - rows[0].lockX) < 1, 'Lock alignment must not depend on label length');
                assert.ok(row.nameRight <= row.lockX && row.eyeRight <= row.rowRight, 'Text and controls must not overlap or overflow');
                assert.ok(row.lockBottom <= row.rowBottom, 'Lock must stay in its row');
            }
            assert.equal(await page.locator('.ant-select-selection-item').evaluate(element =>
                getComputedStyle(element).textOverflow), 'ellipsis');
        }
        await page.locator('.cvat-label-item-button-lock').nth(1).click();
        assert.equal(await page.locator('#locked').textContent(), 'true');
        await page.locator('.cvat-label-item-button-hidden').nth(1).click();
        assert.equal(await page.locator('#hidden').textContent(), 'true');
        await page.locator('.cvat-label-item-name').nth(1).hover();
        await page.getByRole('tooltip').filter({ hasText: 'blood-obscured view' }).waitFor();
        await page.screenshot({ path: '/tmp/cvat-sidebar-label-layout.png' });
        console.log('PASS: long labels preserve lock alignment at 180/240/300px, controls work, full name tooltip available');
    } finally {
        await browser.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
