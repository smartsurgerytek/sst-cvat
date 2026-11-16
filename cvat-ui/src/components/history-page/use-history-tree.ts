// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    useCallback, useEffect, useRef, useState,
} from 'react';
import notification from 'antd/lib/notification';

import {
    getCore, Job, Project, Task,
} from 'cvat-core-wrapper';

import {
    buildPaginatedChildren,
    buildRootTreeNodes,
    buildTreeNodeIndex,
    createRootLoadMoreNode,
    createStandaloneRootNode,
    dedupeTreeChildren,
    getErrorDescription,
    HistorySelection,
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

export interface UseHistoryTreeResult {
    treeData: HistoryTreeNode[];
    treeLoading: boolean;
    expandedKeys: string[];
    selectedKeys: string[];
    selection: HistorySelection | null;
    projectSearchInput: string;
    projectSort: string;
    normalizedProjectSearch: string;
    handleProjectSearchInputChange: (value: string) => void;
    handleProjectSearch: (value: string) => void;
    handleProjectSortChange: (value: string) => void;
    handleTreeExpand: (keys: string[], node: HistoryTreeNode) => void;
    handleTreeSelect: (keys: string[], node: HistoryTreeNode) => void;
    handleToggleStandaloneRoot: (node: HistoryTreeNode) => void;
    handleTreeLoadData: (node: HistoryTreeNode) => Promise<void>;
    handleSelectionBack: () => void;
    handleSelectSummaryTask: (task: Task) => void;
    handleSelectSummaryJob: (job: Job) => void;
}

function createSelectionFromNode(node: HistoryTreeNode): HistorySelection | null {
    if (node.nodeType === 'project') {
        return {
            type: 'project',
            key: node.key,
            projectId: node.resourceId,
            title: node.title,
        };
    }

    if (node.nodeType === 'task') {
        return {
            type: 'task',
            key: node.key,
            taskId: node.resourceId,
            projectId: node.projectId ?? null,
            title: node.title,
        };
    }

    if (node.nodeType === 'job' && node.taskId) {
        return {
            type: 'job',
            key: node.key,
            jobId: node.resourceId,
            taskId: node.taskId,
            projectId: node.projectId ?? null,
            title: node.title,
        };
    }

    return null;
}

export default function useHistoryTree(): UseHistoryTreeResult {
    const [treeData, setTreeData] = useState<HistoryTreeNode[]>([]);
    const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [selection, setSelection] = useState<HistorySelection | null>(null);
    const [treeLoading, setTreeLoading] = useState(true);
    const [projectSearchInput, setProjectSearchInput] = useState('');
    const [projectSearch, setProjectSearch] = useState('');
    const [projectSort, setProjectSort] = useState(DEFAULT_PROJECT_SORT);
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
    const normalizedProjectSearch = projectSearch.trim();
    const projectQueryKey = `${projectSort}|${normalizedProjectSearch}`;
    const shouldShowStandaloneTasks = !normalizedProjectSearch;

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
            await trackTreeRequest(`load-${ROOT_TREE_KEY}-${projectQueryKey}`, async (): Promise<void> => {
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

        await trackTreeRequest(`load-${node.key}`, async (): Promise<void> => {
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
            await trackTreeRequest(
                `load-more-${ROOT_TREE_KEY}-${projectQueryKey}-${nextPage}`,
                async (): Promise<void> => {
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
                },
            );
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
        await trackTreeRequest(`load-more-${parentKey}`, async (): Promise<void> => {
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

    const applyTreeSelection = useCallback((node: HistoryTreeNode): void => {
        if (node.nodeType === 'task') {
            focusTaskExpansion(node);
        } else if (!node.isLeaf && node.nodeType !== 'load-more') {
            expandTreeNode(node.key);
        }

        const nextSelection = createSelectionFromNode(node);
        if (!nextSelection) {
            return;
        }

        setSelectedKeys([node.key]);
        setSelection(nextSelection);
        loadChildren(node).catch(() => undefined);
    }, [
        expandTreeNode,
        focusTaskExpansion,
        loadChildren,
    ]);

    const clearSelection = useCallback((): void => {
        setSelectedKeys([]);
        setSelection(null);
    }, []);

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
    }, [ensureStandaloneRootNode, getIndexedTreeNode, insertChildNode, insertProjectNode, loadChildren]);

    const ensurePathForTask = useCallback(async (task: Task): Promise<void> => {
        const nextExpandedKeys = new Set(expandedKeysRef.current);

        if (task.projectId) {
            const projectKey = `project-${task.projectId}`;
            nextExpandedKeys.add(projectKey);

            let projectNode = getIndexedTreeNode(projectKey);
            if (!projectNode) {
                const [project] = await core.projects.get({ id: task.projectId });
                if (project) {
                    insertProjectNode(project);
                    projectNode = getIndexedTreeNode(projectKey);
                }
            }

            if (projectNode) {
                await loadChildren(projectNode);

                if (!getIndexedTreeNode(`task-${task.id}`)) {
                    insertChildNode(projectKey, mapTaskToTreeNode(task));
                }
            }
        } else {
            ensureStandaloneRootNode();
            nextExpandedKeys.add(STANDALONE_TASKS_ROOT_KEY);

            const standaloneRootNode = getIndexedTreeNode(STANDALONE_TASKS_ROOT_KEY);
            if (standaloneRootNode) {
                await loadChildren(standaloneRootNode);

                if (!getIndexedTreeNode(`task-${task.id}`)) {
                    insertChildNode(STANDALONE_TASKS_ROOT_KEY, mapTaskToTreeNode(task));
                }
            }
        }

        const taskNode = getIndexedTreeNode(`task-${task.id}`);
        if (!taskNode) {
            return;
        }

        const nextKeys = [...nextExpandedKeys];
        expandedKeysRef.current = nextKeys;
        setExpandedKeys(nextKeys);
        applyTreeSelection(taskNode);
    }, [
        applyTreeSelection,
        ensureStandaloneRootNode,
        getIndexedTreeNode,
        insertChildNode,
        insertProjectNode,
        loadChildren,
    ]);

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

    const handleSelectSummaryTask = useCallback((task: Task): void => {
        ensurePathForTask(task).catch(() => undefined);
    }, [ensurePathForTask]);

    const handleSelectSummaryJob = useCallback((job: Job): void => {
        ensurePathForJob(job).catch(() => undefined);
    }, [ensurePathForJob]);

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
        handleProjectSearchInputChange,
        handleProjectSearch,
        handleProjectSortChange,
        handleTreeExpand,
        handleTreeSelect,
        handleToggleStandaloneRoot: toggleStandaloneRoot,
        handleTreeLoadData: loadChildren,
        handleSelectionBack,
        handleSelectSummaryTask,
        handleSelectSummaryJob,
    };
}
