// SPDX-License-Identifier: MIT
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { applyMiddleware, createStore } from 'redux';
import VideoOverlayExport from '../../cvat-ui/src/components/annotation-page/top-bar/video-overlay-export';

(window as any).exportTest = { saves: 0, failSave: true };
const thunk = (store: any) => (next: any) => (action: any): any => (
    typeof action === 'function' ? action(store.dispatch, store.getState) : next(action)
);
const store = createStore(() => ({}), applyMiddleware(thunk));
createRoot(document.getElementById('root')!).render(
    <Provider store={store}>
        <VideoOverlayExport job={{ id: 4, startFrame: 10, stopFrame: 30 } as any} />
    </Provider>,
);
