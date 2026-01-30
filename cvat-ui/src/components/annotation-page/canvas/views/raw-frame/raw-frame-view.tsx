// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shallowEqual, useSelector } from 'react-redux';
import Spin from 'antd/lib/spin';
import Text from 'antd/lib/typography/Text';
import CVATTooltip from 'components/common/cvat-tooltip';
import {
    PicCenterOutlined,
    ReloadOutlined,
} from '@ant-design/icons';

import { CombinedState } from 'reducers';

function RawFrameView(): JSX.Element {
    const { jobInstance, frameNumber } = useSelector((state: CombinedState) => ({
        jobInstance: state.annotation.job.instance,
        frameNumber: state.annotation.player.frame.number,
    }), shallowEqual);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [zoom, setZoom] = useState<number>(1);
    const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [hasFrame, setHasFrame] = useState(false);
    const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const panOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const rafRef = useRef<number | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const clampZoom = useCallback((value: number): number => (
        Math.min(3, Math.max(0.5, +value.toFixed(2)))
    ), []);

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
                    <CVATTooltip title='Fit views'>
                        <PicCenterOutlined
                            onClick={() => {
                                window.dispatchEvent(new CustomEvent('cvat.canvasLayoutAction', { detail: { action: 'fit' } }));
                                setZoom(1);
                                setPan({ x: 0, y: 0 });
                            }}
                            onKeyDown={handleIconKeyDown}
                            role='button'
                            tabIndex={0}
                            aria-label='Fit views'
                        />
                    </CVATTooltip>
                    <CVATTooltip title='Reload layout'>
                        <ReloadOutlined
                            onClick={() => {
                                window.dispatchEvent(new CustomEvent('cvat.canvasLayoutAction', { detail: { action: 'reload' } }));
                                setZoom(1);
                                setPan({ x: 0, y: 0 });
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
                onWheel={(event) => {
                    event.preventDefault();
                    const delta = event.deltaY > 0 ? -0.15 : 0.15;
                    setZoom((value) => clampZoom(value + delta));
                }}
                onPointerDown={(event) => {
                    event.preventDefault();
                    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
                    setIsPanning(true);
                    panStartRef.current = { x: event.clientX, y: event.clientY };
                    panOriginRef.current = { ...pan };
                }}
                onPointerMove={(event) => {
                    if (!isPanning) return;
                    const dx = event.clientX - panStartRef.current.x;
                    const dy = event.clientY - panStartRef.current.y;
                    const next = { x: panOriginRef.current.x + dx, y: panOriginRef.current.y + dy };
                    if (rafRef.current) cancelAnimationFrame(rafRef.current);
                    rafRef.current = requestAnimationFrame(() => {
                        setPan(next);
                    });
                }}
                onPointerUp={(event) => {
                    (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
                    setIsPanning(false);
                }}
                onPointerCancel={() => setIsPanning(false)}
                onLostPointerCapture={() => setIsPanning(false)}
                onPointerLeave={() => setIsPanning(false)}
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
