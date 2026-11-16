// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const { chromium } = require(require.resolve('playwright-core', {
    paths: [process.env.CVAT_BROWSER_TEST_DEPS || process.cwd()],
}));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-range-ui-'));
(async () => {
    await new Promise((resolve, reject) => webpack({
        mode: 'development', devtool: false,
        entry: path.join(__dirname, 'video-range-selector-entry.tsx'),
        output: { path: directory, filename: 'range.js' },
        resolve: {
            extensions: ['.tsx', '.ts', '.js'],
            modules: [path.resolve(__dirname, '../../cvat-ui/src'), 'node_modules'],
            alias: {
                'cvat-core/src/original-video$': path.join(__dirname, 'video-range-source.ts'),
                'cvat-core-wrapper$': path.join(__dirname, 'video-range-core.ts'),
            },
        },
        module: { rules: [{ test: /\.tsx?$/, use: path.join(__dirname, 'typescript-loader.cjs') }] },
    }, (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString())) : resolve()));
    const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
        args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let tile;
        await page.route('http://cvat-preview.test/**', async route => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith('/scrub-preview')) {
                await route.fulfill({ json: {
                    state: 'ready', frames: Array.from({ length: 51 }, (_, i) => i * 10),
                    sheets: Array.from({ length: 51 }, (_, i) => `/sheet/${i}`), cell: 1, columns: 1, per_sheet: 1,
                } });
            } else if (url.pathname.startsWith('/sheet/')) {
                await route.fulfill({ contentType: 'image/png', body: tile });
            } else await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
        });
        await page.goto('http://cvat-preview.test/');
        tile = Buffer.from(await page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
            canvas.getContext('2d').fillRect(0, 0, 1, 1); return canvas.toDataURL().split(',')[1];
        }), 'base64');
        await page.addScriptTag({ content: fs.readFileSync(path.join(directory, 'range.js'), 'utf8') });
        await page.waitForFunction(() => document.querySelector('#range')?.textContent === '[20,80]');
        await page.getByText('Quick previews ready · Drag to preview nearby frames; release to load the exact frame.', { exact: true }).waitFor();
        const endInput = page.getByLabel('End frame', { exact: true });
        await endInput.fill('');
        await endInput.pressSequentially('8');
        assert.equal(await page.locator('#range').textContent(), '[20,80]', 'Partial input must not move either endpoint');
        await endInput.pressSequentially('9');
        assert.equal(await page.locator('#range').textContent(), '[20,80]', 'Typing must wait for confirmation');
        assert.equal(await page.locator('#main-frame').textContent(), '20', 'Typing must not navigate the main frame');
        await endInput.press('Enter');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[20,89]');
        assert.equal(await page.locator('#main-frame').textContent(), '89');
        await endInput.fill('');
        await endInput.blur();
        assert.equal(await endInput.inputValue(), '89', 'Empty input restores the committed frame');
        await endInput.fill('80');
        await endInput.press('Enter');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[20,80]');
        await endInput.fill('90');
        await endInput.blur();
        assert.equal(await page.locator('#range').textContent(), '[20,80]', 'Blur must not apply unconfirmed typing');
        assert.equal(await endInput.inputValue(), '80');
        const startInput = page.getByLabel('Start frame', { exact: true });
        await startInput.press('ArrowUp');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[21,80]');
        await page.waitForFunction(() => document.querySelector('canvas').dataset.frame === '21');
        await startInput.press('ArrowDown');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[20,80]');
        const startControl = startInput.locator('xpath=ancestor::*[contains(@class,"ant-input-number") and not(contains(@class,"input-wrap"))][1]');
        await startControl.locator('.ant-input-number-handler-up').click();
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[21,80]');
        await startControl.locator('.ant-input-number-handler-down').click();
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[20,80]');
        await endInput.press('ArrowUp');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[20,81]');
        assert.equal(await page.locator('#main-frame').textContent(), '81', 'Stepping the endpoint navigates immediately');
        await endInput.press('ArrowDown');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[20,80]');
        const handles = page.getByRole('slider');
        assert.equal(await handles.count(), 2);
        await handles.nth(0).focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[21,80]');
        await handles.nth(1).focus();
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[21,79]');
        // Pointer dragging, not just numeric inputs, moves the endpoint and its preview.
        const handle = await handles.nth(1).boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        const previewsDuringDrag = new Set();
        const mainBeforeDrag = await page.locator('#main-frame').textContent();
        for (let step = 1; step <= 12; step++) {
            await page.mouse.move(handle.x + handle.width / 2 + step * 8, handle.y + handle.height / 2);
            await page.waitForTimeout(45);
            previewsDuringDrag.add(await page.locator('canvas').nth(1).getAttribute('data-frame'));
        }
        assert.ok(previewsDuringDrag.size >= 3, 'Preview must update during drag: ' + await page.locator('.cvat-video-range-selector').innerText());
        assert.equal(await page.locator('canvas').nth(1).getAttribute('data-preview'), 'fast');
        assert.equal(await page.locator('#main-frame').textContent(), mainBeforeDrag, 'Dragging defers main navigation until release');
        await page.mouse.up();
        await page.waitForFunction(() => +document.querySelector('#main-frame').textContent ===
            JSON.parse(document.querySelector('#range').textContent)[1]);
        await page.waitForFunction(() => document.querySelectorAll('canvas')[1].dataset.preview === 'exact' &&
            +document.querySelectorAll('canvas')[1].dataset.frame === JSON.parse(document.querySelector('#range').textContent)[1]);
        assert.ok(JSON.parse(await page.locator('#range').textContent())[1] > 79);
        await page.getByLabel('Start frame', { exact: true }).fill('100');
        await page.getByLabel('Start frame', { exact: true }).press('Enter');
        await page.getByLabel('End frame', { exact: true }).fill('100');
        await page.getByLabel('End frame', { exact: true }).press('Enter');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[100,100]');
        await page.getByText('SAM2 mode', { exact: true }).click();
        await page.getByLabel('End frame', { exact: true }).fill('500');
        await page.getByLabel('End frame', { exact: true }).press('Enter');
        await page.waitForFunction(() => document.querySelector('#range').textContent === '[201,500]');
        await page.waitForFunction(() => [...document.querySelectorAll('canvas')]
            .map(c => c.dataset.frame).join(',') === '201,500');
        await page.getByLabel('End frame', { exact: true }).blur();
        await page.mouse.move(850, 600);
        await page.getByText('Toggle seed', { exact: true }).click();
        const overlay = page.getByLabel('Selected start-frame objects');
        assert.equal(await overlay.count(), 1, 'Only the start preview receives objects');
        assert.equal(await overlay.getAttribute('data-object-count'), '1');
        const mask = overlay.locator('image');
        assert.equal(await mask.getAttribute('x'), '20');
        assert.equal(await mask.getAttribute('y'), '30');
        assert.equal(await mask.getAttribute('width'), '2');
        const alpha = await mask.evaluate(async element => {
            const image = new Image(); image.src = element.getAttribute('href'); await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
            const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
            return [...context.getImageData(0, 0, 2, 2).data].filter((_, index) => index % 4 === 3);
        });
        assert.deepEqual(alpha, [0, 255, 255, 0], 'RLE preview retains mask geometry and transparent background');
        await page.getByText('Toggle seed', { exact: true }).click();
        assert.equal(await overlay.getAttribute('data-object-count'), '0');
        assert.equal(await overlay.locator('image').count(), 0, 'Unchecking removes overlay immediately');
        assert.deepEqual(errors, []);
        await page.screenshot({ path: '/tmp/sst-cvat-range-ui.png' });
        console.log('PASS: endpoint keyboard/pointer controls, phase single frame, SAM2 limit, live previews during pointer drag');
    } finally {
        await browser.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
