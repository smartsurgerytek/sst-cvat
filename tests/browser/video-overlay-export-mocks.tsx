// SPDX-License-Identifier: MIT
import React from 'react';

export const getCore = (): unknown => ({ config: { backendAPI: 'http://cvat-export.test/api' } });
export const switchPlay = (): unknown => ({ type: 'STOP' });
export const saveAnnotationsAsync = () => async (): Promise<void> => {
    const state = (window as any).exportTest;
    state.saves++;
    if (state.failSave) throw new Error('Save failed');
};

export default function Range({ value, onChange, disabled }: {
    value: [number, number]; onChange(range: [number, number]): void; disabled: boolean;
}): JSX.Element {
    return (
        <>
            <input aria-label='Export start' type='number' disabled={disabled} value={value[0]}
                onChange={(event) => onChange([+event.target.value, value[1]])} />
            <input aria-label='Export stop' type='number' disabled={disabled} value={value[1]}
                onChange={(event) => onChange([value[0], +event.target.value])} />
        </>
    );
}
