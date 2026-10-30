// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import {
    useCallback, useEffect, useRef, useState,
} from 'react';
import notification from 'antd/lib/notification';

import {
    getCore, Job, Task,
} from 'cvat-core-wrapper';

import {
    getErrorDescription,
    HistorySelection,
} from './history-utils';

const core = getCore();
const SUMMARY_PAGE_SIZE = 10;
const RESOURCE_SORT_FIELD = '-id';

export interface UseHistorySummaryResult {
    summaryLoading: boolean;
    summaryTasks: Task[];
    summaryJobs: Job[];
    summaryPage: number;
    summaryPageSize: number;
    summaryTotal: number;
    handleSummaryChange: (page: number, pageSize: number) => void;
}

export default function useHistorySummary(selection: HistorySelection | null): UseHistorySummaryResult {
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [summaryTasks, setSummaryTasks] = useState<Task[]>([]);
    const [summaryJobs, setSummaryJobs] = useState<Job[]>([]);
    const [summaryPage, setSummaryPage] = useState(1);
    const [summaryPageSize, setSummaryPageSize] = useState(SUMMARY_PAGE_SIZE);
    const [summaryTotal, setSummaryTotal] = useState(0);
    const summaryRequestID = useRef(0);
    const summarySelectionKey = useRef<string | null>(null);

    useEffect(() => {
        if (!selection || selection.type === 'job') {
            summaryRequestID.current += 1;
            summarySelectionKey.current = null;
            setSummaryTasks([]);
            setSummaryJobs([]);
            setSummaryTotal(0);
            setSummaryPage(1);
            setSummaryLoading(false);
            return;
        }

        if (summarySelectionKey.current !== selection.key) {
            summarySelectionKey.current = selection.key;
            setSummaryTasks([]);
            setSummaryJobs([]);
            setSummaryTotal(0);
            if (summaryPage !== 1) {
                setSummaryPage(1);
                return;
            }
        }

        const requestID = ++summaryRequestID.current;
        setSummaryLoading(true);
        if (selection.type === 'project') {
            // Do not cast this to Task[]; the pager needs the returned count.
            core.tasks.get({
                projectId: selection.projectId,
                page: summaryPage,
                pageSize: summaryPageSize,
                sort: RESOURCE_SORT_FIELD,
            })
                .then((tasks) => {
                    if (summaryRequestID.current !== requestID) {
                        return;
                    }

                    setSummaryTasks([...tasks]);
                    setSummaryJobs([]);
                    setSummaryTotal(tasks.count);
                })
                .catch((error: unknown) => {
                    if (summaryRequestID.current !== requestID) {
                        return;
                    }
                    notification.error({
                        message: 'Could not load tasks for the selected resource',
                        description: getErrorDescription(error),
                    });
                })
                .finally(() => {
                    if (summaryRequestID.current === requestID) {
                        setSummaryLoading(false);
                    }
                });
        } else {
            // Same here: jobs come back as a paginated resource, not a plain array.
            core.jobs.get({
                taskID: selection.taskId,
                page: summaryPage,
                pageSize: summaryPageSize,
                sort: RESOURCE_SORT_FIELD,
            })
                .then((jobs) => {
                    if (summaryRequestID.current !== requestID) {
                        return;
                    }

                    setSummaryTasks([]);
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
        }
    }, [selection, summaryPage, summaryPageSize]);

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

    return {
        summaryLoading,
        summaryTasks,
        summaryJobs,
        summaryPage,
        summaryPageSize,
        summaryTotal,
        handleSummaryChange,
    };
}
