// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const noop = () => {};
const notifications = [];
let post;
const core = {
    classes: {
        MLModel: class { constructor(data) { Object.assign(this, data); this.params = { canvas: {
            minPosVertices: data.min_pos_points, minNegVertices: data.min_neg_points, startWithBox: false,
        } }; } },
        ObjectState: class { constructor(data) { Object.assign(this, data); } },
    },
    plugins: { register: noop }, config: { backendAPI: '/api' },
    enums: { Source: { SEMI_AUTO: 'semi-auto' } },
    utils: { mask2Rle: () => [0, 4] },
};
let mapped;
const requireMock = (name) => {
    if (name === 'react') return React;
    if (name === 'lodash') return require('lodash');
    if (name === 'axios') return { post: (...args) => post(...args) };
    if (name === 'react-redux') return { connect: (map) => { mapped = map; return (c) => c; } };
    if (name === 'cvat-core-wrapper') return { getCore: () => core,
        ModelKind: { INTERACTOR: 'interactor' }, ShapeType: { MASK: 'mask', POLYGON: 'polygon' },
        ObjectType: { SHAPE: 'shape' } };
    if (name === 'cvat-canvas-wrapper') return {
        convertShapesForInteractor: (shapes, kind, button) => shapes.filter(
            (s) => s.shapeType === kind && s.button === button,
        ).map((s) => s.points),
    };
    if (name === 'reducers') return { ActiveControl: { AI_TOOLS: 'ai' } };
    if (name === './handle-popover-visibility') return (c) => c;
    if (name === 'antd/lib/message') return { loading: () => noop, info: noop };
    if (name === 'antd/lib/notification') return { error: (e) => notifications.push(e) };
    return new Proxy(noop, { get: () => noop });
};
const source = fs.readFileSync('cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true,
} });
const api = { exports: {} };
new Function('require', 'exports', 'module', compiled.outputText)(requireMock, api.exports, api);
function fixture() {
    const created = [], previews = [];
    const props = {
        sam1: true, interactors: [new core.classes.MLModel({ id: 'builtin-sam1', min_pos_points: 1, min_neg_points: 0 })],
        trackers: [], labels: [{ id: 1 }], frame: 7, activeLabelID: 1, curZOrder: 0,
        jobInstance: { id: 3 }, isActivated: true, defaultApproxPolyAccuracy: 10,
        canvasInstance: { interact: (p) => previews.push(p), cancel: noop },
        createAnnotations: (states) => created.push(...states), onInteractionStart: noop,
    };
    const component = new api.exports.ToolsControlComponent(props);
    component.setState = (state) => Object.assign(component.state, state);
    component.receivePointsFromMask = async () => [[2, 3], [3, 3], [3, 4], [2, 4]];
    component.approximateResponsePoints = async (points) => points;
    return { component, props, created, previews };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
test('left and right mouse prompts reach SAM1; mask is default and polygon is selectable', async () => {
    const { component, created, previews } = fixture();
    let request;
    post = async (...args) => { request = args; return { data: { mask: [[1, 1], [1, 1]], bounds: [2, 3, 3, 4] } }; };
    component.onInteraction({ detail: { shapesUpdated: true, isDone: false, shapes: [
        { shapeType: 'points', button: 0, points: [2, 3] },
        { shapeType: 'points', button: 2, points: [5, 6] },
    ] } });
    await tick();
    assert.equal(request[0], '/api/jobs/3/sam1');
    assert.deepEqual(request[1].pos_points, [[2, 3]]);
    assert.deepEqual(request[1].neg_points, [[5, 6]]);
    assert.equal(request[1].frame, 7);
    assert.equal(previews.at(-1).intermediateShape.shapeType, 'mask');
    await component.constructFromPoints();
    assert.equal(created[0].shapeType, 'mask');
    assert.deepEqual(created[0].points, [0, 4, 2, 3, 3, 4]);
    component.state.convertMasksToPolygons = true;
    await component.constructFromPoints();
    assert.equal(created[1].shapeType, 'polygon');
    assert.equal(created[1].frame, 7);
    assert.deepEqual(notifications, []);
});
test('cancelling while inference is pending discards the late preview', async () => {
    const { component, previews, created } = fixture();
    let resolve;
    post = () => new Promise((done) => { resolve = done; });
    component.onInteraction({ detail: { shapesUpdated: true, isDone: false,
        shapes: [{ shapeType: 'points', button: 0, points: [2, 3] }] } });
    await component.cancelListener();
    resolve({ data: { mask: [[1, 1], [1, 1]], bounds: [2, 3, 3, 4] } });
    await tick();
    assert.deepEqual(previews, []);
    assert.deepEqual(created, []);
});
test('SAM1 and other AI tools never consume the same canvas interaction', () => {
    const state = { annotation: {
        job: { instance: {}, labels: [] }, canvas: { instance: {}, activeControl: 'ai' },
        player: { frame: { number: 0, data: { deleted: false } } },
        annotations: { zLayer: { cur: 0 }, states: [] }, drawing: { activeInteractor: { id: 'builtin-sam1' } },
    }, models: { interactors: [], detectors: [], trackers: [] },
    settings: { workspace: {} }, plugins: { components: { aiTools: { interactors: { extras: [] } } } } };
    assert.equal(mapped(state, { sam1: true }).isActivated, true);
    assert.equal(mapped(state, {}).isActivated, false);
    state.annotation.drawing.activeInteractor.id = 'other';
    assert.equal(mapped(state, { sam1: true }).isActivated, false);
    assert.equal(mapped(state, {}).isActivated, true);
});
test('rapid prompts skip the obsolete response and show only the newest mask', async () => {
    const { component, previews } = fixture();
    const pending = [];
    post = () => new Promise((resolve) => pending.push(resolve));
    const positive = { shapeType: 'points', button: 0, points: [2, 3] };
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive] } });
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive,
        { shapeType: 'points', button: 2, points: [5, 6] }] } });
    pending[0]({ data: { mask: [[1, 1], [1, 1]], bounds: [2, 3, 3, 4] } });
    await tick();
    assert.equal(previews.length, 0);
    assert.equal(pending.length, 2);
    pending[1]({ data: { mask: [[1, 1], [1, 1]], bounds: [4, 5, 5, 6] } });
    await tick();
    assert.deepEqual(previews[0].intermediateShape.points, [0, 4, 4, 5, 5, 6]);
});
test('a failed refinement cannot commit the previous mask', async () => {
    const { component, created } = fixture();
    const shapes = [{ shapeType: 'points', button: 0, points: [2, 3] }];
    post = async () => ({ data: { mask: [[1, 1], [1, 1]], bounds: [2, 3, 3, 4] } });
    component.onInteraction({ detail: { shapesUpdated: true, shapes } });
    await tick();
    post = async () => { throw new Error('service unavailable'); };
    component.onInteraction({ detail: { shapesUpdated: true, shapes } });
    await tick();
    component.onInteraction({ detail: { isDone: true, shapes } });
    assert.deepEqual(created, []);
});
test('failed superseded inference resumes with the latest complete prompt set', async () => {
    const { component, previews } = fixture();
    const pending = [];
    const beforeErrors = notifications.length;
    post = (_url, data) => new Promise((resolve, reject) => pending.push({ data, resolve, reject }));
    const positive = { shapeType: 'points', button: 0, points: [2, 3] };
    const extra = { shapeType: 'points', button: 0, points: [4, 5] };
    const negative = { shapeType: 'points', button: 2, points: [6, 7] };
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive] } });
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive, extra] } });
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive, extra, negative] } });
    // Removing a point while pending must also replace the queued prompt set.
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive, negative] } });
    assert.equal(pending.length, 1);
    pending[0].reject(new Error('interrupted request'));
    await tick();
    assert.equal(pending.length, 2);
    assert.deepEqual(pending[1].data.pos_points, [[2, 3]]);
    assert.deepEqual(pending[1].data.neg_points, [[6, 7]]);
    assert.equal(component.state.fetching, true);
    assert.equal(notifications.length, beforeErrors);
    pending[1].resolve({ data: { mask: [[1, 1], [1, 1]], bounds: [4, 5, 5, 6] } });
    await tick();
    assert.equal(previews.length, 1);
    assert.deepEqual(previews[0].intermediateShape.points, [0, 4, 4, 5, 5, 6]);
    assert.equal(component.state.fetching, false);
});
test('batched React state does not allow overlapping inference requests', async () => {
    const { component, previews } = fixture();
    const updates = [], pending = [];
    component.setState = (state) => updates.push(state);
    post = (_url, data) => new Promise((resolve) => pending.push({ data, resolve }));
    const positive = { shapeType: 'points', button: 0, points: [2, 3] };
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive] } });
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive,
        { shapeType: 'points', button: 0, points: [4, 5] }] } });
    assert.equal(pending.length, 1);
    pending[0].resolve({ data: { mask: [[1, 1], [1, 1]], bounds: [2, 3, 3, 4] } });
    await tick();
    assert.equal(pending.length, 2);
    assert.equal(previews.length, 0);
    pending[1].resolve({ data: { mask: [[1, 1], [1, 1]], bounds: [4, 5, 5, 6] } });
    await tick();
    assert.equal(previews.length, 1);
    assert.deepEqual(updates.at(-1), { fetching: false });
});
test('Escape drops queued prompts even if the running request fails', async () => {
    const { component, previews } = fixture();
    let reject, requests = 0;
    post = () => { requests += 1; return new Promise((_resolve, fail) => { reject = fail; }); };
    const positive = { shapeType: 'points', button: 0, points: [2, 3] };
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive] } });
    component.onInteraction({ detail: { shapesUpdated: true, shapes: [positive,
        { shapeType: 'points', button: 0, points: [4, 5] }] } });
    const beforeErrors = notifications.length;
    await component.cancelListener();
    reject(new Error('interrupted request'));
    await tick();
    assert.equal(requests, 1);
    assert.deepEqual(previews, []);
    assert.equal(notifications.length, beforeErrors);
    assert.equal(component.state.fetching, false);
});
