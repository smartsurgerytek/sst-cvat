// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    ReactPortal, useEffect, useRef,
} from 'react';
import ReactDOM from 'react-dom';
import Tag from 'antd/lib/tag';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';

import { Issue } from 'cvat-core-wrapper';
import CVATTooltip from 'components/common/cvat-tooltip';

interface Props {
    issue: Issue;
    top: number;
    left: number;
    angle: number;
    scale: number;
    resolved: boolean;
    onClick: (event: React.MouseEvent) => void;
    highlight: () => void;
    blur: () => void;
}

export default function HiddenIssueLabel(props: Props): ReactPortal | null {
    const {
        issue, top, left, angle, scale, resolved, onClick, highlight, blur,
    } = props;

    const { id, comments } = issue;
    const message = comments[0]?.message || '';
    const ref = useRef<HTMLElement>(null);
    useEffect(() => {
        if (!resolved) {
            setTimeout(highlight);
        } else {
            setTimeout(blur);
        }
    }, [resolved]);

    useEffect(() => {
        const { current } = ref;
        if (!current) {
            return () => {};
        }

        const listener = (event: WheelEvent): void => {
            event.stopPropagation();
            if (event.deltaX > 0) {
                current.parentElement?.appendChild(current);
            } else {
                current.parentElement?.prepend(current);
            }
        };

        current.addEventListener('wheel', listener);
        return () => {
            current.removeEventListener('wheel', listener);
        };
    }, [ref]);

    const elementID = `cvat-hidden-issue-label-${id}`;
    const portalContainer = window.document.getElementById('cvat_canvas_attachment_board');
    if (!portalContainer) {
        return null;
    }
    return ReactDOM.createPortal(
        <CVATTooltip title={message || 'No comments found'}>
            <Tag
                ref={ref}
                id={elementID}
                onClick={onClick}
                onMouseEnter={highlight}
                onMouseLeave={blur}
                style={{ top, left, transform: `scale(${scale}) rotate(${angle}deg)` }}
                className='cvat-hidden-issue-label'
            >
                {resolved ? (
                    <CheckCircleOutlined className='cvat-hidden-issue-resolved-indicator' />
                ) : (
                    <CloseCircleOutlined className='cvat-hidden-issue-unsolved-indicator' />
                )}
                {message || null}
            </Tag>
        </CVATTooltip>,
        portalContainer,
    );
}
