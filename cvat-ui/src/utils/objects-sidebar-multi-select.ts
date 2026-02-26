// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

export const OBJECTS_SIDEBAR_TOGGLE_MULTI_SELECTION_EVENT = 'cvat.objects.sidebar.toggle-multi-selection';

export interface ObjectsSidebarToggleMultiSelectionEventDetail {
    clientID: number;
    position: {
        x: number;
        y: number;
    };
}
