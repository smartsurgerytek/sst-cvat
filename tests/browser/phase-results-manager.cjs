// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-manager-ui-'));
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false,
        entry: path.join(__dirname, 'phase-results-manager-entry.tsx'),
        output: { path: directory, filename: 'manager.js' },
        resolve: { extensions: ['.tsx', '.ts', '.js'] },
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ path: path.join(directory, 'manager.js') });
        const rows = page.locator('tbody .ant-table-row');
        await page.getByText('3 annotated ranges', { exact: true }).waitFor();
        assert.equal(await rows.count(), 3);
        await page.getByLabel('Search phase annotations').fill('Phase B');
        assert.equal(await rows.count(), 1);
        await page.getByLabel('Search phase annotations').fill('');
        await page.getByText('Includes current frame 12', { exact: true }).click();
        assert.equal(await rows.count(), 1);
        await page.getByText('Includes current frame 12', { exact: true }).click();
        await rows.nth(1).getByRole('button', { name: '30', exact: true }).click();
        assert.equal(await page.locator('#action').textContent(), 'navigate:30');
        await rows.nth(1).getByRole('button', { name: 'Preview range' }).click();
        assert.equal(await page.locator('#action').textContent(), 'preview:1:30:40');
        await rows.nth(1).getByRole('button', { name: 'Edit range' }).click();
        assert.equal(await page.getByLabel('Edit phase start', { exact: true }).inputValue(), '30');
        assert.equal(await page.getByLabel('Edit phase stop', { exact: true }).inputValue(), '40');
        await page.getByLabel('Edit phase start', { exact: true }).fill('45');
        assert.equal(await page.getByRole('button', { name: 'Apply changes' }).isDisabled(), true);
        await page.getByRole('button', { name: 'Cancel editing' }).click();
        assert.equal(await page.locator('#action').textContent(), 'preview:1:30:40');
        await rows.nth(1).getByRole('button', { name: 'Edit range' }).click();
        await page.getByLabel('Edit phase start', { exact: true }).fill('32');
        await page.getByLabel('Edit phase stop', { exact: true }).fill('38');
        await page.locator('.ant-select-selector').click();
        await page.locator('.ant-select-item-option').filter({ hasText: 'Phase B' }).click();
        await page.getByRole('button', { name: 'Apply changes' }).click();
        await page.getByText('Edit Phase A: 30–40', { exact: true }).waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#action').textContent(), 'edit:1:30:40:2:32:38');
        assert.ok((await rows.nth(1).textContent()).includes('Phase B'));
        assert.equal(await rows.nth(1).getByRole('button', { name: '32', exact: true }).count(), 1);
        await rows.first().getByRole('button', { name: 'Remove range' }).click();
        await page.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(await rows.count(), 3);
        await rows.first().getByRole('button', { name: 'Remove range' }).click();
        await page.getByRole('button', { name: 'Remove this range', exact: true }).click();
        await page.getByText('2 annotated ranges', { exact: true }).waitFor();
        assert.equal(await page.locator('#action').textContent(), 'delete:1:10:20');
        assert.equal(await rows.count(), 2);
        assert.ok((await rows.allTextContents()).some(text => text.includes('Phase B')));
        await page.getByRole('button', { name: 'Refresh ranges' }).click();
        assert.equal(await page.locator('#action').textContent(), 'refresh');
        assert.deepEqual(errors, []);
        console.log('PASS: phase search, filter, jump, preview, range editing, validation, deletion and cancellation');
    } finally {
        await browser.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
