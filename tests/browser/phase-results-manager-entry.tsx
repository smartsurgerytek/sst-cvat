// SPDX-License-Identifier: MIT
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import PhaseResultsManager, {
    PhaseRange,
} from '../../cvat-ui/src/components/annotation-page/top-bar/phase-results-manager';

function Fixture(): JSX.Element {
    const [ranges, setRanges] = useState<PhaseRange[]>([
        { labelID: 1, start: 10, stop: 20 },
        { labelID: 1, start: 30, stop: 40 },
        { labelID: 2, start: 15, stop: 25 },
    ]);
    const [action, setAction] = useState('');
    return (
        <>
            <PhaseResultsManager
                ranges={ranges}
                labels={[{ id: 1, name: 'Phase A', color: '#ff0000' }, { id: 2, name: 'Phase B', color: '#0000ff' }]}
                frame={12}
                busy={false}
                firstFrame={0}
                lastFrame={100}
                onEdit={async (original, updated) => {
                    setAction(`edit:${original.labelID}:${original.start}:${original.stop}:${updated.labelID}:${updated.start}:${updated.stop}`);
                    setRanges(ranges.map((range) => (range === original ? updated : range)));
                    return true;
                }}
                onRefresh={() => setAction('refresh')}
                onSelect={(range) => setAction(`preview:${range.labelID}:${range.start}:${range.stop}`)}
                onNavigate={(frame) => setAction(`navigate:${frame}`)}
                onRemove={async (selected) => {
                    setAction(`delete:${selected.labelID}:${selected.start}:${selected.stop}`);
                    setRanges(ranges.filter((range) => range !== selected));
                }}
            />
            <output id='action'>{action}</output>
        </>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
