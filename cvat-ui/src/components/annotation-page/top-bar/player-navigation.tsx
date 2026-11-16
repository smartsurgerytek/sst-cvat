// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useState, useEffect, useCallback, CSSProperties,
} from 'react';

import { Row, Col } from 'antd/lib/grid';
import Icon, {
    LinkOutlined, DeleteOutlined, CopyOutlined, SearchOutlined,
} from '@ant-design/icons';
import Slider, { SliderMarks } from 'antd/lib/slider';
import InputNumber from 'antd/lib/input-number';
import Text from 'antd/lib/typography/Text';
import Modal from 'antd/lib/modal';
import Tooltip from 'antd/lib/tooltip';

import { Workspace, CombinedState } from 'reducers';
import { RestoreIcon } from 'icons';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
import CVATTooltip from 'components/common/cvat-tooltip';
import { clamp } from 'utils/math';
import GlobalHotKeys, { KeyMap } from 'utils/mousetrap-react';
import { ShortcutScope } from 'utils/enums';
import { subKeyMap } from 'utils/component-subkeymap';
import { Chapter } from 'cvat-core/src/frames';
import { usePlugins } from 'utils/hooks';
import { useSelector } from 'react-redux';
import { originalVideoCachedRanges, originalVideoSource } from 'cvat-core/src/original-video';

interface Props {
    startFrame: number;
    stopFrame: number;
    playing: boolean;
    ranges: string;
    frameNumber: number;
    chapters: Chapter[] | null;
    hoveredChapter: number | null;
    frameFilename: string;
    frameDeleted: boolean;
    deleteFrameShortcut: string;
    focusFrameInputShortcut: string;
    searchFrameByNameShortcut: string;
    showSearchFrameByName: boolean;
    inputFrameRef: React.RefObject<HTMLInputElement>;
    keyMap: KeyMap;
    workspace: Workspace;
    onSliderChange(value: number): void;
    onInputChange(value: number): void;
    onURLIconClick(): void;
    onCopyFilenameIconClick(): void;
    onDeleteFrame(): void;
    onRestoreFrame(): void;
    switchNavigationBlocked(blocked: boolean): void;
    switchShowSearchPallet(visible: boolean): void;
}

const componentShortcuts = {
    DELETE_FRAME: {
        name: 'Delete frame',
        description: 'Delete frame',
        sequences: ['alt+del'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
    FOCUS_INPUT_FRAME: {
        name: 'Focus input frame',
        description: 'Focus on the element to change the current frame',
        sequences: ['`'],
        displayedSequences: ['~'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
    SEARCH_FRAME_BY_NAME: {
        name: 'Search frame by name',
        description: 'Open search frame by name dialog',
        sequences: [],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
};

registerComponentShortcuts(componentShortcuts);

function PlayerNavigation(props: Props): JSX.Element {
    const {
        startFrame,
        stopFrame,
        chapters,
        hoveredChapter,
        playing,
        frameNumber,
        frameFilename,
        frameDeleted,
        deleteFrameShortcut,
        focusFrameInputShortcut,
        searchFrameByNameShortcut,
        inputFrameRef,
        ranges,
        keyMap,
        workspace,
        onSliderChange,
        onInputChange,
        onURLIconClick,
        onCopyFilenameIconClick,
        onDeleteFrame,
        onRestoreFrame,
        switchNavigationBlocked,
        switchShowSearchPallet,
        showSearchFrameByName,
    } = props;

    const jobID = useSelector((state: CombinedState) => state.annotation.job.instance?.id);
    const originalVideo = jobID ? originalVideoSource(jobID) : undefined;
    const [cachedVideoRanges, setCachedVideoRanges] = useState<[number, number][]>([]);
    useEffect(() => {
        const refresh = (): void => setCachedVideoRanges(jobID ? originalVideoCachedRanges(jobID) : []);
        refresh();
        const timer = window.setInterval(refresh, 500);
        return () => window.clearInterval(timer);
    }, [jobID]);
    const timeAt = (frame: number): number => originalVideo?.timestamps[frame] || 0;
    const frameAt = (time: number): number => {
        const index = originalVideo!.timestamps.findIndex((value) => value >= time);
        return index < 0 ? stopFrame : index;
    };
    const [frameInputValue, setFrameInputValue] = useState<number>(frameNumber);

    const cacheRanges = originalVideo ? cachedVideoRanges.map(([start, end]) => {
        const min = timeAt(startFrame);
        const max = timeAt(stopFrame);
        const duration = max - min;
        return {
            start: (Math.max(0, start - min) / duration) * 1000,
            width: (Math.max(0, Math.min(end, max) - Math.max(start, min)) / duration) * 1000,
        };
    }).filter((range) => Number.isFinite(range.width) && range.width > 0) : ranges.split(';').filter(Boolean).map((range) => {
        const [start, stop] = range.split(':').map(Number);
        const count = stopFrame - startFrame + 1;
        return {
            start: (Math.max(0, start - startFrame) / count) * 1000,
            width: ((stop - start + 1) / count) * 1000,
        };
    });

    const playerSliderPlugins = usePlugins(
        (state: CombinedState) => state.plugins.components.annotationPage.player.slider,
        props,
    );

    useEffect(() => {
        if (frameNumber !== frameInputValue) {
            setFrameInputValue(frameNumber);
        }
    }, [frameNumber]);

    const showDeleteFrameDialog = useCallback(() => {
        if (!playing) {
            switchNavigationBlocked(true);
            Modal.confirm({
                title: `Do you want to delete frame #${frameNumber}?`,
                content: 'The frame will not be visible in navigation and exported datasets, but it still can be restored with all the annotations.',
                className: 'cvat-modal-delete-frame',
                okText: 'Delete',
                okType: 'danger',
                onOk: () => {
                    switchNavigationBlocked(false);
                    onDeleteFrame();
                },
                afterClose: () => {
                    switchNavigationBlocked(false);
                },
            });
        }
    }, [playing, frameNumber]);

    const handlers: Record<keyof typeof componentShortcuts, (event?: KeyboardEvent) => void> = {
        DELETE_FRAME: (event: KeyboardEvent | undefined) => {
            event?.preventDefault();
            onDeleteFrame();
        },
        FOCUS_INPUT_FRAME: (event: KeyboardEvent | undefined) => {
            event?.preventDefault();
            if (inputFrameRef.current) {
                inputFrameRef.current.focus();
            }
        },
        SEARCH_FRAME_BY_NAME: (event: KeyboardEvent | undefined) => {
            if (showSearchFrameByName) {
                event?.preventDefault();
                switchShowSearchPallet(true);
            }
        },
    };

    const onSearchIconClick = useCallback(() => {
        switchShowSearchPallet(true);
    }, [switchShowSearchPallet]);

    const deleteFrameIconStyle: CSSProperties = workspace === Workspace.SINGLE_SHAPE ? {
        pointerEvents: 'none',
        opacity: 0.5,
    } : {};

    const marks: SliderMarks = (chapters ?? []).reduce<SliderMarks>((acc, chapter) => {
        const active = hoveredChapter === chapter.id;
        const innerAcc = acc ?? {};
        innerAcc[chapter.start] = {
            label:
                    <Tooltip title={`${chapter.metadata.title}`}>
                        <span className={`ant-slider-mark-chapter ${active ? 'active' : ''}`} />
                    </Tooltip>,
        };
        return innerAcc;
    }, {});

    const deleteFrameIcon = !frameDeleted ? (
        <CVATTooltip title={`Delete the frame ${deleteFrameShortcut}`}>
            <DeleteOutlined
                style={deleteFrameIconStyle}
                className='cvat-player-delete-frame'
                onClick={showDeleteFrameDialog}
            />
        </CVATTooltip>
    ) : (
        <CVATTooltip title='Restore the frame'>
            <Icon
                style={deleteFrameIconStyle}
                className='cvat-player-restore-frame'
                onClick={onRestoreFrame}
                component={RestoreIcon}
            />
        </CVATTooltip>
    );

    return (
        <>
            { workspace !== Workspace.SINGLE_SHAPE && (
                <GlobalHotKeys keyMap={subKeyMap(componentShortcuts, keyMap)} handlers={handlers} />
            )}
            <Col className='cvat-player-controls'>
                <Row align='bottom'>
                    <Col style={{ position: 'relative' }}>
                        <Slider
                            className='cvat-player-slider'
                            min={originalVideo ? timeAt(startFrame) : startFrame}
                            max={originalVideo ? timeAt(stopFrame) : stopFrame}
                            step={originalVideo ? 0.001 : 1}
                            marks={originalVideo ? undefined : marks}
                            value={originalVideo ? timeAt(frameNumber) : (frameNumber || 0)}
                            onChange={workspace !== Workspace.SINGLE_SHAPE ? (value) => (
                                onSliderChange(originalVideo ? frameAt(value) : value)
                            ) : undefined}
                            tooltip={{ formatter: (value) => (originalVideo ? `${value?.toFixed(3)} s` : value) }}
                        />
                        {!!cacheRanges.length && (
                            <svg
                                className='cvat-player-slider-progress'
                                viewBox='0 0 1000 16'
                                xmlns='http://www.w3.org/2000/svg'
                                aria-label='Downloaded frames (green)'
                            >
                                {cacheRanges.map((range) => (
                                    <rect
                                        rx={10}
                                        key={range.start}
                                        x={range.start}
                                        y={0}
                                        height={16}
                                        width={range.width}
                                    />
                                ))}
                            </svg>
                        )}
                        {playerSliderPlugins
                            .sort((a, b) => a.weight - b.weight)
                            .map(({ component: Component }, index) => {
                                const ComponentToRender = Component as React.ComponentType<any>;
                                return <ComponentToRender key={index} targetProps={props} />;
                            })}
                    </Col>
                </Row>
                <Row justify='center'>
                    <Col className='cvat-player-filename-wrapper'>
                        <CVATTooltip title={`${frameFilename}`}>
                            <Text type='secondary'>
                                {originalVideo ?
                                    `${timeAt(frameNumber).toFixed(3)} / ${originalVideo.duration.toFixed(3)} s` :
                                    frameFilename}
                            </Text>
                        </CVATTooltip>
                    </Col>
                    <Col className='cvat-player-frame-actions' offset={1}>
                        <CVATTooltip title='Copy frame filename'>
                            <CopyOutlined className='cvat-player-copy-frame-name-icon' onClick={onCopyFilenameIconClick} />
                        </CVATTooltip>
                        <CVATTooltip title='Create frame URL'>
                            <LinkOutlined className='cvat-player-frame-url-icon' onClick={onURLIconClick} />
                        </CVATTooltip>
                        { deleteFrameIcon }
                    </Col>
                </Row>
            </Col>
            <Col>
                <CVATTooltip title={`Press ${focusFrameInputShortcut} to focus here`}>
                    <InputNumber
                        ref={inputFrameRef}
                        className='cvat-player-frame-selector'
                        type='number'
                        disabled={workspace === Workspace.SINGLE_SHAPE}
                        value={originalVideo ? +timeAt(frameInputValue).toFixed(3) : frameInputValue}
                        aria-label={originalVideo ? 'Video time in seconds' : 'Frame number'}
                        min={originalVideo ? timeAt(startFrame) : startFrame}
                        max={originalVideo ? timeAt(stopFrame) : stopFrame}
                        step={originalVideo ? 0.001 : 1}
                        style={{ ['--frame-input-width' as string]: `${stopFrame.toString().length + 2}ch` }}
                        onChange={(value: number | undefined | string | null) => {
                            if (typeof value !== 'undefined' && value !== null) {
                                setFrameInputValue(originalVideo ?
                                    frameAt(+value) : Math.floor(clamp(+value, startFrame, stopFrame)));
                            }
                        }}
                        onFocus={() => inputFrameRef.current?.select()}
                        onBlur={() => {
                            onInputChange(frameInputValue);
                        }}
                        onPressEnter={() => {
                            onInputChange(frameInputValue);
                        }}
                    />
                </CVATTooltip>
            </Col>
            <Col className='cvat-player-actions'>
                {
                    showSearchFrameByName && (
                        <CVATTooltip title={`Search frame by name ${searchFrameByNameShortcut}`}>
                            <SearchOutlined
                                className='cvat-player-search-frame-name-icon'
                                onClick={onSearchIconClick}
                            />
                        </CVATTooltip>
                    )
                }
            </Col>
        </>
    );
}

export default React.memo(PlayerNavigation);
