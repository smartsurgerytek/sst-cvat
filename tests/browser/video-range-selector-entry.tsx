// SPDX-License-Identifier: MIT
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import VideoRangeSelector from '../../cvat-ui/src/components/annotation-page/top-bar/video-range-selector';

let decoding = false;
let superseded = false;

const job = {
    id: 1, startFrame: 0, stopFrame: 500,
    frames: {
        get: async (frame: number) => ({
            data: async () => {
                if (frame === 80 && !superseded) { superseded = true; throw frame; }
                if (decoding) throw new Error('Concurrent preview requests share the job decoder');
                decoding = true;
                await new Promise((resolve) => setTimeout(resolve, 25));
                const canvas = document.createElement('canvas');
                canvas.width = 640; canvas.height = 360;
                const context = canvas.getContext('2d')!;
                context.fillStyle = `hsl(${frame % 360} 35% 25%)`;
                context.fillRect(0, 0, 640, 360);
                context.fillStyle = 'white'; context.font = '36px sans-serif';
                context.fillText(`Frame ${frame}`, 180, 190);
                const imageData = await createImageBitmap(canvas);
                decoding = false;
                return { imageData };
            },
        }),
    },
};

function Fixture(): JSX.Element {
    const [value, setValue] = useState<[number, number]>([20, 80]);
    const [sam2, setSAM2] = useState(false);
    const [mainFrame, setMainFrame] = useState(20);
    const [selected, setSelected] = useState(false);
    return (
        <div style={{ maxWidth: 740, margin: '30px auto', fontFamily: 'sans-serif' }}>
            <h2>{sam2 ? 'SAM2 · BBox / Segmentation' : 'Phase · Blood-Obscured View'}</h2>
            <VideoRangeSelector
                job={job as any}
                value={value}
                startObjects={sam2 ? (selected ? [{
                    clientID: 42, serverID: 42, shapeType: 'mask', points: [1, 2, 1, 20, 30, 21, 31],
                    label: { color: '#ff0000', name: 'Seed' }, frame: value[0],
                } as any] : []) : undefined}
                onChange={setValue}
                onEndFrameCommit={setMainFrame}
                minGap={sam2 ? 1 : 0}
                maxFrames={sam2 ? 300 : 501}
            />
            <button type='button' onClick={() => setSelected(!selected)}>Toggle seed</button>
            <output id='main-frame'>{mainFrame}</output>
            <output id='range'>{JSON.stringify(value)}</output>
            <button type='button' onClick={() => setSAM2(true)}>SAM2 mode</button>
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
