// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react';
import Alert from 'antd/lib/alert';
import Slider from 'antd/lib/slider';
import Typography from 'antd/lib/typography';
import { Job } from 'cvat-core-wrapper';
import { originalVideoSource } from 'cvat-core/src/original-video';

export default function SAM2EndFrame({
    job, start, stop, disabled, onChange,
}: {
    job: Job; start: number; stop: number; disabled: boolean; onChange(frame: number): void;
}): JSX.Element {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [loaded, setLoaded] = useState<number | null>(null);
    const [error, setError] = useState('');
    const source = originalVideoSource(job.id);
    const label = (frame: number): string => (source ?
        `${source.timestamps[frame].toFixed(3)} s · frame ${frame}` : `Frame ${frame}`);
    useEffect(() => {
        let disposed = false;
        setError('');
        // Coalesce rapid dragging and ignore obsolete asynchronous decodes.
        const timer = window.setTimeout(() => {
            job.frames.get(stop).then((value) => value.data()).then(async (image) => {
                const bitmap = await createImageBitmap(image.imageData);
                try {
                    if (!disposed && canvas.current) {
                        canvas.current.width = bitmap.width;
                        canvas.current.height = bitmap.height;
                        canvas.current.getContext('2d')!.drawImage(bitmap, 0, 0);
                        setLoaded(stop);
                    }
                } finally {
                    bitmap.close();
                    if (source && image.imageData instanceof ImageBitmap) image.imageData.close();
                }
            }).catch((reason) => { if (!disposed) setError(String(reason)); });
        }, 100);
        return () => { disposed = true; window.clearTimeout(timer); };
    }, [job.id, stop]);
    return (
        <div>
            <Typography.Text>{`Starting: ${label(start)} · End: ${label(stop)}`}</Typography.Text>
            <Slider
                aria-label='SAM2 end frame'
                min={Math.min(start + 1, job.stopFrame)}
                max={Math.min(job.stopFrame, start + 299)}
                step={1}
                value={stop}
                disabled={disabled || start >= job.stopFrame}
                tooltip={{ formatter: (value) => label(value ?? stop) }}
                onChange={onChange}
            />
            <Typography.Paragraph type='secondary'>
                Drag to preview the final tracking frame. The starting frame and selected objects stay fixed.
            </Typography.Paragraph>
            {error && <Alert type='error' message='Could not load end-frame preview' description={error} />}
            <canvas
                ref={canvas}
                style={{
                    width: '100%',
                    maxHeight: 300,
                    objectFit: 'contain',
                    background: '#111',
                    opacity: loaded === stop ? 1 : 0.35,
                }}
            />
            <Typography.Text type='secondary'>
                {loaded === stop ? `Preview: ${label(stop)}` : 'Loading end-frame preview…'}
            </Typography.Text>
        </div>
    );
}
