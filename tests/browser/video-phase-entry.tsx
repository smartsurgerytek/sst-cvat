// SPDX-License-Identifier: MIT
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { applyMiddleware, createStore } from 'redux';
import VideoPhase from '../../cvat-ui/src/components/annotation-page/top-bar/video-phase';
const state = { saves: 0, failSave: true, tags: [] as any[], saved: [] as any[] };
(window as any).phaseTest = state;
const thunk = (store: any) => (next: any) => (action: any): any => (
    typeof action === 'function' ? action(store.dispatch, store.getState) : next(action)
);
const store = createStore(() => ({ annotation: {
    player: { frame: { number: 10 } },
    job: {
        labels: [{ id: 1, name: 'Phase A', type: 'tag', attributes: [] }],
        meta: { deletedFrames: {} }, frameNumbers: [10, 11, 12],
    },
} }), applyMiddleware(thunk));
const job = { id: 1, startFrame: 10, stopFrame: 12, annotations: {
    export: async () => ({ tags: state.tags }),
    commit: async (added: any, removed: any) => {
        state.tags = state.tags.filter(tag => !removed.tags.includes(tag)).concat(added.tags);
    },
} };
createRoot(document.getElementById('root')!).render(
    <Provider store={store}><VideoPhase job={job as any} /></Provider>,
);
