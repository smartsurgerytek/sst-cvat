// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useMemo } from 'react';
import Card from 'antd/lib/card';
import Table from 'antd/lib/table';
import Empty from 'antd/lib/empty';
import Spin from 'antd/lib/spin';
import Button from 'antd/lib/button';
import DatePicker from 'antd/lib/date-picker';
import Descriptions from 'antd/lib/descriptions';
import Text from 'antd/lib/typography/Text';
import dayjs from 'dayjs';

import { Job, User } from 'cvat-core-wrapper';

import {
    formatAssignee,
    HistoryChangeRow,
    HistoryDateRange,
    HistorySelection,
} from './history-utils';

interface HistoryRightPanelProps {
    selection: HistorySelection | null;
    summaryLoading: boolean;
    summaryJobs: Job[];
    summaryPage: number;
    summaryPageSize: number;
    summaryTotal: number;
    onSummaryChange: (page: number, pageSize: number) => void;
    onSelectSummaryJob: (job: Job) => void;
    jobDetailsLoading: boolean;
    selectedJob: Job | null;
    historyDateRangeLabel: string;
    historyDateRange: HistoryDateRange | null;
    onHistoryDateRangeChange: (range: HistoryDateRange | null) => void;
    onResetHistoryDateRange: () => void;
    onSetAllTime: () => void;
    historyLoading: boolean;
    historyRows: HistoryChangeRow[];
    historyPage: number;
    historyPageSize: number;
    historyPaginationTotal: number;
    onHistoryChange: (page: number, pageSize: number) => void;
}

interface JobSummaryRow {
    key: number;
    id: number;
    taskId: number;
    assignee: User | null;
    stage: Job['stage'];
    state: Job['state'];
    updatedDate: string;
}

function HistoryRightPanel(props: HistoryRightPanelProps): JSX.Element {
    const {
        selection,
        summaryLoading,
        summaryJobs,
        summaryPage,
        summaryPageSize,
        summaryTotal,
        onSummaryChange,
        onSelectSummaryJob,
        jobDetailsLoading,
        selectedJob,
        historyDateRangeLabel,
        historyDateRange,
        onHistoryDateRangeChange,
        onResetHistoryDateRange,
        onSetAllTime,
        historyLoading,
        historyRows,
        historyPage,
        historyPageSize,
        historyPaginationTotal,
        onHistoryChange,
    } = props;

    const summaryRows = useMemo<JobSummaryRow[]>(() => summaryJobs.map((job) => ({
        key: job.id,
        id: job.id,
        taskId: job.taskId,
        assignee: job.assignee,
        stage: job.stage,
        state: job.state,
        updatedDate: job.updatedDate,
    })), [summaryJobs]);

    const summaryJobsByID = useMemo(() => (
        new Map(summaryJobs.map((job) => [job.id, job]))
    ), [summaryJobs]);

    const jobSummaryColumns = useMemo(() => ([
        {
            title: 'Job',
            dataIndex: 'id',
            key: 'id',
            render: (value: number, row: JobSummaryRow) => (
                <Button
                    type='link'
                    onClick={() => {
                        const job = summaryJobsByID.get(row.id);
                        if (job) {
                            onSelectSummaryJob(job);
                        }
                    }}
                >
                    {`Job #${value}`}
                </Button>
            ),
        },
        {
            title: 'Task',
            dataIndex: 'taskId',
            key: 'taskId',
            render: (value: number) => `Task #${value}`,
        },
        {
            title: 'Assignee',
            dataIndex: 'assignee',
            key: 'assignee',
            render: (value: User | null) => formatAssignee(value),
        },
        {
            title: 'Stage',
            dataIndex: 'stage',
            key: 'stage',
        },
        {
            title: 'State',
            dataIndex: 'state',
            key: 'state',
        },
        {
            title: 'Updated',
            dataIndex: 'updatedDate',
            key: 'updatedDate',
            render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
        },
    ]), [onSelectSummaryJob, summaryJobsByID]);

    const historyColumns = useMemo(() => ([
        {
            title: 'Time',
            dataIndex: 'time',
            key: 'time',
            render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
        },
        {
            title: 'User',
            dataIndex: 'user',
            key: 'user',
        },
        {
            title: 'Assignee',
            dataIndex: 'assignee',
            key: 'assignee',
        },
        {
            title: 'Stage',
            dataIndex: 'stage',
            key: 'stage',
        },
        {
            title: 'State',
            dataIndex: 'state',
            key: 'state',
        },
    ]), []);

    if (!selection) {
        return (
            <div className='cvat-history-empty-state'>
                <Empty description='Select a project, task, or job to view history' />
            </div>
        );
    }

    if (selection.type === 'project' || selection.type === 'task') {
        return (
            <Card title={selection.title} className='cvat-history-card'>
                <div className='cvat-history-card-meta'>
                    <Text type='secondary'>
                        {selection.type === 'project' ?
                            `Project #${selection.projectId}` :
                            `Task #${selection.taskId}`}
                    </Text>
                </div>
                <Table<JobSummaryRow>
                    rowKey='id'
                    loading={summaryLoading}
                    columns={jobSummaryColumns}
                    dataSource={summaryRows}
                    pagination={{
                        current: summaryPage,
                        pageSize: summaryPageSize,
                        total: summaryTotal,
                        hideOnSinglePage: true,
                        showSizeChanger: true,
                        pageSizeOptions: ['10', '20', '50'],
                        onChange: onSummaryChange,
                    }}
                />
            </Card>
        );
    }

    return (
        <div className='cvat-history-job-detail'>
            <Card title={selection.title} className='cvat-history-card'>
                <Spin spinning={jobDetailsLoading}>
                    {selectedJob ? (
                        <Descriptions column={2} bordered size='small'>
                            <Descriptions.Item label='Project'>
                                {selectedJob.projectId ? `Project #${selectedJob.projectId}` : '-'}
                            </Descriptions.Item>
                            <Descriptions.Item label='Task'>
                                {`Task #${selectedJob.taskId}`}
                            </Descriptions.Item>
                            <Descriptions.Item label='Assignee'>
                                {formatAssignee(selectedJob.assignee)}
                            </Descriptions.Item>
                            <Descriptions.Item label='Stage'>
                                {selectedJob.stage}
                            </Descriptions.Item>
                            <Descriptions.Item label='State'>
                                {selectedJob.state}
                            </Descriptions.Item>
                            <Descriptions.Item label='Updated'>
                                {dayjs(selectedJob.updatedDate).format('YYYY-MM-DD HH:mm:ss')}
                            </Descriptions.Item>
                        </Descriptions>
                    ) : (
                        <Empty description='Job details are unavailable' />
                    )}
                </Spin>
            </Card>
            <Card title='Change history' className='cvat-history-card'>
                <div className='cvat-history-history-toolbar'>
                    <Text type='secondary'>{historyDateRangeLabel}</Text>
                    <div className='cvat-history-history-controls'>
                        <DatePicker.RangePicker
                            allowClear
                            value={historyDateRange}
                            format='YYYY-MM-DD'
                            onChange={(value) => {
                                const [fromDate, toDate] = value || [];
                                if (fromDate && toDate) {
                                    onHistoryDateRangeChange([
                                        fromDate.startOf('day'),
                                        toDate.endOf('day'),
                                    ]);
                                } else {
                                    onHistoryDateRangeChange(null);
                                }
                            }}
                        />
                        <Button onClick={onResetHistoryDateRange}>Last 30 days</Button>
                        <Button onClick={onSetAllTime}>All time</Button>
                    </div>
                </div>
                <Table<HistoryChangeRow>
                    rowKey='key'
                    loading={historyLoading}
                    columns={historyColumns}
                    dataSource={historyRows}
                    pagination={{
                        current: historyPage,
                        pageSize: historyPageSize,
                        total: historyPaginationTotal,
                        showSizeChanger: true,
                        pageSizeOptions: ['10', '20', '50'],
                        onChange: onHistoryChange,
                    }}
                />
            </Card>
        </div>
    );
}

export default React.memo(HistoryRightPanel);
