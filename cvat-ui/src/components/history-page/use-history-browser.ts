// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import notification from 'antd/lib/notification';

import {
    getCore, Job, Project,
} from 'cvat-core-wrapper';

import {
    appendHistoryRows,
    applyGroupToSnapshot,
    buildPaginatedChildren,
    buildRootTreeNodes,
    buildTreeNodeIndex,
    createDefaultHistoryDateRange,
    createHistorySnapshot,
    createRootLoadMoreNode,
    createStandaloneRootNode,
    dedupeTreeChildren,
    getErrorDescription,
    groupHistoryEvents,
    HistoryChangeGroup,
    HistoryDateRange,
    HistoryChangeRow,
    HistorySelection,
    HistorySnapshot,
    HistoryTreeNode,
    indexTreeNode,
    mapJobToTreeNode,
    mapProjectToTreeNode,
    mapTaskToTreeNode,
    removeTreeNodeIndex,
    ROOT_TREE_KEY,
    splitLoadMoreNode,
    splitRootNodes,
    STANDALONE_TASKS_ROOT_KEY,
    updateTreeNode,
} from './history-utils';

const core = getCore();
const TREE_PAGE_SIZE = 100;
const SUMMARY_PAGE_SIZE = 10;
const HISTORY_PAGE_SIZE = 20;
const HISTORY_FETCH_PAGE_SIZE = 100;
const HISTORY_FIELDS = 'assignee,stage,state';
const RESOURCE_SORT_FIELD = '-id';
const DEFAULT_PROJECT_SORT = '-id';
const PROJECT_SEARCH_DEBOUNCE_MS = 300;
const STANDALONE_TASKS_FILTER = JSON.stringify({
    '==': [{ var: 'project_id' }, null],
});

export const PROJECT_SORT_OPTIONS = [
    { value: '-id', label: 'Newest first' },
    { value: 'id', label: 'Oldest first' },
    { value: 'name', label: 'Name A-Z' },
    { value: '-name', label: 'Name Z-A' },
];

interface UseHistoryBrowserResult {
    treeData: HistoryTreeNode[];
    treeLoading: boolean;
    expandedKeys: string[];
    selectedKeys: string[];
    selection: HistorySelection | null;
    projectSearchInput: string;
    projectSort: string;
    normalizedProjectSearch: string;
    summaryLoading: boolean;
    summaryJobs: Job[];
    summaryPage: number;
    summaryPageSize: number;
    summaryTotal: number;
    jobDetailsLoading: boolean;
    selectedJob: Job | null;
    historyDateRangeLabel: string;
    historyDateRange: HistoryDateRange | null;
    historyLoading: boolean;
    paginatedHistoryRows: HistoryChangeRow[];
    historyPage: number;
    historyPageSize: number;
    historyPaginationTotal: number;
    handleProjectSearchInputChange: (value: string) => void;
    handleProjectSearch: (value: string) => void;
    handleProjectSortChange: (value: string) => void;
    handleTreeExpand: (keys: string[], node: HistoryTreeNode) => void;
    handleTreeSelect: (keys: string[], node: HistoryTreeNode) => void;
    handleToggleStandaloneRoot: (node: HistoryTreeNode) => void;
    handleTreeLoadData: (node: HistoryTreeNode) => Promise<void>;
    handleSelectionBack: () => void;
    handleSummaryChange: (page: number, pageSize: number) => void;
    handleSelectSummaryJob: (job: Job) => void;
    handleHistoryDateRangeChange: (range: HistoryDateRange | null) => void;
    handleResetHistoryDateRange: () => void;
    handleSetAllTime: () => void;
    handleHistoryChange: (page: number, pageSize: number) => void;
}

export default function useHistoryBrowser(): UseHistoryBrowserResult {
    const [treeData, setTreeData] = useState<HistoryTreeNode[]>([]);
    const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [selection, setSelection] = useState<HistorySelection | null>(null);
    const [treeLoading, setTreeLoading] = useState(true);
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [jobDetailsLoading, setJobDetailsLoading] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyBaseLoading, setHistoryBaseLoading] = useState(false);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [projectSearchInput, setProjectSearchInput] = useState('');
    const [projectSearch, setProjectSearch] = useState('');
    const [projectSort, setProjectSort] = useState(DEFAULT_PROJECT_SORT);
    const [summaryJobs, setSummaryJobs] = useState<Job[]>([]);
    const [summaryPage, setSummaryPage] = useState(1);
    const [summaryPageSize, setSummaryPageSize] = useState(SUMMARY_PAGE_SIZE);
    const [summaryTotal, setSummaryTotal] = useState(0);
    const [selectedJob, setSelectedJob] = useState<Job | null>(null);
    const [historyRows, setHistoryRows] = useState<HistoryChangeRow[]>([]);
    const [historyPage, setHistoryPage] = useState(1);
    const [historyPageSize, setHistoryPageSize] = useState(HISTORY_PAGE_SIZE);
    const [historyDateRange, setHistoryDateRange] = useState<HistoryDateRange | null>(
        () => createDefaultHistoryDateRange(),
    );
    const summaryRequestID = useRef(0);
    const jobDetailsRequestID = useRef(0);
    const historyRequestID = useRef(0);
    const historyBaseRequestID = useRef(0);
    const selectedJobRef = useRef<Job | null>(null);
    const selectedHistoryJobIDRef = useRef<number | null>(null);
    const summarySelectionKey = useRef<string | null>(null);
    const treeDataRef = useRef<HistoryTreeNode[]>([]);
    const treeNodeIndexRef = useRef<Map<string, HistoryTreeNode>>(new Map());
    const treeRequestRef = useRef<Map<string, Promise<void>>>(new Map());
    const expandedKeysRef = useRef<string[]>([]);
    const projectQueryRequestID = useRef(0);
    const rootPaginationRef = useRef<{
        loadedCount: number;
        totalCount: number;
        nextPage?: number;
    }>({ loadedCount: 0, totalCount: 0, nextPage: undefined });
    const historyGroupsRef = useRef<HistoryChangeGroup[]>([]);
    const historyRowsRef = useRef<HistoryChangeRow[]>([]);
    const historySnapshotRef = useRef<HistorySnapshot>(createHistorySnapshot(null));
    const historyBaseReadyRef = useRef(false);
    const historyHasMoreRef = useRef(false);
    const historyNextCursorRef = useRef<string | null>(null);
    const normalizedProjectSearch = projectSearch.trim();
    const projectQueryKey = `${projectSort}|${normalizedProjectSearch}`;
    const shouldShowStandaloneTasks = !normalizedProjectSearch;
    const historyFrom = historyDateRange?.[0]?.toISOString() || null;
    const historyTo = historyDateRange?.[1]?.toISOString() || null;
    const historyAfter = historyDateRange?.[1]?.add(1, 'millisecond').toISOString() || null;
    const historyFilterKey = `${historyFrom || 'all'}|${historyTo || 'all'}`;

    const replaceTreeData = useCallback(
        (nextTree: HistoryTreeNode[], nextIndex?: Map<string, HistoryTreeNode>): void => {
            treeDataRef.current = nextTree;
            treeNodeIndexRef.current = nextIndex || buildTreeNodeIndex(nextTree);
            setTreeData(nextTree);
        },
        [],
    );

    const commitTreeData = useCallback((updater: (current: HistoryTreeNode[]) => HistoryTreeNode[]): void => {
        replaceTreeData(updater(treeDataRef.current));
    }, [replaceTreeData]);

    const updateIndexedTreeNode = useCallback((
        key: string,
        updater: (node: HistoryTreeNode) => HistoryTreeNode,
    ): HistoryTreeNode | null => {
        const currentNode = treeNodeIndexRef.current.get(key);
        if (!currentNode) {
            return null;
        }

        let nextNode: HistoryTreeNode | null = null;
        const nextTree = updateTreeNode(treeDataRef.current, key, (node) => {
            nextNode = updater(node);
            return nextNode;
        });

        if (!nextNode || nextTree === treeDataRef.current) {
            return currentNode;
        }

        const nextIndex = new Map(treeNodeIndexRef.current);
        removeTreeNodeIndex(currentNode, nextIndex);
        indexTreeNode(nextNode, nextIndex);
        replaceTreeData(nextTree, nextIndex);
        return nextNode;
    }, [replaceTreeData]);

    const trackTreeRequest = useCallback((key: string, callback: () => Promise<void>): Promise<void> => {
        const existingRequest = treeRequestRef.current.get(key);
        if (existingRequest) {
            return existingRequest;
        }

        const request = callback().finally(() => {
            treeRequestRef.current.delete(key);
        });
        treeRequestRef.current.set(key, request);
        return request;
    }, []);

    const getIndexedTreeNode = useCallback((key: string): HistoryTreeNode | null => (
        treeNodeIndexRef.current.get(key) || null
    ), []);

    const resetTreeBrowserState = useCallback((): void => {
        replaceTreeData([]);
        rootPaginationRef.current = {
            loadedCount: 0,
            totalCount: 0,
            nextPage: undefined,
        };
        expandedKeysRef.current = [];
        setExpandedKeys([]);
        setSelectedKeys([]);
        setSelection(null);
    }, [replaceTreeData]);

    const loadInitialProjects = useCallback(async (): Promise<void> => {
        const requestID = ++projectQueryRequestID.current;
        setTreeLoading(true);
        try {
            await trackTreeRequest(`load-${ROOT_TREE_KEY}-${projectQueryKey}`, async () => {
                const projects = await core.projects.get({
                    page: 1,
                    pageSize: TREE_PAGE_SIZE,
                    sort: projectSort,
                    ...(normalizedProjectSearch ? { search: normalizedProjectSearch } : {}),
                });
                if (projectQueryRequestID.current !== requestID) {
                    return;
                }
                const nextPage = projects.length < projects.count ? 2 : undefined;
                const nextTreeData = buildRootTreeNodes(
                    [...projects],
                    projects.count,
                    nextPage,
                    shouldShowStandaloneTasks,
                );
                rootPaginationRef.current = {
                    loadedCount: projects.length,
                    totalCount: projects.count,
                    nextPage,
                };
                replaceTreeData(nextTreeData);
            });
        } catch (error: unknown) {
            if (projectQueryRequestID.current !== requestID) {
                return;
            }
            notification.error({
                message: 'Could not load projects for history',
                description: getErrorDescription(error),
            });
        } finally {
            if (projectQueryRequestID.current === requestID) {
                setTreeLoading(false);
            }
        }
    }, [
        normalizedProjectSearch,
        projectQueryKey,
        projectSort,
        replaceTreeData,
        shouldShowStandaloneTasks,
        trackTreeRequest,
    ]);

    const loadChildren = useCallback(async (node: HistoryTreeNode): Promise<void> => {
        if (node.loaded || node.isLeaf || node.nodeType === 'load-more') {
            return;
        }

        await trackTreeRequest(`load-${node.key}`, async () => {
            try {
                let children: HistoryTreeNode[] = [];
                let totalCount = 0;
                let nextPage: number | undefined;
                if (node.nodeType === 'project') {
                    const tasks = await core.tasks.get({
                        projectId: node.resourceId,
                        page: 1,
                        pageSize: TREE_PAGE_SIZE,
                        sort: RESOURCE_SORT_FIELD,
                    });
                    children = tasks.map((task) => mapTaskToTreeNode(task));
                    totalCount = tasks.count;
                    nextPage = children.length < totalCount ? 2 : undefined;
                } else if (node.nodeType === 'task') {
                    const jobs = await core.jobs.get({
                        taskID: node.resourceId,
                        page: 1,
                        pageSize: TREE_PAGE_SIZE,
                        sort: RESOURCE_SORT_FIELD,
                    });
                    children = jobs.map((job) => mapJobToTreeNode(job));
                    totalCount = jobs.count;
                    nextPage = children.length < totalCount ? 2 : undefined;
                } else if (node.nodeType === 'standalone-root') {
                    const tasks = await core.tasks.get({
                        filter: STANDALONE_TASKS_FILTER,
                        page: 1,
                        pageSize: TREE_PAGE_SIZE,
                        sort: RESOURCE_SORT_FIELD,
                    });
                    children = tasks.map((task) => mapTaskToTreeNode(task));
                    totalCount = tasks.count;
                    nextPage = children.length < totalCount ? 2 : undefined;
                }

                updateIndexedTreeNode(node.key, (currentNode) => ({
                    ...currentNode,
                    children: buildPaginatedChildren(
                        currentNode,
                        children,
                        children.length,
                        totalCount,
                        nextPage,
                    ),
                    loaded: true,
                    loadedCount: children.length,
                    totalCount,
                    nextPage,
                }));
            } catch (error: unknown) {
                notification.error({
                    message: 'Could not load history tree data',
                    description: getErrorDescription(error),
                });
            }
        });
    }, [trackTreeRequest, updateIndexedTreeNode]);

    const toggleStandaloneRoot = useCallback((node: HistoryTreeNode): void => {
        const isExpanded = expandedKeysRef.current.includes(node.key);
        const nextKeys = isExpanded ?
            expandedKeysRef.current.filter((key) => key !== node.key) :
            [...expandedKeysRef.current, node.key];
        expandedKeysRef.current = nextKeys;
        setExpandedKeys(nextKeys);

        if (!isExpanded || !node.loaded) {
            loadChildren(node).catch(() => undefined);
        }
    }, [loadChildren]);

    const expandTreeNode = useCallback((nodeKey: string): void => {
        if (expandedKeysRef.current.includes(nodeKey)) {
            return;
        }

        const nextKeys = [...expandedKeysRef.current, nodeKey];
        expandedKeysRef.current = nextKeys;
        setExpandedKeys(nextKeys);
    }, []);

    const focusTaskExpansion = useCallback((taskNode: HistoryTreeNode): void => {
        const taskParentKey = taskNode.projectId ?
            `project-${taskNode.projectId}` :
            STANDALONE_TASKS_ROOT_KEY;

        const nextKeys = expandedKeysRef.current.filter((key) => {
            if (key === taskNode.key || key === taskParentKey) {
                return true;
            }

            if (!key.startsWith('task-')) {
                return true;
            }

            const expandedNode = getIndexedTreeNode(key);
            if (!expandedNode || expandedNode.nodeType !== 'task') {
                return true;
            }

            const expandedNodeParentKey = expandedNode.projectId ?
                `project-${expandedNode.projectId}` :
                STANDALONE_TASKS_ROOT_KEY;

            return expandedNodeParentKey !== taskParentKey;
        });

        if (!nextKeys.includes(taskParentKey)) {
            nextKeys.push(taskParentKey);
        }

        if (!nextKeys.includes(taskNode.key)) {
            nextKeys.push(taskNode.key);
        }

        expandedKeysRef.current = nextKeys;
        setExpandedKeys(nextKeys);
    }, [getIndexedTreeNode]);

    const loadMoreProjects = useCallback(async (): Promise<void> => {
        const { nextPage } = rootPaginationRef.current;
        if (!nextPage) {
            return;
        }

        const requestID = projectQueryRequestID.current;
        setTreeLoading(true);
        try {
            await trackTreeRequest(`load-more-${ROOT_TREE_KEY}-${projectQueryKey}-${nextPage}`, async () => {
                const projects = await core.projects.get({
                    page: nextPage,
                    pageSize: TREE_PAGE_SIZE,
                    sort: projectSort,
                    ...(normalizedProjectSearch ? { search: normalizedProjectSearch } : {}),
                });
                if (projectQueryRequestID.current !== requestID) {
                    return;
                }

                commitTreeData((currentTree) => {
                    const { projectNodes: existingProjectNodes, standaloneRoot } = splitRootNodes(currentTree);
                    const projectNodes = dedupeTreeChildren([
                        ...existingProjectNodes,
                        ...projects.map((project) => mapProjectToTreeNode(project)),
                    ]);
                    const nextRootPage = projectNodes.length < projects.count ? nextPage + 1 : undefined;
                    const nextTreeData = nextRootPage ?
                        [
                            ...projectNodes,
                            ...(standaloneRoot ? [standaloneRoot] : []),
                            createRootLoadMoreNode(projectNodes.length, projects.count, nextRootPage),
                        ] :
                        [
                            ...projectNodes,
                            ...(standaloneRoot ? [standaloneRoot] : []),
                        ];

                    rootPaginationRef.current = {
                        loadedCount: projectNodes.length,
                        totalCount: projects.count,
                        nextPage: nextRootPage,
                    };

                    return nextTreeData;
                });
            });
        } catch (error: unknown) {
            if (projectQueryRequestID.current !== requestID) {
                return;
            }
            notification.error({
                message: 'Could not load additional projects for history',
                description: getErrorDescription(error),
            });
        } finally {
            if (projectQueryRequestID.current === requestID) {
                setTreeLoading(false);
            }
        }
    }, [commitTreeData, normalizedProjectSearch, projectQueryKey, projectSort, trackTreeRequest]);

    const loadMoreChildren = useCallback(async (parentKey: string): Promise<void> => {
        await trackTreeRequest(`load-more-${parentKey}`, async () => {
            const parentNode = getIndexedTreeNode(parentKey);
            if (
                !parentNode ||
                parentNode.isLeaf ||
                parentNode.nodeType === 'load-more' ||
                !parentNode.nextPage
            ) {
                return;
            }

            try {
                let nextChildren: HistoryTreeNode[] = [];
                let totalCount = parentNode.totalCount || 0;
                if (parentNode.nodeType === 'project') {
                    const tasks = await core.tasks.get({
                        projectId: parentNode.resourceId,
                        page: parentNode.nextPage,
                        pageSize: TREE_PAGE_SIZE,
                        sort: RESOURCE_SORT_FIELD,
                    });
                    nextChildren = tasks.map((task) => mapTaskToTreeNode(task));
                    totalCount = tasks.count;
                } else if (parentNode.nodeType === 'task') {
                    const jobs = await core.jobs.get({
                        taskID: parentNode.resourceId,
                        page: parentNode.nextPage,
                        pageSize: TREE_PAGE_SIZE,
                        sort: RESOURCE_SORT_FIELD,
                    });
                    nextChildren = jobs.map((job) => mapJobToTreeNode(job));
                    totalCount = jobs.count;
                } else if (parentNode.nodeType === 'standalone-root') {
                    const tasks = await core.tasks.get({
                        filter: STANDALONE_TASKS_FILTER,
                        page: parentNode.nextPage,
                        pageSize: TREE_PAGE_SIZE,
                        sort: RESOURCE_SORT_FIELD,
                    });
                    nextChildren = tasks.map((task) => mapTaskToTreeNode(task));
                    totalCount = tasks.count;
                }

                updateIndexedTreeNode(parentKey, (currentNode) => {
                    const { items } = splitLoadMoreNode(currentNode.children);
                    const mergedChildren = dedupeTreeChildren([...items, ...nextChildren]);
                    const loadedCount = mergedChildren.length;
                    const nextPage = loadedCount < totalCount ? (currentNode.nextPage || 1) + 1 : undefined;

                    return {
                        ...currentNode,
                        children: buildPaginatedChildren(
                            currentNode,
                            mergedChildren,
                            loadedCount,
                            totalCount,
                            nextPage,
                        ),
                        loaded: true,
                        loadedCount,
                        totalCount,
                        nextPage,
                    };
                });
            } catch (error: unknown) {
                notification.error({
                    message: 'Could not load additional history tree data',
                    description: getErrorDescription(error),
                });
            }
        });
    }, [getIndexedTreeNode, trackTreeRequest, updateIndexedTreeNode]);

    const insertProjectNode = useCallback((project: Project): void => {
        commitTreeData((currentTree) => {
            const { projectNodes, standaloneRoot } = splitRootNodes(currentTree);
            const mergedProjects = dedupeTreeChildren([...projectNodes, mapProjectToTreeNode(project)]);
            const { totalCount: currentTotalCount, nextPage } = rootPaginationRef.current;
            const totalCount = Math.max(currentTotalCount, mergedProjects.length);

            rootPaginationRef.current = {
                loadedCount: mergedProjects.length,
                totalCount,
                nextPage,
            };

            return nextPage ?
                [
                    ...mergedProjects,
                    ...(standaloneRoot ? [standaloneRoot] : []),
                    createRootLoadMoreNode(mergedProjects.length, totalCount, nextPage),
                ] :
                [
                    ...mergedProjects,
                    ...(standaloneRoot ? [standaloneRoot] : []),
                ];
        });
    }, [commitTreeData]);

    const ensureStandaloneRootNode = useCallback((): void => {
        if (getIndexedTreeNode(STANDALONE_TASKS_ROOT_KEY)) {
            return;
        }

        commitTreeData((currentTree) => {
            const { projectNodes, loadMoreNode } = splitRootNodes(currentTree);
            return [
                ...projectNodes,
                createStandaloneRootNode(),
                ...(loadMoreNode ? [loadMoreNode] : []),
            ];
        });
    }, [commitTreeData, getIndexedTreeNode]);

    const insertChildNode = useCallback((parentKey: string, childNode: HistoryTreeNode): void => {
        updateIndexedTreeNode(parentKey, (currentNode) => {
            const { items } = splitLoadMoreNode(currentNode.children);
            const mergedChildren = dedupeTreeChildren([...items, childNode]);
            const loadedCount = mergedChildren.length;
            const totalCount = Math.max(currentNode.totalCount || 0, loadedCount);

            return {
                ...currentNode,
                loaded: true,
                loadedCount,
                totalCount,
                children: buildPaginatedChildren(
                    currentNode,
                    mergedChildren,
                    loadedCount,
                    totalCount,
                    currentNode.nextPage,
                ),
            };
        });
    }, [updateIndexedTreeNode]);

    const ensurePathForJob = useCallback(async (job: Job): Promise<void> => {
        const nextExpandedKeys = new Set(expandedKeysRef.current);

        if (job.projectId) {
            const projectKey = `project-${job.projectId}`;
            nextExpandedKeys.add(projectKey);

            let projectNode = getIndexedTreeNode(projectKey);
            if (!projectNode) {
                const [project] = await core.projects.get({ id: job.projectId });
                if (project) {
                    insertProjectNode(project);
                    projectNode = getIndexedTreeNode(projectKey);
                }
            }

            if (projectNode) {
                await loadChildren(projectNode);

                if (!getIndexedTreeNode(`task-${job.taskId}`)) {
                    const [task] = await core.tasks.get({ id: job.taskId });
                    if (task) {
                        insertChildNode(projectKey, mapTaskToTreeNode(task));
                    }
                }
            }
        }

        if (!job.projectId) {
            ensureStandaloneRootNode();
            nextExpandedKeys.add(STANDALONE_TASKS_ROOT_KEY);

            let standaloneRootNode = getIndexedTreeNode(STANDALONE_TASKS_ROOT_KEY);
            if (standaloneRootNode) {
                await loadChildren(standaloneRootNode);

                if (!getIndexedTreeNode(`task-${job.taskId}`)) {
                    const [task] = await core.tasks.get({ id: job.taskId });
                    if (task) {
                        insertChildNode(STANDALONE_TASKS_ROOT_KEY, mapTaskToTreeNode(task));
                    }
                }

                standaloneRootNode = getIndexedTreeNode(STANDALONE_TASKS_ROOT_KEY);
            }
        }

        const taskKey = `task-${job.taskId}`;
        nextExpandedKeys.add(taskKey);

        let taskNode = getIndexedTreeNode(taskKey);
        if (!taskNode && job.projectId) {
            const projectNode = getIndexedTreeNode(`project-${job.projectId}`);
            if (projectNode) {
                await loadChildren(projectNode);
                taskNode = getIndexedTreeNode(taskKey);
            }
        } else if (!taskNode && !job.projectId) {
            const standaloneRootNode = getIndexedTreeNode(STANDALONE_TASKS_ROOT_KEY);
            if (standaloneRootNode) {
                await loadChildren(standaloneRootNode);
                taskNode = getIndexedTreeNode(taskKey);
            }
        }

        if (taskNode) {
            await loadChildren(taskNode);
            if (!getIndexedTreeNode(`job-${job.id}`)) {
                insertChildNode(taskKey, mapJobToTreeNode(job));
            }
        }

        const nextKeys = [...nextExpandedKeys];
        expandedKeysRef.current = nextKeys;
        setExpandedKeys(nextKeys);
        setSelectedKeys([`job-${job.id}`]);
        setSelection({
            type: 'job',
            key: `job-${job.id}`,
            jobId: job.id,
            taskId: job.taskId,
            projectId: job.projectId,
            title: `Job #${job.id}`,
        });
        setHistoryPage(1);
    }, [ensureStandaloneRootNode, getIndexedTreeNode, insertChildNode, insertProjectNode, loadChildren]);

    const resetHistoryState = useCallback((hasMore: boolean, job: Job | null = null): void => {
        historyRequestID.current += 1;
        historyGroupsRef.current = [];
        historyRowsRef.current = [];
        historySnapshotRef.current = createHistorySnapshot(job);
        historyBaseReadyRef.current = job === null;
        historyHasMoreRef.current = hasMore;
        historyNextCursorRef.current = null;
        setHistoryRows([]);
        setHistoryHasMore(hasMore);
        setHistoryLoading(false);
    }, []);

    const rebuildHistoryRows = useCallback((snapshot: HistorySnapshot): void => {
        const rebuilt = appendHistoryRows(historyGroupsRef.current, snapshot);
        historyRowsRef.current = rebuilt.rows;
        historySnapshotRef.current = rebuilt.snapshot;
        setHistoryRows(rebuilt.rows);
    }, []);

    const buildHistoryBaseSnapshot = useCallback(async (job: Job): Promise<HistorySnapshot> => {
        let snapshot = createHistorySnapshot(job);

        if (!historyAfter) {
            return snapshot;
        }

        let nextCursor: string | null = null;
        let hasMore = true;

        while (hasMore) {
            const batch = await core.analytics.events.list({
                jobId: job.id,
                scope: 'update:job',
                objName: HISTORY_FIELDS,
                pageSize: HISTORY_FETCH_PAGE_SIZE,
                from: historyAfter,
                ...(nextCursor ? { cursor: nextCursor } : {}),
                includeCount: false,
            });

            const groupedBatch = groupHistoryEvents(batch);
            for (const group of groupedBatch) {
                snapshot = applyGroupToSnapshot(snapshot, group);
            }

            hasMore = batch.hasMore;
            nextCursor = batch.nextCursor ?? null;
            if (hasMore && !nextCursor) {
                break;
            }
        }

        return snapshot;
    }, [historyAfter]);

    const ensureHistoryRows = useCallback(async (jobId: number, requiredRows: number): Promise<void> => {
        const currentGroups = historyGroupsRef.current;
        if (currentGroups.length >= requiredRows || !historyHasMoreRef.current) {
            return;
        }

        const requestID = ++historyRequestID.current;
        let nextCursor = historyNextCursorRef.current;
        let hasMore: boolean = historyHasMoreRef.current;

        setHistoryLoading(true);

        try {
            let groupCount = currentGroups.length;
            while (groupCount < requiredRows && hasMore) {
                const batch = await core.analytics.events.list({
                    jobId,
                    scope: 'update:job',
                    objName: HISTORY_FIELDS,
                    pageSize: HISTORY_FETCH_PAGE_SIZE,
                    ...(historyFrom ? { from: historyFrom } : {}),
                    ...(historyTo ? { to: historyTo } : {}),
                    ...(nextCursor ? { cursor: nextCursor } : {}),
                    includeCount: false,
                });

                if (historyRequestID.current !== requestID) {
                    return;
                }

                const groupedBatch = groupHistoryEvents(batch);
                let groupsToAppend = groupedBatch;
                let nextSnapshot = historySnapshotRef.current;

                if (historyGroupsRef.current.length && groupedBatch.length) {
                    const lastGroup = historyGroupsRef.current[historyGroupsRef.current.length - 1];
                    const firstGroup = groupedBatch[0];

                    if (lastGroup.key === firstGroup.key) {
                        const mergedBoundaryGroup: HistoryChangeGroup = {
                            ...lastGroup,
                            events: {
                                ...lastGroup.events,
                                ...firstGroup.events,
                            },
                        };
                        historyGroupsRef.current = [
                            ...historyGroupsRef.current.slice(0, -1),
                            mergedBoundaryGroup,
                            ...groupedBatch.slice(1),
                        ];
                        groupsToAppend = groupedBatch.slice(1);

                        if (selectedJobRef.current && historyRowsRef.current.length) {
                            const boundaryRow = historyRowsRef.current[historyRowsRef.current.length - 1];
                            nextSnapshot = applyGroupToSnapshot(
                                {
                                    assignee: boundaryRow.assignee,
                                    stage: boundaryRow.stage,
                                    state: boundaryRow.state,
                                },
                                mergedBoundaryGroup,
                            );
                        }
                    } else {
                        historyGroupsRef.current = [...historyGroupsRef.current, ...groupedBatch];
                    }
                } else {
                    historyGroupsRef.current = [...historyGroupsRef.current, ...groupedBatch];
                }

                if (selectedJobRef.current && historyBaseReadyRef.current && groupsToAppend.length) {
                    const appended = appendHistoryRows(groupsToAppend, nextSnapshot);
                    historyRowsRef.current = [...historyRowsRef.current, ...appended.rows];
                    historySnapshotRef.current = appended.snapshot;
                    setHistoryRows(historyRowsRef.current);
                } else if (selectedJobRef.current && historyBaseReadyRef.current) {
                    historySnapshotRef.current = nextSnapshot;
                }

                nextCursor = batch.nextCursor ?? null;
                hasMore = batch.hasMore;
                groupCount = historyGroupsRef.current.length;
            }

            historyHasMoreRef.current = hasMore;
            historyNextCursorRef.current = nextCursor;
            setHistoryHasMore(hasMore);
        } catch (error: unknown) {
            if (historyRequestID.current !== requestID) {
                return;
            }

            notification.error({
                message: 'Could not load job history',
                description: getErrorDescription(error),
            });
        } finally {
            if (historyRequestID.current === requestID) {
                setHistoryLoading(false);
            }
        }
    }, [historyFrom, historyTo]);

    useEffect(() => {
        resetTreeBrowserState();
        loadInitialProjects();
    }, [loadInitialProjects, resetTreeBrowserState]);

    useEffect(() => {
        const normalizedSearch = projectSearchInput.trim();
        if (normalizedSearch === projectSearch) {
            return undefined;
        }

        const timeout = window.setTimeout(() => {
            setProjectSearch(normalizedSearch);
        }, PROJECT_SEARCH_DEBOUNCE_MS);

        return () => window.clearTimeout(timeout);
    }, [projectSearch, projectSearchInput]);

    useEffect(() => {
        expandedKeysRef.current = expandedKeys;
    }, [expandedKeys]);

    useEffect(() => {
        selectedJobRef.current = selectedJob;
    }, [selectedJob]);

    useEffect(() => {
        selectedHistoryJobIDRef.current = selection?.type === 'job' ? selection.jobId : null;
    }, [selection]);

    useEffect(() => {
        if (!selection || selection.type === 'job') {
            summaryRequestID.current += 1;
            summarySelectionKey.current = null;
            setSummaryJobs([]);
            setSummaryTotal(0);
            setSummaryPage(1);
            setSummaryLoading(false);
            return;
        }

        if (summarySelectionKey.current !== selection.key) {
            summarySelectionKey.current = selection.key;
            setSummaryJobs([]);
            setSummaryTotal(0);
            if (summaryPage !== 1) {
                setSummaryPage(1);
                return;
            }
        }

        const requestID = ++summaryRequestID.current;
        setSummaryLoading(true);
        const promise = selection.type === 'project' ?
            core.jobs.get({
                projectID: selection.projectId,
                page: summaryPage,
                pageSize: summaryPageSize,
                sort: RESOURCE_SORT_FIELD,
            }) :
            core.jobs.get({
                taskID: selection.taskId,
                page: summaryPage,
                pageSize: summaryPageSize,
                sort: RESOURCE_SORT_FIELD,
            });

        promise
            .then((jobs) => {
                if (summaryRequestID.current !== requestID) {
                    return;
                }
                setSummaryJobs([...jobs]);
                setSummaryTotal(jobs.count);
            })
            .catch((error: unknown) => {
                if (summaryRequestID.current !== requestID) {
                    return;
                }
                notification.error({
                    message: 'Could not load jobs for the selected resource',
                    description: getErrorDescription(error),
                });
            })
            .finally(() => {
                if (summaryRequestID.current === requestID) {
                    setSummaryLoading(false);
                }
            });
    }, [selection, summaryPage, summaryPageSize]);

    useEffect(() => {
        if (!selection || selection.type !== 'job') {
            jobDetailsRequestID.current += 1;
            setSelectedJob(null);
            setJobDetailsLoading(false);
            resetHistoryState(false);
            return;
        }

        const requestID = ++jobDetailsRequestID.current;
        setSelectedJob(null);
        resetHistoryState(true);
        setJobDetailsLoading(true);
        core.jobs.get({ jobID: selection.jobId })
            .then(([job]) => {
                if (jobDetailsRequestID.current !== requestID) {
                    return;
                }
                setSelectedJob(job || null);
            })
            .catch((error: unknown) => {
                if (jobDetailsRequestID.current !== requestID) {
                    return;
                }
                notification.error({
                    message: 'Could not load the selected job',
                    description: getErrorDescription(error),
                });
            })
            .finally(() => {
                if (jobDetailsRequestID.current === requestID) {
                    setJobDetailsLoading(false);
                }
            });
    }, [selection, resetHistoryState]);

    useEffect(() => {
        if (!selectedJob) {
            historyBaseRequestID.current += 1;
            historyBaseReadyRef.current = false;
            if (!historyGroupsRef.current.length) {
                historyRowsRef.current = [];
                setHistoryRows([]);
            }
            historySnapshotRef.current = createHistorySnapshot(null);
            setHistoryBaseLoading(false);
            return;
        }

        const requestID = ++historyBaseRequestID.current;
        historyBaseReadyRef.current = false;
        setHistoryBaseLoading(true);

        buildHistoryBaseSnapshot(selectedJob)
            .then((snapshot) => {
                if (historyBaseRequestID.current !== requestID) {
                    return;
                }

                historyBaseReadyRef.current = true;
                rebuildHistoryRows(snapshot);
            })
            .catch((error: unknown) => {
                if (historyBaseRequestID.current !== requestID) {
                    return;
                }

                const fallbackSnapshot = createHistorySnapshot(selectedJob);
                historyBaseReadyRef.current = true;
                rebuildHistoryRows(fallbackSnapshot);
                notification.error({
                    message: 'Could not build the selected history range',
                    description: getErrorDescription(error),
                });
            })
            .finally(() => {
                if (historyBaseRequestID.current === requestID) {
                    setHistoryBaseLoading(false);
                }
            });
    }, [selectedJob, historyFilterKey, buildHistoryBaseSnapshot, rebuildHistoryRows]);

    useEffect(() => {
        if (!selectedHistoryJobIDRef.current) {
            return;
        }

        const selectedJobID = selectedHistoryJobIDRef.current;
        const snapshotJob = (
            selectedJobRef.current && selectedJobRef.current.id === selectedJobID
        ) ? selectedJobRef.current : null;

        resetHistoryState(true, snapshotJob);
        setHistoryPage((currentPage) => (currentPage === 1 ? currentPage : 1));
    }, [historyFilterKey, resetHistoryState]);

    useEffect(() => {
        if (!selection || selection.type !== 'job') {
            return;
        }

        ensureHistoryRows(selection.jobId, historyPage * historyPageSize);
    }, [selection, historyPage, historyPageSize, historyFilterKey, ensureHistoryRows]);

    const historyPaginationTotal = useMemo(() => (
        historyHasMore ? historyRows.length + historyPageSize : historyRows.length
    ), [historyHasMore, historyRows.length, historyPageSize]);

    const paginatedHistoryRows = useMemo(() => (
        historyRows.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize)
    ), [historyRows, historyPage, historyPageSize]);

    const combinedHistoryLoading = historyLoading || historyBaseLoading;

    const historyDateRangeLabel = useMemo(() => {
        if (!historyDateRange) {
            return 'Showing all available history';
        }

        const [fromDate, toDate] = historyDateRange;
        return `Showing ${fromDate.format('YYYY-MM-DD')} to ${toDate.format('YYYY-MM-DD')}`;
    }, [historyDateRange]);

    useEffect(() => {
        if (historyHasMore) {
            return;
        }

        const maxPage = Math.max(1, Math.ceil(historyRows.length / historyPageSize));
        if (historyPage > maxPage) {
            setHistoryPage(maxPage);
        }
    }, [historyHasMore, historyPage, historyPageSize, historyRows.length]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(summaryTotal / summaryPageSize) || 1);
        if (summaryPage > maxPage) {
            setSummaryPage(maxPage);
        }
    }, [summaryPage, summaryPageSize, summaryTotal]);

    const handleSummaryChange = useCallback((page: number, pageSize: number): void => {
        setSummaryPage(page);
        setSummaryPageSize(pageSize);
    }, []);

    const handleSelectSummaryJob = useCallback((job: Job): void => {
        ensurePathForJob(job).catch(() => undefined);
    }, [ensurePathForJob]);

    const handleHistoryDateRangeChange = useCallback((range: HistoryDateRange | null): void => {
        setHistoryDateRange(range);
    }, []);

    const handleResetHistoryDateRange = useCallback((): void => {
        setHistoryDateRange(createDefaultHistoryDateRange());
    }, []);

    const handleSetAllTime = useCallback((): void => {
        setHistoryDateRange(null);
    }, []);

    const handleHistoryChange = useCallback((page: number, pageSize: number): void => {
        setHistoryPage(page);
        setHistoryPageSize(pageSize);
    }, []);

    const handleProjectSearchInputChange = useCallback((value: string): void => {
        setProjectSearchInput(value);
        if (!value) {
            setProjectSearch('');
        }
    }, []);

    const handleProjectSearch = useCallback((value: string): void => {
        setProjectSearch(value);
    }, []);

    const handleProjectSortChange = useCallback((value: string): void => {
        setProjectSort(value);
    }, []);

    const applyTreeSelection = useCallback((node: HistoryTreeNode): void => {
        if (node.nodeType === 'task') {
            focusTaskExpansion(node);
        } else if (!node.isLeaf && node.nodeType !== 'load-more') {
            expandTreeNode(node.key);
        }

        setSelectedKeys([node.key]);
        if (node.nodeType === 'project') {
            setSelection({
                type: 'project',
                key: node.key,
                projectId: node.resourceId,
                title: node.title,
            });
        } else if (node.nodeType === 'task') {
            setSelection({
                type: 'task',
                key: node.key,
                taskId: node.resourceId,
                projectId: node.projectId ?? null,
                title: node.title,
            });
        } else if (node.taskId) {
            setHistoryPage(1);
            setSelection({
                type: 'job',
                key: node.key,
                jobId: node.resourceId,
                taskId: node.taskId,
                projectId: node.projectId ?? null,
                title: node.title,
            });
        }

        loadChildren(node).catch(() => undefined);
    }, [
        expandTreeNode,
        focusTaskExpansion,
        loadChildren,
    ]);

    const clearSelection = useCallback((): void => {
        setSelectedKeys([]);
        setSelection(null);
        setHistoryPage(1);
    }, []);

    const handleTreeExpand = useCallback((keys: string[], node: HistoryTreeNode): void => {
        expandedKeysRef.current = keys;
        setExpandedKeys(keys);
        if (node.nodeType !== 'load-more') {
            loadChildren(node).catch(() => undefined);
        }
    }, [loadChildren]);

    const handleTreeSelect = useCallback((keys: string[], node: HistoryTreeNode): void => {
        const [selectedKey] = keys;
        if (!selectedKey) {
            return;
        }

        if (node.nodeType === 'load-more' && node.parentKey) {
            if (node.parentKey === ROOT_TREE_KEY) {
                loadMoreProjects().catch(() => undefined);
            } else {
                loadMoreChildren(node.parentKey).catch(() => undefined);
            }
            return;
        }

        applyTreeSelection(node);
    }, [
        applyTreeSelection,
        loadMoreChildren,
        loadMoreProjects,
    ]);

    const handleSelectionBack = useCallback((): void => {
        if (!selection) {
            return;
        }

        if (selection.type === 'job') {
            const taskNode = getIndexedTreeNode(`task-${selection.taskId}`);
            if (taskNode) {
                applyTreeSelection(taskNode);
                return;
            }
        }

        if (selection.type === 'task' && selection.projectId) {
            const projectNode = getIndexedTreeNode(`project-${selection.projectId}`);
            if (projectNode) {
                applyTreeSelection(projectNode);
                return;
            }
        }

        clearSelection();
    }, [
        applyTreeSelection,
        clearSelection,
        getIndexedTreeNode,
        selection,
    ]);

    return {
        treeData,
        treeLoading,
        expandedKeys,
        selectedKeys,
        selection,
        projectSearchInput,
        projectSort,
        normalizedProjectSearch,
        summaryLoading,
        summaryJobs,
        summaryPage,
        summaryPageSize,
        summaryTotal,
        jobDetailsLoading,
        selectedJob,
        historyDateRangeLabel,
        historyDateRange,
        historyLoading: combinedHistoryLoading,
        paginatedHistoryRows,
        historyPage,
        historyPageSize,
        historyPaginationTotal,
        handleProjectSearchInputChange,
        handleProjectSearch,
        handleProjectSortChange,
        handleTreeExpand,
        handleTreeSelect,
        handleToggleStandaloneRoot: toggleStandaloneRoot,
        handleTreeLoadData: loadChildren,
        handleSelectionBack,
        handleSummaryChange,
        handleSelectSummaryJob,
        handleHistoryDateRangeChange,
        handleResetHistoryDateRange,
        handleSetAllTime,
        handleHistoryChange,
    };
}
