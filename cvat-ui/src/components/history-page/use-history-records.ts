// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import notification from 'antd/lib/notification';

import {
    getCore, Job, Project, Task,
} from 'cvat-core-wrapper';

import {
    appendHistoryRows,
    applyGroupToSnapshot,
    createDefaultHistoryDateRange,
    createHistorySnapshot,
    getErrorDescription,
    getHistorySelectionQuery,
    groupHistoryEvents,
    HistoryChangeGroup,
    HistoryChangeRow,
    HistoryDatePreset,
    HistoryDateRange,
    HistorySelection,
    HistorySnapshot,
    HistorySnapshotSource,
} from './history-utils';

const core = getCore();
const HISTORY_PAGE_SIZE = 10;
const HISTORY_FETCH_PAGE_SIZE = 100;

export interface UseHistoryRecordsResult {
    resourceDetailsLoading: boolean;
    selectedProject: Project | null;
    selectedTask: Task | null;
    selectedJob: Job | null;
    historyDatePreset: HistoryDatePreset;
    historyDateRangeLabel: string;
    historyDateRange: HistoryDateRange | null;
    historyLoading: boolean;
    paginatedHistoryRows: HistoryChangeRow[];
    historyPage: number;
    historyPageSize: number;
    historyPaginationTotal: number;
    handleHistoryDateRangeChange: (range: HistoryDateRange | null) => void;
    handleResetHistoryDateRange: () => void;
    handleSetAllTime: () => void;
    handleHistoryChange: (page: number, pageSize: number) => void;
}

export default function useHistoryRecords(selection: HistorySelection | null): UseHistoryRecordsResult {
    const [resourceDetailsLoading, setResourceDetailsLoading] = useState(false);
    const [selectedProject, setSelectedProject] = useState<Project | null>(null);
    const [selectedTask, setSelectedTask] = useState<Task | null>(null);
    const [selectedJob, setSelectedJob] = useState<Job | null>(null);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyBaseLoading, setHistoryBaseLoading] = useState(false);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [historyRows, setHistoryRows] = useState<HistoryChangeRow[]>([]);
    const [historyPage, setHistoryPage] = useState(1);
    const historyPageSize = HISTORY_PAGE_SIZE;
    const [historyDateRange, setHistoryDateRange] = useState<HistoryDateRange | null>(null);
    const [historyDatePreset, setHistoryDatePreset] = useState<HistoryDatePreset>('all-time');
    const resourceDetailsRequestID = useRef(0);
    const historyRequestID = useRef(0);
    const historyBaseRequestID = useRef(0);
    const selectedResourceRef = useRef<HistorySnapshotSource | null>(null);
    const selectedHistorySelectionKeyRef = useRef<string | null>(null);
    const historyGroupsRef = useRef<HistoryChangeGroup[]>([]);
    const historyRowsRef = useRef<HistoryChangeRow[]>([]);
    const historySnapshotRef = useRef<HistorySnapshot>(createHistorySnapshot(null));
    const historyBaseReadyRef = useRef(false);
    const historyHasMoreRef = useRef(false);
    const historyNextCursorRef = useRef<string | null>(null);
    const historyFrom = historyDateRange?.[0]?.toISOString() || null;
    const historyTo = historyDateRange?.[1]?.toISOString() || null;
    const historyAfter = historyDateRange?.[1]?.add(1, 'millisecond').toISOString() || null;
    const historyFilterKey = `${historyFrom || 'all'}|${historyTo || 'all'}`;
    const selectedResource = useMemo<HistorySnapshotSource | null>(() => {
        if (!selection) {
            return null;
        }

        if (selection.type === 'project') {
            return selectedProject;
        }

        if (selection.type === 'task') {
            return selectedTask;
        }

        return selectedJob;
    }, [selection, selectedJob, selectedProject, selectedTask]);

    const resetHistoryState = useCallback((hasMore: boolean, resource: HistorySnapshotSource | null = null): void => {
        historyRequestID.current += 1;
        historyGroupsRef.current = [];
        historyRowsRef.current = [];
        historySnapshotRef.current = createHistorySnapshot(resource);
        historyBaseReadyRef.current = resource === null;
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

    const buildHistoryBaseSnapshot = useCallback(async (
        resource: HistorySnapshotSource,
        selectionForHistory: HistorySelection,
    ): Promise<HistorySnapshot> => {
        let snapshot = createHistorySnapshot(resource);

        if (!historyAfter) {
            return snapshot;
        }

        let nextCursor: string | null = null;
        let hasMore = true;
        const selectionQuery = getHistorySelectionQuery(selectionForHistory);

        while (hasMore) {
            const batch = await core.analytics.events.list({
                ...selectionQuery,
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

    const ensureHistoryRows = useCallback(async (
        selectionForHistory: HistorySelection,
        requiredRows: number,
    ): Promise<void> => {
        const currentGroups = historyGroupsRef.current;
        if (currentGroups.length >= requiredRows || !historyHasMoreRef.current) {
            return;
        }

        const requestID = ++historyRequestID.current;
        let nextCursor = historyNextCursorRef.current;
        let hasMore: boolean = historyHasMoreRef.current;
        const selectionQuery = getHistorySelectionQuery(selectionForHistory);

        setHistoryLoading(true);

        try {
            let groupCount = currentGroups.length;
            while (groupCount < requiredRows && hasMore) {
                const batch = await core.analytics.events.list({
                    ...selectionQuery,
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

                        if (selectedResourceRef.current && historyRowsRef.current.length) {
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

                if (selectedResourceRef.current && historyBaseReadyRef.current && groupsToAppend.length) {
                    const appended = appendHistoryRows(groupsToAppend, nextSnapshot);
                    historyRowsRef.current = [...historyRowsRef.current, ...appended.rows];
                    historySnapshotRef.current = appended.snapshot;
                    setHistoryRows(historyRowsRef.current);
                } else if (selectedResourceRef.current && historyBaseReadyRef.current) {
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
                message: 'Could not load history',
                description: getErrorDescription(error),
            });
        } finally {
            if (historyRequestID.current === requestID) {
                setHistoryLoading(false);
            }
        }
    }, [historyFrom, historyTo]);

    useEffect(() => {
        selectedResourceRef.current = selectedResource;
    }, [selectedResource]);

    useEffect(() => {
        selectedHistorySelectionKeyRef.current = selection?.key ?? null;
    }, [selection]);

    useEffect(() => {
        setHistoryPage(1);
    }, [selection?.key]);

    useEffect(() => {
        if (!selection) {
            resourceDetailsRequestID.current += 1;
            setSelectedProject(null);
            setSelectedTask(null);
            setSelectedJob(null);
            setResourceDetailsLoading(false);
            resetHistoryState(false);
            return;
        }

        const requestID = ++resourceDetailsRequestID.current;
        setSelectedProject(null);
        setSelectedTask(null);
        setSelectedJob(null);
        resetHistoryState(true);
        setResourceDetailsLoading(true);
        let promise: Promise<Project[] | Task[] | Job[]>;
        if (selection.type === 'project') {
            promise = core.projects.get({ id: selection.projectId });
        } else if (selection.type === 'task') {
            promise = core.tasks.get({ id: selection.taskId });
        } else {
            promise = core.jobs.get({ jobID: selection.jobId });
        }

        promise
            .then((resources) => {
                if (resourceDetailsRequestID.current !== requestID) {
                    return;
                }

                if (selection.type === 'project') {
                    setSelectedProject((resources[0] as Project) || null);
                } else if (selection.type === 'task') {
                    setSelectedTask((resources[0] as Task) || null);
                } else {
                    setSelectedJob((resources[0] as Job) || null);
                }
            })
            .catch((error: unknown) => {
                if (resourceDetailsRequestID.current !== requestID) {
                    return;
                }
                notification.error({
                    message: `Could not load the selected ${selection.type}`,
                    description: getErrorDescription(error),
                });
            })
            .finally(() => {
                if (resourceDetailsRequestID.current === requestID) {
                    setResourceDetailsLoading(false);
                }
            });
    }, [selection, resetHistoryState]);

    useEffect(() => {
        if (!selection || !selectedResource) {
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

        buildHistoryBaseSnapshot(selectedResource, selection)
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

                const fallbackSnapshot = createHistorySnapshot(selectedResource);
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
    }, [
        selection,
        selectedResource,
        historyFilterKey,
        buildHistoryBaseSnapshot,
        rebuildHistoryRows,
    ]);

    useEffect(() => {
        if (!selectedHistorySelectionKeyRef.current) {
            return;
        }

        resetHistoryState(true, selectedResourceRef.current);
        setHistoryPage((currentPage) => (currentPage === 1 ? currentPage : 1));
    }, [historyFilterKey, resetHistoryState]);

    useEffect(() => {
        if (!selection) {
            return;
        }

        ensureHistoryRows(selection, historyPage * historyPageSize);
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

    const handleHistoryDateRangeChange = useCallback((range: HistoryDateRange | null): void => {
        setHistoryDateRange(range);
        setHistoryDatePreset(range ? 'custom' : 'all-time');
    }, []);

    const handleResetHistoryDateRange = useCallback((): void => {
        setHistoryDateRange(createDefaultHistoryDateRange());
        setHistoryDatePreset('last-30-days');
    }, []);

    const handleSetAllTime = useCallback((): void => {
        setHistoryDateRange(null);
        setHistoryDatePreset('all-time');
    }, []);

    const handleHistoryChange = useCallback((page: number): void => {
        setHistoryPage(page);
    }, []);

    return {
        resourceDetailsLoading,
        selectedProject,
        selectedTask,
        selectedJob,
        historyDatePreset,
        historyDateRangeLabel,
        historyDateRange,
        historyLoading: combinedHistoryLoading,
        paginatedHistoryRows,
        historyPage,
        historyPageSize,
        historyPaginationTotal,
        handleHistoryDateRangeChange,
        handleResetHistoryDateRange,
        handleSetAllTime,
        handleHistoryChange,
    };
}
