// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import InputNumber from 'antd/lib/input-number';
import Space from 'antd/lib/space';
import Typography from 'antd/lib/typography';
import { getCore, Job } from 'cvat-core-wrapper';

export default function VideoExportPreview({
    job, range, opacity, showNames, showLegend,
}: {
    job: Job; range: [number, number]; opacity: number; showNames: boolean; showLegend: boolean;
}): JSX.Element {
    const [selectedFrame, setSelectedFrame] = useState(range[0]);
    const frame = Math.max(range[0], Math.min(selectedFrame, range[1]));
    const [revision, setRevision] = useState(0);
    const [url, setURL] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        let objectURL = '';
        setLoading(true);
        setError('');
        setURL('');
        const timer = window.setTimeout(async () => {
            try {
                const objects = await job.annotations.get(frame, false, []);
                if (controller.signal.aborted) return;
                const shapes = objects.filter((object) => object.objectType !== 'tag' && !object.outside);
                const tags = objects.filter((object) => object.objectType === 'tag');
                const { data } = await Axios.post<Blob>(
                    `${getCore().config.backendAPI}/jobs/${job.id}/overlay-video/preview`, {
                        frame,
                        start_frame: range[0],
                        stop_frame: range[1],
                        opacity: opacity / 100,
                        show_names: showNames,
                        show_legend: showLegend,
                        show_phase: true,
                        shapes: shapes.map((object) => ({
                            id: object.serverID ?? object.clientID,
                            ...(object.objectType === 'track' ? { track_id: object.serverID ?? object.clientID } : {}),
                            frame,
                            label_id: object.label.id,
                            type: object.shapeType,
                            points: object.points,
                            rotation: object.rotation,
                            z_order: object.zOrder,
                        })),
                        tags: tags.map((object) => ({ frame, label_id: object.label.id })),
                    }, { signal: controller.signal, responseType: 'blob', timeout: 60000 },
                );
                if (controller.signal.aborted) return;
                objectURL = URL.createObjectURL(data);
                setURL(objectURL);
            } catch (reason) {
                if (!controller.signal.aborted) {
                    let message = reason instanceof Error ? reason.message : String(reason);
                    if (Axios.isAxiosError(reason) && reason.response?.data instanceof Blob) {
                        message = await reason.response.data.text();
                    }
                    if (!controller.signal.aborted) setError(message);
                }
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        }, 250);
        return () => {
            controller.abort();
            window.clearTimeout(timer);
            if (objectURL) URL.revokeObjectURL(objectURL);
        };
    }, [job, frame, range[0], range[1], opacity, showNames, showLegend, revision]);
    return (
        <Space direction='vertical' style={{ width: '100%' }}>
            <Space wrap>
                <Typography.Text strong>A + B preview</Typography.Text>
                <Typography.Text>Frame</Typography.Text>
                <InputNumber
                    aria-label='Preview frame'
                    min={range[0]}
                    max={range[1]}
                    precision={0}
                    value={frame}
                    onChange={(value) => { if (value !== null) setSelectedFrame(value); }}
                />
                <Button onClick={() => setRevision((value) => value + 1)}>Refresh preview</Button>
            </Space>
            <div style={{
                background: '#181b21', minHeight: 180, textAlign: 'center', borderRadius: 6,
            }}
            >
                {loading && <Typography.Text style={{ color: '#fff' }}>Updating preview…</Typography.Text>}
                {url && <img src={url} alt={`A + B export preview · Frame ${frame}`} style={{ width: '100%' }} />}
            </div>
            {error && <Alert type='error' showIcon message='Could not load export preview' description={error} />}
            <Typography.Text type='secondary'>
                Preview includes current annotations and phases. Adjust opacity, names, or legend to update it.
                Choose a frame with annotations to see the overlay.
            </Typography.Text>
        </Space>
    );
}
