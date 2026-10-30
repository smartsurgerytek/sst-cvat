// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function setup(timestamps = Array.from({ length: 1001 }, (_, i) => i / 25)) {
    const file = fs.readFileSync('cvat-ui/src/containers/annotation-page/top-bar/top-bar.tsx', 'utf8');
    // Exercise the actual controller with a deterministic clock and no Redux or DOM.
    const source = file.slice(file.indexOf('class AnnotationTopBarContainer'), file.indexOf('export default withRouter'));
    let now = 0;
    const timers = [];
    const changes = [];
    const video = { timestamps, duration: timestamps.at(-1) + 0.04 };
    const context = {
        React: { PureComponent: class { constructor(props) { this.props = props; } }, createRef: () => ({}) },
        performance: { now: () => now },
        setTimeout: (callback, delay) => timers.push({ callback, delay }),
        originalVideoSource: () => video,
        videoFrameAtTime: (times, time) => Math.max(0, times.findLastIndex(value => value <= time + 0.000001)),
        FrameSpeed: { Usual: 25 }, isAbleToChangeFrame: () => true,
    };
    vm.createContext(context);
    vm.runInContext(ts.transpileModule(`${source}\nglobalThis.Controller = AnnotationTopBarContainer;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
    }).outputText, context);
    const props = { playing: true, canvasIsReady: true, frameFetching: false, frameNumber: 0,
        frameSpeed: 25, frameDelay: 0, jobInstance: { id: 4, stopFrame: timestamps.length - 1,
            frames: { search: async (_, next) => next } },
        onChangeFrame: frame => changes.push(frame), onSwitchPlay: playing => { props.playing = playing; } };
    const controller = new context.Controller(props);
    controller.componentDidUpdate({ ...props, playing: false });
    return { controller, props, timers, changes, advance: value => { now = value; },
        flush: async () => { timers.shift().callback(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('slow decoding catches up to elapsed video time instead of accumulating drift', async () => {
    const state = setup();
    assert.equal(state.timers[0].delay, 40);
    state.advance(200);
    await state.flush();
    assert.deepEqual(state.changes, [5]);
    state.props.frameNumber = 5;
    state.advance(1000);
    state.controller.componentDidUpdate(state.props);
    assert.equal(state.timers[0].delay, 0);
    await state.flush();
    assert.deepEqual(state.changes, [5, 25]);
});

test('variable frame rate uses presentation timestamps and stops at the final frame', async () => {
    const state = setup([0, 0.1, 0.15, 0.8, 1.2]);
    assert.equal(state.timers[0].delay, 100);
    state.advance(900);
    await state.flush();
    assert.deepEqual(state.changes, [3]);
    state.props.frameNumber = 4;
    state.advance(2000);
    state.controller.componentDidUpdate(state.props);
    await state.flush();
    assert.equal(state.props.playing, false);
});

test('pause cancels a pending advance; resume resets the time origin', async () => {
    const state = setup();
    state.props.playing = false;
    state.controller.componentDidUpdate({ ...state.props, playing: true });
    state.advance(5000);
    await state.flush();
    assert.deepEqual(state.changes, []);
    state.props.playing = true;
    state.controller.componentDidUpdate({ ...state.props, playing: false });
    assert(Math.abs(state.timers[0].delay - 40) < 0.001);
    state.advance(5040);
    await state.flush();
    assert.deepEqual(state.changes, [1]);
});

test('speed changes reset the clock and invalidate the old pending advance', async () => {
    const state = setup();
    state.props.frameSpeed = 50;
    state.controller.componentDidUpdate({ ...state.props, frameSpeed: 25 });
    await state.flush();
    assert.deepEqual(state.changes, []);
    assert.equal(state.timers[0].delay, 20);
    state.advance(100);
    await state.flush();
    assert.deepEqual(state.changes, [5]);
});
