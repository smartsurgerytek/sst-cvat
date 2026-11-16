// SPDX-License-Identifier: MIT
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import LabelItem from '../../cvat-ui/src/components/annotation-page/standard-workspace/objects-side-bar/label-item';
import LabelSelector from '../../cvat-ui/src/components/label-selector/label-selector';
function Fixture(): JSX.Element {
    const [locked, setLocked] = useState(false);
    const [hidden, setHidden] = useState(false);
    const names = ['Short', 'blood-obscured view', 'A very long label name with additional detail', 'UnbrokenLabel'.repeat(12)];
    return (
        <div id='sidebar' style={{ width: 300 }}>
            {names.map(name => (
                <LabelItem key={name} labelName={name} labelColor='#e33' visible
                    statesLocked={locked} statesHidden={hidden}
                    lockStates={() => setLocked(true)} unlockStates={() => setLocked(false)}
                    hideStates={() => setHidden(true)} showStates={() => setHidden(false)} />
            ))}
            <div style={{ width: '50%' }}>
                <LabelSelector labels={[{ id: 1, name: names[3] }]} value={1} onChange={() => {}}
                    size='small' className='cvat-objects-sidebar-state-item-label-selector' />
            </div>
            <output id='locked'>{String(locked)}</output>
            <output id='hidden'>{String(hidden)}</output>
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
