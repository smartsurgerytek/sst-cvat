// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useState, useEffect, useRef, useCallback,
} from 'react';
import ReactDOM from 'react-dom';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import dayjs from 'dayjs';
import Modal from 'antd/lib/modal';
import { Row, Col } from 'antd/lib/grid';
import { CloseOutlined } from '@ant-design/icons';
import { Comment } from '@ant-design/compatible';
import Text from 'antd/lib/typography/Text';
import Button from 'antd/lib/button';
import Input from 'antd/lib/input';
import Select from 'antd/lib/select';
import Checkbox from 'antd/lib/checkbox';
import notification from 'antd/lib/notification';
import { logError } from 'cvat-logger';
import CVATTooltip from 'components/common/cvat-tooltip';
import {
    Issue, Comment as CommentModel, getCore, ObjectType, ShapeType, LabelType,
} from 'cvat-core-wrapper';
import { createAnnotationsAsync } from 'actions/annotation-actions';
import { deleteIssueAsync } from 'actions/review-actions';
import { CombinedState, Workspace } from 'reducers';
import { filterApplicableForType } from 'utils/filter-applicable-labels';
import { ensureError } from 'utils/error-handling';
import { isLikelyRle } from 'utils/masks';
import { useDialogPositioning } from './use-dialog-positioning';

const core = getCore();

interface Props {
    issue: Issue;
    left: number;
    top: number;
    resolved: boolean;
    isFetching: boolean;
    angle: number;
    scale: number;
    clientCoordinates: [number, number];
    canvasRect: DOMRect | null;
    allowRemoving: boolean;
    collapse: () => void;
    resolve: () => void;
    reopen: () => void;
    comment: (message: string) => void;
    highlight: () => void;
    blur: () => void;
}

export default function IssueDialog(props: Props): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const [currentText, setCurrentText] = useState<string>('');
    const [convertModalVisible, setConvertModalVisible] = useState(false);
    const [selectedLabelId, setSelectedLabelId] = useState<number | null>(null);
    const [resolveAfterConvert, setResolveAfterConvert] = useState(false);
    const dispatch = useDispatch();
    const { labels, workspace } = useSelector((state: CombinedState) => ({
        labels: state.annotation.job.labels,
        workspace: state.annotation.workspace,
    }), shallowEqual);
    const {
        issue,
        left,
        top,
        scale,
        angle,
        resolved,
        isFetching,
        collapse,
        resolve,
        reopen,
        comment,
        highlight,
        blur,
        clientCoordinates,
        canvasRect,
        allowRemoving,
    } = props;

    const { id, comments } = issue;
    const maskLabels = filterApplicableForType(LabelType.MASK, labels);
    const canConvert = workspace !== Workspace.REVIEW && issue.isMaskIssue === true;

    const position = useDialogPositioning({
        ref,
        top,
        left,
        scale,
        angle,
        clientCoordinates,
        canvasRect,
    });

    useEffect(() => {
        if (!resolved) {
            setTimeout(highlight);
        } else {
            setTimeout(blur);
        }
    }, [resolved]);

    useEffect(() => {
        const listener = (event: WheelEvent): void => {
            event.stopPropagation();
        };

        if (ref.current) {
            const { current } = ref;
            current.addEventListener('wheel', listener);
            return () => {
                current.removeEventListener('wheel', listener);
            };
        }
        return () => {};
    }, [ref.current]);

    const onDeleteIssue = useCallback((): void => {
        const issueNumber = typeof id === 'number' ? ` #${id}` : '';
        Modal.confirm({
            title: `The issue${issueNumber} will be deleted.`,
            className: 'cvat-modal-confirm-remove-issue',
            onOk: () => {
                collapse();
                dispatch(deleteIssueAsync(id as number));
            },
            okButtonProps: {
                type: 'primary',
            },
            autoFocusButton: 'cancel',
            okText: 'Delete',
        });
    }, [id, collapse, dispatch]);

    const polygonToMaskRle = (points: number[]): number[] | null => {
        if (!Array.isArray(points) || points.length < 6) {
            return null;
        }

        const xs = points.filter((_, idx) => idx % 2 === 0);
        const ys = points.filter((_, idx) => idx % 2 !== 0);
        const bboxLeft = Math.floor(Math.min(...xs));
        const bboxRight = Math.ceil(Math.max(...xs));
        const bboxTop = Math.floor(Math.min(...ys));
        const bboxBottom = Math.ceil(Math.max(...ys));
        const width = bboxRight - bboxLeft + 1;
        const height = bboxBottom - bboxTop + 1;
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
        ctx.moveTo(points[0] - bboxLeft, points[1] - bboxTop);
        for (let i = 2; i < points.length; i += 2) {
            ctx.lineTo(points[i] - bboxLeft, points[i + 1] - bboxTop);
        }
        ctx.closePath();
        ctx.fill();

        const imageData = ctx.getImageData(0, 0, width, height).data;
        const mask = new Array(width * height);
        for (let i = 0; i < width * height; i++) {
            mask[i] = imageData[i * 4 + 3] > 0 ? 1 : 0;
        }

        const rle = core.utils.mask2Rle(mask);
        rle.push(bboxLeft, bboxTop, bboxRight, bboxBottom);
        return rle;
    };

    const onOpenConvertModal = (): void => {
        if (!maskLabels.length) {
            notification.warning({
                message: 'No mask labels available',
                description: 'Create a mask label first to convert issues into mask annotations.',
            });
            return;
        }

        setSelectedLabelId(maskLabels[0].id as number);
        setResolveAfterConvert(false);
        setConvertModalVisible(true);
    };

    const onCloseConvertModal = (): void => {
        setConvertModalVisible(false);
        setSelectedLabelId(null);
        setResolveAfterConvert(false);
    };

    const onConvertToMask = async (): Promise<void> => {
        if (!selectedLabelId) return;
        const label = labels.find((_label) => _label.id === selectedLabelId);
        if (!label) return;

        const issuePosition = issue.position || [];
        const maskPoints = issue.isMaskIssue && isLikelyRle(issuePosition) ?
            issuePosition : polygonToMaskRle(issuePosition);
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
            frame: issue.frame,
            points: maskPoints,
            occluded: false,
            outside: false,
            rotation: 0,
        });

        try {
            const created = await dispatch(createAnnotationsAsync([objectState])) as boolean;
            if (!created) {
                const issueRef = typeof id === 'number' ? ` (issue #${id})` : '';
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
                type: 'Issue mask conversion create annotation failed',
                issue_id: id,
            });
            const issueRef = typeof id === 'number' ? ` (issue #${id})` : '';
            notification.error({
                message: 'Conversion failed',
                description:
                    `Could not create a mask annotation${issueRef}. ` +
                    'Please try again or report the issue ID to support.',
            });
            return;
        }

        onCloseConvertModal();
        if (resolveAfterConvert) {
            try {
                resolve();
            } catch (error) {
                logError(ensureError(error), false, {
                    type: 'Issue mask conversion resolve issue failed',
                    issue_id: id,
                });
                const issueRef = typeof id === 'number' ? ` #${id}` : '';
                notification.warning({
                    message: 'Mask created, issue not resolved',
                    description:
                        `The mask annotation was created, but the issue${issueRef} ` +
                        'could not be resolved automatically. Please try resolving it again.',
                });
            }
        }
    };

    const lines = comments.map(
        (_comment: CommentModel): JSX.Element => {
            const created = dayjs(_comment.createdDate ?? undefined);
            const diff = created.fromNow();

            return (
                <Comment
                    avatar={null}
                    key={_comment.id}
                    author={<Text strong>{_comment.owner ? _comment.owner.username : 'Unknown'}</Text>}
                    content={<p>{_comment.message}</p>}
                    datetime={(
                        <CVATTooltip title={created.format('MMMM Do YYYY')}>
                            <span>{diff}</span>
                        </CVATTooltip>
                    )}
                />
            );
        },
    );

    const resolveButton = resolved ? (
        <Button loading={isFetching} className='cvat-issue-dialog-reopen-button' type='primary' onClick={reopen}>
            Reopen
        </Button>
    ) : (
        <Button loading={isFetching} className='cvat-issue-dialog-resolve-button' type='primary' onClick={resolve}>
            Resolve
        </Button>
    );

    return ReactDOM.createPortal(
        <div
            style={{ top: position.top, left: position.left, transform: `scale(${scale}) rotate(${angle}deg)` }}
            ref={ref}
            className='cvat-issue-dialog'
        >
            <Row className='cvat-issue-dialog-header' justify='space-between'>
                <Col>
                    <Text strong>{typeof id === 'number' ? `Issue #${id}` : 'Issue'}</Text>
                </Col>
                <Col>
                    <CVATTooltip title='Collapse the chat'>
                        <CloseOutlined onClick={collapse} />
                    </CVATTooltip>
                </Col>
            </Row>
            <Row className='cvat-issue-dialog-chat' justify='start'>
                {
                    lines.length > 0 ? <Col style={{ display: 'block' }}>{lines}</Col> : (
                        <Col>No comments found</Col>
                    )
                }
            </Row>
            <Row className='cvat-issue-dialog-input' justify='start'>
                <Col span={24}>
                    <Input
                        placeholder='Type a comment here..'
                        value={currentText}
                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                            setCurrentText(event.target.value);
                        }}
                        onPressEnter={() => {
                            if (currentText) {
                                comment(currentText);
                                setCurrentText('');
                            }
                        }}
                    />
                </Col>
            </Row>
            <Row className='cvat-issue-dialog-footer' justify={allowRemoving || canConvert ? 'space-between' : 'end'}>
                {(allowRemoving || canConvert) && (
                    <Col>
                        {allowRemoving && (
                            <Button type='link' className='cvat-issue-dialog-remove-button' danger onClick={onDeleteIssue}>
                                Remove
                            </Button>
                        )}
                        {canConvert && (
                            <Button
                                type='link'
                                className='cvat-issue-dialog-convert-to-mask-button'
                                onClick={onOpenConvertModal}
                            >
                                Convert to mask
                            </Button>
                        )}
                    </Col>
                )}
                <Col>
                    {currentText.length ? (
                        <Button
                            className='cvat-issue-dialog-comment-button'
                            loading={isFetching}
                            type='primary'
                            disabled={!currentText.length}
                            onClick={() => {
                                comment(currentText);
                                setCurrentText('');
                            }}
                        >
                            Comment
                        </Button>
                    ) : (
                        resolveButton
                    )}
                </Col>
            </Row>
            <Modal
                open={convertModalVisible}
                title='Convert issue to mask'
                onCancel={onCloseConvertModal}
                onOk={onConvertToMask}
                okButtonProps={{ disabled: !selectedLabelId }}
                destroyOnClose
            >
                <Row gutter={[0, 12]}>
                    <Col span={24}>
                        <Text>Select target mask label</Text>
                    </Col>
                    <Col span={24}>
                        <Select
                            style={{ width: '100%' }}
                            value={selectedLabelId ?? undefined}
                            options={maskLabels.map((label) => ({
                                label: label.name,
                                value: label.id as number,
                            }))}
                            onChange={(value: number): void => setSelectedLabelId(value)}
                        />
                    </Col>
                    {!resolved && (
                        <Col span={24}>
                            <Checkbox
                                checked={resolveAfterConvert}
                                onChange={(event) => setResolveAfterConvert(event.target.checked)}
                            >
                                Resolve issue after conversion
                            </Checkbox>
                        </Col>
                    )}
                </Row>
            </Modal>
        </div>,
        window.document.getElementById('cvat_canvas_attachment_board') as HTMLElement,
    );
}
