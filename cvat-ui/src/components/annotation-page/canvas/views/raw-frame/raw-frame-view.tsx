// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { shallowEqual, useSelector } from 'react-redux';
import Spin from 'antd/lib/spin';
import Text from 'antd/lib/typography/Text';
import CVATTooltip from 'components/common/cvat-tooltip';
import {
    ReloadOutlined,
} from '@ant-design/icons';

import { CombinedState } from 'reducers';

type Point = { x: number; y: number };

type GestureState =
    | {
        mode: 'pan';
        pointerId: number;
        startPoint: Point;
        startPan: Point;
    }
    | {
        mode: 'pinch';
        startCenter: Point;
        startDistance: number;
        startZoom: number;
        startPan: Point;
    }
    | { mode: null };

const getDistance = (first: Point, second: Point): number => (
    Math.hypot(second.x - first.x, second.y - first.y)
);

const getCenter = (first: Point, second: Point): Point => ({
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
});

function RawFrameView(): JSX.Element {
    const { jobInstance, frameNumber } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance,
        frameNumber: state.annotation.player.frame.number,
    }), shallowEqual);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [zoom, setZoom] = useState<number>(1);
    const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [hasFrame, setHasFrame] = useState(false);
    const rafRef = useRef<number | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const zoomRef = useRef<number>(1);
    const panRef = useRef<Point>({ x: 0, y: 0 });
    const activePointersRef = useRef<Map<number, Point>>(new Map());
    const gestureRef = useRef<GestureState>({ mode: null });

    const clampZoom = useCallback((value: number): number => (
        Math.min(3, Math.max(0.5, +value.toFixed(2)))
    ), []);

    const getLocalPointer = useCallback((event: React.PointerEvent<HTMLDivElement>): Point => {
        const rect = event.currentTarget.getBoundingClientRect();
        return {
            x: event.clientX - (rect.left + rect.width / 2),
            y: event.clientY - (rect.top + rect.height / 2),
        };
    }, []);

    const applyTransform = useCallback((nextZoom: number, nextPan: Point): void => {
        zoomRef.current = nextZoom;
        panRef.current = nextPan;
        setZoom(nextZoom);
        setPan(nextPan);
    }, []);

    const startPanGesture = useCallback((pointerId: number, point: Point): void => {
        gestureRef.current = {
            mode: 'pan',
            pointerId,
            startPoint: point,
            startPan: panRef.current,
        };
        setIsPanning(true);
    }, []);

    const startPinchGesture = useCallback((first: Point, second: Point): void => {
        gestureRef.current = {
            mode: 'pinch',
            startCenter: getCenter(first, second),
            startDistance: Math.max(1, getDistance(first, second)),
            startZoom: zoomRef.current,
            startPan: panRef.current,
        };
        setIsPanning(true);
    }, []);

    const restartGestureFromPointers = useCallback((): void => {
        const entries = Array.from(activePointersRef.current.entries());
        if (entries.length >= 2) {
            startPinchGesture(entries[0][1], entries[1][1]);
        } else if (entries.length === 1) {
            startPanGesture(entries[0][0], entries[0][1]);
        } else {
            gestureRef.current = { mode: null };
            setIsPanning(false);
        }
    }, [startPanGesture, startPinchGesture]);

    const handleIconKeyDown = useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            (event.currentTarget as HTMLElement).click();
        }
    }, []);

    useEffect(() => () => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
        }
    }, []);

    useEffect(() => {
        zoomRef.current = zoom;
    }, [zoom]);

    useEffect(() => {
        panRef.current = pan;
    }, [pan]);

    useEffect(() => {
        const content = contentRef.current;
        if (!content) {
            return () => {};
        }

        const handleWheel = (event: WheelEvent): void => {
            event.preventDefault();
            const rect = content.getBoundingClientRect();
            const pointer = {
                x: event.clientX - (rect.left + rect.width / 2),
                y: event.clientY - (rect.top + rect.height / 2),
            };
            const currentZoom = zoomRef.current;
            const currentPan = panRef.current;
            const delta = event.deltaY > 0 ? -0.15 : 0.15;
            const nextZoom = clampZoom(currentZoom + delta);

            if (nextZoom === currentZoom) {
                return;
            }

            const zoomRatio = nextZoom / currentZoom;
            const nextPan = {
                x: pointer.x - (pointer.x - currentPan.x) * zoomRatio,
                y: pointer.y - (pointer.y - currentPan.y) * zoomRatio,
            };

            applyTransform(nextZoom, nextPan);
        };

        content.addEventListener('wheel', handleWheel, { passive: false });
        return () => {
            content.removeEventListener('wheel', handleWheel);
        };
    }, [applyTransform, clampZoom]);

    useEffect(() => {
        let cancelled = false;

        const loadPreview = async (): Promise<void> => {
            if (!jobInstance) {
                setHasFrame(false);
                setLoading(false);
                return;
            }
            setLoading(true);
            setError(null);
            setHasFrame(false);

            try {
                const frameData = await jobInstance.frames.get(frameNumber);
                const { imageData, renderWidth, renderHeight } = await frameData.data();
                const bitmap = await createImageBitmap(imageData);
                try {
                    const canvas = canvasRef.current;
                    if (!canvas) {
                        throw new Error('Canvas is not available');
                    }
                    canvas.width = renderWidth;
                    canvas.height = renderHeight;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        throw new Error('Cannot draw image');
                    }
                    ctx.drawImage(bitmap, 0, 0);
                    if (!cancelled) {
                        setHasFrame(true);
                    }
                } finally {
                    if (typeof bitmap.close === 'function') {
                        bitmap.close();
                    }
                }
            } catch (e: unknown) {
                if (!cancelled) {
                    const message = e instanceof Error ? e.message : 'Could not load raw frame';
                    setError(message);
                    setHasFrame(false);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadPreview();

        return () => {
            cancelled = true;
        };
    }, [jobInstance, frameNumber]);

    const status = useMemo(() => {
        if (loading) return <Spin />;
        if (error) return <Text type='secondary'>{error}</Text>;
        if (!hasFrame) return <Text type='secondary'>No data</Text>;
        return null;
    }, [loading, error, hasFrame]);

    return (
        <div className='cvat-raw-frame-view'>
            <div className='cvat-raw-frame-view-header'>
                <Text strong className='cvat-raw-frame-view-title'>Original</Text>
                <div className='cvat-raw-frame-view-controls'>
                    <CVATTooltip title='Reload layout'>
                        <ReloadOutlined
                            onClick={() => {
                                window.dispatchEvent(new CustomEvent('cvat.canvasLayoutAction', { detail: { action: 'reload' } }));
                                activePointersRef.current.clear();
                                gestureRef.current = { mode: null };
                                setIsPanning(false);
                                applyTransform(1, { x: 0, y: 0 });
                            }}
                            onKeyDown={handleIconKeyDown}
                            role='button'
                            tabIndex={0}
                            aria-label='Reload layout'
                        />
                    </CVATTooltip>
                </div>
            </div>
            <div
                className='cvat-raw-frame-view-content'
                ref={contentRef}
                onPointerDown={(event) => {
                    event.preventDefault();
                    const target = event.currentTarget as HTMLDivElement;
                    target.setPointerCapture(event.pointerId);
                    activePointersRef.current.set(event.pointerId, getLocalPointer(event));
                    restartGestureFromPointers();
                }}
                onPointerMove={(event) => {
                    if (!activePointersRef.current.has(event.pointerId)) return;
                    activePointersRef.current.set(event.pointerId, getLocalPointer(event));
                    const gesture = gestureRef.current;
                    let nextZoom = zoomRef.current;
                    let nextPan = panRef.current;

                    if (gesture.mode === 'pan') {
                        const pointer = activePointersRef.current.get(gesture.pointerId);
                        if (!pointer) return;
                        nextPan = {
                            x: gesture.startPan.x + pointer.x - gesture.startPoint.x,
                            y: gesture.startPan.y + pointer.y - gesture.startPoint.y,
                        };
                    } else if (gesture.mode === 'pinch') {
                        const pointers = Array.from(activePointersRef.current.values());
                        if (pointers.length < 2) return;
                        const center = getCenter(pointers[0], pointers[1]);
                        const distance = Math.max(1, getDistance(pointers[0], pointers[1]));
                        nextZoom = clampZoom(gesture.startZoom * (distance / gesture.startDistance));
                        const zoomRatio = nextZoom / gesture.startZoom;
                        nextPan = {
                            x: center.x - (gesture.startCenter.x - gesture.startPan.x) * zoomRatio,
                            y: center.y - (gesture.startCenter.y - gesture.startPan.y) * zoomRatio,
                        };
                    } else {
                        return;
                    }

                    if (rafRef.current) cancelAnimationFrame(rafRef.current);
                    rafRef.current = requestAnimationFrame(() => {
                        applyTransform(nextZoom, nextPan);
                    });
                }}
                onPointerUp={(event) => {
                    const target = event.currentTarget as HTMLDivElement;
                    if (target.hasPointerCapture(event.pointerId)) {
                        target.releasePointerCapture(event.pointerId);
                    }
                    activePointersRef.current.delete(event.pointerId);
                    restartGestureFromPointers();
                }}
                onPointerCancel={(event) => {
                    activePointersRef.current.delete(event.pointerId);
                    restartGestureFromPointers();
                }}
                onLostPointerCapture={(event) => {
                    activePointersRef.current.delete(event.pointerId);
                    restartGestureFromPointers();
                }}
            >
                <div
                    className='cvat-raw-frame-view-zoomable'
                    style={{
                        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                        transformOrigin: 'center center',
                        cursor: isPanning ? 'grabbing' : 'grab',
                        transition: isPanning ? 'none' : 'transform 0.15s ease-in-out',
                    }}
                >
                    <canvas ref={canvasRef} aria-label='Raw frame' />
                </div>
                {status ? <div className='cvat-raw-frame-view-status'>{status}</div> : null}
            </div>
        </div>
    );
}

export default React.memo(RawFrameView);
