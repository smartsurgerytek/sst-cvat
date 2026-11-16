// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../../cvat-ui/src/utils/phase-annotations.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const api = { exports: {} };
new Function('exports', 'module', compiled.outputText)(api.exports, api);
const { phaseFrames, planPhaseChange, planPhaseEdit, phaseRanges } = api.exports;

test('editing shrinks, extends and moves ranges while preserving retained tag attributes', () => {
    const tags = [10, 11, 12, 20].map(frame => ({ label_id: 1, frame, attributes: [{ value: 'custom' }] }));
    const original = { labelID: 1, start: 10, stop: 12 };
    assert.deepEqual(planPhaseEdit(tags, original, [11, 12], 1), { removed: [tags[0]], missing: [] });
    assert.deepEqual(planPhaseEdit(tags, original, [10, 11, 12, 13], 1), { removed: [], missing: [13] });
    assert.deepEqual(planPhaseEdit(tags, original, [19, 20], 1), { removed: tags.slice(0, 3), missing: [19] });
    assert.deepEqual(planPhaseEdit(tags, original, [10, 11, 12], 1), { removed: [], missing: [] });
});

test('changing phase preserves other ranges and avoids duplicating overlapping target tags', () => {
    const tags = [
        { label_id: 1, frame: 10 }, { label_id: 1, frame: 11 }, { label_id: 1, frame: 20 },
        { label_id: 2, frame: 11 }, { label_id: 3, frame: 10 },
    ];
    assert.deepEqual(planPhaseEdit(tags, { labelID: 1, start: 10, stop: 11 }, [10, 11, 12], 2), {
        removed: tags.slice(0, 2), missing: [10, 12],
    });
});

test('phase range includes endpoints and skips deleted and excluded frames', () => {
    assert.deepEqual(phaseFrames(10, 15, 10, 20, [10, 11, 13, 14, 15, 20], { 13: true }), [10, 11, 14, 15]);
    assert.deepEqual(phaseFrames(10, 10, 10, 20, [10], {}), [10]);
});

test('invalid ranges are rejected, not silently clamped', () => {
    for (const [start, stop] of [[null, 12], [10, null], [9, 12], [10, 21], [12, 11], [10.5, 12], [NaN, 12]]) {
        assert.throws(() => phaseFrames(start, stop, 10, 20, [10, 11, 12], {}));
    }
});

test('adding is idempotent and removal targets only the selected phase and frames', () => {
    const tags = [
        { label_id: 1, frame: 10, clientID: 1 },
        { label_id: 1, frame: 10, clientID: 2 },
        { label_id: 2, frame: 11, clientID: 3 },
        { label_id: 1, frame: 15, clientID: 4 },
    ];
    const plan = planPhaseChange(tags, [10, 11, 12], 1);
    assert.deepEqual(plan.missing, [11, 12]);
    assert.deepEqual(plan.existing, tags.slice(0, 2));
    assert.equal(tags.length, 4);
});

test('range summary handles unsorted tags, duplicates, gaps and overlapping phases', () => {
    assert.deepEqual(phaseRanges([
        { label_id: 1, frame: 12 }, { label_id: 1, frame: 10 },
        { label_id: 1, frame: 11 }, { label_id: 1, frame: 11 },
        { label_id: 1, frame: 14 }, { label_id: 2, frame: 11 },
    ]), [
        { labelID: 1, start: 10, stop: 12 },
        { labelID: 2, start: 11, stop: 11 },
        { labelID: 1, start: 14, stop: 14 },
    ]);
    assert.deepEqual(phaseRanges([]), []);
});
