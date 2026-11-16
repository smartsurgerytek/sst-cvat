// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from 'react';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Popconfirm from 'antd/lib/popconfirm';
import Space from 'antd/lib/space';
import Table from 'antd/lib/table';
import Tag from 'antd/lib/tag';
import Typography from 'antd/lib/typography';
import { Job } from 'cvat-core-wrapper';

interface Group {
    run_id: string;
    created_date: string;
    label_id: number;
    label_name: string;
    label_color: string;
    count: number;
    edited_count: number;
    frames: number[];
}
interface Results { version: string; groups: Group[] }
interface Props {
    job: Job;
    base: string;
    revision: number;
    onChanged(): Promise<void>;
}

export default function SAM2ResultsManager({
    job, base, revision, onChanged,
}: Props): JSX.Element {
    const [results, setResults] = useState<Results>({ version: '', groups: [] });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [refresh, setRefresh] = useState(0);
    useEffect(() => {
        let disposed = false;
        setBusy(true);
        Axios.get<Results>(`${base}/results`).then(({ data }) => {
            if (!disposed) { setResults(data); setError(''); }
        }).catch((reason) => { if (!disposed) setError(String(reason)); })
            .finally(() => { if (!disposed) setBusy(false); });
        return () => { disposed = true; };
    }, [base, revision, refresh]);

    const remove = async (group: Group): Promise<void> => {
        setBusy(true); setError('');
        try {
            if (job.annotations.hasUnsavedChanges()) throw new Error('Save your canvas edits before deleting SAM2 masks.');
            const { data } = await Axios.delete<Results>(`${base}/results`, {
                data: { run_id: group.run_id, label_id: group.label_id, version: results.version },
            });
            setResults(data);
            await onChanged();
        } catch (reason) {
            setError(Axios.isAxiosError(reason) ?
                JSON.stringify(reason.response?.data || reason.message) : String(reason));
        } finally { setBusy(false); }
    };

    return (
        <Space direction='vertical' style={{ width: '100%' }} className='cvat-sam2-results-manager'>
            <Space>
                <Typography.Text strong>Manage SAM2 masks</Typography.Text>
                <Button size='small' disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Refresh results</Button>
            </Space>
            <Typography.Text type='secondary'>Saved masks grouped by inference run and label. Starting prompts and unrelated annotations are preserved.</Typography.Text>
            {error && <Alert type='error' message={error} />}
            <Table<Group>
                size='small'
                loading={busy}
                dataSource={results.groups}
                rowKey={(group) => `${group.run_id}:${group.label_id}`}
                pagination={{ pageSize: 5 }}
                locale={{ emptyText: 'No accepted SAM2 masks remain in this job.' }}
                columns={[
                    {
                        title: 'Label / run',
                        render: (_, group) => (
                            <Space direction='vertical' size={0}>
                                <Tag color={group.label_color}>{group.label_name}</Tag>
                                <Typography.Text type='secondary'>{group.run_id.slice(0, 8)}</Typography.Text>
                            </Space>
                        ),
                    },
                    { title: 'Frames', render: (_, group) => `${group.frames[0]}–${group.frames[group.frames.length - 1]}` },
                    { title: 'Masks', render: (_, group) => `${group.count}${group.edited_count ? ` (${group.edited_count} edited)` : ''}` },
                    {
                        title: 'Actions',
                        render: (_, group) => (
                            <Space>
                                <Popconfirm
                                    title={`Delete ${group.count} ${group.label_name} masks from this run?`}
                                    description={`${group.edited_count} edited masks included. Seeds are preserved.`}
                                    onConfirm={() => remove(group)}
                                    okText='Delete masks'
                                    okButtonProps={{ danger: true }}
                                >
                                    <Button size='small' danger disabled={busy}>Delete label results</Button>
                                </Popconfirm>
                            </Space>
                        ),
                    },
                ]}
            />
        </Space>
    );
}
