// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import dayjs from 'dayjs';
import type { RangePickerProps } from 'antd/lib/date-picker';

import {
    AnalyticsEvent, Job, Project, Task, User,
} from 'cvat-core-wrapper';

const HISTORY_DEFAULT_RANGE_DAYS = 30;
// These are the fields the History page shows today.
const TRACKED_HISTORY_FIELDS = ['assignee', 'stage', 'state'] as const;

export const ROOT_TREE_KEY = '__history-root__';
export const STANDALONE_TASKS_ROOT_KEY = '__history-standalone__';

export type HistoryField = typeof TRACKED_HISTORY_FIELDS[number];

export type HistorySelection =
    | { type: 'project'; key: string; projectId: number; title: string; }
    | { type: 'task'; key: string; taskId: number; projectId: number | null; title: string; }
    | { type: 'job'; key: string; jobId: number; taskId: number; projectId: number | null; title: string; };

export type HistoryTreeNodeType = HistorySelection['type'] | 'load-more' | 'standalone-root';

export interface HistoryTreeNode {
    key: string;
    title: string;
    nodeType: HistoryTreeNodeType;
    resourceId: number;
    children?: HistoryTreeNode[];
    isLeaf?: boolean;
    loaded?: boolean;
    projectId?: number | null;
    taskId?: number;
    parentKey?: string;
    totalCount?: number;
    loadedCount?: number;
    nextPage?: number;
    selectable?: boolean;
}

export interface HistoryChangeGroup {
    key: string;
    timestamp: string;
    user: string;
    events: Partial<Record<HistoryField, AnalyticsEvent>>;
}

export interface HistoryChangeRow {
    key: string;
    time: string;
    user: string;
    assignee: string;
    stage: string;
    state: string;
}

export interface HistorySnapshot {
    assignee: string;
    stage: string;
    state: string;
}

export interface HistorySnapshotSource {
    assignee?: User | null;
    stage?: string | null;
    state?: string | null;
}

type RangePickerValue = NonNullable<RangePickerProps['value']>;

export type HistoryDateRange = [
    NonNullable<RangePickerValue[0]>,
    NonNullable<RangePickerValue[1]>,
];

export function createDefaultHistoryDateRange(): HistoryDateRange {
    return [
        dayjs().subtract(HISTORY_DEFAULT_RANGE_DAYS, 'day').startOf('day'),
        dayjs().endOf('day'),
    ];
}

export function mapProjectToTreeNode(project: Project): HistoryTreeNode {
    return {
        key: `project-${project.id}`,
        title: project.name,
        nodeType: 'project',
        resourceId: project.id,
        projectId: project.id,
        loaded: false,
        isLeaf: false,
    };
}

export function mapTaskToTreeNode(task: { id: number; name: string; projectId: number | null }): HistoryTreeNode {
    return {
        key: `task-${task.id}`,
        title: task.name,
        nodeType: 'task',
        resourceId: task.id,
        projectId: task.projectId,
        taskId: task.id,
        loaded: false,
        isLeaf: false,
    };
}

export function mapJobToTreeNode(job: Job): HistoryTreeNode {
    return {
        key: `job-${job.id}`,
        title: `Job #${job.id}`,
        nodeType: 'job',
        resourceId: job.id,
        projectId: job.projectId,
        taskId: job.taskId,
        isLeaf: true,
        loaded: true,
    };
}

export function createRootLoadMoreNode(
    loadedCount: number,
    totalCount: number,
    nextPage: number,
): HistoryTreeNode {
    return {
        key: `${ROOT_TREE_KEY}-load-more-${nextPage}`,
        title: `Load more projects (${loadedCount}/${totalCount})`,
        nodeType: 'load-more',
        resourceId: 0,
        parentKey: ROOT_TREE_KEY,
        isLeaf: true,
        loaded: true,
    };
}

export function createStandaloneRootNode(): HistoryTreeNode {
    return {
        key: STANDALONE_TASKS_ROOT_KEY,
        title: 'Standalone tasks',
        nodeType: 'standalone-root',
        resourceId: 0,
        loaded: false,
        isLeaf: false,
        selectable: false,
    };
}

export function createLoadMoreNode(parentNode: HistoryTreeNode): HistoryTreeNode {
    const resourceLabel = parentNode.nodeType === 'task' ? 'jobs' : 'tasks';
    const loadedCount = parentNode.loadedCount || 0;
    const totalCount = parentNode.totalCount || loadedCount;

    return {
        key: `${parentNode.key}-load-more-${parentNode.nextPage || 1}`,
        title: `Load more ${resourceLabel} (${loadedCount}/${totalCount})`,
        nodeType: 'load-more',
        resourceId: parentNode.resourceId,
        parentKey: parentNode.key,
        isLeaf: true,
        loaded: true,
        projectId: parentNode.projectId,
        taskId: parentNode.taskId,
    };
}

export function splitLoadMoreNode(children: HistoryTreeNode[] = []): {
    items: HistoryTreeNode[];
    loadMoreNode: HistoryTreeNode | null;
} {
    const items: HistoryTreeNode[] = [];
    let loadMoreNode: HistoryTreeNode | null = null;

    for (const child of children) {
        if (child.nodeType === 'load-more') {
            loadMoreNode = child;
        } else {
            items.push(child);
        }
    }

    return { items, loadMoreNode };
}

export function dedupeTreeChildren(children: HistoryTreeNode[]): HistoryTreeNode[] {
    const seen = new Set<string>();

    return children.filter((child) => {
        if (seen.has(child.key)) {
            return false;
        }

        seen.add(child.key);
        return true;
    });
}

export function buildPaginatedChildren(
    parentNode: HistoryTreeNode,
    children: HistoryTreeNode[],
    loadedCount: number,
    totalCount: number,
    nextPage?: number,
): HistoryTreeNode[] {
    const uniqueChildren = dedupeTreeChildren(children);
    const effectiveParent = {
        ...parentNode,
        loadedCount,
        totalCount,
        nextPage,
    };

    return nextPage ? [...uniqueChildren, createLoadMoreNode(effectiveParent)] : uniqueChildren;
}

export function buildRootTreeNodes(
    projects: Project[],
    totalCount: number,
    nextPage?: number,
    includeStandaloneRoot = false,
): HistoryTreeNode[] {
    const projectNodes = dedupeTreeChildren(projects.map((project) => mapProjectToTreeNode(project)));
    const rootNodes = includeStandaloneRoot ? [...projectNodes, createStandaloneRootNode()] : projectNodes;

    return nextPage ? [...rootNodes, createRootLoadMoreNode(projectNodes.length, totalCount, nextPage)] : rootNodes;
}

export function splitRootNodes(nodes: HistoryTreeNode[]): {
    projectNodes: HistoryTreeNode[];
    standaloneRoot: HistoryTreeNode | null;
    loadMoreNode: HistoryTreeNode | null;
} {
    const projectNodes: HistoryTreeNode[] = [];
    let standaloneRoot: HistoryTreeNode | null = null;
    let loadMoreNode: HistoryTreeNode | null = null;

    for (const node of nodes) {
        if (node.nodeType === 'standalone-root') {
            standaloneRoot = node;
        } else if (node.nodeType === 'load-more' && node.parentKey === ROOT_TREE_KEY) {
            loadMoreNode = node;
        } else {
            projectNodes.push(node);
        }
    }

    return { projectNodes, standaloneRoot, loadMoreNode };
}

export function updateTreeNode(
    nodes: HistoryTreeNode[],
    key: string,
    updater: (node: HistoryTreeNode) => HistoryTreeNode,
): HistoryTreeNode[] {
    for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.key === key) {
            const nextNodes = [...nodes];
            nextNodes[index] = updater(node);
            return nextNodes;
        }

        if (node.children?.length) {
            const updatedChildren = updateTreeNode(node.children, key, updater);
            if (updatedChildren !== node.children) {
                const nextNodes = [...nodes];
                nextNodes[index] = {
                    ...node,
                    children: updatedChildren,
                };
                return nextNodes;
            }
        }
    }

    return nodes;
}

export function buildTreeNodeIndex(
    nodes: HistoryTreeNode[],
    index: Map<string, HistoryTreeNode> = new Map(),
): Map<string, HistoryTreeNode> {
    for (const node of nodes) {
        index.set(node.key, node);
        if (node.children?.length) {
            buildTreeNodeIndex(node.children, index);
        }
    }

    return index;
}

export function indexTreeNode(node: HistoryTreeNode, index: Map<string, HistoryTreeNode>): void {
    index.set(node.key, node);
    if (node.children?.length) {
        node.children.forEach((child) => indexTreeNode(child, index));
    }
}

export function removeTreeNodeIndex(node: HistoryTreeNode, index: Map<string, HistoryTreeNode>): void {
    index.delete(node.key);
    if (node.children?.length) {
        node.children.forEach((child) => removeTreeNodeIndex(child, index));
    }
}

export function formatAssignee(user: User | null): string {
    return user?.username || 'Unassigned';
}

function formatEventAssignee(value: unknown): string {
    if (value === null || value === undefined || value === 'None') {
        return 'Unassigned';
    }

    if (typeof value === 'object' && value) {
        const userValue = value as Record<string, unknown>;
        const fullName = [userValue.first_name, userValue.last_name]
            .filter((entry) => typeof entry === 'string' && entry)
            .join(' ');

        return (
            (typeof userValue.username === 'string' && userValue.username) ||
            fullName ||
            (typeof userValue.email === 'string' && userValue.email) ||
            JSON.stringify(userValue)
        );
    }

    if (typeof value === 'string') {
        const usernameMatch = value.match(/'username': '([^']+)'/);
        if (usernameMatch) {
            return usernameMatch[1];
        }

        const emailMatch = value.match(/'email': '([^']+)'/);
        if (emailMatch) {
            return emailMatch[1];
        }

        return value;
    }

    return String(value);
}

function formatHistoryValue(event: AnalyticsEvent, value: unknown): string {
    if (event.objName === 'assignee') {
        return formatEventAssignee(value);
    }

    if (value === null || value === undefined || value === '') {
        return '-';
    }

    return String(value);
}

function getEventOldValue(event: AnalyticsEvent): unknown {
    if (!event.payload) {
        return null;
    }

    const { old_value: oldValue } = event.payload as Record<string, unknown>;
    return oldValue;
}

function getEventRequestId(event: AnalyticsEvent): string | null {
    if (!event.payload) {
        return null;
    }

    const { request } = event.payload;
    if (typeof request === 'object' && request && 'id' in request) {
        const requestID = request.id;
        return typeof requestID === 'string' && requestID ? requestID : null;
    }

    return null;
}

function getEventRequestSignature(event: AnalyticsEvent): string | null {
    if (!event.payload) {
        return null;
    }

    const { request } = event.payload;
    if (typeof request !== 'object' || !request) {
        return null;
    }

    const requestData = Object.entries(request as Record<string, unknown>)
        .filter(([key, value]) => key !== 'id' && value !== null && value !== undefined && value !== '')
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    if (!requestData.length) {
        return null;
    }

    return JSON.stringify(Object.fromEntries(requestData));
}

function getEventGroupKey(event: AnalyticsEvent): string {
    const requestID = getEventRequestId(event);
    if (requestID) {
        return requestID;
    }

    // If the event has no request id, build another stable key so one save still becomes one row.
    const requestSignature = getEventRequestSignature(event);
    return JSON.stringify({
        timestamp: event.timestamp,
        userId: event.userId ?? null,
        scope: event.scope ?? null,
        jobId: event.jobId ?? null,
        taskId: event.taskId ?? null,
        projectId: event.projectId ?? null,
        request: requestSignature,
    });
}

function isTrackedHistoryField(value: string | null | undefined): value is HistoryField {
    return value === 'assignee' || value === 'stage' || value === 'state';
}

export function groupHistoryEvents(events: AnalyticsEvent[]): HistoryChangeGroup[] {
    const groups: HistoryChangeGroup[] = [];
    const groupIndex = new Map<string, number>();

    for (const event of events) {
        if (!isTrackedHistoryField(event.objName)) {
            continue;
        }
        const field = event.objName;

        const key = getEventGroupKey(event);
        const existingIndex = groupIndex.get(key);

        if (existingIndex === undefined) {
            // Keep the incoming order so snapshot reconstruction stays correct.
            groupIndex.set(key, groups.length);
            groups.push({
                key,
                timestamp: event.timestamp,
                user: event.userName || event.userEmail || '-',
                events: { [field]: event },
            });
        } else {
            groups[existingIndex].events[field] = event;
        }
    }

    return groups;
}

export function createHistorySnapshot(resource: HistorySnapshotSource | null): HistorySnapshot {
    return {
        assignee: resource ? formatAssignee(resource.assignee ?? null) : '-',
        stage: resource?.stage || '-',
        state: resource?.state || '-',
    };
}

export function getHistorySelectionQuery(selection: HistorySelection): {
    scope: 'update:project' | 'update:task' | 'update:job';
    objName: string;
    projectId?: number;
    taskId?: number;
    jobId?: number;
} {
    if (selection.type === 'project') {
        return {
            scope: 'update:project',
            // Project history only shows assignee changes for now.
            objName: 'assignee',
            projectId: selection.projectId,
        };
    }

    if (selection.type === 'task') {
        return {
            scope: 'update:task',
            // Task history only shows assignee changes for now.
            objName: 'assignee',
            taskId: selection.taskId,
        };
    }

    return {
        scope: 'update:job',
        objName: 'assignee,stage,state',
        jobId: selection.jobId,
    };
}

export function isJobHistorySelection(
    selection: HistorySelection | null,
): selection is Extract<HistorySelection, { type: 'job' }> {
    return selection?.type === 'job';
}

export function isProjectHistoryResource(
    selection: HistorySelection,
    resource: Project | Task | Job | null,
): resource is Project {
    return selection.type === 'project' && resource instanceof Project;
}

export function isTaskHistoryResource(
    selection: HistorySelection,
    resource: Project | Task | Job | null,
): resource is Task {
    return selection.type === 'task' && resource instanceof Task;
}

export function applyGroupToSnapshot(
    snapshot: HistorySnapshot,
    group: HistoryChangeGroup,
): HistorySnapshot {
    const nextSnapshot = { ...snapshot };

    for (const field of TRACKED_HISTORY_FIELDS) {
        const event = group.events[field];
        if (event) {
            nextSnapshot[field] = formatHistoryValue(event, getEventOldValue(event));
        }
    }

    return nextSnapshot;
}

export function appendHistoryRows(
    groups: HistoryChangeGroup[],
    initialSnapshot: HistorySnapshot,
): { rows: HistoryChangeRow[]; snapshot: HistorySnapshot } {
    let snapshot = { ...initialSnapshot };
    const rows = groups.map((group) => {
        const row: HistoryChangeRow = {
            key: group.key,
            time: group.timestamp,
            user: group.user,
            assignee: snapshot.assignee,
            stage: snapshot.stage,
            state: snapshot.state,
        };

        snapshot = applyGroupToSnapshot(snapshot, group);
        return row;
    });

    return { rows, snapshot };
}

export function getErrorDescription(error: unknown, fallback = ''): string {
    if (!(error instanceof Error) || !error.message) {
        return fallback;
    }

    if (error.message.includes('<!DOCTYPE html>')) {
        return 'The server returned an internal error page. Check the server logs for details.';
    }

    return error.message;
}
