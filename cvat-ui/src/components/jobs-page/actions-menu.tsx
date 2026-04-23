// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useCallback, useEffect, useMemo, useState,
} from 'react';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import Dropdown from 'antd/lib/dropdown';
import Modal from 'antd/lib/modal';
import Button from 'antd/lib/button';

import {
    Job, JobStage, JobState, JobType, User,
} from 'cvat-core-wrapper';
import { useDropdownEditField, usePlugins } from 'utils/hooks';
import { CombinedState } from 'reducers';
import { exportActions } from 'actions/export-actions';
import { importActions } from 'actions/import-actions';
import { mergeConsensusJobsAsync } from 'actions/consensus-actions';
import { deleteJobAsync, updateJobAsync } from 'actions/jobs-actions';
import { makeBulkOperationAsync } from 'actions/bulk-actions';

import UserSelector from 'components/task-page/user-selector';
import { JobStageSelector, JobStateSelector } from 'components/job-item/job-selectors';
import { makeKey } from 'reducers/consensus-reducer';
import { getJobStateForStageChange } from 'utils/job-workflow';
import JobActionsItems from './actions-menu-items';

interface Props {
    jobInstance: Job;
    consensusJobsPresent: boolean;
    triggerElement: JSX.Element;
    dropdownTrigger?: ('click' | 'hover' | 'contextMenu')[];
}

function JobActionsComponent(
    props: Readonly<Props>,
): JSX.Element {
    const {
        jobInstance,
        triggerElement,
        consensusJobsPresent,
        dropdownTrigger,
    } = props;
    const dispatch = useDispatch();

    const pluginActions = usePlugins((state: CombinedState) => state.plugins.components.jobActions.items, props);
    const {
        mergingConsensus,
        selectedIds,
        allJobs,
    } = useSelector((state: CombinedState) => ({
        mergingConsensus: state.consensus.actions.merging,
        selectedIds: state.jobs.selected,
        allJobs: state.jobs.current,
    }), shallowEqual);
    const isBulkMode = selectedIds.length > 1;
    const [draftAssignee, setDraftAssignee] = useState<User | null>(null);
    const [draftState, setDraftState] = useState<JobState | null>(null);
    const [draftStage, setDraftStage] = useState<JobStage | null>(null);
    const [draftDirty, setDraftDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    const {
        dropdownOpen,
        editField,
        startEditField,
        stopEditField,
        onOpenChange,
        onMenuClick,
    } = useDropdownEditField();

    useEffect(() => {
        if (!editField) {
            setDraftDirty(false);
            setSaving(false);
            return;
        }

        setDraftDirty(false);
        if (editField === 'assignee') {
            setDraftAssignee(isBulkMode ? null : jobInstance.assignee);
        } else if (editField === 'state') {
            setDraftState(isBulkMode ? null : jobInstance.state);
        } else if (editField === 'stage') {
            setDraftStage(isBulkMode ? null : jobInstance.stage);
            setDraftState(isBulkMode ? null : jobInstance.state);
        }
    }, [editField, isBulkMode, jobInstance.assignee, jobInstance.stage, jobInstance.state]);

    const onOpenBugTracker = useCallback(() => {
        if (jobInstance.bugTracker) {
            window.open(jobInstance.bugTracker, '_blank', 'noopener noreferrer');
        }
    }, [jobInstance.bugTracker]);

    const onImportAnnotations = useCallback(() => {
        dispatch(importActions.openImportDatasetModal(jobInstance));
    }, [jobInstance]);

    const onExportAnnotations = useCallback(() => {
        dispatch(exportActions.openExportDatasetModal(jobInstance));
    }, [jobInstance]);

    const onMergeConsensusJob = useCallback(() => {
        if (consensusJobsPresent && jobInstance.parentJobId === null) {
            Modal.confirm({
                title: 'The consensus job will be merged',
                content: 'Existing annotations in the parent job will be updated. Continue?',
                className: 'cvat-modal-confirm-consensus-merge-job',
                onOk: () => {
                    dispatch(mergeConsensusJobsAsync(jobInstance));
                },
                okButtonProps: {
                    type: 'primary',
                    danger: true,
                },
                okText: 'Merge',
            });
        }
    }, [consensusJobsPresent, jobInstance]);

    const onDeleteJob = useCallback(() => {
        const jobsToDelete = allJobs.filter((job) => selectedIds.includes(job.id));
        const isBulk = jobsToDelete.length > 1;
        Modal.confirm({
            title: isBulk ?
                `Delete ${jobsToDelete.length} selected jobs` :
                `The job ${jobInstance.id} will be deleted`,
            content: isBulk ?
                'All related data (annotations) for all selected jobs will be lost. Continue?' :
                'All related data (annotations) will be lost. Continue?',
            className: 'cvat-modal-confirm-delete-job',
            onOk: () => {
                setTimeout(() => {
                    dispatch(makeBulkOperationAsync(
                        jobsToDelete.length ? jobsToDelete : [jobInstance],
                        async (job) => {
                            if (job.type === JobType.GROUND_TRUTH) {
                                await dispatch(deleteJobAsync(job));
                            }
                        },
                        (job, idx, total) => `Deleting job #${job.id} (${idx + 1}/${total})`,
                    ));
                }, 0);
            },
            okButtonProps: {
                type: 'primary',
                danger: true,
            },
            okText: isBulk ? 'Delete selected' : 'Delete',
        });
    }, [jobInstance, allJobs, selectedIds, dispatch]);

    const onUpdateJobField = useCallback(async (
        fields: Partial<{ assignee: User | null; state: JobState; stage: JobStage; }>,
    ) => {
        const jobsToUpdate = allJobs.filter((job) => selectedIds.includes(job.id));
        const jobs = jobsToUpdate.length ? jobsToUpdate : [jobInstance];

        const jobsNeedingUpdate = jobs.filter((job) => {
            const assigneeChanged = fields.assignee !== undefined && job.assignee?.id !== fields.assignee?.id;
            const stateChanged = fields.state !== undefined && job.state !== fields.state;
            const stageChanged = fields.stage !== undefined && job.stage !== fields.stage;

            return assigneeChanged || stateChanged || stageChanged;
        });

        stopEditField();
        if (jobsNeedingUpdate.length === 0) {
            return;
        }

        await dispatch(makeBulkOperationAsync(
            jobsNeedingUpdate,
            async (job) => {
                await dispatch(updateJobAsync(job, fields));
            },
            (job, idx, total) => `Updating job #${job.id} (${idx + 1}/${total})`,
        ));
    }, [jobInstance, allJobs, selectedIds, dispatch, stopEditField]);

    const onUpdateJobStage = useCallback(async (stage: JobStage) => {
        const jobsToUpdate = allJobs.filter((job) => selectedIds.includes(job.id));
        const jobs = jobsToUpdate.length ? jobsToUpdate : [jobInstance];
        const jobsWithChanges = jobs
            .map((job) => {
                const nextState = getJobStateForStageChange(job.stage, job.state, stage);
                const fields: Partial<{ stage: JobStage; state: JobState; }> = {};

                if (job.stage !== stage) {
                    fields.stage = stage;
                }

                if (job.state !== nextState) {
                    fields.state = nextState;
                }

                return { job, fields };
            })
            .filter(({ fields }) => Object.keys(fields).length);

        stopEditField();
        if (!jobsWithChanges.length) {
            return;
        }

        const updatesByJobID = new Map(jobsWithChanges.map(({ job, fields }) => [job.id, fields]));
        await dispatch(makeBulkOperationAsync(
            jobsWithChanges.map(({ job }) => job),
            async (job) => {
                const fields = updatesByJobID.get(job.id);
                if (fields) {
                    await dispatch(updateJobAsync(job, fields));
                }
            },
            (job, idx, total) => `Updating job #${job.id} (${idx + 1}/${total})`,
        ));
    }, [jobInstance, allJobs, selectedIds, dispatch, stopEditField]);

    const hasDraftChanges = useMemo(() => {
        if (!editField) {
            return false;
        }

        if (isBulkMode) {
            return draftDirty;
        }

        if (editField === 'assignee') {
            return jobInstance.assignee?.id !== draftAssignee?.id;
        }

        if (editField === 'state') {
            return jobInstance.state !== draftState;
        }

        if (editField === 'stage') {
            return jobInstance.stage !== draftStage;
        }

        return false;
    }, [editField, isBulkMode, draftDirty, draftAssignee, draftState, draftStage, jobInstance]);

    const onCancelEdit = useCallback((event?: React.MouseEvent) => {
        event?.stopPropagation();
        stopEditField();
    }, [stopEditField]);

    const onSaveEdit = useCallback(async (event?: React.MouseEvent) => {
        event?.stopPropagation();
        if (!editField || !hasDraftChanges) {
            return;
        }

        const fields: Partial<{ assignee: User | null; state: JobState; stage: JobStage; }> = {};
        if (editField === 'assignee') {
            fields.assignee = draftAssignee;
        } else if (editField === 'state' && draftState) {
            fields.state = draftState;
        } else if (editField === 'stage' && draftStage) {
            setSaving(true);
            try {
                await onUpdateJobStage(draftStage);
            } finally {
                setSaving(false);
            }
            return;
        }

        if (!Object.keys(fields).length) {
            return;
        }

        setSaving(true);
        try {
            await onUpdateJobField(fields);
        } finally {
            setSaving(false);
        }
    }, [editField, hasDraftChanges, draftAssignee, draftState, draftStage, onUpdateJobField, onUpdateJobStage]);

    let menuItems;
    if (editField) {
        const editorLabel = (
            <div
                className='cvat-job-item-menu-editor'
                role='presentation'
                onClick={(event) => {
                    event.stopPropagation();
                }}
                onKeyDown={(event) => {
                    event.stopPropagation();
                }}
            >
                <div className='cvat-job-item-menu-editor-selector'>
                    {editField === 'assignee' && (
                        <UserSelector
                            value={draftAssignee}
                            onSelect={(value: User | null): void => {
                                setDraftAssignee(value);
                                setDraftDirty(true);
                            }}
                        />
                    )}
                    {editField === 'state' && (
                        <JobStateSelector
                            value={draftState}
                            onSelect={(value) => {
                                setDraftState(value);
                                setDraftDirty(true);
                            }}
                        />
                    )}
                    {editField === 'stage' && (
                        <JobStageSelector
                            value={draftStage}
                            onSelect={(value) => {
                                setDraftStage(value);
                                setDraftState(getJobStateForStageChange(jobInstance.stage, jobInstance.state, value));
                                setDraftDirty(true);
                            }}
                        />
                    )}
                </div>
                <div className='cvat-job-item-menu-editor-actions'>
                    <Button size='small' onClick={onCancelEdit} disabled={saving}>
                        Cancel
                    </Button>
                    <Button
                        size='small'
                        type='primary'
                        onClick={onSaveEdit}
                        loading={saving}
                        disabled={!hasDraftChanges}
                    >
                        Save
                    </Button>
                </div>
            </div>
        );
        const fieldSelectors: Record<string, JSX.Element> = {
            assignee: editorLabel,
            state: editorLabel,
            stage: editorLabel,
        };
        menuItems = [{
            key: `${editField}-selector`,
            label: fieldSelectors[editField],
        }];
    } else {
        menuItems = JobActionsItems({
            startEditField,
            jobId: jobInstance.id,
            taskId: jobInstance.taskId,
            projectId: jobInstance.projectId,
            pluginActions,
            isMergingConsensusEnabled: mergingConsensus[makeKey(jobInstance)],
            onOpenBugTracker: jobInstance.bugTracker ? onOpenBugTracker : null,
            onImportAnnotations,
            onExportAnnotations,
            onMergeConsensusJob: consensusJobsPresent && jobInstance.parentJobId === null ? onMergeConsensusJob : null,
            onDeleteJob: jobInstance.type === JobType.GROUND_TRUTH ? onDeleteJob : null,
            selectedIds,
        }, props);
    }

    return (
        <Dropdown
            destroyPopupOnHide
            trigger={dropdownTrigger || ['click']}
            open={dropdownOpen}
            onOpenChange={onOpenChange}
            className='job-actions-menu'
            menu={{
                selectable: false,
                className: 'cvat-job-item-menu',
                items: menuItems,
                onClick: onMenuClick,
            }}
        >
            {triggerElement}
        </Dropdown>
    );
}

export default React.memo(JobActionsComponent);
