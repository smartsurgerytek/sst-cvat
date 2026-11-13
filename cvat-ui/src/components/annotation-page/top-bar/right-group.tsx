// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useCallback, useState } from 'react';
import { Col } from 'antd/lib/grid';
import Icon, {
    DownOutlined, InfoCircleOutlined, MoreOutlined, VideoCameraOutlined,
} from '@ant-design/icons';
import Select from 'antd/lib/select';
import Button from 'antd/lib/button';
import Dropdown from 'antd/lib/dropdown';
import { useDispatch } from 'react-redux';
import { switchPlay } from 'actions/annotation-actions';
import Modal from 'antd/lib/modal';
import notification from 'antd/lib/notification';

import { FilterIcon, FullscreenIcon, GuideIcon } from 'icons';
import config from 'config';
import {
    DimensionType, Job, JobStage, JobState,
} from 'cvat-core-wrapper';
import { Workspace } from 'reducers';

import MDEditor from '@uiw/react-md-editor';
import SAM2Video from './sam2-video';
import VideoPhase from './video-phase';
import VideoOverlayExport from './video-overlay-export';

interface Props {
    showStatistics(): void;
    showFilters(): void;
    changeWorkspace(workspace: Workspace): void;
    jobInstance: Job;
    workspace: Workspace;
    annotationFilters: object[];
    initialOpenGuide: boolean;
}

function RightGroup(props: Props): JSX.Element {
    const {
        showStatistics,
        changeWorkspace,
        showFilters,
        workspace,
        jobInstance,
        annotationFilters,
        initialOpenGuide,
    } = props;

    const dispatch = useDispatch();
    const [activeVideoTool, setActiveVideoTool] = useState<string | null>(null);
    const [videoMenuOpen, setVideoMenuOpen] = useState(false);
    const [moreMenuOpen, setMoreMenuOpen] = useState(false);
    const filters = annotationFilters.length;

    useEffect(() => {
        setActiveVideoTool(null);
        setVideoMenuOpen(false);
        setMoreMenuOpen(false);
    }, [jobInstance.id]);

    const openGuide = useCallback(() => {
        const PADDING = Math.min(window.screen.availHeight, window.screen.availWidth) * 0.4;
        jobInstance.guide().then((guide) => {
            if (guide) {
                Modal.info({
                    icon: null,
                    width: window.screen.availWidth - PADDING,
                    className: 'cvat-annotation-view-markdown-guide-modal',
                    content: (
                        <MDEditor
                            visibleDragbar={false}
                            data-color-mode='light'
                            height={window.screen.availHeight - PADDING}
                            preview='preview'
                            hideToolbar
                            value={guide.markdown}
                        />
                    ),
                });
            }
        }).catch((error: unknown) => {
            notification.error({
                message: 'Could not receive annotation guide',
                description: error instanceof Error ? error.message : console.error('error'),
            });
        });
    }, [jobInstance]);

    useEffect(() => {
        if (Number.isInteger(jobInstance?.guideId)) {
            if (initialOpenGuide) {
                openGuide();
            } else if (
                jobInstance?.stage === JobStage.ANNOTATION &&
                jobInstance?.state === JobState.NEW
            ) {
                let seenGuides = [];
                try {
                    seenGuides = JSON.parse(localStorage.getItem('seenGuides') || '[]');
                    if (!Array.isArray(seenGuides) || seenGuides.some((el) => !Number.isInteger(el))) {
                        throw new Error('Wrong structure stored in local storage');
                    }
                } catch (error: unknown) {
                    seenGuides = [];
                }

                if (!seenGuides.includes(jobInstance.guideId)) {
                    // open guide if the user have not seen it yet
                    openGuide();
                    const updatedSeenGuides = Array
                        .from(new Set([
                            jobInstance.guideId,
                            ...seenGuides.slice(0, config.LOCAL_STORAGE_SEEN_GUIDES_MEMORY_LIMIT - 1),
                        ]));
                    localStorage.setItem('seenGuides', JSON.stringify(updatedSeenGuides));
                }
            }
        }
    }, []);

    return (
        <Col className='cvat-annotation-header-right-group'>
            {jobInstance.dimension === DimensionType.DIMENSION_2D && (
                <>
                    <Dropdown
                        trigger={['click']}
                        placement='bottomRight'
                        open={videoMenuOpen}
                        onOpenChange={setVideoMenuOpen}
                        menu={{
                            items: [
                                { key: 'phase', label: 'Phase · Stage annotation' },
                                { key: 'sam2', label: 'SAM2 Video · Video tracking' },
                                { type: 'divider' },
                                { key: 'export', label: 'Export annotated video' },
                            ],
                            onClick: ({ key }) => {
                                setVideoMenuOpen(false);
                                dispatch(switchPlay(false));
                                setActiveVideoTool(key);
                            },
                        }}
                    >
                        <Button
                            type='link'
                            className='cvat-annotation-header-button cvat-annotation-header-video-tools-button'
                            aria-haspopup='menu'
                            aria-expanded={videoMenuOpen}
                        >
                            <VideoCameraOutlined />
                            Video tools
                            <DownOutlined className='cvat-annotation-header-dropdown-arrow' />
                        </Button>
                    </Dropdown>
                    <VideoPhase
                        key={`phase-${jobInstance.id}`}
                        job={jobInstance}
                        visible={activeVideoTool === 'phase'}
                        onVisibleChange={(visible) => setActiveVideoTool(visible ? 'phase' : null)}
                    />
                    <VideoOverlayExport
                        key={`export-${jobInstance.id}`}
                        job={jobInstance}
                        visible={activeVideoTool === 'export'}
                        onVisibleChange={(visible) => setActiveVideoTool(visible ? 'export' : null)}
                    />
                    <SAM2Video
                        key={`sam2-${jobInstance.id}`}
                        job={jobInstance}
                        visible={activeVideoTool === 'sam2'}
                        onVisibleChange={(visible) => setActiveVideoTool(visible ? 'sam2' : null)}
                    />
                </>
            )}
            <Button
                type='link'
                className={`cvat-annotation-header-filters-button cvat-annotation-header-button ${filters ?
                    'filters-armed' : ''
                }`}
                onClick={showFilters}
            >
                <Icon component={FilterIcon} />
                Filters
            </Button>
            <Dropdown
                trigger={['click']}
                open={moreMenuOpen}
                onOpenChange={setMoreMenuOpen}
                menu={{
                    items: [
                        {
                            key: 'fullscreen',
                            icon: <Icon component={FullscreenIcon} />,
                            label: 'Fullscreen',
                            disabled: !window.document.fullscreenEnabled,
                        },
                        ...(jobInstance.guideId !== null ? [{
                            key: 'guide', icon: <Icon component={GuideIcon} />, label: 'Guide',
                        }] : []),
                        { key: 'info', icon: <InfoCircleOutlined />, label: 'Info' },
                    ],
                    onClick: ({ key }) => {
                        setMoreMenuOpen(false);
                        if (key === 'guide') openGuide();
                        else if (key === 'info') showStatistics();
                        else if (key === 'fullscreen') {
                            if (window.document.fullscreenElement) window.document.exitFullscreen();
                            else window.document.documentElement.requestFullscreen();
                        }
                    },
                }}
            >
                <Button
                    type='link'
                    className='cvat-annotation-header-button cvat-annotation-header-dropdown-button'
                    aria-haspopup='menu'
                    aria-expanded={moreMenuOpen}
                >
                    <MoreOutlined />
                    More
                    <DownOutlined className='cvat-annotation-header-dropdown-arrow' />
                </Button>
            </Dropdown>
            <div>
                <Select
                    popupClassName='cvat-workspace-selector-dropdown'
                    className='cvat-workspace-selector'
                    aria-label='Workspace'
                    onChange={changeWorkspace}
                    value={workspace}
                >
                    {Object.values(Workspace).map((ws) => {
                        if (jobInstance.dimension === DimensionType.DIMENSION_3D) {
                            if (ws === Workspace.STANDARD) {
                                return null;
                            }
                            return (
                                <Select.Option disabled={ws !== Workspace.STANDARD3D} key={ws} value={ws}>
                                    {ws}
                                </Select.Option>
                            );
                        }
                        if (ws !== Workspace.STANDARD3D) {
                            return (
                                <Select.Option key={ws} value={ws}>
                                    {ws}
                                </Select.Option>
                            );
                        }
                        return null;
                    })}
                </Select>
            </div>
        </Col>
    );
}

export default React.memo(RightGroup);
