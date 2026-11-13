// SPDX-License-Identifier: MIT
import React from 'react';
export const LabelType = { TAG: 'tag' };
export const Source = { MANUAL: 'manual' };
export const switchPlay = () => ({ type: 'STOP' });
export const changeFrameAsync = () => ({ type: 'FRAME' });
export const fetchAnnotationsAsync = () => ({ type: 'FETCH' });
export const saveAnnotationsAsync = () => async (): Promise<void> => {
    const state = (window as any).phaseTest;
    state.saves++;
    if (state.failSave) throw new Error('Save failed');
    state.saved = [...state.tags];
};
export default function Range(): JSX.Element { return <div>Range preview</div>; }
