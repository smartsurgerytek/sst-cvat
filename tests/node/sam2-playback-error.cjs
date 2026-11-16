// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../cvat-ui/src/utils/sam2-playback-error.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
});
const api = { exports: {} };
new Function('require', 'exports', 'module', compiled.outputText)(require, api.exports, api);
const { playbackErrorMessage } = api.exports;

function failure(data) {
    return {
        isAxiosError: true,
        config: { url: '/api/jobs/1/original-video/segments/0?org=example' },
        response: { status: 400, data },
        message: 'Request failed with status code 400',
    };
}

test('shows DRF error from blob segment response and identifies the endpoint', async () => {
    assert.equal(await playbackErrorMessage(failure(new Blob(['["Could not decode this video segment"]']))),
        'HTTP 400 · /api/jobs/1/original-video/segments/0: Could not decode this video segment');
});

test('handles JSON detail, text and missing response bodies', async () => {
    assert.match(await playbackErrorMessage(failure({ detail: 'Invalid segment' })), /: Invalid segment$/);
    assert.match(await playbackErrorMessage(failure(new Blob(['Encoder failed']))), /: Encoder failed$/);
    assert.match(await playbackErrorMessage(failure(undefined)), /: Request failed with status code 400$/);
    assert.equal(await playbackErrorMessage(new Error('Playback cancelled')), 'Error: Playback cancelled');
});

test('preserves the original request error if reading the blob fails', async () => {
    const blob = new Blob([]);
    blob.text = async () => { throw new Error('Read failed'); };
    assert.match(await playbackErrorMessage(failure(blob)), /: Request failed with status code 400$/);
});
