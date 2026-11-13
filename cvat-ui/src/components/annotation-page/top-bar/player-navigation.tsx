// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useState, useEffect, useCallback, CSSProperties,
} from 'react';

import Axios from 'axios';
import { getCore } from 'cvat-core-wrapper';

import { Row, Col } from 'antd/lib/grid';
import Icon, {
    LinkOutlined, DeleteOutlined, CopyOutlined, SearchOutlined,
} from '@ant-design/icons';
import Slider, { SliderMarks } from 'antd/lib/slider';
import InputNumber from 'antd/lib/input-number';
import Radio from 'antd/lib/radio';
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
import { Chapter, getDownloadedChunks } from 'cvat-core/src/frames';
import { videoDownloadSpeed } from 'cvat-core/src/video-download-speed';
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

function formatVideoTime(seconds: number): string {
    const milliseconds = Math.max(0, Math.round(seconds * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor(milliseconds / 60000) % 60;
    const remainder = Math.floor(milliseconds / 1000) % 60;
    return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${
        String(remainder).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

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

    const job = useSelector((state: CombinedState) => state.annotation.job.instance);
    const jobID = job?.id;
    const includedFrames = useSelector((state: CombinedState) => state.annotation.job.frameNumbers);
    const [downloadedChunks, setDownloadedChunks] = useState<number[]>([]);
    const originalVideo = jobID ? originalVideoSource(jobID) : undefined;
    const [navigationMode, setNavigationMode] = useState<'frame' | 'time'>('time');
    const [videoTiming, setVideoTiming] = useState<{
        jobID: number; timestamps: number[]; duration: number;
    } | null>(null);
    const [timingError, setTimingError] = useState(false);
    const isVideo = Boolean(originalVideo) || job?.mode === 'interpolation';
    const timing = originalVideo || (videoTiming?.jobID === jobID ? videoTiming : null);
    const showTime = Boolean(timing) && navigationMode === 'time';
    useEffect(() => {
        setTimingError(false);
        if (!jobID || originalVideo || !isVideo) return undefined;
        let active = true;
        Axios.get(`${getCore().config.backendAPI}/jobs/${jobID}/video-timing`)
            .then(({ data }) => { if (active) setVideoTiming({ ...data, jobID }); })
            .catch(() => { if (active) setTimingError(true); });
        return () => { active = false; };
    }, [jobID, isVideo, originalVideo]);
    const [cachedVideoRanges, setCachedVideoRanges] = useState<[number, number][]>([]);
    useEffect(() => {
        const refresh = (): void => {
            setCachedVideoRanges(jobID ? originalVideoCachedRanges(jobID) : []);
            setDownloadedChunks(jobID ? getDownloadedChunks(jobID) : []);
        };
        refresh();
        const timer = window.setInterval(refresh, 500);
        return () => window.clearInterval(timer);
    }, [jobID]);
    const [downloadSpeed, setDownloadSpeed] = useState<{ active: boolean; mbps: number | null }>({
        active: false, mbps: null,
    });
    useEffect(() => {
        const refresh = (): void => setDownloadSpeed(videoDownloadSpeed(
            originalVideo ? `video:${originalVideo.id}` : `job:${jobID}`,
        ));
        refresh();
        const timer = window.setInterval(refresh, 500);
        return () => window.clearInterval(timer);
    }, [jobID, originalVideo]);
    const timeAt = (frame: number): number => timing?.timestamps[frame] || 0;
    const frameAt = (time: number): number => {
        // Select the sample displayed at this time, including variable-frame-rate videos.
        let low = startFrame;
        let high = stopFrame;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (timeAt(middle) <= time) low = middle;
            else high = middle - 1;
        }
        return low;
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
    }).filter((range) => Number.isFinite(range.width) && range.width > 0) : [
        ...ranges.split(';').filter(Boolean),
        ...downloadedChunks.map((chunk) => {
            const size = job?.dataChunkSize || 1;
            const start = includedFrames[chunk * size];
            const stop = includedFrames[Math.min(includedFrames.length - 1, (chunk + 1) * size - 1)];
            return `${start}:${stop}`;
        }),
    ].map((range) => {
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

    let navigationLabel = frameFilename;
    if (timing) {
        navigationLabel = showTime ?
            `${formatVideoTime(timeAt(frameNumber))} / ${formatVideoTime(timing.duration)}` :
            `Frame ${frameNumber} / ${stopFrame}`;
    }

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
                            tooltip={{
                                formatter: (value) => {
                                    if (value === undefined) return '';
                                    if (!timing) return value;
                                    const frame = originalVideo ? frameAt(value) : value;
                                    return showTime ? formatVideoTime(timeAt(frame)) : `Frame ${frame}`;
                                },
                            }}
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
                                {navigationLabel}
                            </Text>
                        </CVATTooltip>
                    </Col>
                    {isVideo && (
                        <Col style={{ marginLeft: 12 }}>
                            <Text
                                type='secondary'
                                className='cvat-video-download-speed'
                                title='Video download speed, including response wait time. Updated every 0.5 seconds.'
                                style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                            >
                                {downloadSpeed.active ? `Download: ${downloadSpeed.mbps === null ?
                                    'Measuring…' : `${downloadSpeed.mbps.toFixed(1)} Mbps`}` : `Download: Buffered / Idle${downloadedChunks.length ? ` · ${downloadedChunks.length} chunks` : ''}`}
                            </Text>
                        </Col>
                    )}
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
            {isVideo && (
                <Col>
                    <Radio.Group
                        size='small'
                        value={showTime ? 'time' : 'frame'}
                        aria-label='Video navigation mode'
                        onChange={(event) => {
                            setFrameInputValue(frameNumber);
                            setNavigationMode(event.target.value);
                        }}
                    >
                        <Radio.Button value='frame'>Frame</Radio.Button>
                        <Radio.Button
                            value='time'
                            disabled={!timing}
                            title={timingError ? 'Video timing unavailable' : 'Current video time / total duration'}
                        >
                            {timing || timingError ? 'Time' : 'Time…'}
                        </Radio.Button>
                    </Radio.Group>
                </Col>
            )}
            <Col>
                <CVATTooltip title={`Press ${focusFrameInputShortcut} to focus here`}>
                    <InputNumber
                        ref={inputFrameRef}
                        className='cvat-player-frame-selector'
                        type='number'
                        disabled={workspace === Workspace.SINGLE_SHAPE}
                        value={showTime ? +timeAt(frameInputValue).toFixed(3) : frameInputValue}
                        aria-label={showTime ? 'Video time in seconds' : 'Frame number'}
                        min={showTime ? timeAt(startFrame) : startFrame}
                        max={showTime ? timeAt(stopFrame) : stopFrame}
                        step={showTime ? 0.001 : 1}
                        style={{ ['--frame-input-width' as string]: `${showTime ? Math.max(10, timeAt(stopFrame).toFixed(3).length + 2) : stopFrame.toString().length + 2}ch` }}
                        onChange={(value: number | undefined | string | null) => {
                            if (typeof value !== 'undefined' && value !== null) {
                                setFrameInputValue(showTime ?
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
