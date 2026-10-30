import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerOriginalVideo, originalVideoFrame } from '../../cvat-core/src/original-video';
import { cachedVideoRanges } from '../../cvat-core/src/video-segments';
import Playback from '../../cvat-ui/src/components/annotation-page/top-bar/sam2-video-playback';
const source = { id: 'overlay-test', project_id: 1, filename: 'test', url: '/video.mp4', duration: 12,
    timestamps: Array.from({ length: 300 }, (_, i) => i / 25) };
function Test(): JSX.Element {
    const [parameters, setParameters] = useState({ one: { threshold: null as number | null, radius: 0, curve: 0, iterations: 0 } });
    const [opacity, setOpacity] = useState(0.5);
    const [hidden, setHidden] = useState<string[]>([]);
    const [playing, setPlaying] = useState(true);
    return <>
        <button onClick={() => setPlaying(false)}>Pause</button>
        <button onClick={() => setPlaying(true)}>Play</button>
        <button onClick={() => setParameters({ one: { threshold: null, radius: 0, curve: 0, iterations: 0 } })}>Reset</button>
        <button onClick={() => setParameters({ one: { threshold: null, radius: 0, curve: 2, iterations: 2 } })}>Curve</button>
        <button onClick={() => setParameters({ one: { threshold: 10, radius: 0, curve: 0, iterations: 0 } })}>Threshold</button>
        <button onClick={() => setParameters({ one: { threshold: 10, radius: 2, curve: 0, iterations: 0 } })}>Smooth</button>
        <button onClick={() => setParameters({ one: { threshold: null, radius: 0, curve: 2, iterations: 0 } })}>Sampling</button>
        <button onClick={() => setParameters({ one: { threshold: null, radius: 0, curve: 2, iterations: 5 } })}>Passes</button>
        <button onClick={() => setOpacity(0.2)}>Opacity</button>
        <button onClick={() => setHidden(['one'])}>Hide</button>
        <Playback source={source} endpoint='/playback' masksEndpoint='/masks' startFrame={0} stopFrame={299}
            frame={0} playing={playing} parameters={parameters} hidden={hidden} opacity={opacity}
            onFrame={() => {}} onStop={() => {}} />
    </>;
}
(window as any).warmMain = async () => {
    registerOriginalVideo(4, source);
    (await originalVideoFrame(4, 0)).imageData.close();
};
(window as any).mainCacheReady = () => cachedVideoRanges(source).length === 3;
(window as any).startOverlay = () => createRoot(document.getElementById('root')!).render(<Test />);
