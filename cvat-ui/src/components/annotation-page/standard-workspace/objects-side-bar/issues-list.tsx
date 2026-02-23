// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useState } from 'react';
import { useSelector, useDispatch, shallowEqual } from 'react-redux';
import dayjs from 'dayjs';
import Icon, {
    LeftOutlined, RightOutlined, EyeInvisibleFilled, EyeOutlined,
    CheckCircleFilled, CheckCircleOutlined,
} from '@ant-design/icons';
import Modal from 'antd/lib/modal';
import { Row, Col } from 'antd/lib/grid';
import Text from 'antd/lib/typography/Text';
import Button from 'antd/lib/button';
import Select from 'antd/lib/select';
import Checkbox from 'antd/lib/checkbox';
import notification from 'antd/lib/notification';
import { logError } from 'cvat-logger';

import {
    activateObject, fetchAnnotationsAsync, changeFrameAsync, highlightConflict, createAnnotationsAsync,
} from 'actions/annotation-actions';
import { reviewActions } from 'actions/review-actions';
import CVATTooltip from 'components/common/cvat-tooltip';
import { ActiveControl, CombinedState, Workspace } from 'reducers';
import Paragraph from 'antd/lib/typography/Paragraph';
import {
    ConflictSeverity, QualityConflict, Issue, getCore, ObjectType, ShapeType, LabelType, JobStage,
} from 'cvat-core-wrapper';
import { changeShowGroundTruth } from 'actions/settings-actions';
import { ShowGroundTruthIcon } from 'icons';
import { ensureError } from 'utils/error-handling';
import { filterApplicableForType } from 'utils/filter-applicable-labels';
import { isLikelyRle } from 'utils/masks';

const core = getCore();

export default function LabelsListComponent(): JSX.Element {
    const dispatch = useDispatch();
    const {
        frame,
        frameIssues,
        frameConflicts,
        showGroundTruth,
        issues,
        conflicts,
        issuesHidden,
        issuesResolvedHidden,
        highlightedConflict,
        workspace,
        ready,
        activeControl,
        labels,
        user,
        issueFetching,
        jobStage,
    } = useSelector((state: CombinedState) => ({
        frame: state.annotation.player.frame.number,
        frameIssues: state.review.frameIssues,
        frameConflicts: state.review.frameConflicts,
        showGroundTruth: state.settings.shapes.showGroundTruth,
        issues: state.review.issues,
        conflicts: state.review.conflicts,
        issuesHidden: state.review.issuesHidden,
        issuesResolvedHidden: state.review.issuesResolvedHidden,
        highlightedConflict: state.annotation.annotations.highlightedConflict,
        workspace: state.annotation.workspace,
        ready: state.annotation.canvas.ready,
        activeControl: state.annotation.canvas.activeControl,
        labels: state.annotation.job.labels,
        user: state.auth.user,
        issueFetching: state.review.fetching.issueId,
        jobStage: state.annotation.job.instance?.stage,
    }), shallowEqual);

    const [convertModalVisible, setConvertModalVisible] = useState(false);
    const [issueToConvert, setIssueToConvert] = useState<Issue | null>(null);
    const [selectedLabelId, setSelectedLabelId] = useState<number | null>(null);
    const [resolveAfterConvert, setResolveAfterConvert] = useState(false);
    const isReviewMode = workspace === Workspace.REVIEW && jobStage === JobStage.VALIDATION;

    const maskLabels = filterApplicableForType(LabelType.MASK, labels);

    const openConvertModal = (issue: Issue): void => {
        if (!maskLabels.length) {
            notification.warning({
                message: 'No mask labels available',
                description: 'Create a mask label first to convert issues into mask annotations.',
            });
            return;
        }

        setIssueToConvert(issue);
        setSelectedLabelId(maskLabels[0].id as number);
        setResolveAfterConvert(false);
        setConvertModalVisible(true);
    };

    const closeConvertModal = (): void => {
        setConvertModalVisible(false);
        setIssueToConvert(null);
        setSelectedLabelId(null);
        setResolveAfterConvert(false);
    };

    const polygonToMaskRle = (points: number[]): number[] | null => {
        if (!Array.isArray(points) || points.length < 6) {
            return null;
        }

        const xs = points.filter((_, idx) => idx % 2 === 0);
        const ys = points.filter((_, idx) => idx % 2 !== 0);
        const left = Math.floor(Math.min(...xs));
        const right = Math.ceil(Math.max(...xs));
        const top = Math.floor(Math.min(...ys));
        const bottom = Math.ceil(Math.max(...ys));
        const width = right - left + 1;
        const height = bottom - top + 1;
        if (width <= 0 || height <= 0) {
            return null;
        }

        const canvas = window.document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(points[0] - left, points[1] - top);
        for (let i = 2; i < points.length; i += 2) {
            ctx.lineTo(points[i] - left, points[i + 1] - top);
        }
        ctx.closePath();
        ctx.fill();

        const imageData = ctx.getImageData(0, 0, width, height).data;
        const mask = new Array(width * height);
        for (let i = 0; i < width * height; i++) {
            mask[i] = imageData[i * 4 + 3] > 0 ? 1 : 0;
        }

        const rle = core.utils.mask2Rle(mask);
        rle.push(left, top, right, bottom);
        return rle;
    };

    const resolveIssueDirect = async (issue: Issue): Promise<boolean> => {
        if (typeof issue.id !== 'number') return false;
        if (!user) {
            return false;
        }
        try {
            dispatch(reviewActions.resolveIssue(issue.id));
            await issue.resolve(user);
            dispatch(reviewActions.resolveIssueSuccess());
            return true;
        } catch (error) {
            logError(ensureError(error), false, {
                type: 'Issue mask conversion resolve issue failed (sidebar)',
                issue_id: issue.id,
            });
            dispatch(reviewActions.resolveIssueFailed(error));
            return false;
        }
    };

    const reopenIssueDirect = async (issue: Issue): Promise<void> => {
        if (typeof issue.id !== 'number') return;
        try {
            dispatch(reviewActions.reopenIssue(issue.id));
            await issue.reopen();
            dispatch(reviewActions.reopenIssueSuccess());
        } catch (error) {
            dispatch(reviewActions.reopenIssueFailed(error));
            notification.error({
                message: 'Could not reopen the issue',
            });
        }
    };

    const onConvertToMask = async (): Promise<void> => {
        if (!issueToConvert || !selectedLabelId) return;
        const label = labels.find((_label) => _label.id === selectedLabelId);
        if (!label) return;

        const position = issueToConvert.position || [];
        const maskPoints = issueToConvert.isMaskIssue && isLikelyRle(position) ? position : polygonToMaskRle(position);
        if (!maskPoints) {
            notification.error({
                message: 'Conversion failed',
                description: 'The issue region cannot be converted into a mask.',
            });
            return;
        }

        const objectState = new core.classes.ObjectState({
            objectType: ObjectType.SHAPE,
            shapeType: ShapeType.MASK,
            label,
            frame: issueToConvert.frame,
            points: maskPoints,
            occluded: false,
            outside: false,
            rotation: 0,
        });

        try {
            const created = await dispatch(createAnnotationsAsync([objectState])) as boolean;
            if (!created) {
                const issueRef = typeof issueToConvert.id === 'number' ? ` (issue #${issueToConvert.id})` : '';
                notification.error({
                    message: 'Conversion failed',
                    description:
                        `Could not create a mask annotation${issueRef}. ` +
                        'Please try again or report the issue ID to support.',
                });
                return;
            }
        } catch (error) {
            logError(ensureError(error), false, {
                type: 'Issue mask conversion create annotation failed (sidebar)',
                issue_id: issueToConvert.id,
            });
            const issueRef = typeof issueToConvert.id === 'number' ? ` (issue #${issueToConvert.id})` : '';
            notification.error({
                message: 'Conversion failed',
                description:
                    `Could not create a mask annotation${issueRef}. ` +
                    'Please try again or report the issue ID to support.',
            });
            return;
        }

        let resolvedAfterConvert = true;
        if (resolveAfterConvert) {
            resolvedAfterConvert = await resolveIssueDirect(issueToConvert);
        }
        closeConvertModal();
        if (resolveAfterConvert && !resolvedAfterConvert) {
            const issueRef = typeof issueToConvert.id === 'number' ? ` #${issueToConvert.id}` : '';
            notification.warning({
                message: 'Mask created, issue not resolved',
                description:
                    `The mask annotation was created, but the issue${issueRef} ` +
                    'could not be resolved automatically. Please try resolving it again.',
            });
        }
    };

    const isLikelyMaskIssue = (issue: Issue): boolean => issue.isMaskIssue === true;

    let frames = issues
        .filter((issue: Issue) => !issuesResolvedHidden || !issue.resolved)
        .map((issue: Issue) => issue.frame)
        .sort((a: number, b: number) => +a - +b);

    if (showGroundTruth) {
        const conflictFrames = conflicts
            .map((conflict): number => conflict.frame).sort((a: number, b: number) => +a - +b);
        frames = [...new Set([...frames, ...conflictFrames])];
    }
    const nearestLeft = frames.filter((_frame: number): boolean => _frame < frame).reverse()[0];
    const dynamicLeftProps: any = Number.isInteger(nearestLeft) ?
        {
            onClick: () => dispatch(changeFrameAsync(nearestLeft)),
        } :
        {
            style: {
                pointerEvents: 'none',
                opacity: 0.5,
            },
        };

    const nearestRight = frames.filter((_frame: number): boolean => _frame > frame)[0];
    const dynamicRightProps: any = Number.isInteger(nearestRight) ?
        {
            onClick: () => dispatch(changeFrameAsync(nearestRight)),
        } :
        {
            style: {
                pointerEvents: 'none',
                opacity: 0.5,
            },
        };

    return (
        <>
            <div className='cvat-objects-sidebar-issues-list-header'>
                <Row justify='start' align='middle'>
                    <Col>
                        <Text>{`Items: ${frameIssues.length}`}</Text>
                    </Col>
                    <Col offset={1}>
                        <CVATTooltip title='Find the previous frame with issues'>
                            <LeftOutlined className='cvat-issues-sidebar-previous-frame' {...dynamicLeftProps} />
                        </CVATTooltip>
                    </Col>
                    <Col offset={1}>
                        <CVATTooltip title='Find the next frame with issues'>
                            <RightOutlined className='cvat-issues-sidebar-next-frame' {...dynamicRightProps} />
                        </CVATTooltip>
                    </Col>
                    <Col offset={2}>
                        <CVATTooltip title='Show/hide all issues'>
                            {issuesHidden ? (
                                <EyeInvisibleFilled
                                    className='cvat-issues-sidebar-hidden-issues'
                                    onClick={() => dispatch(reviewActions.switchIssuesHiddenFlag(false))}
                                />
                            ) : (
                                <EyeOutlined
                                    className='cvat-issues-sidebar-shown-issues'
                                    onClick={() => dispatch(reviewActions.switchIssuesHiddenFlag(true))}
                                />
                            )}
                        </CVATTooltip>
                    </Col>
                    <Col offset={2}>
                        <CVATTooltip title='Show/hide resolved issues'>
                            { issuesResolvedHidden ? (
                                <CheckCircleFilled
                                    className='cvat-issues-sidebar-hidden-resolved-status'
                                    onClick={() => dispatch(reviewActions.switchIssuesHiddenResolvedFlag(false))}
                                />
                            ) : (
                                <CheckCircleOutlined
                                    className='cvat-issues-sidebar-hidden-resolved-status'
                                    onClick={() => dispatch(reviewActions.switchIssuesHiddenResolvedFlag(true))}
                                />

                            )}
                        </CVATTooltip>
                    </Col>
                    {
                        workspace === Workspace.REVIEW ? (
                            <Col offset={2}>
                                <CVATTooltip title='Show Ground truth annotations and conflicts'>
                                    <Icon
                                        className={
                                            `cvat-objects-sidebar-show-ground-truth ${showGroundTruth ? 'cvat-objects-sidebar-show-ground-truth-active' : ''}`
                                        }
                                        component={ShowGroundTruthIcon}
                                        onClick={() => {
                                            dispatch(changeShowGroundTruth(!showGroundTruth));
                                            dispatch(fetchAnnotationsAsync());
                                        }}
                                    />
                                </CVATTooltip>
                            </Col>
                        ) : null
                    }
                </Row>
            </div>
            <div className='cvat-objects-sidebar-issues-list'>
                {frameIssues.map(
                    (frameIssue: Issue): JSX.Element => {
                        const firstComment = frameIssue.comments[0];
                        const lastComment = frameIssue.comments.slice(-1)[0];
                        const firstMessage = firstComment?.message || '';
                        const lastMessage = lastComment?.message || '';
                        const canConvert = workspace !== Workspace.REVIEW &&
                            isLikelyMaskIssue(frameIssue);
                        return (
                            <div
                                key={frameIssue.id}
                                id={`cvat-objects-sidebar-issue-item-${frameIssue.id}`}
                                className={
                                    `cvat-objects-sidebar-issue-item ${frameIssue.resolved ? 'cvat-objects-sidebar-issue-resolved' : ''}`
                                }
                                onMouseEnter={() => {
                                    const element = window.document.getElementById(
                                        `cvat_canvas_issue_region_${frameIssue.id}`,
                                    );
                                    if (element) {
                                        element.setAttribute('fill', 'url(#cvat_issue_region_pattern_2)');
                                    }
                                    dispatch(activateObject(null, null, null));
                                }}
                                onMouseLeave={() => {
                                    const element = window.document.getElementById(
                                        `cvat_canvas_issue_region_${frameIssue.id}`,
                                    );
                                    if (element) {
                                        element.setAttribute('fill', 'url(#cvat_issue_region_pattern_1)');
                                    }
                                }}
                            >
                                <Row justify='space-between'>
                                    <Col>
                                        <Text strong>
                                            {`#${frameIssue.id} • Issue`}
                                        </Text>
                                    </Col>
                                    <Col offset={1}>
                                        <Text type='secondary'>
                                            {`created ${dayjs(frameIssue.createdDate).fromNow()}`}
                                        </Text>
                                    </Col>
                                </Row>
                                <Row>
                                    <Paragraph ellipsis={{ rows: 2 }}>
                                        {!!firstComment?.owner?.username && (
                                            <Text strong>{`${firstComment.owner.username}: `}</Text>
                                        )}
                                        <Text>{firstMessage}</Text>
                                    </Paragraph>
                                </Row>
                                { lastComment !== firstComment && (
                                    <>
                                        <Row justify='start'>
                                            <Col>
                                                <Text strong>&#8230;</Text>
                                            </Col>
                                        </Row>
                                        <Row>
                                            <Paragraph ellipsis={{ rows: 2 }}>
                                                {!!lastComment?.owner?.username && (
                                                    <Text strong>{`${lastComment.owner.username}: `}</Text>
                                                )}
                                                <Text>{lastMessage}</Text>
                                            </Paragraph>
                                        </Row>
                                    </>
                                )}
                                {canConvert && (
                                    <Row justify='start'>
                                        <Button
                                            type='link'
                                            className='cvat-issues-convert-to-mask-button'
                                            onClick={() => openConvertModal(frameIssue)}
                                        >
                                            Convert to mask
                                        </Button>
                                    </Row>
                                )}
                                {!isReviewMode && frameIssue.resolved && (
                                    <Row justify='start'>
                                        <Button
                                            type='link'
                                            className='cvat-issues-reopen-button'
                                            loading={issueFetching === frameIssue.id}
                                            onClick={() => {
                                                reopenIssueDirect(frameIssue);
                                            }}
                                        >
                                            Reopen
                                        </Button>
                                    </Row>
                                )}
                            </div>
                        );
                    },
                )}
                {showGroundTruth && frameConflicts.map(
                    (frameConflict: QualityConflict): JSX.Element => (
                        <div
                            key={frameConflict.id}
                            id={`cvat-objects-sidebar-conflict-item-${frameConflict.id}`}
                            className={
                                `${frameConflict.severity === ConflictSeverity.WARNING ?
                                    'cvat-objects-sidebar-warning-item' : 'cvat-objects-sidebar-conflict-item'}
                                  ${frameConflict.id === highlightedConflict?.id ? 'cvat-objects-sidebar-item-active' : ''}  `
                            }
                            onMouseEnter={() => {
                                if (ready && activeControl === ActiveControl.CURSOR) {
                                    dispatch(highlightConflict(frameConflict));
                                }
                            }}
                            onMouseLeave={() => {
                                if (ready && activeControl === ActiveControl.CURSOR) {
                                    dispatch(highlightConflict(null));
                                }
                            }}
                        >
                            <Row>
                                <Text strong>
                                    {`#${frameConflict.id} • ${frameConflict.severity === ConflictSeverity.WARNING ?
                                        'Warning' : 'Conflict'}`}
                                </Text>
                            </Row>
                            <Row>
                                <Paragraph ellipsis={{ rows: 2 }}>
                                    {frameConflict.description}
                                </Paragraph>
                                <Text />
                            </Row>
                        </div>
                    ),
                )}
            </div>
            <Modal
                title='Convert issue to mask'
                visible={convertModalVisible}
                onCancel={closeConvertModal}
                onOk={onConvertToMask}
                okButtonProps={{ disabled: !selectedLabelId }}
            >
                <Row style={{ marginBottom: 12 }}>
                    <Col span={24}>
                        <Text strong>Label</Text>
                    </Col>
                    <Col span={24}>
                        <Select
                            style={{ width: '100%' }}
                            value={selectedLabelId ?? undefined}
                            onChange={(value: number) => setSelectedLabelId(value)}
                        >
                            {maskLabels.map((label) => (
                                <Select.Option key={label.id} value={label.id as number}>
                                    {label.name}
                                </Select.Option>
                            ))}
                        </Select>
                    </Col>
                </Row>
                <Row>
                    <Checkbox
                        checked={resolveAfterConvert}
                        onChange={(event) => setResolveAfterConvert(event.target.checked)}
                    >
                        Resolve issue after conversion
                    </Checkbox>
                </Row>
            </Modal>
        </>
    );
}
