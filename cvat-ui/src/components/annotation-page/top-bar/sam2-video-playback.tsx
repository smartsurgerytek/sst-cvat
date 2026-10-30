// SPDX-License-Identifier: MIT
import React, {
    useEffect, useMemo, useRef, useState,
} from 'react';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Typography from 'antd/lib/typography';
import { OriginalVideoSource } from 'cvat-core/src/original-video';
import { prepareSegmentedVideo } from 'utils/sam2-video-segments';
import { videoFrameAtTime } from 'utils/sam2-video-timing';
import { playbackErrorMessage } from 'utils/sam2-playback-error';
import { SAM2FrameBuffer } from 'utils/sam2-frame-buffer';
import {
    decodeLogits, smoothMask, thresholdMask, curveSmoothMask,
} from 'utils/sam2-mask-processing';

interface Mask { object_id: string; points: number[] | null; label_color: string; logits?: string }
interface Snapshot { width: number; height: number; frames: { frame: number; objects: Mask[] }[] }
interface Scores { width: number; height: number; source_height: number; objects: Mask[] }
interface Props {
    source: OriginalVideoSource;
    endpoint: string;
    masksEndpoint: string;
    revision?: number;
    startFrame: number;
    stopFrame: number;
    frame: number;
    playing: boolean;
    pausedPreview?: { frame: number; width: number; height: number; objects: Mask[] };
    parameters: Record<string, { radius: number; threshold: number | null; curve?: number; iterations?: number }>;
    hidden: string[];
    opacity: number;
    onFrame(frame: number): void;
    onStop(frame: number): void;
}

export default function SAM2VideoPlayback(props: Props): JSX.Element {
    const {
        source, endpoint, masksEndpoint, revision, startFrame, stopFrame,
        frame: requestedFrame, playing: isPlaying, parameters: allSettings,
        hidden: hiddenObjects, opacity: maskOpacity, pausedPreview,
    } = props;
    const videoRef = useRef<HTMLVideoElement>(null);
    const overlayRef = useRef<HTMLCanvasElement>(null);
    const frameLabel = useRef<HTMLSpanElement>(null);
    const latest = useRef(props);
    latest.current = props;
    const snapshot = useRef<Snapshot | null>(null);
    const masks = useRef(new Map<number, Mask[]>());
    const scores = useRef(new Map<number, Scores>());
    const processed = useRef(new Map<string, { objects: Mask[]; width: number; height: number }>());
    const pending = useRef(new Set<number>());
    const ready = useRef(false);
    const lastTime = useRef(-Infinity);
    const presentedTime = useRef<number | null>(null);
    const redrawPending = useRef(false);
    const redraw = useRef<(force?: boolean) => void>(() => {});
    const [status, setStatus] = useState('Preparing playback…');
    const [overlayStatus, setOverlayStatus] = useState('');
    const [error, setError] = useState('');
    const scoreBuffer = useMemo(() => new SAM2FrameBuffer<Scores>(async (frame, signal) => (
        await Axios.get<Scores>(masksEndpoint, { params: { frame, preview: 1 }, signal, timeout: 30000 })
    ).data, () => {}, (data) => (
        data.objects.reduce((sum, object) => sum + (object.logits?.length || 0) * 2, 0)
    ), 64 * 1024 * 1024, 40), [masksEndpoint, revision]);

    useEffect(() => {
        const controller = new AbortController();
        snapshot.current = null; masks.current.clear(); scores.current.clear(); processed.current.clear();
        Axios.get<Snapshot>(endpoint, { signal: controller.signal, timeout: 60000 }).then(({ data }) => {
            if (controller.signal.aborted) return;
            snapshot.current = data;
            masks.current = new Map(data.frames.map((entry) => [entry.frame, entry.objects]));
            redraw.current(true);
        }).catch((reason) => { if (!controller.signal.aborted) setOverlayStatus(String(reason)); });
        return () => { controller.abort(); scoreBuffer.dispose(); pending.current.clear(); };
    }, [endpoint, revision, scoreBuffer]);

    redraw.current = (force = false): void => {
        if (force) redrawPending.current = true;
        const video = videoRef.current;
        const canvas = overlayRef.current;
        const data = snapshot.current;
        if (!video || !canvas || !data) return;
        if (video.seeking || video.readyState < 2) {
            canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }
        // currentTime is the playback clock; mediaTime identifies the displayed video sample.
        const time = presentedTime.current ?? video.currentTime;
        if (!redrawPending.current && time === lastTime.current) return;
        lastTime.current = time;
        const frame = Math.min(stopFrame, videoFrameAtTime(source.timestamps, time));
        if (frameLabel.current) frameLabel.current.textContent = `Frame ${frame}`;
        latest.current.onFrame(frame);
        const {
            parameters, hidden, opacity,
        } = latest.current;
        const exactPreview = !latest.current.playing && latest.current.pausedPreview?.frame === frame ?
            latest.current.pausedPreview : undefined;
        const needsScores = !exactPreview && Object.values(parameters).some((value) => value.threshold !== null);
        const scoreFrame = frame;
        const load = (target: number): void => {
            if (target > stopFrame || scores.current.has(target) || pending.current.has(target)) return;
            pending.current.add(target);
            scoreBuffer.get(target).then((value) => {
                scores.current.set(target, value);
                while (scores.current.size > 40) scores.current.delete(scores.current.keys().next().value!);
                redraw.current(true);
            }).catch((reason) => {
                if (!Axios.isCancel(reason)) setOverlayStatus('Could not load adjusted overlay. Seek to retry.');
            }).finally(() => pending.current.delete(target));
        };
        if (needsScores) {
            load(scoreFrame);
            if (latest.current.playing) {
                for (let step = 1; step <= 6; step++) {
                    load(frame + step);
                }
            }
        }
        const scoreData = needsScores ? scores.current.get(scoreFrame) : undefined;
        const context = canvas.getContext('2d')!;
        const width = exactPreview?.width || scoreData?.width || data.width;
        const height = exactPreview?.height || scoreData?.height || data.height;
        const displayScale = Math.min(video.clientWidth / width, 420 / height);
        const displayWidth = Math.max(1, Math.round(width * displayScale));
        const displayHeight = Math.max(1, Math.round(height * displayScale));
        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth; canvas.height = displayHeight;
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        delete canvas.dataset.frame;
        if (needsScores && !scoreData) { setOverlayStatus('Loading adjusted overlay…'); return; }
        setOverlayStatus('');
        const key = JSON.stringify([needsScores ? scoreFrame : frame, parameters]);
        // Already processed by the editor: do not threshold or smooth this preview a second time.
        let result = exactPreview || processed.current.get(key);
        if (!result) {
            const objects = (scoreData?.objects || masks.current.get(frame) || []).map((object) => {
                const settings = parameters[object.object_id];
                let { points } = object;
                if (settings?.threshold !== null && settings?.threshold !== undefined && object.logits) {
                    points = thresholdMask(
                        decodeLogits(object.logits, width, height), settings.threshold, width, height,
                    );
                }
                if (points && settings?.radius) {
                    const radius = scoreData ?
                        Math.max(1, Math.round((settings.radius * height) / data.height)) : settings.radius;
                    points = smoothMask(points, radius, width, height);
                }
                if (points && (settings?.curve || settings?.iterations)) {
                    points = curveSmoothMask(points, settings.curve || 0, width, height, settings.iterations || 0);
                }
                return { ...object, points };
            });
            result = { objects, width, height };
            processed.current.set(key, result);
            while (processed.current.size > 24) processed.current.delete(processed.current.keys().next().value!);
        }
        context.save();
        context.scale(canvas.width / result.width, canvas.height / result.height);
        context.globalAlpha = opacity;
        for (const object of result.objects) {
            if (hidden.includes(object.object_id) || !object.points) continue;
            const [x, y, right] = object.points.slice(-4);
            const maskWidth = right - x + 1;
            let offset = 0;
            context.fillStyle = object.label_color;
            object.points.slice(0, -4).forEach((count, index) => {
                if (index % 2) {
                    let remaining = count;
                    while (remaining > 0) {
                        const col = offset % maskWidth;
                        const span = Math.min(remaining, maskWidth - col);
                        context.fillRect(x + col, y + Math.floor(offset / maskWidth), span, 1);
                        offset += span; remaining -= span;
                    }
                } else offset += count;
            });
        }
        context.restore();
        canvas.dataset.frame = String(frame);
        redrawPending.current = false;
    };

    useEffect(() => {
        const video = videoRef.current!;
        const controller = new AbortController();
        let animation = 0;
        let videoCallback = 0;
        const hasVideoCallbacks = typeof video.requestVideoFrameCallback === 'function';
        presentedTime.current = null;
        ready.current = false;
        const present = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
            presentedTime.current = metadata.mediaTime;
            redraw.current();
            videoCallback = video.requestVideoFrameCallback(present);
        };
        const tick = (): void => {
            // Keep paused edits responsive; playing overlays follow decoded frames, not the UI clock.
            if (!hasVideoCallbacks || video.paused) redraw.current();
            if (latest.current.playing && video.currentTime >= source.timestamps[stopFrame]) {
                video.pause(); latest.current.onStop(stopFrame);
            }
            animation = requestAnimationFrame(tick);
        };
        const playing = (): void => setStatus('');
        const waiting = (): void => {
            if (video.seeking || video.readyState < 2) setStatus('Buffering video…');
        };
        const ended = (): void => latest.current.onStop(stopFrame);
        const seeking = (): void => { presentedTime.current = null; };
        const refresh = (): void => {
            if (!video.seeking && video.readyState >= 2) {
                setStatus((current) => (current === 'Buffering video…' ? '' : current));
            }
            redraw.current(true);
        };
        video.addEventListener('playing', playing);
        video.addEventListener('waiting', waiting);
        video.addEventListener('ended', ended);
        video.addEventListener('seeking', seeking);
        video.addEventListener('seeked', refresh);
        if (hasVideoCallbacks) videoCallback = video.requestVideoFrameCallback(present);
        video.addEventListener('loadeddata', refresh);
        video.addEventListener('canplay', refresh);
        video.addEventListener('pause', refresh);
        prepareSegmentedVideo(
            video,
            source,
            source.timestamps[latest.current.frame],
            source.timestamps[stopFrame + 1] ?? source.duration,
            controller.signal,
            setStatus,
        ).then(async () => {
            if (controller.signal.aborted) return;
            ready.current = true;
            video.currentTime = source.timestamps[latest.current.frame];
            if (latest.current.playing) await video.play();
            tick();
        }).catch(async (reason) => {
            if (!controller.signal.aborted) setError(await playbackErrorMessage(reason));
        });
        return () => {
            ready.current = false;
            controller.abort(); cancelAnimationFrame(animation);
            if (hasVideoCallbacks) video.cancelVideoFrameCallback(videoCallback);
            video.removeEventListener('playing', playing);
            video.removeEventListener('waiting', waiting);
            video.removeEventListener('ended', ended);
            video.removeEventListener('seeking', seeking);
            video.removeEventListener('seeked', refresh);
            video.removeEventListener('loadeddata', refresh);
            video.removeEventListener('canplay', refresh);
            video.removeEventListener('pause', refresh);
        };
    }, [source.url, source.id, startFrame, stopFrame]);

    useEffect(() => {
        const video = videoRef.current!;
        if (video.src) video.currentTime = source.timestamps[requestedFrame];
        scoreBuffer.retain(requestedFrame, Math.min(stopFrame, requestedFrame + 30));
        lastTime.current = -Infinity;
        redraw.current(true);
    }, [requestedFrame, scoreBuffer]);

    useEffect(() => {
        if (!ready.current) return;
        const video = videoRef.current!;
        if (isPlaying) video.play().catch((reason) => setError(String(reason)));
        else video.pause();
        redraw.current(true);
    }, [isPlaying]);

    useEffect(() => { redraw.current(true); }, [allSettings, hiddenObjects, maskOpacity, pausedPreview]);

    return (
        <div className='cvat-sam2-continuous-playback'>
            <span ref={frameLabel} />
            {error && <Alert type='error' message={error} />}
            {status && !error && <Typography.Text>{status}</Typography.Text>}
            {overlayStatus && <Typography.Text>{overlayStatus}</Typography.Text>}
            <div style={{ position: 'relative', background: '#111' }}>
                <video
                    ref={videoRef}
                    muted
                    playsInline
                    preload='auto'
                    style={{
                        width: '100%', maxHeight: 420, display: 'block', objectFit: 'contain',
                    }}
                />
                <canvas
                    ref={overlayRef}
                    style={{
                        position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain',
                    }}
                />
            </div>
            <Typography.Text type='secondary'>
                播放時同步預覽遮罩，暫停後可套用調整。
            </Typography.Text>
        </div>
    );
}
