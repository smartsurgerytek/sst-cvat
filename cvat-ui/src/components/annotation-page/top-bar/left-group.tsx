// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import { Col } from 'antd/lib/grid';
import Icon, {
    StopOutlined, CheckCircleOutlined, LoadingOutlined, CheckCircleTwoTone, SwapOutlined,
} from '@ant-design/icons';
import Modal from 'antd/lib/modal';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import config from 'config';

import { UndoIcon, RedoIcon } from 'icons';
import { ActiveControl, ToolsBlockerState } from 'reducers';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
import AnnotationMenuComponent from 'components/annotation-page/top-bar/annotation-menu';
import CVATTooltip from 'components/common/cvat-tooltip';
import { ShortcutScope } from 'utils/enums';
import { subKeyMap } from 'utils/component-subkeymap';
import GlobalHotKeys, { KeyMap } from 'utils/mousetrap-react';
import { finishDrawAvailable } from 'utils/drawing';
import SaveAnnotationsButton from './save-annotations-button';

interface Props {
    saving: boolean;
    undoAction?: string;
    redoAction?: string;
    undoShortcut: string;
    redoShortcut: string;
    drawShortcut: string;
    switchToolsBlockerShortcut: string;
    toolsBlockerState: ToolsBlockerState;
    activeControl: ActiveControl;
    keyMap: KeyMap;
    onUndoClick(): void;
    onRedoClick(): void;
    onFinishDraw(): void;
    onSwitchToolsBlockerState(): void;
    onFinishJob(): void;
}

const componentShortcuts = {
    UNDO: {
        name: 'Undo action',
        description: 'Cancel the latest action related with objects',
        sequences: ['ctrl+z'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
    REDO: {
        name: 'Redo action',
        description: 'Cancel undo action',
        sequences: ['ctrl+shift+z', 'ctrl+y'],
        scope: ShortcutScope.ANNOTATION_PAGE,
    },
    SWITCH_TOOLS_BLOCKER_STATE: {
        name: 'Switch algorithm blocker',
        description: 'Postpone running the algorithm for interaction tools',
        sequences: ['tab'],
        scope: ShortcutScope.STANDARD_WORKSPACE,
    },
};

registerComponentShortcuts(componentShortcuts);

function LeftGroup(props: Props): JSX.Element {
    const {
        saving,
        keyMap,
        undoAction,
        redoAction,
        undoShortcut,
        redoShortcut,
        drawShortcut,
        switchToolsBlockerShortcut,
        activeControl,
        toolsBlockerState,
        onUndoClick,
        onRedoClick,
        onFinishDraw,
        onSwitchToolsBlockerState,
        onFinishJob,
    } = props;

    const includesDoneButton = finishDrawAvailable(activeControl);
    const [rawCompareActive, setRawCompareActive] = useState<boolean>(false);
    const [rawCompareSwapped, setRawCompareSwapped] = useState<boolean>(() => {
        try {
            return JSON.parse(localStorage.getItem(config.RAW_COMPARE_SWAP_STORAGE_KEY) || 'false') === true;
        } catch (error: unknown) {
            return false;
        }
    });

    const includesToolsBlockerButton =
        [ActiveControl.OPENCV_TOOLS, ActiveControl.AI_TOOLS].includes(activeControl) && toolsBlockerState.buttonVisible;

    const handlers: Record<keyof typeof componentShortcuts, (event?: KeyboardEvent) => void> = {
        UNDO: (event: KeyboardEvent | undefined) => {
            event?.preventDefault();
            if (undoAction) {
                onUndoClick();
            }
        },
        REDO: (event: KeyboardEvent | undefined) => {
            event?.preventDefault();
            if (redoAction) {
                onRedoClick();
            }
        },
        SWITCH_TOOLS_BLOCKER_STATE: (event: KeyboardEvent | undefined) => {
            event?.preventDefault();
            onSwitchToolsBlockerState();
        },
    };

    useEffect(() => {
        const handler = (event: Event): void => {
            const detail = (event as CustomEvent).detail || {};
            setRawCompareActive(Boolean(detail.active));
        };
        window.addEventListener('cvat.rawCompareToggle', handler as EventListener);
        return () => window.removeEventListener('cvat.rawCompareToggle', handler as EventListener);
    }, []);

    return (
        <>
            <GlobalHotKeys keyMap={subKeyMap(componentShortcuts, keyMap)} handlers={handlers} />
            { saving && (
                <Modal
                    open
                    destroyOnClose
                    className='cvat-saving-job-modal'
                    closable={false}
                    footer={[]}
                >
                    <Text>CVAT is saving your annotations, please wait </Text>
                    <LoadingOutlined />
                </Modal>
            )}
            <Col className='cvat-annotation-header-left-group'>
                <AnnotationMenuComponent />
                <SaveAnnotationsButton />
                <CVATTooltip overlay={`Undo: ${undoAction} ${undoShortcut}`}>
                    <Button
                        style={{ pointerEvents: undoAction ? 'initial' : 'none', opacity: undoAction ? 1 : 0.5 }}
                        type='link'
                        className='cvat-annotation-header-undo-button cvat-annotation-header-button'
                        onClick={onUndoClick}
                    >
                        <Icon component={UndoIcon} />
                        <span>Undo</span>
                    </Button>
                </CVATTooltip>
                <CVATTooltip overlay={`Redo: ${redoAction} ${redoShortcut}`}>
                    <Button
                        style={{ pointerEvents: redoAction ? 'initial' : 'none', opacity: redoAction ? 1 : 0.5 }}
                        type='link'
                        className='cvat-annotation-header-redo-button cvat-annotation-header-button'
                        onClick={onRedoClick}
                    >
                        <Icon component={RedoIcon} />
                        Redo
                    </Button>
                </CVATTooltip>
                <CVATTooltip overlay='Save and complete job'>
                    <Button
                        type='link'
                        disabled={saving}
                        className='cvat-annotation-header-finish-job-button cvat-annotation-header-button'
                        onClick={() => {
                            Modal.confirm({
                                title: 'Finish this job?',
                                content: 'It will save annotations and set the job state to "completed".',
                                okText: 'Finish job',
                                cancelText: 'Cancel',
                                className: 'cvat-modal-content-finish-job',
                                onOk: onFinishJob,
                            });
                        }}
                    >
                        <CheckCircleTwoTone />
                        Finish Job
                    </Button>
                </CVATTooltip>
                {rawCompareActive && (
                    <Button
                        type='link'
                        className='cvat-annotation-header-raw-compare-swap-button cvat-annotation-header-button'
                        onClick={() => {
                            const next = !rawCompareSwapped;
                            setRawCompareSwapped(next);
                            localStorage.setItem(config.RAW_COMPARE_SWAP_STORAGE_KEY, JSON.stringify(next));
                            window.dispatchEvent(new CustomEvent('cvat.rawCompareSwap', { detail: { swapped: next } }));
                        }}
                    >
                        <SwapOutlined />
                        Swap
                    </Button>
                )}
                {includesDoneButton ? (
                    <CVATTooltip overlay={`Press "${drawShortcut}" to finish`}>
                        <Button type='link' className='cvat-annotation-header-done-button cvat-annotation-header-button' onClick={onFinishDraw}>
                            <CheckCircleOutlined />
                            Done
                        </Button>
                    </CVATTooltip>
                ) : null}
                {includesToolsBlockerButton ? (
                    <CVATTooltip overlay={`Press "${switchToolsBlockerShortcut}" to postpone running the algorithm `}>
                        <Button
                            type='link'
                            className={`cvat-annotation-header-block-tool-button cvat-annotation-header-button ${
                                toolsBlockerState.algorithmsLocked ? 'cvat-button-active' : ''
                            }`}
                            onClick={onSwitchToolsBlockerState}
                        >
                            <StopOutlined />
                            Block
                        </Button>
                    </CVATTooltip>
                ) : null}
            </Col>
        </>
    );
}

export default React.memo(LeftGroup);
