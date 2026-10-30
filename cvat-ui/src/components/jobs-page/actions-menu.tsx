// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useState } from 'react';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import Dropdown from 'antd/lib/dropdown';
import Modal from 'antd/lib/modal';

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
import JobActionsItems from './actions-menu-items';

interface SingleJobDraft {
    assignee: User | null;
    stage: JobStage;
    state: JobState;
    saving: boolean;
    onAssigneeChange: (user: User | null) => void;
    onStageChange: (stage: JobStage) => void;
    onStateChange: (state: JobState) => void;
}

interface Props {
    jobInstance: Job;
    consensusJobsPresent: boolean;
    triggerElement: JSX.Element;
    dropdownTrigger?: ('click' | 'hover' | 'contextMenu')[];
    singleJobDraft?: SingleJobDraft;
}

function JobActionsComponent(
    props: Readonly<Props>,
): JSX.Element {
    const {
        jobInstance,
        triggerElement,
        consensusJobsPresent,
        dropdownTrigger,
        singleJobDraft,
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
    // For one job, edit the same draft the card uses so both entry points stay in sync.
    const useSingleJobDraft = !isBulkMode && !!singleJobDraft;
    const [draftAssignee, setDraftAssignee] = useState<User | null>(null);
    const [draftState, setDraftState] = useState<JobState | null>(null);
    const [draftStage, setDraftStage] = useState<JobStage | null>(null);
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
            return;
        }

        let initialAssignee = isBulkMode ? null : jobInstance.assignee;
        let initialState = isBulkMode ? null : jobInstance.state;
        let initialStage = isBulkMode ? null : jobInstance.stage;

        if (useSingleJobDraft) {
            initialAssignee = singleJobDraft.assignee;
            initialState = singleJobDraft.state;
            initialStage = singleJobDraft.stage;
        }

        if (editField === 'assignee') {
            setDraftAssignee(initialAssignee);
        } else if (editField === 'state') {
            setDraftState(initialState);
        } else if (editField === 'stage') {
            setDraftStage(initialStage);
        }
    }, [
        editField,
        isBulkMode,
        jobInstance.assignee,
        jobInstance.stage,
        jobInstance.state,
        singleJobDraft,
        useSingleJobDraft,
    ]);

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

    const runAutoSave = useCallback((callback: () => Promise<void>): void => {
        if (saving) {
            return;
        }

        setSaving(true);
        callback()
            .catch(() => undefined)
            .finally(() => {
                setSaving(false);
            });
    }, [saving]);

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
                {editField === 'assignee' && (
                    <UserSelector
                        value={useSingleJobDraft ? singleJobDraft.assignee : draftAssignee}
                        disabled={useSingleJobDraft ? singleJobDraft.saving : saving}
                        onSelect={(value: User | null): void => {
                            setDraftAssignee(value);
                            if (useSingleJobDraft) {
                                stopEditField();
                                singleJobDraft.onAssigneeChange(value);
                                return;
                            }

                            runAutoSave(() => onUpdateJobField({ assignee: value }));
                        }}
                    />
                )}
                {editField === 'state' && (
                    <JobStateSelector
                        value={useSingleJobDraft ? singleJobDraft.state : draftState}
                        disabled={useSingleJobDraft ? singleJobDraft.saving : saving}
                        onSelect={(value) => {
                            setDraftState(value);
                            if (useSingleJobDraft) {
                                stopEditField();
                                singleJobDraft.onStateChange(value);
                                return;
                            }

                            runAutoSave(() => onUpdateJobField({ state: value }));
                        }}
                    />
                )}
                {editField === 'stage' && (
                    <JobStageSelector
                        value={useSingleJobDraft ? singleJobDraft.stage : draftStage}
                        disabled={useSingleJobDraft ? singleJobDraft.saving : saving}
                        onSelect={(value) => {
                            setDraftStage(value);
                            if (useSingleJobDraft) {
                                stopEditField();
                                singleJobDraft.onStageChange(value);
                                return;
                            }

                            runAutoSave(() => onUpdateJobField({ stage: value }));
                        }}
                    />
                )}
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
