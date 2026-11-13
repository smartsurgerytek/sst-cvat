// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react';
import Alert from 'antd/lib/alert';
import InputNumber from 'antd/lib/input-number';
import Slider from 'antd/lib/slider';
import Space from 'antd/lib/space';
import Typography from 'antd/lib/typography';
import { Job, ObjectState } from 'cvat-core-wrapper';
import { originalVideoSource } from 'cvat-core/src/original-video';
import { constrainVideoRange } from 'utils/video-annotation-range';
import { prepareScrubPreview, ScrubPreview } from 'utils/scrub-preview';
import SeedPreviewOverlay from './seed-preview-overlay';

// CVAT has one active frame decoder per job. Serialize both endpoint previews.
const previewQueues = new Map<number, Promise<void>>();

function previewBitmap(job: Job, frame: number): Promise<ImageBitmap> {
    const previous = previewQueues.get(job.id) || Promise.resolve();
    const result = previous.then(async () => {
        // Other viewers (e.g. an existing SAM2 result) share this decoder too.
        // CVAT rejects superseded frame requests with the frame number.
        for (let attempt = 0; ; attempt++) {
            try {
                const image = await (await job.frames.get(frame)).data();
                const owned = Boolean(originalVideoSource(job.id)) && image.imageData instanceof ImageBitmap;
                try {
                    return await createImageBitmap(image.imageData);
                } finally {
                    if (owned) (image.imageData as ImageBitmap).close();
                }
            } catch (error) {
                if (error !== frame || attempt >= 3) throw error;
                await new Promise((resolve) => { window.setTimeout(resolve, (attempt + 1) * 150); });
            }
        }
    });
    const settled = result.then(() => {}, () => {});
    previewQueues.set(job.id, settled);
    settled.then(() => {
        if (previewQueues.get(job.id) === settled) previewQueues.delete(job.id);
    });
    return result;
}

function FramePreview({
    job, frame, fastPreview, scrubbing, objects,
}: {
    job: Job; frame: number; fastPreview: ScrubPreview | null; scrubbing: boolean; objects?: ObjectState[];
}): JSX.Element {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [loaded, setLoaded] = useState<number | null>(null);
    const [approximate, setApproximate] = useState(false);
    const [error, setError] = useState('');
    const requested = useRef({ frame, fastPreview, scrubbing });
    requested.current = { frame, fastPreview, scrubbing };
    const requestPreview = useRef<() => void>(() => {});
    useEffect(() => {
        let disposed = false;
        let running = false;
        let lastRequested = '';
        const key = (): string => `${requested.current.frame}:${Boolean(
            requested.current.scrubbing && requested.current.fastPreview,
        )}`;
        const isCurrent = (targetKey: string): boolean => !disposed && key() === targetKey;
        const renderLatest = async (): Promise<void> => {
            if (running || disposed) return;
            running = true;
            while (!disposed && lastRequested !== key() &&
                !(requested.current.scrubbing && requested.current.fastPreview)) {
                const target = requested.current;
                const currentKey = key();
                lastRequested = currentKey;
                const current = isCurrent.bind(null, currentKey);
                try {
                    const bitmap = await previewBitmap(job, target.frame);
                    try {
                        if (current() && canvas.current) {
                            const element = canvas.current;
                            element.width = bitmap.width;
                            element.height = bitmap.height;
                            element.getContext('2d')!.drawImage(bitmap, 0, 0);
                            element.dataset.frame = String(target.frame);
                            element.dataset.preview = 'exact';
                            setLoaded(target.frame);
                            setApproximate(false);
                            setError('');
                        }
                    } finally { bitmap.close(); }
                } catch (reason) {
                    if (current()) setError(String(reason));
                }
            }
            running = false;
        };
        requestPreview.current = () => {
            const target = requested.current;
            if (target.scrubbing && target.fastPreview && canvas.current) {
                lastRequested = '';
                const current = isCurrent.bind(null, key());
                target.fastPreview.draw(canvas.current, target.frame, current).then((sampled) => {
                    if (sampled !== undefined && current()) {
                        setLoaded(sampled);
                        setApproximate(true);
                        setError('');
                    }
                }).catch((reason) => { if (current()) setError(String(reason)); });
            } else renderLatest();
        };
        requestPreview.current();
        return () => { disposed = true; requestPreview.current = () => {}; };
    }, [job.id]);
    useEffect(() => { requestPreview.current(); }, [frame, scrubbing, fastPreview]);
    return (
        <div>
            <div style={{ position: 'relative', height: 220 }}>
                {objects && loaded === frame && !approximate && canvas.current && (
                    <SeedPreviewOverlay objects={objects} width={canvas.current.width} height={canvas.current.height} />
                )}
                <canvas
                    ref={canvas}
                    aria-label={`Frame ${frame} preview`}
                    style={{
                        width: '100%',
                        height: 220,
                        objectFit: 'contain',
                        background: '#111',
                        borderRadius: 6,
                        opacity: loaded === null ? 0.35 : 1,
                    }}
                />
            </div>
            {error ? <Alert type='error' message='Could not load the frame preview' description={error} /> : (
                <Typography.Text type='secondary'>
                    {loaded === null ? 'Loading preview…' : `${approximate ? 'Quick preview' : 'Exact preview'} · Frame ${loaded}`}
                    {approximate && !scrubbing ? ' · Loading exact frame…' : ''}
                </Typography.Text>
            )}
        </div>
    );
}

function FrameNumberInput({ value, onCommit, ...props }: {
    value: number;
    onCommit(value: number): number;
    min: number;
    max: number;
    disabled: boolean;
    'aria-label': string;
}): JSX.Element {
    const [draft, setDraft] = useState<number | null>(value);
    useEffect(() => setDraft(value), [value]);
    const commit = (next: number | null): void => {
        setDraft(next !== null && Number.isFinite(next) && next !== value ? onCommit(next) : value);
    };
    return (
        <InputNumber
            {...props}
            precision={0}
            value={draft}
            onChange={setDraft}
            changeOnBlur={false}
            onPressEnter={() => commit(draft)}
            onStep={commit}
            onBlur={() => setDraft(value)}
        />
    );
}

export default function VideoRangeSelector({
    job, value, onChange, disabled = false, maxFrames = job.stopFrame - job.startFrame + 1, minGap = 0,
    startObjects, onEndFrameCommit,
}: {
    job: Job;
    value: [number, number];
    onChange(value: [number, number]): void;
    disabled?: boolean;
    maxFrames?: number;
    minGap?: number;
    startObjects?: ObjectState[];
    onEndFrameCommit?(frame: number): void;
}): JSX.Element {
    const source = originalVideoSource(job.id);
    const [scrubbing, setScrubbing] = useState(false);
    const pendingRange = useRef<{ originalEnd: number; range: [number, number] } | null>(null);
    const [fastPreview, setFastPreview] = useState<ScrubPreview | null>(null);
    const [previewFailed, setPreviewFailed] = useState(false);
    const isVideo = Boolean(source) || job.mode === 'interpolation';
    useEffect(() => {
        setFastPreview(null);
        setPreviewFailed(false);
        if (!isVideo) return undefined;
        const controller = new AbortController();
        prepareScrubPreview(job.id, controller.signal).then((preview) => {
            if (!controller.signal.aborted) setFastPreview(preview);
        }).catch(() => { if (!controller.signal.aborted) setPreviewFailed(true); });
        return () => controller.abort();
    }, [job.id, isVideo]);
    let previewStatus = 'Preparing quick previews. The first load may take a moment…';
    if (previewFailed) previewStatus = 'Quick previews are unavailable. You can still select exact frames.';
    if (fastPreview) previewStatus = 'Quick previews ready · Drag to preview nearby frames; release to load the exact frame.';
    const label = (frame: number): string => {
        const time = source?.timestamps[frame];
        return time === undefined ? `Frame ${frame}` : `${time.toFixed(2)} s · Frame ${frame}`;
    };
    const update = (next: number[]): [number, number] => {
        const constrained = constrainVideoRange(next, value, job.startFrame, job.stopFrame, maxFrames, minGap);
        onChange(constrained);
        return constrained;
    };
    return (
        <div className='cvat-video-range-selector'>
            {isVideo && (
                <Typography.Paragraph type='secondary' className='cvat-scrub-preview-status'>
                    {previewStatus}
                </Typography.Paragraph>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {value.map((frame, index) => (
                    // Endpoint identity must stay stable while dragging.
                    <div key={index === 0 ? 'start' : 'stop'}>
                        <Typography.Text strong>{index === 0 ? 'Start' : 'End'}</Typography.Text>
                        <FramePreview
                            job={job}
                            frame={frame}
                            fastPreview={fastPreview}
                            scrubbing={scrubbing}
                            objects={index === 0 ? startObjects : undefined}
                        />
                        <Space wrap>
                            <Typography.Text>{label(frame)}</Typography.Text>
                            <FrameNumberInput
                                aria-label={index === 0 ? 'Start frame' : 'End frame'}
                                min={job.startFrame}
                                max={job.stopFrame}
                                value={frame}
                                disabled={disabled}
                                onCommit={(number) => {
                                    const next = update(index === 0 ? [number, value[1]] : [value[0], number]);
                                    if (next[1] !== value[1]) onEndFrameCommit?.(next[1]);
                                    return next[index];
                                }}
                            />
                        </Space>
                    </div>
                ))}
            </div>
            <Slider
                range={{ draggableTrack: true }}
                min={job.startFrame}
                max={job.stopFrame}
                value={value}
                disabled={disabled || job.startFrame === job.stopFrame}
                step={1}
                tooltip={{ formatter: (frame) => label(frame ?? value[0]) }}
                onChange={(next: number[]) => {
                    setScrubbing(true);
                    pendingRange.current = {
                        originalEnd: pendingRange.current?.originalEnd ?? value[1],
                        range: update(next),
                    };
                }}
                onChangeComplete={() => {
                    setScrubbing(false);
                    const pending = pendingRange.current;
                    pendingRange.current = null;
                    if (pending && pending.range[1] !== pending.originalEnd) {
                        onEndFrameCommit?.(pending.range[1]);
                    }
                }}
            />
            <Typography.Text type='secondary'>
                Press Enter to apply a frame number; use the arrows to step immediately.
                Drag either endpoint or move the entire range.
                {` Selected: ${value[1] - value[0] + 1} frames (inclusive).`}
            </Typography.Text>
        </div>
    );
}
