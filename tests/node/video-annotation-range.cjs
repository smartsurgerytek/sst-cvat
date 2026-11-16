// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../cvat-ui/src/utils/video-annotation-range.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const api = { exports: {} };
new Function('exports', 'module', compiled.outputText)(api.exports, api);
const { constrainVideoRange } = api.exports;

test('both endpoints and the whole range can move', () => {
    assert.deepEqual(constrainVideoRange([20, 100], [10, 100], 0, 999, 300, 1), [20, 100]);
    assert.deepEqual(constrainVideoRange([10, 120], [10, 100], 0, 999, 300, 1), [10, 120]);
    assert.deepEqual(constrainVideoRange([30, 120], [10, 100], 0, 999, 300, 1), [30, 120]);
});
test('SAM2 keeps inclusive frame count within limit whichever endpoint moves', () => {
    assert.deepEqual(constrainVideoRange([0, 500], [300, 500], 0, 999, 300, 1), [0, 299]);
    assert.deepEqual(constrainVideoRange([0, 500], [0, 200], 0, 999, 300, 1), [201, 500]);
});
test('crossing handles and boundary inputs retain a valid SAM2 range', () => {
    for (const next of [[999, 200], [100, 0], [-10, 5000], [20, 20]]) {
        const [start, stop] = constrainVideoRange(next, [100, 200], 10, 999, 300, 1);
        assert.ok(start >= 10 && stop <= 999 && start < stop && stop - start < 300);
    }
});
test('phase supports one-frame ranges and a one-frame job', () => {
    assert.deepEqual(constrainVideoRange([25, 25], [10, 100], 0, 999, 1000), [25, 25]);
    assert.deepEqual(constrainVideoRange([5, 5], [5, 5], 5, 5, 1), [5, 5]);
});
