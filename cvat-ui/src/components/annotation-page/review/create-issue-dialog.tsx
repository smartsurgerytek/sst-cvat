// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, {
    useState, ReactPortal, useRef, useEffect, useMemo,
} from 'react';
import ReactDOM from 'react-dom';
import { useDispatch } from 'react-redux';
import Form from 'antd/lib/form';
import Input, { InputRef } from 'antd/lib/input';
import Select from 'antd/lib/select';
import Button from 'antd/lib/button';
import { Row, Col } from 'antd/lib/grid';
import { Store } from 'antd/lib/form/interface';

import { reviewActions, finishIssueAsync } from 'actions/review-actions';
import { useIsMounted } from 'utils/hooks';
import { useDialogPositioning } from './use-dialog-positioning';

interface FormProps {
    top: number;
    left: number;
    angle: number;
    scale: number;
    fetching: boolean;
    clientCoordinates: [number, number];
    canvasRect: DOMRect | null;
    labelTexts: string[];
    submit(message: string): void;
    cancel(): void;
}

function MessageForm(props: Readonly<FormProps>): JSX.Element {
    const {
        top, left, angle, scale, fetching, submit, cancel, clientCoordinates, canvasRect, labelTexts,
    } = props;

    const dialogRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<InputRef>(null);
    const cursorRangeRef = useRef<{ start: number; end: number } | null>(null);
    const [form] = Form.useForm();
    const labelOptions = useMemo(
        () => labelTexts.map((label: string) => ({
            value: label,
            label,
        })),
        [labelTexts],
    );

    const position = useDialogPositioning({
        ref: dialogRef,
        top,
        left,
        scale,
        angle,
        clientCoordinates,
        canvasRect,
    });

    useEffect(() => {
        if (inputRef.current) {
            setTimeout(() => {
                inputRef.current?.focus();
            }, 0);
        }
    }, [position]);

    const storeCursorRange = (): void => {
        const inputElement = inputRef.current?.input;
        if (!inputElement) return;
        const start = inputElement.selectionStart ?? inputElement.value.length;
        const end = inputElement.selectionEnd ?? start;
        cursorRangeRef.current = { start, end };
    };

    const applyLabelText = (labelText: string): void => {
        const currentDescription = String(form.getFieldValue('issue_description') || '');
        const inputElement = inputRef.current?.input;
        const liveStart = inputElement?.selectionStart;
        const liveEnd = inputElement?.selectionEnd;
        const liveRange = Number.isInteger(liveStart) && Number.isInteger(liveEnd) ?
            { start: liveStart as number, end: liveEnd as number } :
            cursorRangeRef.current;
        const safeStart = Math.min(Math.max(0, liveRange?.start ?? currentDescription.length), currentDescription.length);
        const safeEnd = Math.min(Math.max(safeStart, liveRange?.end ?? safeStart), currentDescription.length);
        const nextDescription = `${currentDescription.slice(0, safeStart)}${labelText}${currentDescription.slice(safeEnd)}`;
        const nextCursor = safeStart + labelText.length;

        form.setFieldsValue({
            issue_label_text: undefined,
            issue_description: nextDescription,
        });

        setTimeout(() => {
            const nextInputElement = inputRef.current?.input;
            if (nextInputElement) {
                nextInputElement.focus();
                nextInputElement.setSelectionRange(nextCursor, nextCursor);
                cursorRangeRef.current = { start: nextCursor, end: nextCursor };
            }
        }, 0);
    };

    function handleSubmit(values: Store): void {
        submit(values.issue_description);
    }

    return (
        <div
            ref={dialogRef}
            className='cvat-create-issue-dialog'
            style={{
                top: position.top,
                left: position.left,
                transform: `scale(${scale}) rotate(${angle}deg)`,
            }}
        >
            <Form
                form={form}
                onFinish={(values: Store) => handleSubmit(values)}
            >
                <Form.Item name='issue_label_text' label='Label text'>
                    <Select
                        className='cvat-create-issue-dialog-shortcut-selector'
                        placeholder='Select label text'
                        options={labelOptions}
                        showSearch
                        onSelect={(value: string) => {
                            applyLabelText(value);
                        }}
                    />
                </Form.Item>
                <Form.Item
                    name='issue_description'
                    rules={[{ required: true, message: 'Please, fill out the field' }]}
                >
                    <Input
                        ref={inputRef}
                        autoComplete='off'
                        placeholder='Please, describe the issue'
                        onClick={() => {
                            storeCursorRange();
                        }}
                        onKeyUp={() => {
                            storeCursorRange();
                        }}
                        onSelect={() => {
                            storeCursorRange();
                        }}
                        onBlur={() => {
                            storeCursorRange();
                        }}
                    />
                </Form.Item>
                <Row justify='space-between'>
                    <Col>
                        <Button
                            onClick={cancel}
                            disabled={fetching}
                            className='cvat-create-issue-dialog-cancel-button'
                        >
                            Cancel
                        </Button>
                    </Col>
                    <Col>
                        <Button
                            loading={fetching}
                            disabled={fetching}
                            type='primary'
                            htmlType='submit'
                            className='cvat-create-issue-dialog-submit-button'
                        >
                            Submit
                        </Button>
                    </Col>
                </Row>
            </Form>
        </div>
    );
}

interface Props {
    top: number;
    left: number;
    angle: number;
    scale: number;
    clientCoordinates: [number, number];
    canvasRect: DOMRect | null;
    labelTexts: string[];
    onCreateIssue: () => void;
}

export default function CreateIssueDialog(props: Props): ReactPortal {
    const [fetching, setFetching] = useState(false);
    const isMounted = useIsMounted();
    const dispatch = useDispatch();
    const {
        top, left, angle, scale, clientCoordinates, canvasRect, labelTexts, onCreateIssue,
    } = props;
    const filteredLabelTexts = useMemo(
        () => Array.from(new Set(labelTexts.filter((label: string) => Boolean(label?.trim())))),
        [labelTexts],
    );

    return ReactDOM.createPortal(
        <MessageForm
            top={top}
            left={left}
            angle={angle}
            scale={scale}
            clientCoordinates={clientCoordinates}
            canvasRect={canvasRect}
            labelTexts={filteredLabelTexts}
            fetching={fetching}
            submit={(message: string) => {
                setFetching(true);
                dispatch(finishIssueAsync(message)).finally(() => {
                    if (isMounted()) {
                        setFetching(false);
                    }
                    onCreateIssue();
                });
            }}
            cancel={() => {
                dispatch(reviewActions.cancelIssue());
            }}
        />,
        window.document.getElementById('cvat_canvas_attachment_board') as HTMLElement,
    );
}
