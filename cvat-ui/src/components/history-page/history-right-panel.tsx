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
import { LeftOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

import {
    Job, Project, Task, User,
} from 'cvat-core-wrapper';

import {
    formatAssignee,
    HistoryChangeRow,
    HistoryDateRange,
    HistoryDatePreset,
    HistorySelection,
    isJobHistorySelection,
    isProjectHistoryResource,
    isTaskHistoryResource,
} from './history-utils';

interface HistoryRightPanelProps {
    selection: HistorySelection | null;
    onNavigateBack: () => void;
    summaryLoading: boolean;
    summaryTasks: Task[];
    summaryJobs: Job[];
    summaryPage: number;
    summaryPageSize: number;
    summaryTotal: number;
    onSummaryChange: (page: number, pageSize: number) => void;
    onSelectSummaryTask: (task: Task) => void;
    onSelectSummaryJob: (job: Job) => void;
    resourceDetailsLoading: boolean;
    selectedProject: Project | null;
    selectedTask: Task | null;
    selectedJob: Job | null;
    historyDatePreset: HistoryDatePreset;
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

interface TaskSummaryRow {
    key: number;
    id: number;
    assignee: User | null;
    updatedDate: string;
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
        onNavigateBack,
        summaryLoading,
        summaryTasks,
        summaryJobs,
        summaryPage,
        summaryPageSize,
        summaryTotal,
        onSummaryChange,
        onSelectSummaryTask,
        onSelectSummaryJob,
        resourceDetailsLoading,
        selectedProject,
        selectedTask,
        selectedJob,
        historyDatePreset,
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

    const taskSummaryRows = useMemo<TaskSummaryRow[]>(() => summaryTasks.map((task) => ({
        key: task.id,
        id: task.id,
        assignee: task.assignee,
        updatedDate: task.updatedDate,
    })), [summaryTasks]);

    const summaryRows = useMemo<JobSummaryRow[]>(() => summaryJobs.map((job) => ({
        key: job.id,
        id: job.id,
        taskId: job.taskId,
        assignee: job.assignee,
        stage: job.stage,
        state: job.state,
        updatedDate: job.updatedDate,
    })), [summaryJobs]);

    const summaryTasksByID = useMemo(() => (
        new Map(summaryTasks.map((task) => [task.id, task]))
    ), [summaryTasks]);

    const summaryJobsByID = useMemo(() => (
        new Map(summaryJobs.map((job) => [job.id, job]))
    ), [summaryJobs]);

    const taskSummaryColumns = useMemo(() => ([
        {
            title: 'Task',
            dataIndex: 'id',
            key: 'id',
            render: (value: number, row: TaskSummaryRow) => (
                <Button
                    type='link'
                    onClick={() => {
                        const task = summaryTasksByID.get(row.id);
                        if (task) {
                            onSelectSummaryTask(task);
                        }
                    }}
                >
                    {`Task #${value}`}
                </Button>
            ),
        },
        {
            title: 'Assignee',
            dataIndex: 'assignee',
            key: 'assignee',
            render: (value: User | null) => formatAssignee(value),
        },
        {
            title: 'Updated',
            dataIndex: 'updatedDate',
            key: 'updatedDate',
            render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss'),
        },
    ]), [onSelectSummaryTask, summaryTasksByID]);

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

    const historyColumns = useMemo(() => {
        const columns = [
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
        ];

        if (isJobHistorySelection(selection)) {
            // Only job history shows stage and state changes.
            columns.push(
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
            );
        }

        return columns;
    }, [selection]);

    const selectionCardTitle = useMemo(() => {
        if (!selection) {
            return null;
        }

        return (
            <div className='cvat-history-card-title'>
                <Button
                    type='text'
                    size='small'
                    icon={<LeftOutlined />}
                    className='cvat-history-card-title-back'
                    aria-label='Back'
                    onClick={onNavigateBack}
                />
                {/* Keep one title area while drilling down from project to task to job. */}
                <span>{selection.title}</span>
            </div>
        );
    }, [onNavigateBack, selection]);

    if (!selection) {
        return (
            <div className='cvat-history-empty-state'>
                <Empty description='Select a project, task, or job to view history' />
            </div>
        );
    }

    let selectedResource: Project | Task | Job | null = selectedJob;
    if (selection.type === 'project') {
        selectedResource = selectedProject;
    } else if (selection.type === 'task') {
        selectedResource = selectedTask;
    }

    const renderHistoryCard = (): JSX.Element => (
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
                    <Button
                        type={historyDatePreset === 'last-30-days' ? 'primary' : 'default'}
                        aria-pressed={historyDatePreset === 'last-30-days'}
                        onClick={onResetHistoryDateRange}
                    >
                        Last 30 days
                    </Button>
                    <Button
                        type={historyDatePreset === 'all-time' ? 'primary' : 'default'}
                        aria-pressed={historyDatePreset === 'all-time'}
                        onClick={onSetAllTime}
                    >
                        All time
                    </Button>
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
                    onChange: onHistoryChange,
                }}
            />
        </Card>
    );

    if (selection.type === 'project' || selection.type === 'task') {
        return (
            <div className='cvat-history-job-detail'>
                <Card title={selectionCardTitle} className='cvat-history-card'>
                    <Spin spinning={resourceDetailsLoading}>
                        {isProjectHistoryResource(selection, selectedResource) ? (
                            <Descriptions column={2} bordered size='small'>
                                <Descriptions.Item label='Project'>
                                    {`Project #${selectedResource.id}`}
                                </Descriptions.Item>
                                <Descriptions.Item label='Assignee'>
                                    {formatAssignee(selectedResource.assignee)}
                                </Descriptions.Item>
                                <Descriptions.Item label='Updated'>
                                    {dayjs(selectedResource.updatedDate).format('YYYY-MM-DD HH:mm:ss')}
                                </Descriptions.Item>
                            </Descriptions>
                        ) : null}
                        {isTaskHistoryResource(selection, selectedResource) ? (
                            <Descriptions column={2} bordered size='small'>
                                <Descriptions.Item label='Project'>
                                    {selectedResource.projectId ? `Project #${selectedResource.projectId}` : '-'}
                                </Descriptions.Item>
                                <Descriptions.Item label='Task'>
                                    {`Task #${selectedResource.id}`}
                                </Descriptions.Item>
                                <Descriptions.Item label='Assignee'>
                                    {formatAssignee(selectedResource.assignee)}
                                </Descriptions.Item>
                                <Descriptions.Item label='Updated'>
                                    {dayjs(selectedResource.updatedDate).format('YYYY-MM-DD HH:mm:ss')}
                                </Descriptions.Item>
                            </Descriptions>
                        ) : null}
                        {!selectedResource ? <Empty description={`${selection.type} details are unavailable`} /> : null}
                    </Spin>
                </Card>
                {selection.type === 'project' ? (
                    <Card title='Tasks' className='cvat-history-card'>
                        <Table<TaskSummaryRow>
                            rowKey='id'
                            loading={summaryLoading}
                            columns={taskSummaryColumns}
                            dataSource={taskSummaryRows}
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
                ) : (
                    <Card title='Jobs' className='cvat-history-card'>
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
                )}
                {renderHistoryCard()}
            </div>
        );
    }

    return (
        <div className='cvat-history-job-detail'>
            <Card title={selectionCardTitle} className='cvat-history-card'>
                <Spin spinning={resourceDetailsLoading}>
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
            {renderHistoryCard()}
        </div>
    );
}

export default React.memo(HistoryRightPanel);
