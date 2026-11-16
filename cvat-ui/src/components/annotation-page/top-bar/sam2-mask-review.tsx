// SPDX-License-Identifier: MIT
import React, {
    useEffect, useMemo, useRef, useState,
} from 'react';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Checkbox from 'antd/lib/checkbox';
import InputNumber from 'antd/lib/input-number';
import Slider from 'antd/lib/slider';
import Space from 'antd/lib/space';
import Typography from 'antd/lib/typography';
import { Job } from 'cvat-core-wrapper';
import { originalVideoSource } from 'cvat-core/src/original-video';
import { cachedVideoRanges } from 'cvat-core/src/video-segments';
import { videoFrameAtTime } from 'utils/sam2-video-timing';
import { SAM2FrameBuffer } from 'utils/sam2-frame-buffer';
import {
    decodeLogits, decodeMask, smoothMask, thresholdMask, curveSmoothMask,
} from 'utils/sam2-mask-processing';
import SAM2VideoPlayback from './sam2-video-playback';

interface MaskObject {
    object_id: string;
    shape_id: number | null;
    label_id: number;
    label_name: string;
    label_color: string;
    points: number[];
    version: string | null;
    logits?: string | null;
}
interface MaskFrame { frame: number; width: number; height: number; objects: MaskObject[] }
interface Props {
    job: Job;
    base: string;
    run: { id: string; status: string; start_frame: number; stop_frame: number };
    initialFrame?: number;
    resultsRevision: number;
    onChanged(): Promise<void>;
}

function playbackError(reason: unknown, source: string, frame: number): Error {
    if (Axios.isAxiosError(reason)) {
        const status = reason.response?.status;
        const response = reason.response?.data;
        const detail = typeof response === 'string' ? response : JSON.stringify(response);
        return new Error(`${source} · frame ${frame} · ${status ? `HTTP ${status}` : 'Network error'}: ${
            (detail || reason.message).slice(0, 500)
        }`);
    }
    return new Error(`${source} · frame ${frame}: ${reason instanceof Error ? reason.message : String(reason)}`);
}

export default function SAM2MaskReview({
    job, base, run, initialFrame, resultsRevision, onChanged,
}: Props): JSX.Element {
    const [frame, setFrame] = useState(initialFrame ?? Math.min(run.stop_frame, run.start_frame + 1));
    const [data, setData] = useState<MaskFrame | null>(null);
    const [selected, setSelected] = useState('');
    const [hidden, setHidden] = useState<string[]>([]);
    const [parameters, setParameters] = useState<Record<string, {
        radius: number; threshold: number | null; curve?: number; iterations?: number;
    }>>({});
    const [opacity, setOpacity] = useState(0.5);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    const nativeSource = originalVideoSource(job.id);
    const continuous = Boolean(nativeSource);
    const [downloaded, setDownloaded] = useState<[number, number][]>([]);
    useEffect(() => {
        if (!nativeSource) return undefined;
        const update = (): void => setDownloaded(cachedVideoRanges(nativeSource));
        update();
        const timer = window.setInterval(update, 500);
        return () => window.clearInterval(timer);
    }, [nativeSource?.id]);
    const [displayFrame, setDisplayFrame] = useState(frame);
    const playbackFrame = useRef(frame);
    const background = useRef<HTMLCanvasElement>(null);
    const overlay = useRef<HTMLCanvasElement>(null);
    const selectedMask = data?.objects.find((obj) => obj.object_id === selected);
    const {
        radius = 0, threshold = null, curve = 0, iterations = 0,
    } = parameters[selected] || {};
    const updateParameters = (patch: {
        radius?: number; threshold?: number | null; curve?: number; iterations?: number;
    }): void => {
        setParameters((previous) => ({
            ...previous,
            [selected]: {
                ...(previous[selected] || { radius: 0, threshold: null }), ...patch,
            },
        }));
    };
    const resetParameters = (): void => updateParameters({
        radius: 0, threshold: null, curve: 0, iterations: 0,
    });
    const scores = useMemo(() => {
        const decoded: Record<string, Float32Array> = {};
        if (data) {
            data.objects.forEach((obj) => {
                if (obj.logits) decoded[obj.object_id] = decodeLogits(obj.logits, data.width, data.height);
            });
        }
        return decoded;
    }, [data]);
    const previews = useMemo(() => {
        const masks: Record<string, number[] | null> = {};
        if (data) {
            data.objects.forEach((obj) => {
                const settings = parameters[obj.object_id];
                const hasThreshold = settings?.threshold !== null && settings?.threshold !== undefined;
                const points = hasThreshold && scores[obj.object_id] ?
                    thresholdMask(scores[obj.object_id], settings.threshold!, data.width, data.height) : obj.points;
                const smoothed = points ? smoothMask(points, settings?.radius || 0, data.width, data.height) : null;
                masks[obj.object_id] = smoothed ? curveSmoothMask(
                    smoothed, settings?.curve || 0, data.width, data.height, settings?.iterations || 0,
                ) : null;
            });
        }
        return masks;
    }, [data, scores, parameters]);
    const processed = previews[selected];
    // The paused canvas must show the exact same full-resolution points that Apply saves.
    const pausedPreview = useMemo(() => (data ? {
        frame: data.frame,
        width: data.width,
        height: data.height,
        objects: data.objects.map((object) => ({ ...object, points: previews[object.object_id] })),
    } : undefined), [data, previews]);

    useEffect(() => {
        if (initialFrame !== undefined) setFrame(initialFrame);
    }, [initialFrame]);

    const buffer = useMemo(() => new SAM2FrameBuffer(async (target: number, signal: AbortSignal) => {
        const [response, image] = await Promise.all([
            Axios.get<MaskFrame>(`${base}/${run.id}/masks`, {
                params: { frame: target }, timeout: 30000, signal,
            }).catch((reason) => { throw playbackError(reason, 'SAM2 mask request', target); }),
            nativeSource ? Promise.resolve(null) : job.frames.get(target)
                .then((value) => value.data()).catch((reason) => {
                    throw playbackError(reason, 'Source video frame', target);
                }),
        ]);
        // Own the buffered bitmap; never close a bitmap owned by CVAT's frame cache.
        try {
            const bitmap = image ? await createImageBitmap(image.imageData) : null;
            return { data: response.data, bitmap };
        } finally {
            // Original-video decoding returns a fresh bitmap, unlike the shared chunk cache.
            if (originalVideoSource(job.id) && image?.imageData instanceof ImageBitmap) image.imageData.close();
        }
    }, ({ bitmap }) => bitmap?.close(), ({ data: cached, bitmap }) => (
        (bitmap ? bitmap.width * bitmap.height * 4 : 0) + cached.objects.reduce((bytes, object) => (
            bytes + (object.logits?.length || 0) * 2 + (object.points?.length || 0) * 8
        ), 0)
    )), [job.id, base, run.id, run.status, revision, resultsRevision]);

    useEffect(() => () => buffer.dispose(), [buffer]);

    useEffect(() => {
        if (continuous && playing) { buffer.retain(Infinity, -Infinity); setLoading(false); return undefined; }
        let disposed = false;
        setLoading(!buffer.has(frame));
        setError('');
        // Retain the displayed frame while waiting, including its mask overlay.
        buffer.retain(frame, frame + 3);
        const timeout = setTimeout(() => {
            if (!disposed) {
                disposed = true;
                buffer.dispose();
                setPlaying(false);
                setLoading(false);
                setError(`Frame ${frame} did not load within 30 seconds. Retry this frame.`);
            }
        }, 30000);
        buffer.get(frame).then(({ data: next, bitmap }) => {
            if (!disposed) {
                if (bitmap && background.current) {
                    const canvas = background.current;
                    canvas.width = next.width;
                    canvas.height = next.height;
                    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                }
                setData(next);
                setSelected((previous) => (next.objects.some((obj) => obj.object_id === previous) ?
                    previous : next.objects[0]?.object_id || ''));
            }
        }).catch((reason) => {
            if (!disposed) {
                setPlaying(false);
                setError(reason instanceof Error ? reason.message : String(reason));
            }
        }).finally(() => {
            clearTimeout(timeout);
            if (!disposed) setLoading(false);
        });
        return () => { disposed = true; clearTimeout(timeout); };
    }, [frame, buffer, continuous, playing]);

    useEffect(() => {
        if (continuous || !data || data.frame !== frame || error) return;
        // Bound decoded images + float32/base64 scores to a small look-ahead window.
        const bytesPerFrame = data.width * data.height * (4 + data.objects.length * 10);
        const ahead = Math.max(0, Math.min(3, Math.floor((128 * 1024 * 1024) / bytesPerFrame) - 1));
        buffer.retain(frame, frame + ahead);
        for (let next = frame + 1; next <= Math.min(run.stop_frame, frame + ahead); next++) {
            // A speculative failure is retried when this becomes the displayed frame.
            buffer.get(next).catch(() => {});
        }
    }, [data, frame, buffer, error, run.stop_frame, continuous]);

    useEffect(() => {
        if (!data || !overlay.current) return;
        const canvas = overlay.current;
        canvas.width = data.width;
        canvas.height = data.height;
        const context = canvas.getContext('2d')!;
        for (const obj of data.objects) {
            if (hidden.includes(obj.object_id)) continue;
            const points = previews[obj.object_id];
            if (!points) continue;
            const mask = decodeMask(points);
            const layer = document.createElement('canvas');
            layer.width = mask.width; layer.height = mask.height;
            const layerContext = layer.getContext('2d')!;
            const pixels = layerContext.createImageData(mask.width, mask.height);
            mask.pixels.forEach((value, index) => { pixels.data[index * 4 + 3] = value * 255; });
            layerContext.putImageData(pixels, 0, 0);
            layerContext.globalCompositeOperation = 'source-in';
            layerContext.fillStyle = obj.label_color;
            layerContext.fillRect(0, 0, mask.width, mask.height);
            context.globalAlpha = opacity;
            context.drawImage(layer, mask.x, mask.y);
        }
    }, [data, previews, hidden, opacity]);

    useEffect(() => {
        if (continuous || !playing || loading || error || data?.frame !== frame) return undefined;
        const timer = setTimeout(() => {
            if (frame >= run.stop_frame) setPlaying(false);
            else setFrame(frame + 1);
        }, 200);
        return () => clearTimeout(timer);
    }, [playing, loading, error, frame, run.stop_frame, data?.frame, continuous]);

    const apply = async (): Promise<void> => {
        if (!selectedMask?.shape_id || !processed) return;
        setSaving(true); setPlaying(false); setError('');
        try {
            if (job.annotations.hasUnsavedChanges()) throw new Error('Save your canvas edits before applying post-processing.');
            await Axios.patch(`${base}/${run.id}/masks`, {
                shape_id: selectedMask.shape_id, version: selectedMask.version, points: processed,
            });
            await onChanged();
            resetParameters(); setRevision((value) => value + 1);
        } catch (reason) {
            setError(Axios.isAxiosError(reason) ?
                JSON.stringify(reason.response?.data || reason.message) : String(reason));
        } finally { setSaving(false); }
    };

    return (
        <div className='cvat-sam2-mask-review'>
            {error && (
                <Alert
                    type='error'
                    message='Could not load the playback frame'
                    description={error}
                    action={<Button onClick={() => setRevision((value) => value + 1)}>Retry frame</Button>}
                />
            )}
            <div className='cvat-sam2-review-layout'>
                <div className='cvat-sam2-review-player'>
                    {continuous && nativeSource && (
                        <SAM2VideoPlayback
                            source={nativeSource}
                            endpoint={`${base}/${run.id}/playback`}
                            startFrame={run.start_frame}
                            frame={frame}
                            playing={playing}
                            parameters={parameters}
                            pausedPreview={pausedPreview}
                            masksEndpoint={`${base}/${run.id}/masks`}
                            revision={revision + resultsRevision}
                            stopFrame={run.stop_frame}
                            hidden={hidden}
                            opacity={opacity}
                            onFrame={(value) => { playbackFrame.current = value; setDisplayFrame(value); }}
                            onStop={(value) => { setPlaying(false); setFrame(value); }}
                        />
                    )}
                    <div style={{
                        display: continuous ? 'none' : undefined,
                        position: 'relative',
                        width: '100%',
                        background: '#111',
                        minHeight: 80,
                    }}
                    >
                        <canvas
                            ref={background}
                            style={{
                                width: '100%', display: 'block', maxHeight: 420, objectFit: 'contain',
                            }}
                        />
                        <canvas
                            ref={overlay}
                            style={{
                                position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', visibility: data ? 'visible' : 'hidden',
                            }}
                        />
                    </div>
                    <Space>
                        <Button
                            onClick={() => {
                                if (continuous) setFrame(playbackFrame.current);
                                else if (frame >= run.stop_frame) {
                                    setFrame(Math.min(run.stop_frame, run.start_frame + 1));
                                }
                                setPlaying(!playing);
                            }}
                            disabled={saving || (!continuous && !playing && (loading || Boolean(error)))}
                        >
                            {playing ? 'Pause' : 'Play'}
                        </Button>
                        {!continuous && (
                            <Typography.Text>{`Frame ${data?.frame ?? frame}${loading ? ' · buffering' : ''}`}</Typography.Text>
                        )}
                    </Space>
                    {nativeSource && run.stop_frame > run.start_frame && (
                        <svg
                            className='cvat-sam2-buffered-ranges'
                            aria-label='Downloaded video ranges'
                            viewBox='0 0 1000 4'
                            preserveAspectRatio='none'
                            style={{
                                width: '100%', height: 3, display: 'block', background: '#ddd',
                            }}
                        >
                            {downloaded.map(([start, end]) => {
                                const first = Math.max(
                                    run.start_frame, videoFrameAtTime(nativeSource.timestamps, start),
                                );
                                const last = Math.min(run.stop_frame, videoFrameAtTime(nativeSource.timestamps, end));
                                const scale = 1000 / (run.stop_frame - run.start_frame);
                                return last > first ? (
                                    <rect
                                        key={`${start}:${end}`}
                                        x={(first - run.start_frame) * scale}
                                        width={(last - first) * scale}
                                        height={4}
                                        fill='#52c41a'
                                    />
                                ) : null;
                            })}
                        </svg>
                    )}
                    <Slider
                        min={run.start_frame}
                        max={run.stop_frame}
                        value={continuous ? displayFrame : frame}
                        disabled={saving}
                        onChange={(value) => { setPlaying(false); setFrame(value); setDisplayFrame(value); }}
                    />
                    <Typography.Text>{`Mask opacity: ${Math.round(opacity * 100)}%`}</Typography.Text>
                    <Slider min={0} max={1} step={0.05} value={opacity} onChange={setOpacity} />
                </div>
                <div className='cvat-sam2-review-controls'>
                    <details className='cvat-sam2-section' open>
                        <summary role='button' tabIndex={0} onKeyDown={(event) => event.stopPropagation()}>物件圖層</summary>
                        <div className='cvat-sam2-section-body'>
                            {!loading && !error && !data?.objects.length && <Alert type='info' message='No SAM2 result masks on this frame. The starting prompt stays in the main annotation canvas.' />}
                            <Space direction='vertical' style={{ width: '100%' }}>
                                {data?.objects.map((obj) => (
                                    <div
                                        key={obj.object_id}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            padding: 8,
                                            border: `1px solid ${obj.object_id === selected ? '#1890ff' : '#ddd'}`,
                                            borderRadius: 4,
                                        }}
                                    >
                                        <Checkbox
                                            aria-label={`Show ${obj.object_id}`}
                                            checked={!hidden.includes(obj.object_id)}
                                            onChange={(event) => setHidden((previous) => (event.target.checked ?
                                                previous.filter((id) => id !== obj.object_id) :
                                                [...previous, obj.object_id]))}
                                        />
                                        <span style={{
                                            background: obj.label_color, width: 12, height: 12, borderRadius: 2,
                                        }}
                                        />
                                        <Button
                                            type='text'
                                            disabled={saving}
                                            onClick={() => {
                                                setSelected(obj.object_id);
                                                setHidden((previous) => previous.filter((id) => id !== obj.object_id));
                                            }}
                                        >
                                            {`${obj.label_name} · ${obj.object_id}`}
                                        </Button>
                                        <Button
                                            size='small'
                                            onClick={() => setHidden(data.objects
                                                .filter((other) => other.object_id !== obj.object_id)
                                                .map((other) => other.object_id))}
                                        >
                            Solo
                                        </Button>
                                    </div>
                                ))}
                                <Button size='small' onClick={() => setHidden([])}>Show all objects</Button>
                            </Space>
                        </div>
                    </details>
                    <details className='cvat-sam2-section cvat-sam2-adjustments' open>
                        <summary role='button' tabIndex={0} onKeyDown={(event) => event.stopPropagation()}>
                            {selectedMask ? `Adjusting ${selectedMask.label_name} · ${selected}` : 'Select a SAM2 object'}
                        </summary>
                        <div className='cvat-sam2-section-body'>
                            <Typography.Text type='secondary'>調整會即時預覽；暫停後可套用至目前物件與影格。</Typography.Text>
                            <Typography.Text strong>切角平滑 (Corner-cutting smoothing)</Typography.Text>
                            <Typography.Text>strength · Sampling spacing</Typography.Text>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                <Slider
                                    aria-label='Sampling strength'
                                    style={{ flex: 1 }}
                                    min={0}
                                    max={5}
                                    step={0.01}
                                    value={curve}
                                    disabled={!selectedMask || saving}
                                    onChange={(value) => updateParameters({ curve: value })}
                                />
                                <InputNumber
                                    aria-label='Sampling strength value'
                                    min={0}
                                    max={5}
                                    step={0.01}
                                    precision={2}
                                    value={curve}
                                    disabled={!selectedMask || saving}
                                    onChange={(value) => {
                                        if (value !== null) {
                                            updateParameters({ curve: Math.min(5, Math.max(0, value)) });
                                        }
                                    }}
                                />
                            </div>
                            <Typography.Text type='secondary'>
                Higher values keep fewer boundary points. 0 keeps every point.
                            </Typography.Text>
                            <Typography.Text>iterations · Smoothing passes</Typography.Text>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                <Slider
                                    aria-label='Smoothing iterations'
                                    style={{ flex: 1 }}
                                    min={0}
                                    max={5}
                                    step={1}
                                    value={iterations}
                                    disabled={!selectedMask || saving}
                                    onChange={(value) => updateParameters({ iterations: value })}
                                />
                                <InputNumber
                                    aria-label='Smoothing iterations value'
                                    min={0}
                                    max={5}
                                    step={1}
                                    precision={0}
                                    value={iterations}
                                    disabled={!selectedMask || saving}
                                    onChange={(value) => {
                                        if (value !== null) {
                                            updateParameters({
                                                iterations: Math.min(5, Math.max(0, Math.round(value))),
                                            });
                                        }
                                    }}
                                />
                            </div>
                            <Typography.Text type='secondary'>
                More passes round the sampled contour further. 0 keeps straight segments between samples.
                            </Typography.Text>
                            <details className='cvat-sam2-advanced'>
                                <summary role='button' tabIndex={0} onKeyDown={(event) => event.stopPropagation()}>進階設定 · Threshold / 遮罩清理</summary>
                                <div className='cvat-sam2-section-body'>
                                    <Typography.Text>{`SAM2 threshold (logit): ${threshold ?? 0}`}</Typography.Text>
                                    <Slider
                                        aria-label='SAM2 mask threshold'
                                        min={-10}
                                        max={10}
                                        step={0.1}
                                        value={threshold ?? 0}
                                        disabled={!selectedMask?.logits || loading || saving}
                                        onChange={(value) => updateParameters({ threshold: value })}
                                    />
                                    <Typography.Text type='secondary'>
                                        {selectedMask?.logits ?
                                            'Higher values keep fewer pixels. Threshold uses original inference scores, then applies smoothing. Default: 0.' :
                                            'Threshold is unavailable: this result has no saved logits. Binary masks cannot recover scores. Corner-cutting smoothing remains available.'}
                                    </Typography.Text>
                                    {threshold !== null && (
                                        <Typography.Text type='secondary'>
                Threshold previews use the original inference and replace any manual edits on this mask when applied.
                                        </Typography.Text>
                                    )}
                                    <Typography.Text>
                                        {`Mask cleanup radius: ${radius} px · selected object preview`}
                                    </Typography.Text>
                                    <Slider
                                        aria-label='Mask smoothing radius'
                                        min={0}
                                        max={10}
                                        value={radius}
                                        disabled={!selectedMask || saving}
                                        onChange={(value) => updateParameters({ radius: value })}
                                    />
                                </div>
                            </details>
                            {selectedMask && !processed && <Alert type='warning' message='These parameters remove the entire mask. Lower the threshold or smoothing radius.' />}
                            <Space wrap>
                                <Button onClick={resetParameters}>Reset preview</Button>
                                <Button
                                    type='primary'
                                    loading={saving}
                                    disabled={(!radius && !curve && !iterations && threshold === null) || !processed ||
                        !selectedMask?.shape_id || loading || data?.frame !== frame || playing}
                                    onClick={apply}
                                >
Apply to this object / frame
                                </Button>
                            </Space>
                            {run.status !== 'accepted' && (
                                <Typography.Text type='secondary'>
                    Accept masks imports the original predictions. Then use Apply to save your post-processing preview.
                                </Typography.Text>
                            )}
                        </div>
                    </details>
                </div>
            </div>
        </div>
    );
}
