// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';

import React, {
    useCallback, useEffect, useRef, useState,
} from 'react';
import { useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import dayjs, { Dayjs } from 'dayjs';
import PropTypes from 'prop-types';
import { Col, Row } from 'antd/lib/grid';
import Card from 'antd/lib/card';
import Button from 'antd/lib/button';
import Text from 'antd/lib/typography/Text';
import Icon from '@ant-design/icons';
import {
    BorderOutlined,
    LoadingOutlined, MoreOutlined, QuestionCircleOutlined,
} from '@ant-design/icons/lib/icons';
import { DurationIcon, FramesIcon } from 'icons';
import {
    Job, JobStage, JobState, JobType, Task, User,
} from 'cvat-core-wrapper';
import { useIsMounted, useContextMenuClick } from 'utils/hooks';
import UserSelector from 'components/task-page/user-selector';
import CVATTooltip from 'components/common/cvat-tooltip';
import { CombinedState } from 'reducers';
import Collapse from 'antd/lib/collapse';
import CVATTag, { TagType } from 'components/common/cvat-tag';
import JobActionsComponent from 'components/jobs-page/actions-menu';
import { getJobStateForStageChange } from 'utils/job-workflow';
import { JobStageSelector, JobStateSelector } from './job-selectors';

function formatDate(value: Dayjs): string {
    return value.format('MMM Do YYYY HH:mm');
}

const AUTOSAVE_DELAY_MS = 1200;

type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'error';
type JobSaveFields = NonNullable<Parameters<Job['save']>[0]>;

interface JobDraftSnapshot {
    assignee: User | null;
    stage: JobStage;
    state: JobState;
}

function createJobDraftSnapshot(job: Job): JobDraftSnapshot {
    return {
        assignee: job.assignee,
        stage: job.stage,
        state: job.state,
    };
}

function isSameJobDraftSnapshot(left: JobDraftSnapshot, right: JobDraftSnapshot): boolean {
    return left.assignee?.id === right.assignee?.id &&
        left.stage === right.stage &&
        left.state === right.state;
}

function buildJobUpdateFields(
    baseline: JobDraftSnapshot,
    draft: JobDraftSnapshot,
): JobSaveFields {
    const fields: JobSaveFields = {};

    if (baseline.assignee?.id !== draft.assignee?.id) {
        fields.assignee = draft.assignee;
    }

    if (baseline.stage !== draft.stage) {
        fields.stage = draft.stage;
    }

    if (baseline.state !== draft.state) {
        fields.state = draft.state;
    }

    return fields;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    return 'Could not save changes.';
}

interface Props {
    job: Job;
    task: Task;
    onJobUpdate: (job: Job, fields: JobSaveFields) => Promise<void>;
    childJobs?: Job[];
    defaultCollapsed?: boolean;
    onCollapseChange?: (jobID: number, collapsed: boolean) => void;
    selected?: boolean;
    onClick?: (event?: React.MouseEvent) => void;
}

function ReviewSummaryComponent({ jobInstance }: Readonly<{ jobInstance: Job }>): JSX.Element {
    const [summary, setSummary] = useState<Record<string, any> | null>(null);
    const [error, setError] = useState<any>(null);
    const isMounted = useIsMounted();

    useEffect(() => {
        setError(null);
        jobInstance
            .issues()
            .then((issues: any[]) => {
                if (isMounted()) {
                    setSummary({
                        issues_unsolved: issues.filter((issue) => !issue.resolved).length,
                        issues_resolved: issues.filter((issue) => issue.resolved).length,
                    });
                }
            })
            .catch((_error: any) => {
                if (isMounted()) {
                    // eslint-disable-next-line
                    console.log(_error);
                    setError(_error);
                }
            });
    }, []);

    if (!summary) {
        if (error) {
            if (error.toString().includes('403')) {
                return <p>You do not have permissions</p>;
            }

            return <p>Could not fetch, check console output</p>;
        }

        return (
            <>
                <p>Loading.. </p>
                <LoadingOutlined />
            </>
        );
    }

    return (
        <table className='cvat-review-summary-description'>
            <tbody>
                <tr>
                    <td>
                        <Text strong>Unsolved issues</Text>
                    </td>
                    <td>{summary.issues_unsolved}</td>
                </tr>
                <tr>
                    <td>
                        <Text strong>Resolved issues</Text>
                    </td>
                    <td>{summary.issues_resolved}</td>
                </tr>
            </tbody>
        </table>
    );
}

function JobItem(props: Readonly<Props>): JSX.Element {
    const {
        job, task, onJobUpdate, childJobs, defaultCollapsed, onCollapseChange, selected, onClick,
    } = props;
    const isMounted = useIsMounted();
    const [baseline, setBaseline] = useState<JobDraftSnapshot>(() => createJobDraftSnapshot(job));
    const [draft, setDraft] = useState<JobDraftSnapshot>(() => createJobDraftSnapshot(job));
    const [stateTouched, setStateTouched] = useState(false);
    const [saving, setSaving] = useState(false);
    const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
    const [saveError, setSaveError] = useState<string | null>(null);
    const autoSaveTimeoutRef = useRef<number | null>(null);
    const baselineRef = useRef<JobDraftSnapshot>(baseline);

    const deletes = useSelector((state: CombinedState) => state.jobs.activities.deletes);
    const deleted = job.id in deletes ? deletes[job.id] === true : false;
    const { itemRef, handleContextMenuClick } = useContextMenuClick<HTMLDivElement>();

    const created = dayjs(job.createdDate);
    const updated = dayjs(job.updatedDate);
    const now = dayjs();

    const clearAutoSaveTimeout = useCallback((): void => {
        if (autoSaveTimeoutRef.current !== null) {
            window.clearTimeout(autoSaveTimeoutRef.current);
            autoSaveTimeoutRef.current = null;
        }
    }, []);

    useEffect(() => {
        baselineRef.current = baseline;
    }, [baseline]);

    useEffect(() => {
        const nextSnapshot = createJobDraftSnapshot(job);
        clearAutoSaveTimeout();
        setBaseline(nextSnapshot);
        setDraft(nextSnapshot);
        setStateTouched(false);
        setSaving(false);
        setAutoSaveStatus('idle');
        setSaveError(null);
    }, [job.id, clearAutoSaveTimeout]);

    useEffect(() => {
        const nextSnapshot = createJobDraftSnapshot(job);
        if (isSameJobDraftSnapshot(nextSnapshot, baselineRef.current)) {
            return;
        }

        // If the saved job changed elsewhere, reset this local draft to that saved value.
        clearAutoSaveTimeout();
        setBaseline(nextSnapshot);
        setDraft(nextSnapshot);
        setStateTouched(false);
        setSaving(false);
        setAutoSaveStatus('idle');
        setSaveError(null);
    }, [job.assignee, job.stage, job.state, clearAutoSaveTimeout]);

    useEffect(() => clearAutoSaveTimeout, [clearAutoSaveTimeout]);

    const hasChanges = !isSameJobDraftSnapshot(draft, baseline);

    const clearAutoSaveError = useCallback(() => {
        if (autoSaveStatus === 'error' || saveError) {
            setAutoSaveStatus('idle');
            setSaveError(null);
        }
    }, [autoSaveStatus, saveError]);

    const onUndo = useCallback(() => {
        clearAutoSaveTimeout();
        setDraft(baseline);
        setStateTouched(false);
        setAutoSaveStatus('idle');
        setSaveError(null);
    }, [baseline, clearAutoSaveTimeout]);

    const onDraftAssigneeSelect = useCallback((user: User | null): void => {
        clearAutoSaveError();
        setDraft((currentDraft) => ({
            ...currentDraft,
            assignee: user,
        }));
    }, [clearAutoSaveError]);

    const onDraftStageSelect = useCallback((newValue: JobStage): void => {
        clearAutoSaveError();
        setDraft((currentDraft) => {
            const nextDraft = {
                ...currentDraft,
                stage: newValue,
            };

            if (!stateTouched) {
                // Apply the same stage->state rule the backend uses so the UI does
                // not briefly show the old state before autosave finishes.
                nextDraft.state = getJobStateForStageChange(
                    currentDraft.stage,
                    currentDraft.state,
                    newValue,
                );
            }

            return nextDraft;
        });
    }, [clearAutoSaveError, stateTouched]);

    const onDraftStateSelect = useCallback((newValue: JobState): void => {
        clearAutoSaveError();
        setStateTouched(true);
        setDraft((currentDraft) => ({
            ...currentDraft,
            state: newValue,
        }));
    }, [clearAutoSaveError]);

    const onSave = useCallback(async () => {
        const fields = buildJobUpdateFields(baseline, draft);
        const hasFieldChanges =
            'assignee' in fields ||
            'stage' in fields ||
            'state' in fields;

        if (!hasFieldChanges) {
            clearAutoSaveTimeout();
            setAutoSaveStatus('idle');
            setSaveError(null);
            return;
        }

        clearAutoSaveTimeout();
        setSaving(true);
        setAutoSaveStatus('saving');
        setSaveError(null);

        try {
            await onJobUpdate(job, fields);
            if (isMounted()) {
                setBaseline({ ...draft });
                setStateTouched(false);
                setAutoSaveStatus('idle');
            }
        } catch (error: unknown) {
            if (isMounted()) {
                setAutoSaveStatus('error');
                setSaveError(getErrorMessage(error));
            }
        } finally {
            if (isMounted()) {
                setSaving(false);
            }
        }
    }, [baseline, clearAutoSaveTimeout, draft, isMounted, job, onJobUpdate]);

    useEffect(() => {
        clearAutoSaveTimeout();

        if (!hasChanges || saving) {
            if (!hasChanges) {
                setAutoSaveStatus('idle');
            }
            return undefined;
        }

        if (autoSaveStatus === 'error') {
            return undefined;
        }

        if (autoSaveStatus !== 'pending') {
            setAutoSaveStatus('pending');
        }

        autoSaveTimeoutRef.current = window.setTimeout(() => {
            onSave().catch(() => {});
        }, AUTOSAVE_DELAY_MS);

        return clearAutoSaveTimeout;
    }, [autoSaveStatus, clearAutoSaveTimeout, hasChanges, onSave, saving]);

    let autoSaveStatusText: string | null = null;
    if (autoSaveStatus === 'saving') {
        autoSaveStatusText = 'Saving changes...';
    } else if (autoSaveStatus === 'error') {
        autoSaveStatusText = saveError || 'Could not save changes.';
    } else if (autoSaveStatus === 'pending' || (hasChanges && autoSaveStatus === 'idle')) {
        autoSaveStatusText = 'Changes pending. Saving automatically...';
    }

    const style = {};
    if (deleted) {
        (style as any).pointerEvents = 'none';
        (style as any).opacity = 0.5;
    }
    const frameCountPercent = ((job.frameCount / (task.size || 1)) * 100).toFixed(0);
    const frameCountPercentRepresentation = frameCountPercent === '0' ? '<1' : frameCountPercent;
    const jobName = `Job #${job.id}`;

    let childJobViews: React.JSX.Element[] = [];
    if (childJobs && childJobs.length > 0) {
        const sortedChildJobs = [...childJobs].sort((a, b) => a.id - b.id);
        childJobViews = sortedChildJobs.map((eachJob: Job) => (
            <JobItem key={eachJob.id} job={eachJob} task={task} onJobUpdate={onJobUpdate} selected={selected} />
        ));
    }

    let tag = null;
    if (job.type === JobType.GROUND_TRUTH) {
        tag = (
            <Col offset={1}>
                <CVATTag type={TagType.GROUND_TRUTH} />
            </Col>
        );
    } else if (job.consensusReplicas) {
        tag = (
            <Col offset={1}>
                <CVATTag type={TagType.CONSENSUS} />
            </Col>
        );
    }

    const onCollapse = useCallback((keys: string | string[]) => {
        if (onCollapseChange) {
            onCollapseChange(job.id, Array.isArray(keys) ? keys.length === 0 : keys === '');
        }
    }, [onCollapseChange]);

    /* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
    const card = (
        <Card
            ref={itemRef}
            className={`cvat-job-item${selected ? ' cvat-item-selected' : ''}`}
            style={{ ...style }}
            data-row-id={job.id}
            onClick={onClick}
        >
            <Row align='middle'>
                <Col span={6}>
                    <Row>
                        <Col>
                            <Link to={`/tasks/${job.taskId}/jobs/${job.id}`}>{jobName}</Link>
                        </Col>
                        {tag}
                        {job.type !== JobType.GROUND_TRUTH && (
                            <Col className='cvat-job-item-issues-summary-icon'>
                                <CVATTooltip title={<ReviewSummaryComponent jobInstance={job} />}>
                                    <QuestionCircleOutlined />
                                </CVATTooltip>
                            </Col>
                        )}
                    </Row>
                    <Row className='cvat-job-item-dates-info'>
                        <Col>
                            <Text>Created: </Text>
                            <Text type='secondary'>{`${formatDate(created)}`}</Text>
                        </Col>
                    </Row>
                    <Row>
                        <Col>
                            <Text>Updated: </Text>
                            <Text type='secondary'>{`${formatDate(updated)}`}</Text>
                        </Col>
                    </Row>
                </Col>
                <Col span={12}>
                    <Row className='cvat-job-item-selects' justify='space-between'>
                        <Col>
                            <Row>
                                <Col className='cvat-job-item-select'>
                                    <Row>
                                        <Text>Assignee:</Text>
                                    </Row>
                                    <UserSelector
                                        className='cvat-job-assignee-selector'
                                        value={draft.assignee}
                                        disabled={saving}
                                        onSelect={onDraftAssigneeSelect}
                                    />
                                </Col>
                                <Col className='cvat-job-item-select'>
                                    <Row justify='space-between' align='middle'>
                                        <Col>
                                            <Text>Stage:</Text>
                                        </Col>
                                    </Row>
                                    <JobStageSelector
                                        value={draft.stage}
                                        disabled={saving}
                                        onSelect={onDraftStageSelect}
                                    />
                                </Col>
                                <Col className='cvat-job-item-select'>
                                    <Row justify='space-between' align='middle'>
                                        <Col>
                                            <Text>State:</Text>
                                        </Col>
                                    </Row>
                                    <JobStateSelector
                                        value={draft.state}
                                        disabled={saving}
                                        onSelect={onDraftStateSelect}
                                    />
                                </Col>
                            </Row>
                            {(autoSaveStatusText || hasChanges) && (
                                <Row className='cvat-job-item-autosave-status' align='middle' justify='space-between'>
                                    <Col>
                                        <Text type={autoSaveStatus === 'error' ? 'danger' : 'secondary'}>
                                            {autoSaveStatusText}
                                        </Text>
                                    </Col>
                                    <Col className='cvat-job-item-autosave-actions'>
                                        {autoSaveStatus === 'error' && (
                                            <Button
                                                type='link'
                                                size='small'
                                                onClick={() => {
                                                    onSave().catch(() => {});
                                                }}
                                            >
                                                Retry
                                            </Button>
                                        )}
                                        {hasChanges && (
                                            <Button type='link' size='small' onClick={onUndo} disabled={saving}>
                                                Undo
                                            </Button>
                                        )}
                                    </Col>
                                </Row>
                            )}
                        </Col>
                    </Row>
                </Col>
                <Col span={5} offset={1}>
                    <Row className='cvat-job-item-details'>
                        <Col>
                            <Row>
                                <Col>
                                    <Icon component={DurationIcon} />
                                    <Text>Duration: </Text>
                                    <Text type='secondary'>
                                        {`${dayjs
                                            .duration(now.diff(created))
                                            .humanize()}`}
                                    </Text>
                                </Col>
                            </Row>
                            <Row>
                                <Col>
                                    <BorderOutlined />
                                    <Text>Frame count: </Text>
                                    <Text type='secondary' className='cvat-job-item-frames'>
                                        {`${job.frameCount} (${frameCountPercentRepresentation}%)`}
                                    </Text>
                                </Col>
                            </Row>
                            {job.type !== JobType.GROUND_TRUTH && (
                                <Row>
                                    <Col>
                                        <Icon component={FramesIcon} />
                                        <Text>Frame range: </Text>
                                        <Text type='secondary' className='cvat-job-item-frame-range'>
                                            {`${job.startFrame}-${job.stopFrame}`}
                                        </Text>
                                    </Col>
                                </Row>
                            )}
                        </Col>
                    </Row>
                </Col>
            </Row>
            <div
                onClick={handleContextMenuClick}
                className='cvat-job-item-more-button cvat-actions-menu-button'
            >
                <MoreOutlined className='cvat-menu-icon' />
            </div>
            {childJobViews.length > 0 && (
                <Collapse
                    className='cvat-consensus-job-collapse'
                    defaultActiveKey={defaultCollapsed ? [] : ['1']}
                    onChange={onCollapse}
                    items={[
                        {
                            key: '1',
                            label: <Text>{`${childJobViews.length} Replicas`}</Text>,
                            children: childJobViews,
                        },
                    ]}
                />
            )}
        </Card>
    );

    return (
        <Col span={24}>
            {
                job.parentJobId === null ? (
                    <JobActionsComponent
                        jobInstance={job}
                        consensusJobsPresent={(childJobs as Job[]).length > 0}
                        dropdownTrigger={['contextMenu']}
                        singleJobDraft={{
                            assignee: draft.assignee,
                            stage: draft.stage,
                            state: draft.state,
                            saving,
                            onAssigneeChange: onDraftAssigneeSelect,
                            onStageChange: onDraftStageSelect,
                            onStateChange: onDraftStateSelect,
                        }}
                        triggerElement={card}
                    />
                ) : card
            }
        </Col>
    );
}

JobItem.defaultProps = {
    childJobs: [],
};

JobItem.propTypes = {
    childJobs: PropTypes.arrayOf(PropTypes.instanceOf(Job)),
};

export default React.memo(JobItem);
