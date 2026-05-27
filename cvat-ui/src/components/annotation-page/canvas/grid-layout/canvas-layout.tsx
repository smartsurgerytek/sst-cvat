// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import 'react-grid-layout/css/styles.css';

import React, {
    useCallback, useEffect, useRef, useState,
} from 'react';
import { shallowEqual, useSelector } from 'react-redux';
import RGL, { WidthProvider } from 'react-grid-layout';
import PropTypes from 'prop-types';
import { isEqual } from 'lodash';
import Layout from 'antd/lib/layout';
import {
    CloseOutlined,
    DragOutlined,
    FullscreenExitOutlined,
    FullscreenOutlined,
    PicCenterOutlined,
    PlusOutlined,
    ReloadOutlined,
} from '@ant-design/icons';

import config from 'config';
import { Canvas } from 'cvat-canvas-wrapper';
import { DimensionType } from 'cvat-core-wrapper';
import { CombinedState } from 'reducers';
import CanvasWrapperComponent from 'components/annotation-page/canvas/views/canvas2d/canvas-wrapper';
import CanvasWrapper3DComponent, {
    PerspectiveViewComponent,
    TopViewComponent,
    SideViewComponent,
    FrontViewComponent,
} from 'components/annotation-page/canvas/views/canvas3d/canvas-wrapper3D';
import ContextImage from 'components/annotation-page/canvas/views/context-image/context-image';
import RawFrameView from 'components/annotation-page/canvas/views/raw-frame/raw-frame-view';
import CVATTooltip from 'components/common/cvat-tooltip';
import { useUpdateEffect } from 'utils/hooks';
import defaultLayout, { ItemLayout, ViewType } from './canvas-layout.conf';

const ReactGridLayout = WidthProvider(RGL);
const RAW_COMPARE_MIN_WIDTH = 2;

const getLayoutKey = (itemLayout: Pick<ItemLayout, 'viewType' | 'viewIndex'>): string => (
    typeof itemLayout.viewIndex !== 'undefined' ? `${itemLayout.viewType}_${itemLayout.viewIndex}` : `${itemLayout.viewType}`
);

const clampGridValue = (value: number, min: number, max: number): number => (
    Math.min(max, Math.max(min, value))
);

const buildDefaultRawCompareLayout = (swapped: boolean): ItemLayout[] => {
    const totalWidth = config.CANVAS_WORKSPACE_COLS;
    const leftWidth = Math.floor(totalWidth / 2);
    const firstViewType = swapped ? ViewType.RAW_FRAME : ViewType.CANVAS;
    const secondViewType = swapped ? ViewType.CANVAS : ViewType.RAW_FRAME;

    return [{
        viewType: firstViewType,
        offset: [0],
        x: 0,
        y: 0,
        w: leftWidth,
        h: config.CANVAS_WORKSPACE_ROWS,
    }, {
        viewType: secondViewType,
        offset: [0],
        x: leftWidth,
        y: 0,
        w: totalWidth - leftWidth,
        h: config.CANVAS_WORKSPACE_ROWS,
    }];
};

const buildRawCompareItem = (item: ItemLayout, viewType = item.viewType): ItemLayout => ({
    viewType,
    offset: [0],
    x: item.x,
    y: item.y,
    w: item.w,
    h: item.h,
});

const cloneRawCompareLayout = (layout: ItemLayout[]): ItemLayout[] => (
    layout.map((item: ItemLayout): ItemLayout => buildRawCompareItem(item))
);

const swapRawCompareLayout = (layout: ItemLayout[]): ItemLayout[] => {
    if (layout.length !== 2) {
        return cloneRawCompareLayout(layout);
    }

    return [
        buildRawCompareItem(layout[0], layout[1].viewType),
        buildRawCompareItem(layout[1], layout[0].viewType),
    ];
};

const buildRawCompareSplitLayout = (layout: ItemLayout[], split: number): ItemLayout[] => {
    if (layout.length !== 2) {
        return cloneRawCompareLayout(layout);
    }

    const [left, right] = layout;
    const nextSplit = clampGridValue(
        split,
        RAW_COMPARE_MIN_WIDTH,
        config.CANVAS_WORKSPACE_COLS - RAW_COMPARE_MIN_WIDTH,
    );

    return [{
        ...buildRawCompareItem(left),
        x: 0,
        y: 0,
        w: nextSplit,
        h: config.CANVAS_WORKSPACE_ROWS,
    }, {
        ...buildRawCompareItem(right),
        x: nextSplit,
        y: 0,
        w: config.CANVAS_WORKSPACE_COLS - nextSplit,
        h: config.CANVAS_WORKSPACE_ROWS,
    }];
};

const renderResizeHandle = (axis: string, ref: React.MutableRefObject<HTMLDivElement>): JSX.Element => (
    <div
        ref={ref}
        className={
            'cvat-grid-item-resize-handler ' +
            `react-resizable-handle react-resizable-handle-${axis}`
        }
    />
);

const ViewFabric = (itemLayout: ItemLayout): JSX.Element => {
    const { viewType: type, offset } = itemLayout;

    let component = null;
    switch (type) {
        case ViewType.CANVAS:
            component = <CanvasWrapperComponent />;
            break;
        case ViewType.CANVAS_3D:
            component = <PerspectiveViewComponent />;
            break;
        case ViewType.RELATED_IMAGE:
            component = <ContextImage offset={offset} />;
            break;
        case ViewType.CANVAS_3D_FRONT:
            component = <FrontViewComponent />;
            break;
        case ViewType.CANVAS_3D_SIDE:
            component = <SideViewComponent />;
            break;
        case ViewType.CANVAS_3D_TOP:
            component = <TopViewComponent />;
            break;
        case ViewType.RAW_FRAME:
            component = <RawFrameView />;
            break;
        default:
            component = <div> Undefined view </div>;
    }

    return component;
};

const fitLayout = (type: DimensionType, layoutConfig: ItemLayout[]): ItemLayout[] => {
    const updatedLayout: ItemLayout[] = [];

    const relatedViews = layoutConfig
        .filter((item: ItemLayout) => item.viewType === ViewType.RELATED_IMAGE);
    const rawFrameView = layoutConfig
        .find((item: ItemLayout) => item.viewType === ViewType.RAW_FRAME);
    const relatedViewsCols = relatedViews.length > 6 ? 2 : 1;
    let height = Math.floor(config.CANVAS_WORKSPACE_ROWS / (relatedViews.length / relatedViewsCols));
    height = Math.min(height, config.CANVAS_WORKSPACE_DEFAULT_CONTEXT_HEIGHT);
    relatedViews.forEach((view: ItemLayout, i: number) => {
        updatedLayout.push({
            ...view,
            h: height,
            w: relatedViews.length > 6 ? 2 : 3,
            x: relatedViewsCols === 1 ? 9 : 8 + (i % 2) * 2,
            y: height * i,
        });
    });

    let widthAvail = config.CANVAS_WORKSPACE_COLS;
    if (updatedLayout.length > 0) {
        widthAvail -= updatedLayout[0].w * relatedViewsCols;
    }

    if (type === DimensionType.DIMENSION_2D) {
        const canvas = layoutConfig
            .find((item: ItemLayout) => item.viewType === ViewType.CANVAS) as ItemLayout;

        if (rawFrameView) {
            const leftWidth = Math.floor(widthAvail / 2);
            updatedLayout.push({
                ...canvas,
                x: 0,
                y: 0,
                w: leftWidth,
                h: config.CANVAS_WORKSPACE_ROWS,
            }, {
                ...rawFrameView,
                x: leftWidth,
                y: 0,
                w: widthAvail - leftWidth,
                h: config.CANVAS_WORKSPACE_ROWS,
            });
            return updatedLayout;
        }

        updatedLayout.push({
            ...canvas,
            x: 0,
            y: 0,
            w: widthAvail,
            h: config.CANVAS_WORKSPACE_ROWS,
        });
    } else {
        const canvas = layoutConfig
            .find((item: ItemLayout) => item.viewType === ViewType.CANVAS_3D) as ItemLayout;
        const top = layoutConfig
            .find((item: ItemLayout) => item.viewType === ViewType.CANVAS_3D_TOP) as ItemLayout;
        const side = layoutConfig
            .find((item: ItemLayout) => item.viewType === ViewType.CANVAS_3D_SIDE) as ItemLayout;
        const front = layoutConfig
            .find((item: ItemLayout) => item.viewType === ViewType.CANVAS_3D_FRONT) as ItemLayout;
        const helpfulCanvasViewHeight = 3;
        updatedLayout.push({
            ...canvas,
            x: 0,
            y: 0,
            w: widthAvail,
            h: config.CANVAS_WORKSPACE_ROWS - helpfulCanvasViewHeight,
        }, {
            ...top,
            x: 0,
            y: config.CANVAS_WORKSPACE_ROWS,
            w: Math.ceil(widthAvail / 3),
            h: helpfulCanvasViewHeight,
        }, {
            ...side,
            x: Math.ceil(widthAvail / 3),
            y: config.CANVAS_WORKSPACE_ROWS,
            w: Math.ceil(widthAvail / 3),
            h: helpfulCanvasViewHeight,
        }, {
            ...front,
            x: Math.ceil(widthAvail / 3) * 2,
            y: config.CANVAS_WORKSPACE_ROWS,
            w: Math.floor(widthAvail / 3),
            h: helpfulCanvasViewHeight,
        });
    }

    return updatedLayout;
};

function CanvasLayout({ type }: { type?: DimensionType }): JSX.Element {
    const {
        relatedFiles,
        canvasInstance,
        canvasBackgroundColor,
        dimension,
    } = useSelector((state: CombinedState) => ({
        relatedFiles: state.annotation.player.frame.relatedFiles,
        canvasInstance: state.annotation.canvas.instance,
        canvasBackgroundColor: state.settings.player.canvasBackgroundColor,
        dimension: state.annotation.job.instance?.dimension,
    }), shallowEqual);

    const resolvedType = type ?? dimension;
    const hasKnownDimension = Boolean(resolvedType);
    const layoutType = resolvedType ?? DimensionType.DIMENSION_2D;
    const [layoutMode, setLayoutMode] = useState<'grid' | 'raw_compare'>('grid');
    const [rawCompareSwapped, setRawCompareSwapped] = useState<boolean>(() => {
        try {
            return JSON.parse(localStorage.getItem(config.RAW_COMPARE_SWAP_STORAGE_KEY) || 'false') === true;
        } catch (error: unknown) {
            return false;
        }
    });
    const [layoutConfig, setLayoutConfig] = useState<ItemLayout[]>([]);
    const gridLayoutRef = useRef<ItemLayout[] | null>(null);
    const rawCompareLayoutRef = useRef<ItemLayout[] | null>(null);
    const rawCompareRestoreRef = useRef<ItemLayout[] | null>(null);
    const rawCompareDividerActiveRef = useRef<boolean>(false);
    const rawComparePendingSplitRef = useRef<number | null>(null);

    const computeRowHeight = (): number => {
        const container = window.document.getElementsByClassName('cvat-annotation-header')[0];
        let containerHeight = window.innerHeight;
        if (container) {
            containerHeight = window.innerHeight - container.getBoundingClientRect().bottom;
            // https://github.com/react-grid-layout/react-grid-layout/issues/628#issuecomment-1228453084
            return Math.floor(
                (containerHeight - config.CANVAS_WORKSPACE_MARGIN * (config.CANVAS_WORKSPACE_ROWS)) /
                config.CANVAS_WORKSPACE_ROWS,
            );
        }

        return 0;
    };

    const buildDefaultGridLayout = useCallback((): ItemLayout[] => (
        defaultLayout[(layoutType as DimensionType).toUpperCase() as '2D' | '3D'][Math.min(relatedFiles, 3)]
    ), [layoutType, relatedFiles]);

    const buildRawCompareLayout = useCallback((swapped = rawCompareSwapped, reset = false): ItemLayout[] => {
        if (!reset && rawCompareLayoutRef.current?.length === 2) {
            return cloneRawCompareLayout(rawCompareLayoutRef.current);
        }

        return buildDefaultRawCompareLayout(swapped);
    }, [rawCompareSwapped]);

    const [rowHeight, setRowHeight] = useState<number>(Math.floor(computeRowHeight()));
    const [fullscreenKey, setFullscreenKey] = useState<string>('');

    const applyRawCompareSplit = useCallback((split: number): void => {
        const source = rawCompareLayoutRef.current?.length === 2 ?
            rawCompareLayoutRef.current : buildRawCompareLayout();
        const next = buildRawCompareSplitLayout(source, split);

        if (isEqual(rawCompareLayoutRef.current, next)) {
            return;
        }

        rawCompareLayoutRef.current = next;
        setLayoutConfig(next);
    }, [buildRawCompareLayout]);

    useEffect(() => {
        if (!hasKnownDimension) return;

        if (resolvedType !== DimensionType.DIMENSION_2D && layoutMode === 'raw_compare') {
            rawCompareRestoreRef.current = null;
            setLayoutMode('grid');
            const next = gridLayoutRef.current ?? buildDefaultGridLayout();
            gridLayoutRef.current = next;
            setLayoutConfig(next);
            window.dispatchEvent(new CustomEvent('cvat.rawCompareToggle', { detail: { active: false } }));
        }
    }, [buildDefaultGridLayout, hasKnownDimension, layoutMode, resolvedType]);

    const fitCanvas = useCallback(() => {
        if (canvasInstance instanceof Canvas) {
            // only applicable for 2D canvas because of SVG-based nature
            canvasInstance.fitCanvas();
            canvasInstance.fit();
        }
    }, [canvasInstance]);

    useEffect(() => {
        const onResize = (): void => {
            setRowHeight(computeRowHeight());
            fitCanvas();
            const [el] = window.document.getElementsByClassName('cvat-canvas-grid-root');
            if (el) {
                el.addEventListener('transitionend', () => {
                    fitCanvas();
                }, { once: true });
            }
        };

        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [fitCanvas]);

    useEffect(() => {
        setRowHeight(computeRowHeight());
    }, []);

    useEffect(() => {
        const handler = (event: Event): void => {
            if (!hasKnownDimension) {
                return;
            }

            if (resolvedType !== DimensionType.DIMENSION_2D) {
                return;
            }

            const detail = (event as CustomEvent).detail || {};
            const nextActive = Boolean(detail.active);
            if (nextActive) {
                if (layoutMode !== 'raw_compare') {
                    rawCompareRestoreRef.current = layoutConfig;
                }
                setLayoutMode('raw_compare');
                const next = buildRawCompareLayout();
                rawCompareLayoutRef.current = next;
                setLayoutConfig(next);
            } else if (layoutMode === 'raw_compare') {
                const restore = rawCompareRestoreRef.current;
                rawCompareRestoreRef.current = null;
                if (restore) {
                    setLayoutMode('grid');
                    setLayoutConfig(restore);
                    gridLayoutRef.current = restore;
                } else {
                    setLayoutMode('grid');
                    const next = gridLayoutRef.current ?? buildDefaultGridLayout();
                    gridLayoutRef.current = next;
                    setLayoutConfig(next);
                }
            }
        };
        window.addEventListener('cvat.rawCompareToggle', handler as EventListener);
        return () => window.removeEventListener('cvat.rawCompareToggle', handler as EventListener);
    }, [buildDefaultGridLayout, buildRawCompareLayout, hasKnownDimension, layoutConfig, layoutMode, resolvedType]);

    useEffect(() => {
        const handler = (event: Event): void => {
            const detail = (event as CustomEvent).detail || {};
            const swapped = Boolean(detail.swapped);
            setRawCompareSwapped(swapped);
            localStorage.setItem(config.RAW_COMPARE_SWAP_STORAGE_KEY, JSON.stringify(swapped));
            if (layoutMode === 'raw_compare') {
                const source = rawCompareLayoutRef.current;
                const next = source?.length === 2 ? swapRawCompareLayout(source) : buildRawCompareLayout(swapped);
                rawCompareLayoutRef.current = next;
                setLayoutConfig(next);
            }
        };
        window.addEventListener('cvat.rawCompareSwap', handler as EventListener);
        return () => window.removeEventListener('cvat.rawCompareSwap', handler as EventListener);
    }, [buildRawCompareLayout, layoutMode]);

    useEffect(() => {
        const handler = (event: Event): void => {
            const detail = (event as CustomEvent).detail || {};
            const action = detail.action as string | undefined;
            if (!action) return;

            if (action === 'fit') {
                if (layoutMode === 'raw_compare') {
                    const next = buildRawCompareLayout(rawCompareSwapped, true);
                    rawCompareLayoutRef.current = next;
                    setLayoutConfig(next);
                } else {
                    setLayoutConfig(fitLayout(layoutType as DimensionType, layoutConfig));
                }
                window.dispatchEvent(new Event('resize'));
            } else if (action === 'reload') {
                if (layoutMode === 'raw_compare') {
                    const next = buildRawCompareLayout(rawCompareSwapped, true);
                    rawCompareLayoutRef.current = next;
                    setLayoutConfig(next);
                } else {
                    const next = buildDefaultGridLayout();
                    gridLayoutRef.current = next;
                    setLayoutConfig(next);
                }
                window.dispatchEvent(new Event('resize'));
            }
        };

        window.addEventListener('cvat.canvasLayoutAction', handler as EventListener);
        return () => window.removeEventListener('cvat.canvasLayoutAction', handler as EventListener);
    }, [
        buildDefaultGridLayout,
        buildRawCompareLayout,
        layoutConfig,
        layoutMode,
        layoutType,
        rawCompareSwapped,
        resolvedType,
    ]);

    useEffect(() => {
        const next = buildDefaultGridLayout();
        if (!gridLayoutRef.current) {
            gridLayoutRef.current = next;
        }

        if (layoutMode === 'grid') {
            gridLayoutRef.current = next;
            setLayoutConfig(next);
        }
    }, [buildDefaultGridLayout, layoutMode]);

    useEffect(() => {
        if (layoutMode === 'raw_compare') {
            const next = buildRawCompareLayout();
            rawCompareLayoutRef.current = next;
            setLayoutConfig(next);
        } else if (layoutMode === 'grid') {
            const next = gridLayoutRef.current ?? buildDefaultGridLayout();
            gridLayoutRef.current = next;
            setLayoutConfig(next);
        }
    }, [buildDefaultGridLayout, buildRawCompareLayout, layoutMode]);

    useUpdateEffect(() => {
        window.dispatchEvent(new Event('resize'));
    }, [layoutConfig]);

    const showRawCompare = layoutMode === 'raw_compare';

    const children = layoutConfig.map((value: ItemLayout) => ViewFabric(value));
    const layout = layoutConfig.map((value: ItemLayout) => ({
        x: value.x,
        y: value.y,
        w: value.w,
        h: value.h,
        i: getLayoutKey(value),
    }));

    const singleClassName = 'cvat-canvas-grid-root-single';
    const className = !relatedFiles && children.length <= 1 ?
        `cvat-canvas-grid-root ${singleClassName}` : 'cvat-canvas-grid-root';

    const mergeUpdatedGridLayout = useCallback((updatedLayout: RGL.Layout[]): ItemLayout[] => {
        const updatedLayoutByKey = updatedLayout.reduce((
            acc: Record<string, RGL.Layout>,
            item: RGL.Layout,
        ): Record<string, RGL.Layout> => {
            acc[item.i] = item;
            return acc;
        }, {});

        return layoutConfig.map((itemLayout: ItemLayout, i: number): ItemLayout => ({
            ...itemLayout,
            x: updatedLayoutByKey[getLayoutKey(itemLayout)]?.x ?? updatedLayout[i].x,
            y: updatedLayoutByKey[getLayoutKey(itemLayout)]?.y ?? updatedLayout[i].y,
            w: updatedLayoutByKey[getLayoutKey(itemLayout)]?.w ?? updatedLayout[i].w,
            h: updatedLayoutByKey[getLayoutKey(itemLayout)]?.h ?? updatedLayout[i].h,
        }));
    }, [layoutConfig]);

    const setRawCompareSplitVariables = useCallback((container: HTMLElement, split: number): void => {
        const nextSplit = clampGridValue(
            split,
            RAW_COMPARE_MIN_WIDTH,
            config.CANVAS_WORKSPACE_COLS - RAW_COMPARE_MIN_WIDTH,
        );

        container.style.setProperty('--cvat-raw-compare-left', `${nextSplit}fr`);
        container.style.setProperty(
            '--cvat-raw-compare-right',
            `${config.CANVAS_WORKSPACE_COLS - nextSplit}fr`,
        );
        rawComparePendingSplitRef.current = nextSplit;
    }, []);

    const updateRawCompareSplitFromPointer = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
        const container = event.currentTarget.parentElement;
        if (!container) {
            return;
        }

        const rect = container.getBoundingClientRect();
        const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
        const split = Math.round(ratio * config.CANVAS_WORKSPACE_COLS);
        setRawCompareSplitVariables(container, split);
    }, [setRawCompareSplitVariables]);

    const finishRawCompareDividerResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
        const pendingSplit = rawComparePendingSplitRef.current;
        rawCompareDividerActiveRef.current = false;
        rawComparePendingSplitRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (pendingSplit !== null) {
            applyRawCompareSplit(pendingSplit);
        }
    }, [applyRawCompareSplit]);

    const renderCanvasGridItem = (itemLayout: ItemLayout, child: JSX.Element): JSX.Element => {
        const { viewType, viewIndex } = itemLayout;
        const key = getLayoutKey({ viewType, viewIndex });
        const showCloseButton = !showRawCompare || viewType === ViewType.RAW_FRAME;

        return (
            <div
                style={fullscreenKey === key ? { backgroundColor: canvasBackgroundColor } : {}}
                className={fullscreenKey === key ?
                    'cvat-canvas-grid-item cvat-canvas-grid-fullscreen-item' :
                    'cvat-canvas-grid-item'}
                key={key}
            >
                {!showRawCompare && <DragOutlined className='cvat-grid-item-drag-handler' />}
                {showCloseButton && (
                    <CloseOutlined
                        className='cvat-grid-item-close-button'
                        style={{
                            pointerEvents:
                                viewType !== ViewType.RELATED_IMAGE && viewType !== ViewType.RAW_FRAME ?
                                    'none' : undefined,
                            opacity:
                                viewType !== ViewType.RELATED_IMAGE && viewType !== ViewType.RAW_FRAME ?
                                    0.2 : undefined,
                        }}
                        onClick={() => {
                            if (viewType === ViewType.RELATED_IMAGE) {
                                setLayoutConfig(
                                    layoutConfig
                                        .filter((item: ItemLayout) => !(
                                            item.viewType === viewType && item.viewIndex === viewIndex
                                        )),
                                );
                            } else if (viewType === ViewType.RAW_FRAME) {
                                window.dispatchEvent(new CustomEvent('cvat.rawCompareToggle', {
                                    detail: { active: false },
                                }));
                            }
                        }}
                    />
                )}
                {!showRawCompare && (
                    fullscreenKey === key ? (
                        <FullscreenExitOutlined
                            className='cvat-grid-item-fullscreen-handler'
                            onClick={() => {
                                window.dispatchEvent(new Event('resize'));
                                setFullscreenKey('');
                            }}
                        />
                    ) : (
                        <FullscreenOutlined
                            className='cvat-grid-item-fullscreen-handler'
                            onClick={() => {
                                window.dispatchEvent(new Event('resize'));
                                setFullscreenKey(key);
                            }}
                        />
                    )
                )}

                { child }
            </div>
        );
    };

    if (showRawCompare) {
        const rawCompareItems = layoutConfig.length === 2 ? layoutConfig : buildRawCompareLayout();
        const rawCompareSplit = clampGridValue(
            rawCompareItems[0]?.w ?? Math.floor(config.CANVAS_WORKSPACE_COLS / 2),
            RAW_COMPARE_MIN_WIDTH,
            config.CANVAS_WORKSPACE_COLS - RAW_COMPARE_MIN_WIDTH,
        );
        const rawCompareHeight = rowHeight * config.CANVAS_WORKSPACE_ROWS +
            config.CANVAS_WORKSPACE_MARGIN * (config.CANVAS_WORKSPACE_ROWS - 1) +
            config.CANVAS_WORKSPACE_PADDING * 2;
        const rawCompareStyle = {
            background: canvasBackgroundColor,
            height: rawCompareHeight,
            '--cvat-raw-compare-left': `${rawCompareSplit}fr`,
            '--cvat-raw-compare-right': `${config.CANVAS_WORKSPACE_COLS - rawCompareSplit}fr`,
        } as React.CSSProperties;
        const rawCompareChildren = rawCompareItems.map((value: ItemLayout) => ViewFabric(value));

        return (
            <Layout.Content>
                { !!rowHeight && (
                    <div className='cvat-raw-compare-layout' style={rawCompareStyle}>
                        {renderCanvasGridItem(rawCompareItems[0], rawCompareChildren[0])}
                        <div
                            className='cvat-raw-compare-divider'
                            role='separator'
                            aria-orientation='vertical'
                            onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
                                event.preventDefault();
                                rawCompareDividerActiveRef.current = true;
                                event.currentTarget.setPointerCapture(event.pointerId);
                                updateRawCompareSplitFromPointer(event);
                            }}
                            onPointerMove={(event: React.PointerEvent<HTMLDivElement>) => {
                                if (rawCompareDividerActiveRef.current) {
                                    updateRawCompareSplitFromPointer(event);
                                }
                            }}
                            onPointerUp={finishRawCompareDividerResize}
                            onPointerCancel={finishRawCompareDividerResize}
                            onLostPointerCapture={() => {
                                rawCompareDividerActiveRef.current = false;
                            }}
                        />
                        {renderCanvasGridItem(rawCompareItems[1], rawCompareChildren[1])}
                    </div>
                )}
                { resolvedType === DimensionType.DIMENSION_3D && <CanvasWrapper3DComponent /> }
            </Layout.Content>
        );
    }

    return (
        <Layout.Content>
            { !!rowHeight && (
                <ReactGridLayout
                    key={layoutMode}
                    cols={config.CANVAS_WORKSPACE_COLS}
                    maxRows={config.CANVAS_WORKSPACE_ROWS}
                    style={{ background: canvasBackgroundColor }}
                    containerPadding={[config.CANVAS_WORKSPACE_PADDING, config.CANVAS_WORKSPACE_PADDING]}
                    margin={[config.CANVAS_WORKSPACE_MARGIN, config.CANVAS_WORKSPACE_MARGIN]}
                    className={className}
                    rowHeight={rowHeight}
                    layout={layout}
                    resizeHandles={['se']}
                    onLayoutChange={(updatedLayout: RGL.Layout[]) => {
                        const transformedLayout = mergeUpdatedGridLayout(updatedLayout);

                        if (!isEqual(layoutConfig, transformedLayout)) {
                            gridLayoutRef.current = transformedLayout;
                            setLayoutConfig(transformedLayout);
                        }
                    }}
                    resizeHandle={
                        renderResizeHandle as unknown as RGL.ReactGridLayoutProps['resizeHandle']
                    }
                    draggableHandle='.cvat-grid-item-drag-handler'
                >
                    { children.map((child: JSX.Element, idx: number): JSX.Element => (
                        renderCanvasGridItem(layoutConfig[idx], child)
                    )) }
                </ReactGridLayout>
            )}
            { resolvedType === DimensionType.DIMENSION_3D && <CanvasWrapper3DComponent /> }
            {!showRawCompare && (
                <div className='cvat-grid-layout-common-setups'>
                    <CVATTooltip title='Fit views'>
                        <PicCenterOutlined
                            onClick={() => {
                                setLayoutConfig(fitLayout(layoutType as DimensionType, layoutConfig));
                                window.dispatchEvent(new Event('resize'));
                            }}
                        />
                    </CVATTooltip>
                    <CVATTooltip title='Add context image'>
                        <PlusOutlined
                            style={{
                                pointerEvents: !relatedFiles ? 'none' : undefined,
                                opacity: !relatedFiles ? 0.2 : undefined,
                            }}
                            disabled={!!relatedFiles}
                            onClick={() => {
                                const MAXIMUM_RELATED = 12;
                                const existingRelated = layoutConfig
                                    .filter((configItem: ItemLayout) => configItem.viewType === ViewType.RELATED_IMAGE);

                                if (existingRelated.length >= MAXIMUM_RELATED) {
                                    return;
                                }

                                if (existingRelated.length === 0) {
                                    setLayoutConfig(defaultLayout[type?.toUpperCase() as '2D' | '3D']['1']);
                                    return;
                                }

                                const viewIndexes = existingRelated
                                    .map((item: ItemLayout) => +(item.viewIndex as string)).sort();
                                const max = Math.max(...viewIndexes);
                                let viewIndex = max + 1;
                                for (let i = 0; i < max + 1; i++) {
                                    if (!viewIndexes.includes(i)) {
                                        viewIndex = i;
                                        break;
                                    }
                                }

                                const latest = existingRelated[existingRelated.length - 1];
                                const copy = { ...latest, offset: [0, viewIndex], viewIndex: `${viewIndex}` };
                                setLayoutConfig(fitLayout(type as DimensionType, [...layoutConfig, copy]));
                                window.dispatchEvent(new Event('resize'));
                            }}
                        />
                    </CVATTooltip>
                    <CVATTooltip title='Reload layout'>
                        <ReloadOutlined onClick={() => {
                            const next = buildDefaultGridLayout();
                            gridLayoutRef.current = next;
                            setLayoutConfig(next);
                            window.dispatchEvent(new Event('resize'));
                        }}
                        />
                    </CVATTooltip>
                </div>
            )}
        </Layout.Content>
    );
}

CanvasLayout.defaultProps = {
    type: DimensionType.DIMENSION_2D,
};

CanvasLayout.PropType = {
    type: PropTypes.oneOf(Object.values(DimensionType)),
};

export default React.memo(CanvasLayout);
