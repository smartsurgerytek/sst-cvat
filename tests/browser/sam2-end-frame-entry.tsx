import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerOriginalVideo } from '../../cvat-core/src/original-video';
import EndFrame from '../../cvat-ui/src/components/annotation-page/top-bar/sam2-end-frame';
const source = { id: 'end-frame-test', project_id: 1, filename: 'test', url: '/video.mp4', duration: 8,
    timestamps: [0, 0.1, 0.3, 0.6, 1.1, 2, 3, 4.5, 6, 7.5] };
registerOriginalVideo(123, source);
const job: any = { id: 123, stopFrame: 9, frames: { get: async (frame: number) => ({ data: async () => {
    await new Promise(resolve => setTimeout(resolve, frame === 4 ? 250 : 10));
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    canvas.getContext('2d')!.fillStyle = `rgb(${frame * 20}, 0, 0)`;
    canvas.getContext('2d')!.fillRect(0, 0, 32, 18);
    return { imageData: await createImageBitmap(canvas) };
} }) } };
function Test(): JSX.Element {
    const [stop, setStop] = useState(3);
    return <EndFrame job={job} start={1} stop={stop} disabled={false} onChange={setStop} />;
}
createRoot(document.getElementById('root')!).render(<Test />);
