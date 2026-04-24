// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import ReactDOM from 'react-dom';

import { connect, ConnectedProps } from 'react-redux';
import GlobalHotKeys, { KeyMap } from 'utils/mousetrap-react';
import Button from 'antd/lib/button';
import message from 'antd/lib/message';
import Modal from 'antd/lib/modal';
import { DeleteOutlined } from '@ant-design/icons';

import ObjectsListComponent from 'components/annotation-page/standard-workspace/objects-side-bar/objects-list';
import LabelSelector from 'components/label-selector/label-selector';
import {
    updateAnnotationsAsync,
    changeFrameAsync,
    collapseObjectItems,
    changeGroupColorAsync,
    copyShape as copyShapeAction,
    switchPropagateVisibility as switchPropagateVisibilityAction,
    removeObject as removeObjectAction,
    removeObjectAsync,
    fetchAnnotationsAsync,
    changeHideActiveObjectAsync,
} from 'actions/annotation-actions';
import {
    changeShowGroundTruth as changeShowGroundTruthAction,
} from 'actions/settings-actions';
import isAbleToChangeFrame from 'utils/is-able-to-change-frame';
import logger, { EventScope, logError } from 'cvat-logger';
import {
    CombinedState, StatesOrdering, ColorBy, Workspace,
    ActiveControl,
} from 'reducers';
import {
    Label, ObjectState, ObjectType, ShapeType,
} from 'cvat-core-wrapper';
import { filterAnnotations } from 'utils/filter-annotations';
import { filterApplicableLabels } from 'utils/filter-applicable-labels';
import {
    OBJECTS_SIDEBAR_TOGGLE_MULTI_SELECTION_EVENT,
    ObjectsSidebarToggleMultiSelectionEventDetail,
} from 'utils/objects-sidebar-multi-select';
import { registerComponentShortcuts } from 'actions/shortcuts-actions';
import { ShortcutScope } from 'utils/enums';
import { subKeyMap } from 'utils/component-subkeymap';
import { openAnnotationsActionModal } from 'components/annotation-page/annotations-actions/annotations-actions-modal';

interface OwnProps {
    readonly: boolean;
}

interface StateToProps {
    jobInstance: any;
    labels: Label[];
    frameNumber: any;
    statesHidden: boolean;
    statesLocked: boolean;
    statesCollapsedAll: boolean;
    collapsedStates: Record<number, boolean>;
    objectStates: ObjectState[];
    annotationsFilters: any[];
    colors: string[];
    colorBy: ColorBy;
    activatedStateID: number | null;
    activatedElementID: number | null;
    minZLayer: number;
    maxZLayer: number;
    keyMap: KeyMap;
    normalizedKeyMap: Record<string, string>;
    showGroundTruth: boolean;
    workspace: Workspace;
    editedState: ObjectState | null,
    activeControl: ActiveControl,
    activeObjectHidden: boolean,
}

interface DispatchToProps {
    updateAnnotations(states: any[]): void;
    collapseStates(states: any[], value: boolean): void;
    removeObject: (objectState: any, force: boolean) => void;
    removeObjectImmediately: (objectState: ObjectState, force: boolean) => Promise<void>;
    copyShape: (objectState: any) => void;
    switchPropagateVisibility: (visible: boolean) => void;
    changeFrame(frame: number): void;
    changeGroupColor(group: number, color: string): void;
    changeShowGroundTruth(value: boolean): void;
    changeHideEditedState(value: boolean): void;
}

const componentShortcuts = {
    SWITCH_ALL_LOCK: {
        name: 'Lock/unlock all objects',
        description: 'Change locked state for all objects in the side bar',
        sequences: ['t l'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    SWITCH_LOCK: {
        name: 'Lock/unlock an object',
        description: 'Change locked state for an active object',
        sequences: ['l'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    SWITCH_ALL_HIDDEN: {
        name: 'Hide/show all objects',
        description: 'Change hidden state for objects in the side bar',
        sequences: ['t h'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    SWITCH_HIDDEN: {
        name: 'Hide/show an object',
        description: 'Change hidden state for an active object',
        sequences: ['h'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    SWITCH_OCCLUDED: {
        name: 'Switch occluded',
        description: 'Change occluded property for an active object',
        sequences: ['q', '/'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    SWITCH_PINNED: {
        name: 'Switch pinned property',
        description: 'Change pinned property for an active object',
        sequences: ['p'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    SWITCH_KEYFRAME: {
        name: 'Switch keyframe',
        description: 'Change keyframe property for an active track',
        sequences: ['k'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    SWITCH_OUTSIDE: {
        name: 'Switch outside',
        description: 'Change outside property for an active track',
        sequences: ['o'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    DELETE_OBJECT_STANDARD_WORKSPACE: {
        name: 'Delete object',
        description: 'Delete an active object. Use shift to force delete of locked objects',
        sequences: ['del', 'shift+del'],
        scope: ShortcutScope.STANDARD_WORKSPACE,
    },
    TO_BACKGROUND: {
        name: 'To background',
        description: 'Put an active object "farther" from the user (decrease z axis value)',
        sequences: ['-', '_'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    TO_FOREGROUND: {
        name: 'To foreground',
        description: 'Put an active object "closer" to the user (increase z axis value)',
        sequences: ['+', '='],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    COPY_SHAPE: {
        name: 'Copy shape',
        description: 'Copy shape to CVAT internal clipboard',
        sequences: ['ctrl+c'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    RUN_ANNOTATIONS_ACTION: {
        name: 'Run annotations action',
        description: 'Opens a dialog with annotations actions',
        sequences: ['ctrl+e'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    PROPAGATE_OBJECT: {
        name: 'Propagate object',
        description: 'Make a copy of the object on the following frames',
        sequences: ['ctrl+b'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    NEXT_KEY_FRAME: {
        name: 'Next keyframe',
        description: 'Go to the next keyframe of an active track',
        sequences: ['r'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    PREV_KEY_FRAME: {
        name: 'Previous keyframe',
        description: 'Go to the previous keyframe of an active track',
        sequences: ['e'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
    CHANGE_OBJECT_COLOR: {
        name: 'Change color',
        description: 'Set the next color for an activated shape',
        sequences: ['enter'],
        scope: ShortcutScope.OBJECTS_SIDEBAR,
    },
};

const BULK_LABEL_SELECTOR_VIEWPORT_MARGIN = 16;
const BULK_LABEL_SELECTOR_MAX_WIDTH = 220;
const BULK_LABEL_SELECTOR_CONTROL_HEIGHT = 40;

registerComponentShortcuts(componentShortcuts);

function mapStateToProps(state: CombinedState): StateToProps {
    const {
        annotation: {
            annotations: {
                states: objectStates,
                filters: annotationsFilters,
                collapsed,
                collapsedAll,
                activatedStateID,
                activatedElementID,
                zLayer: { min: minZLayer, max: maxZLayer },
            },
            job: { instance: jobInstance, labels },
            player: {
                frame: { number: frameNumber },
            },
            canvas: {
                activeControl, activeObjectHidden,
            },
            editing: { objectState: editedState },
            colors,
            workspace,
        },
        settings: {
            shapes: { colorBy, showGroundTruth },
        },
        shortcuts: { keyMap, normalizedKeyMap },
    } = state;

    let statesHidden = true;
    let statesLocked = true;

    objectStates.forEach((objectState: ObjectState) => {
        const { lock } = objectState;
        if (!lock) {
            if (objectState.objectType !== ObjectType.TAG) {
                if (objectState.shapeType === ShapeType.SKELETON) {
                    objectState.elements.forEach((element: ObjectState) => {
                        statesHidden = statesHidden && (element.lock || element.hidden);
                    });
                } else {
                    statesHidden = statesHidden && objectState.hidden;
                }
            }
            statesLocked = statesLocked && objectState.lock;
        }
    });

    return {
        statesHidden,
        statesLocked,
        statesCollapsedAll: collapsedAll,
        collapsedStates: collapsed,
        objectStates,
        frameNumber,
        jobInstance,
        labels,
        annotationsFilters,
        colors,
        colorBy,
        activatedStateID,
        activatedElementID,
        minZLayer,
        maxZLayer,
        keyMap,
        normalizedKeyMap,
        showGroundTruth,
        workspace,
        editedState,
        activeControl,
        activeObjectHidden,
    };
}

function mapDispatchToProps(dispatch: any): DispatchToProps {
    return {
        updateAnnotations(states: ObjectState[]): void {
            dispatch(updateAnnotationsAsync(states));
        },
        collapseStates(states: ObjectState[], collapsed: boolean): void {
            dispatch(collapseObjectItems(states, collapsed));
        },
        removeObject(objectState: ObjectState, force: boolean): void {
            dispatch(removeObjectAction(objectState, force));
        },
        removeObjectImmediately(objectState: ObjectState, force: boolean): Promise<void> {
            return dispatch(removeObjectAsync(objectState, force));
        },
        copyShape(objectState: ObjectState): void {
            dispatch(copyShapeAction(objectState));
        },
        switchPropagateVisibility(visible: boolean): void {
            dispatch(switchPropagateVisibilityAction(visible));
        },
        changeFrame(frame: number): void {
            dispatch(changeFrameAsync(frame));
        },
        changeGroupColor(group: number, color: string): void {
            dispatch(changeGroupColorAsync(group, color));
        },
        changeShowGroundTruth(value: boolean): void {
            dispatch(changeShowGroundTruthAction(value));
            dispatch(fetchAnnotationsAsync());
        },
        changeHideEditedState(value: boolean): void {
            dispatch(changeHideActiveObjectAsync(value));
        },
    };
}

function sortAndMap(objectStates: ObjectState[], ordering: StatesOrdering): number[] {
    let sorted = [];
    if (ordering === StatesOrdering.ID_ASCENT) {
        sorted = [...objectStates].sort((a: any, b: any): number => a.clientID - b.clientID);
    } else if (ordering === StatesOrdering.ID_DESCENT) {
        sorted = [...objectStates].sort((a: any, b: any): number => b.clientID - a.clientID);
    } else if (ordering === StatesOrdering.UPDATED) {
        sorted = [...objectStates].sort((a: any, b: any): number => b.updated - a.updated);
    } else {
        sorted = [...objectStates].sort((a: any, b: any): number => a.zOrder - b.zOrder);
    }

    return sorted.map((state: any) => state.clientID);
}

interface BulkLabelSelectorState {
    visible: boolean;
    // This stores the preferred source item for the popup; render still falls back to another
    // compatible selected item if the preferred one cannot change labels.
    sourceStateID: number | null;
    left: number;
    top: number;
}

interface PendingBulkLabelSelectorState {
    // Preserve the user's last canvas target so keyup can open the popup near that interaction.
    sourceStateID: number;
    left: number;
    top: number;
}

interface State {
    statesOrdering: StatesOrdering;
    objectStates: ObjectState[];
    filteredStates: ObjectState[];
    sortedStatesID: number[];
    selectedStateIDs: number[];
    bulkLabelSelector: BulkLabelSelectorState;
}

const connector = connect(mapStateToProps, mapDispatchToProps);

type PropsFromRedux = ConnectedProps<typeof connector>;
type Props = PropsFromRedux & OwnProps;

class ObjectsListContainer extends React.PureComponent<Props, State> {
    private pendingBulkLabelSelector: PendingBulkLabelSelectorState | null = null;
    private lastMultiSelectSource: 'canvas' | null = null;

    private lastPointerPosition = {
        left: 0,
        top: 0,
    };

    public constructor(props: Props) {
        super(props);
        this.state = {
            statesOrdering: StatesOrdering.ID_ASCENT,
            objectStates: [],
            filteredStates: [],
            sortedStatesID: [],
            selectedStateIDs: [],
            bulkLabelSelector: this.hiddenBulkLabelSelector(),
        };
    }

    public componentDidMount(): void {
        window.addEventListener('keydown', this.onModifierKeyDown);
        window.addEventListener('keyup', this.onModifierKeyUp);
        window.addEventListener('mousedown', this.onOutsideBulkLabelSelectorClick);
        window.addEventListener('blur', this.onWindowBlur);
        window.document.addEventListener(
            OBJECTS_SIDEBAR_TOGGLE_MULTI_SELECTION_EVENT,
            this.onCanvasToggleSelection as EventListener,
        );
        this.updateObjects();
    }

    public componentDidUpdate(prevProps: Props): void {
        const {
            objectStates, workspace, readonly, frameNumber,
        } = this.props;
        const { objectStates: prevObjectStates } = this.state;
        const frameChanged = prevProps.frameNumber !== frameNumber;
        const workspaceChanged = prevProps.workspace !== workspace;
        const readonlyChanged = prevProps.readonly !== readonly;
        const shouldClearSelection = frameChanged || workspaceChanged || readonlyChanged;

        if (
            objectStates !== prevObjectStates ||
            frameChanged ||
            workspaceChanged ||
            readonlyChanged
        ) {
            this.updateObjects({ clearSelection: shouldClearSelection });
        }
    }

    public componentWillUnmount(): void {
        window.removeEventListener('keydown', this.onModifierKeyDown);
        window.removeEventListener('keyup', this.onModifierKeyUp);
        window.removeEventListener('mousedown', this.onOutsideBulkLabelSelectorClick);
        window.removeEventListener('blur', this.onWindowBlur);
        window.document.removeEventListener(
            OBJECTS_SIDEBAR_TOGGLE_MULTI_SELECTION_EVENT,
            this.onCanvasToggleSelection as EventListener,
        );
    }

    private hiddenBulkLabelSelector = (): BulkLabelSelectorState => ({
        visible: false,
        sourceStateID: null,
        left: 0,
        top: 0,
    });

    private isSelectionModifierKey = (key: string): boolean => key === 'Control' || key === 'Meta';

    private logInternal = (type: string, payload: Record<string, unknown> = {}): void => {
        const { jobInstance } = this.props;
        const targetLogger = jobInstance?.logger?.log ? jobInstance.logger : logger;
        const eventPayload = {
            type,
            source: 'objects_sidebar_multi_select',
            ...payload,
        };

        try {
            targetLogger.log(EventScope.debugInfo, eventPayload, false)
                .catch((error: unknown) => {
                    logError(error, false, {
                        type: 'objects_sidebar_internal_log_failed',
                        source_type: type,
                    });
                });
        } catch (error: unknown) {
            logError(error, false, {
                type: 'objects_sidebar_internal_log_failed_sync',
                source_type: type,
            });
        }
    };

    private isMultiSelectEnabled = (): boolean => {
        const { workspace, readonly } = this.props;
        return workspace === Workspace.STANDARD && !readonly;
    };

    private getPointerPosition = (
        event?: Pick<MouseEvent, 'clientX' | 'clientY'> | Pick<React.MouseEvent, 'clientX' | 'clientY'>,
    ): { left: number; top: number } => {
        if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            this.lastPointerPosition = {
                left: event.clientX,
                top: event.clientY,
            };
        }

        return this.lastPointerPosition;
    };

    private resolveBulkLabelSourceState = (
        options: {
            preferredSourceStateID?: number | null;
            selectedStateIDs?: number[];
            states?: ObjectState[];
        } = {},
    ): ObjectState | null => {
        const { labels } = this.props;
        const {
            selectedStateIDs: currentSelectedStateIDs,
            objectStates: currentObjectStates,
        } = this.state;
        const {
            preferredSourceStateID = null,
            selectedStateIDs = currentSelectedStateIDs,
            states = currentObjectStates,
        } = options;

        const selectedSet = new Set(selectedStateIDs);
        const stateByID = new Map(
            states.map((state: ObjectState): [number, ObjectState] => [state.clientID as number, state]),
        );
        const candidateIDs: number[] = [];

        if (
            Number.isInteger(preferredSourceStateID) &&
            selectedSet.has(preferredSourceStateID as number)
        ) {
            candidateIDs.push(preferredSourceStateID as number);
        }

        for (let index = selectedStateIDs.length - 1; index >= 0; index -= 1) {
            candidateIDs.push(selectedStateIDs[index]);
        }

        const checkedIDs = new Set<number>();

        // Keep the popup usable even if the last clicked object cannot change labels, such as skeletons.
        for (const candidateID of candidateIDs) {
            if (checkedIDs.has(candidateID)) {
                continue;
            }

            checkedIDs.add(candidateID);
            const state = stateByID.get(candidateID);
            if (
                state &&
                state.shapeType !== ShapeType.SKELETON &&
                filterApplicableLabels(state, labels).length
            ) {
                return state;
            }
        }

        return null;
    };

    private clampBulkLabelSelectorPosition = (
        position: Pick<BulkLabelSelectorState, 'left' | 'top'>,
    ): { left: number; top: number } => {
        const availableWidth = Math.max(
            0,
            window.innerWidth - BULK_LABEL_SELECTOR_VIEWPORT_MARGIN * 2,
        );
        // Keep this in sync with the anchor width in styles.scss.
        const anchorWidth = Math.min(BULK_LABEL_SELECTOR_MAX_WIDTH, availableWidth);
        const maxLeft = Math.max(
            BULK_LABEL_SELECTOR_VIEWPORT_MARGIN,
            window.innerWidth - anchorWidth - BULK_LABEL_SELECTOR_VIEWPORT_MARGIN,
        );
        const maxTop = Math.max(
            BULK_LABEL_SELECTOR_VIEWPORT_MARGIN,
            window.innerHeight - BULK_LABEL_SELECTOR_CONTROL_HEIGHT - BULK_LABEL_SELECTOR_VIEWPORT_MARGIN,
        );

        return {
            left: Math.min(Math.max(position.left, BULK_LABEL_SELECTOR_VIEWPORT_MARGIN), maxLeft),
            top: Math.min(Math.max(position.top, BULK_LABEL_SELECTOR_VIEWPORT_MARGIN), maxTop),
        };
    };

    private updateObjects = (
        options: {
            clearSelection?: boolean;
        } = {},
    ): void => {
        const {
            objectStates, frameNumber, workspace,
        } = this.props;
        const { clearSelection = false } = options;
        const filteredStates = filterAnnotations(objectStates, {
            frame: frameNumber,
            workspace,
        });

        if (clearSelection) {
            this.pendingBulkLabelSelector = null;
            this.lastMultiSelectSource = null;
        }

        this.setState((prevState) => {
            const sortedStatesID = sortAndMap(filteredStates, prevState.statesOrdering);
            // Keep the selection and popup anchor limited to states that still exist
            // in the current frame/workspace snapshot.
            const availableStateIDs = new Set(sortedStatesID);
            const selectedStateIDs = clearSelection ?
                [] :
                prevState.selectedStateIDs
                    .filter((id: number): boolean => availableStateIDs.has(id));
            const bulkLabelSourceState = this.resolveBulkLabelSourceState({
                preferredSourceStateID: prevState.bulkLabelSelector.sourceStateID,
                selectedStateIDs,
                states: objectStates,
            });
            const bulkLabelSelectorValid = Boolean(
                !clearSelection &&
                prevState.bulkLabelSelector.visible &&
                selectedStateIDs.length >= 2 &&
                bulkLabelSourceState,
            );
            const pendingBulkLabelSourceState = this.pendingBulkLabelSelector ?
                this.resolveBulkLabelSourceState({
                    preferredSourceStateID: this.pendingBulkLabelSelector.sourceStateID,
                    selectedStateIDs,
                    states: objectStates,
                }) :
                null;
            const pendingBulkLabelSelectorValid = Boolean(
                !clearSelection &&
                this.pendingBulkLabelSelector &&
                selectedStateIDs.length >= 2 &&
                pendingBulkLabelSourceState,
            );

            if (!pendingBulkLabelSelectorValid) {
                this.pendingBulkLabelSelector = null;
            }

            return {
                objectStates,
                filteredStates,
                sortedStatesID,
                selectedStateIDs,
                bulkLabelSelector: bulkLabelSelectorValid ?
                    {
                        ...prevState.bulkLabelSelector,
                        sourceStateID: bulkLabelSourceState?.clientID ?? null,
                    } :
                    this.hiddenBulkLabelSelector(),
            };
        });
    };

    private onChangeStatesOrdering = (statesOrdering: StatesOrdering): void => {
        const { filteredStates } = this.state;
        this.setState({
            statesOrdering,
            sortedStatesID: sortAndMap(filteredStates, statesOrdering),
        });
    };

    private resetBulkLabelSelector = (clearSelectedStateIDs = false): void => {
        this.pendingBulkLabelSelector = null;
        this.lastMultiSelectSource = null;
        this.setState((prevState) => ({
            selectedStateIDs: clearSelectedStateIDs ? [] : prevState.selectedStateIDs,
            bulkLabelSelector: this.hiddenBulkLabelSelector(),
        }));
    };

    private clearMultiSelectionState = (): void => {
        this.resetBulkLabelSelector(true);
    };

    private onWindowBlur = (): void => {
        this.resetBulkLabelSelector(false);
    };

    private onModifierKeyDown = (event: KeyboardEvent): void => {
        if (!this.isMultiSelectEnabled()) {
            this.pendingBulkLabelSelector = null;
            this.lastMultiSelectSource = null;
            return;
        }

        if (!this.isSelectionModifierKey(event.key) || event.repeat) {
            return;
        }

        const { selectedStateIDs } = this.state;
        // A fresh modifier-assisted selection starts a new batch session for both canvas and checkbox flows.
        if (selectedStateIDs.length) {
            this.clearMultiSelectionState();
        }
    };

    private onModifierKeyUp = (event: KeyboardEvent): void => {
        if (!this.isMultiSelectEnabled()) {
            this.pendingBulkLabelSelector = null;
            this.lastMultiSelectSource = null;
            return;
        }

        if (!this.isSelectionModifierKey(event.key) || this.lastMultiSelectSource !== 'canvas') {
            return;
        }

        // Checkbox multi-select stays inline; only canvas-driven multi-select opens
        // the floating batch actions after the modifier key is released.
        const pending = this.pendingBulkLabelSelector;
        this.pendingBulkLabelSelector = null;
        this.lastMultiSelectSource = null;

        this.setState((prevState) => {
            if (prevState.selectedStateIDs.length < 2) {
                return {
                    bulkLabelSelector: this.hiddenBulkLabelSelector(),
                };
            }

            const sourceState = this.resolveBulkLabelSourceState({
                preferredSourceStateID: pending?.sourceStateID ?? null,
                selectedStateIDs: prevState.selectedStateIDs,
                states: prevState.objectStates,
            });

            if (!sourceState) {
                return {
                    bulkLabelSelector: this.hiddenBulkLabelSelector(),
                };
            }

            return {
                bulkLabelSelector: {
                    visible: true,
                    sourceStateID: sourceState.clientID as number,
                    left: pending?.left ?? this.lastPointerPosition.left,
                    top: pending?.top ?? this.lastPointerPosition.top,
                },
            };
        });
    };

    private onOutsideBulkLabelSelectorClick = (event: MouseEvent): void => {
        const {
            bulkLabelSelector: { visible },
        } = this.state;

        if (!visible || !(event.target instanceof Element)) {
            return;
        }

        if (
            event.target.closest('.cvat-objects-sidebar-bulk-label-selector-anchor') ||
            event.target.closest('.cvat-objects-sidebar-bulk-label-selector-dropdown')
        ) {
            return;
        }

        this.resetBulkLabelSelector(false);
    };

    private toggleMultiSelection = (
        clientID: number,
        pointerPosition: { left: number; top: number },
        deferBulkLabelOpen: boolean,
    ): void => {
        if (!this.isMultiSelectEnabled()) {
            this.lastMultiSelectSource = null;
            return;
        }

        this.setState((prevState) => {
            if (!prevState.filteredStates.some((state: ObjectState): boolean => state.clientID === clientID)) {
                this.logInternal('objects_sidebar_toggle_multi_select_state_not_found', {
                    clientID,
                    deferBulkLabelOpen,
                    filteredStatesCount: prevState.filteredStates.length,
                });
                return null;
            }

            const nextSelectedStateIDs = prevState.selectedStateIDs.includes(clientID) ?
                prevState.selectedStateIDs.filter((id: number): boolean => id !== clientID) :
                [...prevState.selectedStateIDs, clientID];

            const nextBulkLabelSelector = this.hiddenBulkLabelSelector();

            return {
                selectedStateIDs: nextSelectedStateIDs,
                bulkLabelSelector: nextBulkLabelSelector,
            };
        }, () => {
            const { selectedStateIDs } = this.state;
            if (!selectedStateIDs.length) {
                this.pendingBulkLabelSelector = null;
                this.lastMultiSelectSource = null;
                return;
            }

            if (deferBulkLabelOpen && selectedStateIDs.length >= 2) {
                // Let users keep Ctrl/Cmd-clicking on the canvas without fighting the popup;
                // the selector appears once the modifier key is released.
                this.lastMultiSelectSource = 'canvas';
                const previousPendingSourceID = this.pendingBulkLabelSelector?.sourceStateID;
                let sourceStateID = clientID;

                if (!selectedStateIDs.includes(clientID)) {
                    if (
                        typeof previousPendingSourceID === 'number' &&
                        selectedStateIDs.includes(previousPendingSourceID)
                    ) {
                        sourceStateID = previousPendingSourceID;
                    } else {
                        sourceStateID = selectedStateIDs[selectedStateIDs.length - 1]!;
                    }
                }

                this.pendingBulkLabelSelector = {
                    sourceStateID,
                    left: pointerPosition.left,
                    top: pointerPosition.top,
                };
            } else {
                this.pendingBulkLabelSelector = null;
                this.lastMultiSelectSource = deferBulkLabelOpen ? 'canvas' : null;
            }
        });
    };

    private onSidebarToggleSelection = (clientID: number): void => {
        this.toggleMultiSelection(clientID, this.lastPointerPosition, false);
    };

    private onCanvasToggleSelection = (event: Event): void => {
        if (!this.isMultiSelectEnabled()) {
            return;
        }

        const customEvent = event as CustomEvent<ObjectsSidebarToggleMultiSelectionEventDetail>;
        const { detail } = customEvent;
        if (!detail || typeof detail !== 'object') {
            this.logInternal('objects_sidebar_canvas_multi_select_invalid_payload', {
                reason: 'detail_is_not_object',
            });
            return;
        }

        const { clientID, position } = detail;
        if (
            !Number.isInteger(clientID) ||
            !position ||
            typeof position !== 'object' ||
            !Number.isFinite(position.x) ||
            !Number.isFinite(position.y)
        ) {
            this.logInternal('objects_sidebar_canvas_multi_select_invalid_payload', {
                reason: 'detail_fields_invalid',
                clientIDIsInteger: Number.isInteger(clientID),
                hasPosition: Boolean(position && typeof position === 'object'),
                positionXIsFinite: Number.isFinite(position?.x),
                positionYIsFinite: Number.isFinite(position?.y),
            });
            return;
        }

        const pointerPosition = this.getPointerPosition({
            clientX: position.x,
            clientY: position.y,
        });
        this.toggleMultiSelection(clientID, pointerPosition, true);
    };

    private onBulkLabelSelectorChange = (label: Label): void => {
        this.bulkChangeLabel(label);
        this.clearMultiSelectionState();
    };

    private onBulkRemoveButtonMouseDown = (event: React.MouseEvent<HTMLButtonElement>): void => {
        event.preventDefault();
        event.stopPropagation();
        this.bulkRemoveObjects(false);
    };

    private getSelectedStates = (): ObjectState[] => {
        const { filteredStates, selectedStateIDs } = this.state;
        const selectedSet = new Set(selectedStateIDs);

        return filteredStates.filter(
            (state: ObjectState): boolean => selectedSet.has(state.clientID as number),
        );
    };

    private removeSelectedStates = async (statesToRemove: ObjectState[], force: boolean): Promise<void> => {
        const { removeObjectImmediately } = this.props;

        this.clearMultiSelectionState();

        // Preserve the same ordered async behavior as repeated single-object deletes.
        for (const state of statesToRemove) {
            await removeObjectImmediately(state, force);
        }
    };

    private bulkRemoveObjects = (force = false): boolean => {
        if (!this.isMultiSelectEnabled()) {
            return false;
        }

        const selectedStates = this.getSelectedStates();
        if (selectedStates.length < 2) {
            return false;
        }

        const lockedCount = selectedStates.filter((state: ObjectState): boolean => state.lock).length;
        const trackCount = selectedStates.filter(
            (state: ObjectState): boolean => state.objectType === ObjectType.TRACK,
        ).length;

        if (!force && (lockedCount > 0 || trackCount > 0)) {
            Modal.confirm({
                title: 'Remove selected objects',
                className: 'cvat-modal-confirm-remove-object',
                content: (
                    <>
                        <p>{`Are you sure you want to remove ${selectedStates.length} selected object(s)?`}</p>
                        {trackCount > 0 ? (
                            <p>{`${trackCount} selected object(s) are tracks. Removing them also removes drawn objects on other frames.`}</p>
                        ) : null}
                        {lockedCount > 0 ? (
                            <p>{`${lockedCount} selected object(s) are locked and will be force removed.`}</p>
                        ) : null}
                    </>
                ),
                okType: 'primary',
                okText: 'Remove selected',
                cancelText: 'Cancel',
                onOk: () => this.removeSelectedStates(selectedStates, true),
            });
        } else {
            void this.removeSelectedStates(selectedStates, force);
        }

        return true;
    };

    private bulkChangeLabel = (label: Label): boolean => {
        const { updateAnnotations, labels } = this.props;
        const { objectStates, selectedStateIDs } = this.state;
        const sourceState = this.resolveBulkLabelSourceState();

        if (!this.isMultiSelectEnabled() || selectedStateIDs.length < 2 || !sourceState) {
            return false;
        }

        const selectedSet = new Set(selectedStateIDs);
        const selectedStates = objectStates.filter(
            (state: ObjectState): boolean => selectedSet.has(state.clientID as number),
        );
        const updatedStates: ObjectState[] = [];

        for (const state of selectedStates) {
            const labelIsApplicable = state.shapeType !== ShapeType.SKELETON &&
                filterApplicableLabels(state, labels).some((applicableLabel: Label): boolean => (
                    applicableLabel.id === label.id
                ));

            // Batch relabel is best-effort: incompatible or locked states are skipped
            // instead of aborting the whole selection.
            if (!state.lock && labelIsApplicable) {
                state.label = label;
                updatedStates.push(state);
            }
        }

        if (updatedStates.length) {
            updateAnnotations(updatedStates);
        }

        const skipped = selectedStates.length - updatedStates.length;
        if (skipped > 0) {
            this.logInternal('objects_sidebar_batch_label_partial_skip', {
                sourceStateID: sourceState.clientID,
                selectedCount: selectedStates.length,
                updatedCount: updatedStates.length,
                skippedCount: skipped,
                labelID: label.id,
            });
            message.warning(
                `Updated ${updatedStates.length} object(s). Skipped ${skipped} incompatible or locked object(s).`,
            );
        }

        return updatedStates.length > 0;
    };

    private onLockAllStates = (): void => {
        this.lockAllStates(true);
    };

    private onUnlockAllStates = (): void => {
        this.lockAllStates(false);
    };

    private onCollapseAllStates = (): void => {
        this.collapseAllStates(true);
    };

    private onExpandAllStates = (): void => {
        this.collapseAllStates(false);
    };

    private onHideAllStates = (): void => {
        this.hideAllStates(true);
    };

    private onShowAllStates = (): void => {
        this.hideAllStates(false);
    };

    private changeShowGroundTruth = (): void => {
        const { showGroundTruth, changeShowGroundTruth } = this.props;
        changeShowGroundTruth(!showGroundTruth);
    };

    private lockAllStates(locked: boolean): void {
        const { updateAnnotations, readonly } = this.props;
        const { filteredStates } = this.state;

        if (!readonly) {
            for (const objectState of filteredStates) {
                objectState.lock = locked;
            }

            updateAnnotations(filteredStates);
        }
    }

    private hideAllStates(hidden: boolean): void {
        const { updateAnnotations, editedState, changeHideEditedState } = this.props;
        const { filteredStates } = this.state;

        if (editedState?.shapeType === ShapeType.MASK) {
            changeHideEditedState(hidden);
        }

        for (const objectState of filteredStates) {
            objectState.hidden = hidden;
        }

        updateAnnotations(filteredStates);
    }

    private collapseAllStates(collapsed: boolean): void {
        const { collapseStates } = this.props;
        const { filteredStates } = this.state;

        collapseStates(filteredStates, collapsed);
    }

    public render(): JSX.Element {
        const {
            statesHidden,
            statesLocked,
            activatedStateID,
            activatedElementID,
            maxZLayer,
            minZLayer,
            keyMap,
            normalizedKeyMap,
            colors,
            labels,
            colorBy,
            readonly,
            statesCollapsedAll,
            showGroundTruth,
            updateAnnotations,
            changeGroupColor,
            removeObject,
            copyShape,
            switchPropagateVisibility,
            changeFrame,
            workspace,
        } = this.props;
        const {
            objectStates, sortedStatesID, statesOrdering, filteredStates, selectedStateIDs, bulkLabelSelector,
        } = this.state;
        const multiSelectEnabled = this.isMultiSelectEnabled();
        const bulkLabelSelectorPosition = this.clampBulkLabelSelectorPosition(bulkLabelSelector);
        const sourceState = this.resolveBulkLabelSourceState({
            preferredSourceStateID: bulkLabelSelector.sourceStateID,
        });
        const labelSelectorLabels = sourceState && sourceState.shapeType !== ShapeType.SKELETON ?
            filterApplicableLabels(sourceState, labels) :
            [];
        const shouldRenderBulkLabelSelector = Boolean(
            multiSelectEnabled &&
            bulkLabelSelector.visible &&
            selectedStateIDs.length >= 2 &&
            sourceState &&
            labelSelectorLabels.length,
        );

        const preventDefault = (event: KeyboardEvent | undefined): void => {
            if (event) {
                event.preventDefault();
            }
        };

        const activatedState = (ignoreElements = false): ObjectState | null => {
            if (activatedStateID !== null) {
                const state = objectStates
                    .find((objectState: ObjectState): boolean => objectState.clientID === activatedStateID);

                if (state && activatedElementID !== null && !ignoreElements) {
                    const element = state.elements
                        .find((_element: ObjectState): boolean => _element.clientID === activatedElementID);
                    return element || null;
                }

                return state || null;
            }

            return null;
        };

        const handlers: Record<keyof typeof componentShortcuts, (event?: KeyboardEvent) => void> = {
            SWITCH_ALL_LOCK: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                this.lockAllStates(!statesLocked);
            },
            SWITCH_LOCK: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state && !readonly) {
                    state.lock = !state.lock;
                    updateAnnotations([state]);
                }
            },
            SWITCH_ALL_HIDDEN: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                this.hideAllStates(!statesHidden);
            },
            SWITCH_HIDDEN: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                const {
                    editedState, changeHideEditedState, activeControl, activeObjectHidden,
                } = this.props;
                if (editedState?.shapeType === ShapeType.MASK || activeControl === ActiveControl.DRAW_MASK) {
                    const hide = editedState ? !editedState.hidden : !activeObjectHidden;
                    changeHideEditedState(hide);
                }
                if (state) {
                    state.hidden = !state.hidden;
                    updateAnnotations([state]);
                }
            },
            SWITCH_OCCLUDED: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state && !readonly && state.objectType !== ObjectType.TAG) {
                    state.occluded = !state.occluded;
                    updateAnnotations([state]);
                }
            },
            SWITCH_PINNED: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState(true);
                if (state && !readonly) {
                    state.pinned = !state.pinned;
                    updateAnnotations([state]);
                }
            },
            SWITCH_KEYFRAME: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state && !readonly && state.objectType === ObjectType.TRACK) {
                    const { first, last } = state.keyframes as NonNullable<typeof state.keyframes>;
                    if (first !== last || !state.keyframe) {
                        state.keyframe = !state.keyframe;
                        updateAnnotations([state]);
                    }
                }
            },
            SWITCH_OUTSIDE: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state && !readonly && (state.objectType === ObjectType.TRACK || state.parentID)) {
                    state.outside = !state.outside;
                    updateAnnotations([state]);
                }
            },
            DELETE_OBJECT_STANDARD_WORKSPACE: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                if (!readonly && this.bulkRemoveObjects(Boolean(event?.shiftKey))) {
                    return;
                }

                const state = activatedState(true);
                if (state && !readonly) {
                    removeObject(state, event ? event.shiftKey : false);
                }
            },
            CHANGE_OBJECT_COLOR: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state) {
                    if (colorBy === ColorBy.GROUP && state.group) {
                        const colorID = (colors.indexOf(state.group.color) + 1) % colors.length;
                        changeGroupColor(state.group.id, colors[colorID]);
                        return;
                    }

                    if (colorBy === ColorBy.INSTANCE) {
                        const colorID = (colors.indexOf(state.color) + 1) % colors.length;
                        state.color = colors[colorID];
                        updateAnnotations([state]);
                    }
                }
            },
            TO_BACKGROUND: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState(true);
                if (state && !readonly && state.objectType !== ObjectType.TAG) {
                    state.zOrder = minZLayer - 1;
                    updateAnnotations([state]);
                }
            },
            TO_FOREGROUND: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState(true);
                if (state && !readonly && state.objectType !== ObjectType.TAG) {
                    state.zOrder = maxZLayer + 1;
                    updateAnnotations([state]);
                }
            },
            COPY_SHAPE: () => {
                const state = activatedState(true);
                if (state && !readonly) {
                    copyShape(state);
                }
            },
            RUN_ANNOTATIONS_ACTION: () => {
                const state = activatedState(true);
                if (!readonly) {
                    if (state) {
                        openAnnotationsActionModal({ defaultObjectState: state });
                    } else {
                        openAnnotationsActionModal();
                    }
                }
            },
            PROPAGATE_OBJECT: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state && !readonly) {
                    switchPropagateVisibility(true);
                }
            },
            NEXT_KEY_FRAME: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state && state.keyframes) {
                    const frame = typeof state.keyframes.next === 'number' ? state.keyframes.next : null;
                    if (frame !== null && isAbleToChangeFrame(frame)) {
                        changeFrame(frame);
                    }
                }
            },
            PREV_KEY_FRAME: (event: KeyboardEvent | undefined) => {
                preventDefault(event);
                const state = activatedState();
                if (state && state.keyframes) {
                    const frame = typeof state.keyframes.prev === 'number' ? state.keyframes.prev : null;
                    if (frame !== null && isAbleToChangeFrame(frame)) {
                        changeFrame(frame);
                    }
                }
            },
        };

        return (
            <>
                <GlobalHotKeys keyMap={subKeyMap(componentShortcuts, keyMap)} handlers={handlers} />
                <ObjectsListComponent
                    statesHidden={statesHidden}
                    statesLocked={statesLocked}
                    statesCollapsedAll={statesCollapsedAll}
                    readonly={readonly || false}
                    workspace={workspace}
                    statesOrdering={statesOrdering}
                    sortedStatesID={sortedStatesID}
                    selectedStateIDs={selectedStateIDs}
                    multiSelectEnabled={multiSelectEnabled}
                    showGroundTruth={showGroundTruth}
                    objectStates={filteredStates}
                    onToggleSelection={multiSelectEnabled ? this.onSidebarToggleSelection : undefined}
                    clearMultiSelectionState={multiSelectEnabled ? this.clearMultiSelectionState : undefined}
                    bulkChangeLabel={multiSelectEnabled ? this.bulkChangeLabel : undefined}
                    bulkRemoveObjects={multiSelectEnabled ? this.bulkRemoveObjects : undefined}
                    switchHiddenAllShortcut={normalizedKeyMap.SWITCH_ALL_HIDDEN}
                    switchLockAllShortcut={normalizedKeyMap.SWITCH_ALL_LOCK}
                    changeStatesOrdering={this.onChangeStatesOrdering}
                    lockAllStates={this.onLockAllStates}
                    unlockAllStates={this.onUnlockAllStates}
                    collapseAllStates={this.onCollapseAllStates}
                    expandAllStates={this.onExpandAllStates}
                    hideAllStates={this.onHideAllStates}
                    showAllStates={this.onShowAllStates}
                    changeShowGroundTruth={this.changeShowGroundTruth}
                />
                {shouldRenderBulkLabelSelector && ReactDOM.createPortal(
                    <div
                        className='cvat-objects-sidebar-bulk-label-selector-anchor'
                        style={{
                            left: bulkLabelSelectorPosition.left,
                            top: bulkLabelSelectorPosition.top,
                        }}
                    >
                        <LabelSelector
                            autoFocus
                            open
                            size='middle'
                            labels={labelSelectorLabels}
                            value={sourceState?.label?.id ?? null}
                            popupClassName='cvat-objects-sidebar-bulk-label-selector-dropdown'
                            className='cvat-objects-sidebar-bulk-label-selector'
                            onChange={this.onBulkLabelSelectorChange}
                            dropdownRender={(menu): JSX.Element => (
                                <div>
                                    {menu}
                                    <div className='cvat-objects-sidebar-bulk-label-selector-actions'>
                                        <Button
                                            block
                                            danger
                                            type='primary'
                                            icon={<DeleteOutlined />}
                                            className='cvat-objects-sidebar-bulk-remove-button'
                                            onMouseDown={this.onBulkRemoveButtonMouseDown}
                                        >
                                            Remove
                                        </Button>
                                    </div>
                                </div>
                            )}
                            onDropdownVisibleChange={(open: boolean): void => {
                                if (!open) {
                                    this.resetBulkLabelSelector(false);
                                }
                            }}
                        />
                    </div>,
                    window.document.body,
                )}
            </>
        );
    }
}

export default connector(ObjectsListContainer);
