// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import ReactDOM from 'react-dom';
import PropTypes from 'prop-types';
import message from 'antd/lib/message';

import { connect } from 'react-redux';
import GlobalHotKeys, { KeyMap } from 'utils/mousetrap-react';

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
    fetchAnnotationsAsync,
    changeHideActiveObjectAsync,
} from 'actions/annotation-actions';
import {
    changeShowGroundTruth as changeShowGroundTruthAction,
} from 'actions/settings-actions';
import isAbleToChangeFrame from 'utils/is-able-to-change-frame';
import {
    CombinedState, StatesOrdering, ColorBy, Workspace,
    ActiveControl,
} from 'reducers';
import {
    JobStage, Label, LabelType, ObjectState, ObjectType, ShapeType,
} from 'cvat-core-wrapper';
import { filterAnnotations } from 'utils/filter-annotations';
import { filterApplicableLabels } from 'utils/filter-applicable-labels';
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
        labels,
        frameNumber,
        jobInstance,
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

type Props = StateToProps & DispatchToProps & OwnProps;

interface BulkLabelSelectorState {
    visible: boolean;
    sourceStateID: number | null;
    left: number;
    top: number;
}

interface PendingBulkLabelSelectorState {
    sourceStateID: number;
    left: number;
    top: number;
}

interface State {
    statesOrdering: StatesOrdering;
    objectStates: ObjectState[];
    filteredStates: ObjectState[];
    sortedStatesID: number[];
    selectedStatesID: number[];
    bulkLabelSelector: BulkLabelSelectorState;
    selectedStateIDs: number[];
    floatingLabelOpen: boolean;
    floatingLabelPosition: { x: number; y: number } | null;
    selectedLabelID: number | null;
    selectionSource: 'canvas' | 'sidebar' | null;
}

class ObjectsListContainer extends React.PureComponent<Props, State> {
    private pendingBulkLabelSelector: PendingBulkLabelSelectorState | null = null;
    private checkboxModifierSelectionActive = false;

    private lastPointerPosition = {
        left: 0,
        top: 0,
    };

    static propTypes = {
        readonly: PropTypes.bool,
    };

    static defaultProps = {
        readonly: false,
    };

    private isValidationMode(): boolean {
        return this.props.jobInstance?.stage === JobStage.VALIDATION;
    }

    public constructor(props: Props) {
        super(props);
        this.state = {
            statesOrdering: StatesOrdering.ID_ASCENT,
            objectStates: [],
            filteredStates: [],
            sortedStatesID: [],
            selectedStatesID: [],
            bulkLabelSelector: {
                visible: false,
                sourceStateID: null,
                left: 0,
                top: 0,
            },
            selectedStateIDs: [],
            floatingLabelOpen: false,
            floatingLabelPosition: null,
            selectedLabelID: null,
            selectionSource: null,
        };
    }

    public componentDidMount(): void {
        window.addEventListener('keyup', this.onModifierKeyUp);
        window.addEventListener('mousedown', this.onOutsideBulkLabelSelectorClick);
        this.updateObjects();
        window.document.addEventListener('keyup', this.onDocumentKeyUp);
        window.document.addEventListener('keydown', this.onDocumentKeyDown);
        window.document.addEventListener('mousedown', this.onDocumentMouseDown);
    }

    public componentDidUpdate(prevProps: Props): void {
        const { objectStates } = this.props;
        const { objectStates: prevObjectStates } = this.state;
        if (objectStates !== prevObjectStates) {
            this.updateObjects();
        }
        if (this.isValidationMode() && (
            this.state.selectedStateIDs.length ||
            this.state.selectedStatesID.length ||
            this.state.bulkLabelSelector.visible
        )) {
            this.pendingBulkLabelSelector = null;
            this.checkboxModifierSelectionActive = false;
            this.setState({
                selectedStatesID: [],
                bulkLabelSelector: {
                    visible: false,
                    sourceStateID: null,
                    left: 0,
                    top: 0,
                },
                selectedStateIDs: [],
                floatingLabelOpen: false,
                floatingLabelPosition: null,
                selectedLabelID: null,
                selectionSource: null,
            });
        }
    }

    public componentWillUnmount(): void {
        window.removeEventListener('keyup', this.onModifierKeyUp);
        window.removeEventListener('mousedown', this.onOutsideBulkLabelSelectorClick);
        window.document.removeEventListener('keyup', this.onDocumentKeyUp);
        window.document.removeEventListener('keydown', this.onDocumentKeyDown);
        window.document.removeEventListener('mousedown', this.onDocumentMouseDown);
    }

    private updateObjects = (): void => {
        const {
            objectStates, frameNumber, workspace,
        } = this.props;
        const filteredStates = filterAnnotations(objectStates, {
            frame: frameNumber,
            workspace,
        });
        this.setState((prevState) => {
            const sortedStatesID = sortAndMap(filteredStates, prevState.statesOrdering);
            const availableStateIDs = new Set(sortedStatesID);
            const mergedSelectedStateIDs = Array.from(new Set([
                ...prevState.selectedStatesID,
                ...prevState.selectedStateIDs,
            ])).filter((id: number) => availableStateIDs.has(id));

            const bulkLabelSourceIsValid = prevState.bulkLabelSelector.sourceStateID !== null &&
                availableStateIDs.has(prevState.bulkLabelSelector.sourceStateID) &&
                mergedSelectedStateIDs.includes(prevState.bulkLabelSelector.sourceStateID);

            const nextBulkLabelSelector = bulkLabelSourceIsValid ?
                prevState.bulkLabelSelector :
                {
                    visible: false,
                    sourceStateID: null,
                    left: 0,
                    top: 0,
                };

            if (!bulkLabelSourceIsValid) {
                this.pendingBulkLabelSelector = null;
            }

            const nextSelectedLabelID = mergedSelectedStateIDs.length ?
                filteredStates.find((state: ObjectState) => state.clientID === mergedSelectedStateIDs[0])?.label?.id ?? null :
                null;
            const hasSelection = mergedSelectedStateIDs.length > 0;

            return {
                objectStates,
                filteredStates,
                sortedStatesID,
                selectedStatesID: mergedSelectedStateIDs,
                bulkLabelSelector: nextBulkLabelSelector,
                selectedStateIDs: mergedSelectedStateIDs,
                floatingLabelOpen: hasSelection ? prevState.floatingLabelOpen : false,
                floatingLabelPosition: hasSelection ? prevState.floatingLabelPosition : null,
                selectedLabelID: nextSelectedLabelID,
                selectionSource: hasSelection ? prevState.selectionSource : null,
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

    private resetBulkLabelSelector = (clearSelectedStates = false): void => {
        this.pendingBulkLabelSelector = null;
        if (clearSelectedStates) {
            this.checkboxModifierSelectionActive = false;
        }
        this.setState((prevState) => ({
            selectedStatesID: clearSelectedStates ? [] : prevState.selectedStatesID,
            selectedStateIDs: clearSelectedStates ? [] : prevState.selectedStateIDs,
            bulkLabelSelector: {
                visible: false,
                sourceStateID: null,
                left: 0,
                top: 0,
            },
            ...(clearSelectedStates ? {
                floatingLabelOpen: false,
                floatingLabelPosition: null,
                selectedLabelID: null,
                selectionSource: null,
            } : {}),
        }));
    };

    private clearSidebarMultiSelection = (): void => {
        // Clears checkbox/multi-select state and related bulk UI, but keeps active object unchanged.
        this.resetBulkLabelSelector(true);
    };

    private getPointerPosition = (event?: React.MouseEvent): { left: number; top: number } => {
        if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            this.lastPointerPosition = {
                left: event.clientX,
                top: event.clientY,
            };
        }

        return this.lastPointerPosition;
    };

    private onModifierKeyUp = (event: KeyboardEvent): void => {
        if (!['Control', 'Meta'].includes(event.key) || !this.pendingBulkLabelSelector) {
            return;
        }

        const { pendingBulkLabelSelector } = this;
        this.pendingBulkLabelSelector = null;

        this.setState((prevState) => {
            const {
                sourceStateID, left, top,
            } = pendingBulkLabelSelector;
            if (prevState.selectedStatesID.length < 2 || !prevState.selectedStatesID.includes(sourceStateID)) {
                return null;
            }

            return {
                bulkLabelSelector: {
                    visible: true,
                    sourceStateID,
                    left,
                    top,
                },
            };
        });
    };

    private onBulkLabelSelectorChange = (label: Label): void => {
        const {
            bulkLabelSelector: { sourceStateID },
        } = this.state;
        if (sourceStateID !== null) {
            this.bulkChangeLabel(sourceStateID, label);
        }

        this.resetBulkLabelSelector(true);
    };

    private onOutsideBulkLabelSelectorClick = (event: MouseEvent): void => {
        const {
            bulkLabelSelector: { visible },
        } = this.state;

        if (!visible || !(event.target instanceof Element)) {
            return;
        }

        const clickInsideAnchor = event.target.closest('.cvat-objects-sidebar-bulk-label-selector-anchor');
        const clickInsideDropdown = event.target.closest('.cvat-objects-sidebar-bulk-label-selector-dropdown');

        if (!clickInsideAnchor && !clickInsideDropdown) {
            this.resetBulkLabelSelector(true);
        }
    };

    private onSelectState = (stateID: number, event?: React.MouseEvent, forceToggle = false): void => {
        const { sortedStatesID } = this.state;
        if (!sortedStatesID.includes(stateID)) {
            return;
        }

        const sourceIsCheckbox = Boolean(
            event?.target instanceof Element &&
            event.target.closest('.ant-checkbox-wrapper, .ant-checkbox, .ant-checkbox-input'),
        );
        const withModifierSelection = Boolean(event?.ctrlKey || event?.metaKey);
        const isCheckboxSelection = forceToggle || sourceIsCheckbox;
        const pointerPosition = this.getPointerPosition(event);

        this.setState((prevState) => {
            const {
                selectedStatesID,
            } = prevState;
            const computeNextState = (nextSelectedStateIDs: number[]): Partial<State> => ({
                selectedStatesID: nextSelectedStateIDs,
                selectedStateIDs: nextSelectedStateIDs,
                selectedLabelID: nextSelectedStateIDs.length ?
                    prevState.filteredStates.find((state: ObjectState) => state.clientID === nextSelectedStateIDs[0])?.label?.id ?? null :
                    null,
                floatingLabelOpen: false,
                floatingLabelPosition: null,
                selectionSource: nextSelectedStateIDs.length ? 'sidebar' : null,
            });

            if (isCheckboxSelection) {
                if (!withModifierSelection) {
                    return computeNextState(selectedStatesID.includes(stateID) ? [] : [stateID]);
                }

                const baseSelectedStateIDs = this.checkboxModifierSelectionActive ? selectedStatesID : [];
                const nextSelectedStateIDs = baseSelectedStateIDs.includes(stateID) ?
                    baseSelectedStateIDs.filter((id: number) => id !== stateID) :
                    [...baseSelectedStateIDs, stateID];

                return computeNextState(nextSelectedStateIDs);
            }

            if (withModifierSelection) {
                const nextSelectedStateIDs = selectedStatesID.includes(stateID) ?
                    selectedStatesID.filter((id: number) => id !== stateID) :
                    [...selectedStatesID, stateID];

                return computeNextState(nextSelectedStateIDs);
            }

            return computeNextState([stateID]);
        }, () => {
            const { selectedStatesID } = this.state;
            const selected = selectedStatesID.includes(stateID);

            if (selectedStatesID.length === 0) {
                this.checkboxModifierSelectionActive = false;
            } else if (isCheckboxSelection) {
                this.checkboxModifierSelectionActive = withModifierSelection;
            } else if (!withModifierSelection) {
                this.checkboxModifierSelectionActive = false;
            }

            if (withModifierSelection && !isCheckboxSelection && selected) {
                this.pendingBulkLabelSelector = {
                    sourceStateID: stateID,
                    ...pointerPosition,
                };
            } else {
                this.resetBulkLabelSelector();
            }
        });
    };

    private bulkChangeLabel = (sourceStateID: number, label: Label): boolean => {
        const { readonly, updateAnnotations } = this.props;
        const { objectStates, selectedStatesID } = this.state;

        if (readonly || selectedStatesID.length < 2 || !selectedStatesID.includes(sourceStateID)) {
            return false;
        }

        const selectedStateIDsSet = new Set(selectedStatesID);
        const selectedStates = objectStates.filter(
            (state: ObjectState): boolean => selectedStateIDsSet.has(state.clientID as number),
        );
        const updatedStates: ObjectState[] = [];

        for (const state of selectedStates) {
            const bothAreTags = state.objectType === ObjectType.TAG && label.type === LabelType.TAG;
            const labelIsApplicable = label.type === LabelType.ANY ||
                (state.shapeType === label.type && state.shapeType !== ShapeType.SKELETON) ||
                bothAreTags;

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

    private onDocumentKeyUp = (event: KeyboardEvent): void => {
        const { selectionSource, selectedStateIDs } = this.state;
        if (this.isValidationMode()) {
            return;
        }
        if (event.key !== 'Shift') {
            return;
        }

        const target = event.target as HTMLElement | null;
        const role = target?.getAttribute?.('role');
        const ariaMultiline = target?.getAttribute?.('aria-multiline');
        if (
            target?.isContentEditable ||
            ['INPUT', 'TEXTAREA'].includes(target?.tagName || '') ||
            role === 'textbox' ||
            ariaMultiline === 'true'
        ) {
            return;
        }

        if (selectionSource === 'canvas' && selectedStateIDs.length) {
            this.setState({ floatingLabelOpen: true });
        }
    };

    private onDocumentKeyDown = (event: KeyboardEvent): void => {
        const { selectionSource, selectedStateIDs, floatingLabelOpen } = this.state;
        if (this.isValidationMode()) {
            return;
        }
        if (event.key !== 'Shift') {
            return;
        }

        const target = event.target as HTMLElement | null;
        const role = target?.getAttribute?.('role');
        const ariaMultiline = target?.getAttribute?.('aria-multiline');
        if (
            target?.isContentEditable ||
            ['INPUT', 'TEXTAREA'].includes(target?.tagName || '') ||
            role === 'textbox' ||
            ariaMultiline === 'true'
        ) {
            return;
        }

        if (selectionSource === 'canvas' && selectedStateIDs.length && floatingLabelOpen) {
            this.setState({ floatingLabelOpen: false });
        }
    };

    private onDocumentMouseDown = (event: MouseEvent): void => {
        const { floatingLabelOpen } = this.state;
        if (!floatingLabelOpen) {
            return;
        }

        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }

        if (target.closest('.cvat-objects-sidebar-floating-label')) {
            return;
        }

        if (target.closest('.ant-select-dropdown')) {
            return;
        }

        this.setState({ floatingLabelOpen: false });
    };

    private toggleSelectionFromSource = (
        clientID: number,
        selectionSource: 'canvas' | 'sidebar',
        floatingLabelPosition: { x: number; y: number } | null,
    ): void => {
        const { filteredStates, selectedStateIDs } = this.state;
        if (!filteredStates.some((state: ObjectState) => state.clientID === clientID)) {
            return;
        }

        this.pendingBulkLabelSelector = null;
        this.checkboxModifierSelectionActive = false;

        const nextSelectedStateIDs = selectedStateIDs.includes(clientID) ?
            selectedStateIDs.filter((id: number) => id !== clientID) :
            [...selectedStateIDs, clientID];

        if (!nextSelectedStateIDs.length) {
            this.setState({
                selectedStatesID: [],
                bulkLabelSelector: {
                    visible: false,
                    sourceStateID: null,
                    left: 0,
                    top: 0,
                },
                selectedStateIDs: [],
                floatingLabelOpen: false,
                floatingLabelPosition: null,
                selectedLabelID: null,
                selectionSource: null,
            });
            return;
        }

        const selectedLabelID = filteredStates
            .find((state: ObjectState) => state.clientID === nextSelectedStateIDs[0])?.label?.id ?? null;
        this.setState({
            selectedStatesID: nextSelectedStateIDs,
            bulkLabelSelector: {
                visible: false,
                sourceStateID: null,
                left: 0,
                top: 0,
            },
            selectedStateIDs: nextSelectedStateIDs,
            floatingLabelOpen: false,
            floatingLabelPosition,
            selectedLabelID,
            selectionSource,
        });
    };

    private onSidebarToggleSelection = (clientID: number): void => {
        if (this.isValidationMode()) {
            return;
        }
        this.toggleSelectionFromSource(clientID, 'sidebar', null);
    };

    private applyLabelToSelection = (label: Label): void => {
        const { readonly, updateAnnotations } = this.props;
        const isReadonly = readonly || this.isValidationMode();
        const { selectedStateIDs, filteredStates } = this.state;
        if (isReadonly || !selectedStateIDs.length) {
            return;
        }

        const selectedStates = filteredStates
            .filter((state: ObjectState) => selectedStateIDs.includes(state.clientID))
            .filter((state: ObjectState) => state.shapeType !== ShapeType.SKELETON);
        if (selectedStates.length) {
            selectedStates.forEach((state: ObjectState) => {
                state.label = label;
            });
            updateAnnotations(selectedStates);
        }

        this.setState({
            selectedStatesID: [],
            bulkLabelSelector: {
                visible: false,
                sourceStateID: null,
                left: 0,
                top: 0,
            },
            selectedStateIDs: [],
            floatingLabelOpen: false,
            floatingLabelPosition: null,
            selectedLabelID: null,
            selectionSource: null,
        });
    };

    private closeFloatingLabel = (): void => {
        this.setState({ floatingLabelOpen: false });
    };

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
            readonly: readonlyProp,
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
        const readonly = readonlyProp || this.isValidationMode();
        const {
            objectStates, sortedStatesID, statesOrdering, filteredStates, selectedStatesID, bulkLabelSelector,
            selectedStateIDs,
        } = this.state;

        const sourceState = bulkLabelSelector.sourceStateID !== null ?
            objectStates.find((state: ObjectState): boolean => state.clientID === bulkLabelSelector.sourceStateID) :
            null;
        const labelSelectorLabels = sourceState ? filterApplicableLabels(sourceState, labels) : [];
        const labelSelectorValue = sourceState ? sourceState.label.id : null;
        const shouldRenderBulkLabelSelector = Boolean(
            bulkLabelSelector.visible && sourceState && labelSelectorLabels.length,
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
                if (selectedStateIDs.length > 1) {
                    return;
                }
                const state = selectedStateIDs.length === 1 ?
                    objectStates.find((objectState: ObjectState): boolean => objectState.clientID === selectedStateIDs[0]) ||
                    null :
                    activatedState(true);
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
                    selectedStatesID={selectedStatesID}
                    showGroundTruth={showGroundTruth}
                    objectStates={filteredStates}
                    selectState={this.onSelectState}
                    onToggleSelection={this.onSidebarToggleSelection}
                    clearMultiSelection={this.clearSidebarMultiSelection}
                    bulkChangeLabel={this.bulkChangeLabel}
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
                            left: bulkLabelSelector.left,
                            top: bulkLabelSelector.top,
                        }}
                    >
                        <LabelSelector
                            autoFocus
                            open
                            size='middle'
                            labels={labelSelectorLabels}
                            value={labelSelectorValue}
                            popupClassName='cvat-objects-sidebar-bulk-label-selector-dropdown'
                            className='cvat-objects-sidebar-bulk-label-selector'
                            onChange={this.onBulkLabelSelectorChange}
                            onOpenChange={(open: boolean) => {
                                if (!open) {
                                    this.resetBulkLabelSelector();
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

export default connect<StateToProps, DispatchToProps, OwnProps, CombinedState>(
    mapStateToProps, mapDispatchToProps,
)(ObjectsListContainer);
