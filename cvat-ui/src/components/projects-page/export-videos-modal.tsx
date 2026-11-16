// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Checkbox from 'antd/lib/checkbox';
import Modal from 'antd/lib/modal';
import Progress from 'antd/lib/progress';
import Slider from 'antd/lib/slider';
import Space from 'antd/lib/space';
import Table from 'antd/lib/table';
import Typography from 'antd/lib/typography';
import { getCore, Project } from 'cvat-core-wrapper';
import downloadWithProgress, { DownloadProgress, downloadStatus } from 'utils/download-with-progress';

interface VideoTask { id: number; name: string; size: number; mode: string; dimension: string }
interface ExportRun { id: string; state: 'queued' | 'running' | 'ready' | 'failed'; progress: number; error?: string }
interface ExportRow { task: VideoTask; run?: ExportRun; error?: string; starting?: boolean }
const eligible = (task: VideoTask): boolean => task.mode === 'interpolation' && task.dimension === '2d' && task.size > 0;
const pending = (row: ExportRow): boolean => Boolean(row.starting || ['queued', 'running'].includes(row.run?.state || ''));
const message = (reason: unknown): string => {
    if (Axios.isAxiosError(reason) && reason.response?.data?.detail) return String(reason.response.data.detail);
    return reason instanceof Error ? reason.message : String(reason);
};

export default function ExportVideosModal({ project, open, onClose }: {
    project: Project; open: boolean; onClose(): void;
}): JSX.Element {
    const base = getCore().config.backendAPI;
    const storageKey = `cvat-project-video-exports-${project.id}`;
    const [tasks, setTasks] = useState<VideoTask[]>([]);
    const [selected, setSelected] = useState<React.Key[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [opacity, setOpacity] = useState(35);
    const [showNames, setShowNames] = useState(true);
    const [showLegend, setShowLegend] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [zip, setZip] = useState<ExportRun | null>(null);
    const [packaging, setPackaging] = useState(false);
    const [zipDownload, setZipDownload] = useState<DownloadProgress | null>(null);
    const [browserDownloads, setBrowserDownloads] = useState<Record<number, boolean>>({});
    const [downloadBytes, setDownloadBytes] = useState<Record<number, number>>({});
    const [downloads, setDownloads] = useState<Record<number, number>>({});
    const [rows, setRows] = useState<ExportRow[]>(() => {
        try {
            return (JSON.parse(sessionStorage.getItem(storageKey) || '[]') as ExportRow[])
                .map((row) => (row.starting ? { ...row, starting: false, error: 'Submission interrupted. Retry this task.' } : row));
        } catch { return []; }
    });
    const busy = submitting || rows.some(pending);
    const pendingKey = rows.filter((row) => row.run && pending(row))
        .map((row) => `${row.task.id}/${row.run!.id}`).join(',');
    useEffect(() => {
        try { sessionStorage.setItem(storageKey, JSON.stringify(rows)); } catch { /* Storage may be unavailable. */ }
    }, [rows, storageKey]);
    useEffect(() => {
        if (!open) return undefined;
        const controller = new AbortController();
        setLoading(true);
        setError('');
        (async () => {
            try {
                const all: VideoTask[] = [];
                for (let page = 1; ; page++) {
                    const { data } = await Axios.get<{ results: VideoTask[]; next: string | null }>(`${base}/tasks`, {
                        params: {
                            project_id: project.id, page_size: 100, page, sort: 'id',
                        },
                        signal: controller.signal,
                    });
                    all.push(...data.results);
                    if (!data.next) break;
                }
                if (!controller.signal.aborted) {
                    setTasks(all);
                    setSelected((previous) => previous.filter((id) => (
                        all.some((task) => task.id === id && eligible(task))
                    )));
                }
            } catch (reason) {
                if (!controller.signal.aborted) setError(message(reason));
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        })();
        return () => controller.abort();
    }, [open, project.id, base]);
    useEffect(() => {
        if (!pendingKey) return undefined;
        const controller = new AbortController();
        let timer: number;
        const poll = async (): Promise<void> => {
            await Promise.all(pendingKey.split(',').map(async (key) => {
                const [taskID, runID] = key.split('/');
                try {
                    const { data } = await Axios.get<ExportRun>(`${base}/tasks/${taskID}/overlay-video/${runID}`, {
                        signal: controller.signal, timeout: 30000,
                    });
                    if (!controller.signal.aborted) {
                        setRows((previous) => previous.map((row) => (
                            row.task.id === +taskID && row.run?.id === runID ?
                                { ...row, run: data, error: undefined } : row
                        )));
                    }
                } catch (reason) {
                    if (controller.signal.aborted) return;
                    const expired = Axios.isAxiosError(reason) && [403, 404].includes(reason.response?.status || 0);
                    setRows((previous) => previous.map((row) => (
                        row.task.id === +taskID && row.run?.id === runID ? {
                            ...row,
                            error: message(reason),
                            run: expired ? { ...row.run, state: 'failed' } : row.run,
                        } : row
                    )));
                }
            }));
            if (!controller.signal.aborted) timer = window.setTimeout(poll, 2000);
        };
        poll();
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [pendingKey, base]);
    const readyRows = rows.filter((row) => row.run?.state === 'ready');
    const zipPending = zip?.state === 'queued' || zip?.state === 'running';
    useEffect(() => {
        if (!zip || !zipPending) return undefined;
        const controller = new AbortController();
        let timer: number;
        const poll = async (): Promise<void> => {
            try {
                const { data } = await Axios.get<ExportRun>(`${base}/projects/${project.id}/video-zip/${zip.id}`, {
                    signal: controller.signal, timeout: 30000,
                });
                if (controller.signal.aborted) return;
                setZip(data);
                if (data.state === 'ready' || data.state === 'failed') return;
            } catch (reason) {
                if (controller.signal.aborted) return;
                setError(message(reason));
                if (Axios.isAxiosError(reason) && [403, 404].includes(reason.response?.status || 0)) {
                    setZip((previous) => (previous ? { ...previous, state: 'failed' } : null));
                    return;
                }
            }
            timer = window.setTimeout(poll, 2000);
        };
        poll();
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [zip?.id, zipPending, project.id, base]);
    const packageZip = async (): Promise<void> => {
        setPackaging(true);
        setError('');
        setZipDownload(null);
        try {
            const { data } = await Axios.post<ExportRun>(`${base}/projects/${project.id}/video-zip`, {
                exports: readyRows.map((row) => ({ task_id: row.task.id, export_id: row.run!.id })),
            }, { timeout: 120000 });
            setZip(data);
        } catch (reason) { setError(message(reason)); } finally { setPackaging(false); }
    };
    const downloadZip = async (): Promise<void> => {
        if (!zip) return;
        setZipDownload({ percent: 0, loaded: 0 });
        setError('');
        try {
            const completed = await downloadWithProgress(
                `${base}/projects/${project.id}/video-zip/${zip.id}/download`,
                `project-${project.id}-videos.zip`,
                setZipDownload,
            );
            if (!completed) setZipDownload(null);
        } catch (reason) { setZipDownload(null); setError(message(reason)); }
    };
    const start = async (chosen: VideoTask[]): Promise<void> => {
        setSubmitting(true);
        setError('');
        setRows((previous) => [
            ...previous.filter((row) => !chosen.some((task) => task.id === row.task.id)),
            ...chosen.map((task) => ({ task, starting: true })),
        ]);
        let index = 0;
        // Bound snapshot requests; every successful request gets an independent backend queue job.
        await Promise.all(Array.from({ length: Math.min(4, chosen.length) }, async () => {
            while (index < chosen.length) {
                const task = chosen[index++];
                try {
                    const { data } = await Axios.post<ExportRun>(`${base}/tasks/${task.id}/overlay-video`, {
                        opacity: opacity / 100, show_names: showNames, show_legend: showLegend, show_phase: true,
                    }, { timeout: 120000 });
                    setRows((previous) => previous.map((row) => (
                        row.task.id === task.id ? { task, run: data } : row
                    )));
                } catch (reason) {
                    setRows((previous) => previous.map((row) => (
                        row.task.id === task.id ? { task, error: message(reason) } : row
                    )));
                }
            }
        }));
        setSubmitting(false);
    };
    const download = async (row: ExportRow): Promise<void> => {
        setDownloads((previous) => ({ ...previous, [row.task.id]: 0 }));
        setDownloadBytes((previous) => ({ ...previous, [row.task.id]: 0 }));
        setBrowserDownloads((previous) => ({ ...previous, [row.task.id]: false }));
        setError('');
        try {
            const completed = await downloadWithProgress(
                `${base}/tasks/${row.task.id}/overlay-video/${row.run!.id}/download`,
                `task-${row.task.id}-A-B.mp4`,
                ({ percent, loaded, browserManaged }) => {
                    setBrowserDownloads((previous) => ({ ...previous, [row.task.id]: Boolean(browserManaged) }));
                    setDownloads((previous) => ({ ...previous, [row.task.id]: percent }));
                    setDownloadBytes((previous) => ({ ...previous, [row.task.id]: loaded }));
                },
            );
            if (completed) return;
        } catch (reason) { setError(message(reason)); }
        setDownloads((previous) => { const next = { ...previous }; delete next[row.task.id]; return next; });
    };
    return (
        <Modal title={`Export videos · ${project.name}`} open={open} onCancel={onClose} footer={null} width={1000}>
            <Space direction='vertical' style={{ width: '100%' }}>
                <Typography.Paragraph>
                    Select tasks to export as separate A + B MP4s: original on the left, overlay + phase on the right.
                    Uses saved annotations across all jobs in each task. Tasks are processed in parallel by available
                    export workers. You can close this dialog and return to view progress and download within 24 hours.
                </Typography.Paragraph>
                {error && <Alert type='error' showIcon message={error} />}
                <Table<VideoTask>
                    rowKey='id'
                    loading={loading}
                    dataSource={tasks}
                    size='small'
                    pagination={{ pageSize: 8 }}
                    rowSelection={{
                        selectedRowKeys: selected,
                        onChange: setSelected,
                        getCheckboxProps: (task) => ({ disabled: busy || !eligible(task) }),
                        selections: [Table.SELECTION_ALL, Table.SELECTION_NONE],
                    }}
                    columns={[
                        { title: 'Task', render: (_, task) => `#${task.id} ${task.name}` },
                        { title: 'Frames', dataIndex: 'size' },
                        { title: 'Format', render: (_, task) => (eligible(task) ? 'A + B MP4' : 'Not a 2D video task') },
                    ]}
                />
                <Typography.Text>{`Overlay opacity: ${opacity}%`}</Typography.Text>
                <Slider value={opacity} onChange={setOpacity} min={0} max={100} disabled={busy} />
                <Space>
                    <Checkbox
                        checked={showNames}
                        disabled={busy}
                        onChange={(event) => setShowNames(event.target.checked)}
                    >
                        Object names and IDs
                    </Checkbox>
                    <Checkbox
                        checked={showLegend}
                        disabled={busy}
                        onChange={(event) => setShowLegend(event.target.checked)}
                    >
                        Color legend
                    </Checkbox>
                    <Typography.Text>Phase included</Typography.Text>
                </Space>
                <Button
                    type='primary'
                    disabled={busy || !selected.length}
                    loading={submitting}
                    onClick={() => start(tasks.filter((task) => selected.includes(task.id) && eligible(task)))}
                >
                    {`Export selected videos (${selected.length})`}
                </Button>
                <Space wrap>
                    <Button
                        onClick={packageZip}
                        loading={packaging || zipPending}
                        disabled={!readyRows.length || packaging || zipPending ||
                            Boolean(zipDownload && zipDownload.percent < 100)}
                    >
                        {`Package ready videos as ZIP (${readyRows.length})`}
                    </Button>
                    {zip?.state === 'ready' && (
                        <Button
                            type='primary'
                            onClick={downloadZip}
                            loading={Boolean(zipDownload && zipDownload.percent < 100)}
                        >
                            Download ZIP
                        </Button>
                    )}
                </Space>
                <Typography.Text type='secondary'>
                    ZIP includes videos completed when packaging starts. MP4 files are already compressed;
                    ZIP packaging preserves quality and supports large files.
                </Typography.Text>
                {zip && (
                    <>
                        <Typography.Text>{zipPending ? 'Packaging ZIP…' : `ZIP: ${zip.state}`}</Typography.Text>
                        <Progress percent={zip.progress} status={zip.state === 'failed' ? 'exception' : undefined} />
                        {zip.error && <Alert type='error' message={zip.error} />}
                    </>
                )}
                {zipDownload && (
                    <>
                        <Typography.Text>
                            {downloadStatus(zipDownload.percent, zipDownload.browserManaged)}
                            {!zipDownload.browserManaged && ` ${(zipDownload.loaded / 1024 / 1024).toFixed(1)} MB`}
                        </Typography.Text>
                        {!zipDownload.browserManaged && <Progress percent={zipDownload.percent} />}
                    </>
                )}
                {rows.length > 0 && (
                    <Table<ExportRow>
                        rowKey={(row) => row.task.id}
                        dataSource={rows}
                        pagination={false}
                        size='small'
                        columns={[
                            { title: 'Task', render: (_, row) => `#${row.task.id} ${row.task.name}` },
                            {
                                title: 'Generation',
                                render: (_, row) => (
                                    <>
                                        <Typography.Text>{row.starting ? 'Submitting…' : row.run?.state}</Typography.Text>
                                        <Progress
                                            percent={row.run?.progress || 0}
                                            status={row.error || row.run?.state === 'failed' ? 'exception' : undefined}
                                        />
                                        {(row.error || row.run?.error) && (
                                            <Typography.Text type='danger'>{row.error || row.run?.error}</Typography.Text>
                                        )}
                                    </>
                                ),
                            },
                            {
                                title: 'Download',
                                render: (_, row) => (
                                    <Space direction='vertical'>
                                        {row.run?.state === 'ready' && (
                                            <Button
                                                onClick={() => download(row)}
                                                loading={downloads[row.task.id] !== undefined &&
                                                    downloads[row.task.id] < 100}
                                                disabled={downloads[row.task.id] !== undefined &&
                                                    downloads[row.task.id] < 100}
                                            >
                                            Download MP4
                                            </Button>
                                        )}
                                        {downloads[row.task.id] !== undefined && (
                                            <>
                                                <Typography.Text>
                                                    {downloadStatus(
                                                        downloads[row.task.id], browserDownloads[row.task.id],
                                                    )}
                                                    {' '}
                                                    {!browserDownloads[row.task.id] && (
                                                        <span>
                                                            {((downloadBytes[row.task.id] || 0) / 1048576).toFixed(1)}
                                                            {' MB'}
                                                        </span>
                                                    )}
                                                </Typography.Text>
                                                {!browserDownloads[row.task.id] && (
                                                    <Progress percent={downloads[row.task.id]} />
                                                )}
                                            </>
                                        )}
                                        {!pending(row) && (row.error || row.run?.state === 'failed') && (
                                            <Button disabled={submitting} onClick={() => start([row.task])}>
                                                Retry
                                            </Button>
                                        )}
                                    </Space>
                                ),
                            },
                        ]}
                    />
                )}
            </Space>
        </Modal>
    );
}
