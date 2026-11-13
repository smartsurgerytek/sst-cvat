// SPDX-License-Identifier: MIT

import React, { useState } from 'react';
import Button from 'antd/lib/button';
import Checkbox from 'antd/lib/checkbox';
import Input from 'antd/lib/input';
import InputNumber from 'antd/lib/input-number';
import Select from 'antd/lib/select';
import Popconfirm from 'antd/lib/popconfirm';
import Space from 'antd/lib/space';
import Table from 'antd/lib/table';
import Tag from 'antd/lib/tag';
import Typography from 'antd/lib/typography';

export interface PhaseRange { labelID: number; start: number; stop: number }
interface Props {
    ranges: PhaseRange[];
    labels: { id?: number; name: string; color?: string }[];
    frame: number;
    busy: boolean;
    firstFrame: number;
    lastFrame: number;
    onEdit(original: PhaseRange, updated: PhaseRange): Promise<boolean>;
    onRefresh(): void;
    onSelect(range: PhaseRange): void;
    onNavigate(frame: number): void;
    onRemove(range: PhaseRange): Promise<void>;
}

export default function PhaseResultsManager({
    ranges, labels, frame, busy, firstFrame, lastFrame, onEdit, onRefresh, onSelect, onNavigate, onRemove,
}: Props): JSX.Element {
    const [search, setSearch] = useState('');
    const [currentOnly, setCurrentOnly] = useState(false);
    const [editing, setEditing] = useState<PhaseRange | null>(null);
    const [labelID, setLabelID] = useState<number>();
    const [start, setStart] = useState<number | null>(null);
    const [stop, setStop] = useState<number | null>(null);
    const valid = labelID !== undefined && start !== null && stop !== null &&
        Number.isInteger(start) && Number.isInteger(stop) && start >= firstFrame && stop <= lastFrame && start <= stop;
    const name = (range: PhaseRange): string => labels.find((label) => label.id === range.labelID)?.name || '';
    const visible = ranges.filter((range) => (
        name(range).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
        (!currentOnly || (range.start <= frame && frame <= range.stop))
    ));
    return (
        <Space direction='vertical' style={{ width: '100%' }} className='cvat-phase-results-manager'>
            <Space wrap>
                <Typography.Text strong>{`${ranges.length} annotated ranges`}</Typography.Text>
                <Button size='small' disabled={busy} onClick={onRefresh}>Refresh ranges</Button>
                <Input.Search
                    aria-label='Search phase annotations'
                    placeholder='Search phase names'
                    allowClear
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    style={{ width: 220 }}
                />
                <Checkbox checked={currentOnly} onChange={(event) => setCurrentOnly(event.target.checked)}>
                    {`Includes current frame ${frame}`}
                </Checkbox>
            </Space>
            <Typography.Text type='secondary'>
                Consecutive frames with the same phase form one range. Click an endpoint to navigate, or preview
                both endpoints.
            </Typography.Text>
            {editing && (
                <Space direction='vertical' style={{ width: '100%' }}>
                    <Typography.Text strong>
                        {`Edit ${name(editing)}: ${editing.start}–${editing.stop}`}
                    </Typography.Text>
                    <Space wrap>
                        <Select
                            aria-label='Edit phase label'
                            value={labelID}
                            onChange={setLabelID}
                            disabled={busy}
                            style={{ width: 180 }}
                            options={labels.map((label) => ({ value: label.id, label: label.name }))}
                        />
                        <Typography.Text>Start</Typography.Text>
                        <InputNumber
                            aria-label='Edit phase start'
                            value={start}
                            min={firstFrame}
                            max={lastFrame}
                            onChange={setStart}
                            disabled={busy}
                        />
                        <Typography.Text>End</Typography.Text>
                        <InputNumber
                            aria-label='Edit phase stop'
                            value={stop}
                            min={firstFrame}
                            max={lastFrame}
                            onChange={setStop}
                            disabled={busy}
                        />
                        <Button
                            type='primary'
                            loading={busy}
                            disabled={busy || !valid}
                            onClick={async () => {
                                if (valid && labelID !== undefined && start !== null && stop !== null &&
                                    await onEdit(editing, { labelID, start, stop })) setEditing(null);
                            }}
                        >
                            Apply changes
                        </Button>
                        <Button disabled={busy} onClick={() => setEditing(null)}>Cancel editing</Button>
                    </Space>
                    <Typography.Text type='secondary'>
                        Endpoints are inclusive; the start must not exceed the end. Applying replaces the original
                        range and merges adjacent ranges of the same phase.
                    </Typography.Text>
                </Space>
            )}
            <Table<PhaseRange>
                size='small'
                loading={busy}
                dataSource={visible}
                rowKey={(range) => `${range.labelID}:${range.start}:${range.stop}`}
                pagination={{ pageSize: 6, hideOnSinglePage: true, showSizeChanger: false }}
                locale={{ emptyText: ranges.length ? 'No matching ranges' : 'No phase annotations yet' }}
                columns={[
                    {
                        title: 'Phase',
                        render: (_, range) => (
                            <Space wrap>
                                <Tag color={labels.find((label) => label.id === range.labelID)?.color}>
                                    {name(range)}
                                </Tag>
                                {range.start <= frame && frame <= range.stop && <Tag color='blue'>Current frame</Tag>}
                            </Space>
                        ),
                    },
                    {
                        title: 'Start → End',
                        render: (_, range) => (
                            <Space size={0}>
                                <Button type='link' size='small' disabled={busy} onClick={() => onNavigate(range.start)}>
                                    {range.start}
                                </Button>
                                <span>→</span>
                                <Button type='link' size='small' disabled={busy} onClick={() => onNavigate(range.stop)}>
                                    {range.stop}
                                </Button>
                            </Space>
                        ),
                    },
                    { title: 'Frames', render: (_, range) => range.stop - range.start + 1 },
                    {
                        title: 'Actions',
                        render: (_, range) => (
                            <Space>
                                <Button
                                    size='small'
                                    disabled={busy || editing !== null}
                                    onClick={() => {
                                        setEditing(range);
                                        setLabelID(range.labelID);
                                        setStart(range.start);
                                        setStop(range.stop);
                                    }}
                                >
                                    Edit range
                                </Button>
                                <Button size='small' disabled={busy || editing !== null} onClick={() => onSelect(range)}>Preview range</Button>
                                <Popconfirm
                                    title={`Remove ${name(range)} from frames ${range.start}–${range.stop}?`}
                                    description='Only this phase label will be removed from the range. Save to persist changes.'
                                    onConfirm={() => onRemove(range)}
                                    okText='Remove this range'
                                    cancelText='Cancel'
                                    okButtonProps={{ danger: true }}
                                >
                                    <Button size='small' danger disabled={busy || editing !== null}>Remove range</Button>
                                </Popconfirm>
                            </Space>
                        ),
                    },
                ]}
            />
        </Space>
    );
}
