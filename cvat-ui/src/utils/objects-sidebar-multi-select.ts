// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export const OBJECTS_SIDEBAR_TOGGLE_MULTI_SELECTION_EVENT = 'cvat.objects.sidebar.toggle-multi-selection';
const OBJECTS_SIDEBAR_STATE_ITEM_ID_PREFIX = 'cvat-objects-sidebar-state-item-';
const OBJECTS_SIDEBAR_STATE_ITEM_ELEMENT_ID_PREFIX = 'cvat-objects-sidebar-state-item-element-';

export interface ObjectsSidebarToggleMultiSelectionEventDetail {
    clientID: number;
    position: {
        x: number;
        y: number;
    };
}

interface ObjectsSidebarStateReference {
    clientID: number;
    parentID?: number | null;
}

export function resolveObjectsSidebarTargets(
    state: ObjectsSidebarStateReference,
): { sidebarItemID: string; targetSidebarStateID: number } {
    const { clientID, parentID } = state;
    // Element clicks in the canvas should still target the owning sidebar state row.
    const isElement = Number.isInteger(parentID);

    return {
        targetSidebarStateID: isElement ? (parentID as number) : clientID,
        sidebarItemID: isElement ?
            `${OBJECTS_SIDEBAR_STATE_ITEM_ELEMENT_ID_PREFIX}${clientID}` :
            `${OBJECTS_SIDEBAR_STATE_ITEM_ID_PREFIX}${clientID}`,
    };
}

export function getObjectsSidebarItem(
    documentRef: Document,
    state: ObjectsSidebarStateReference,
): { sidebarItem: HTMLElement | null; targetSidebarStateID: number } {
    const { sidebarItemID, targetSidebarStateID } = resolveObjectsSidebarTargets(state);

    return {
        sidebarItem: documentRef.getElementById(sidebarItemID),
        targetSidebarStateID,
    };
}

export function dispatchObjectsSidebarToggleMultiSelection(
    documentRef: Document,
    detail: ObjectsSidebarToggleMultiSelectionEventDetail,
): void {
    documentRef.dispatchEvent(new CustomEvent(OBJECTS_SIDEBAR_TOGGLE_MULTI_SELECTION_EVENT, {
        detail,
    }));
}
