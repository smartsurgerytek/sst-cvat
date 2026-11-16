// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import Axios from 'axios';
import downloadWithProgress, { downloadStatus } from 'utils/download-with-progress';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Checkbox from 'antd/lib/checkbox';
import Modal from 'antd/lib/modal';
import Progress from 'antd/lib/progress';
import Slider from 'antd/lib/slider';
import Space from 'antd/lib/space';
import Typography from 'antd/lib/typography';
import { getCore, Job } from 'cvat-core-wrapper';
import { saveAnnotationsAsync, switchPlay } from 'actions/annotation-actions';
import VideoRangeSelector from './video-range-selector';
import VideoExportPreview from './video-export-preview';

interface ExportRun {
    id: string;
    state: 'queued' | 'running' | 'ready' | 'failed';
    progress: number;
    error?: string;
}

function errorMessage(reason: unknown): string {
    if (Axios.isAxiosError(reason)) {
        const detail = reason.response?.data;
        if (typeof detail === 'string') return detail;
        if (detail?.detail) return String(detail.detail);
        if (detail) return JSON.stringify(detail);
    }
    return reason instanceof Error ? reason.message : String(reason);
}

interface Props {
    job: Job;
    visible?: boolean;
    onVisibleChange?: (visible: boolean) => void;
}

export default function VideoOverlayExport({ job, visible, onVisibleChange }: Props): JSX.Element {
    const dispatch = useDispatch();
    const [internalOpen, setInternalOpen] = useState(false);
    const open = visible ?? internalOpen;
    const setOpen = onVisibleChange ?? setInternalOpen;
    const [range, setRange] = useState<[number, number]>([job.startFrame, job.stopFrame]);
    const [opacity, setOpacity] = useState(35);
    const [showNames, setShowNames] = useState(true);
    const [showLegend, setShowLegend] = useState(true);
    const [browserDownload, setBrowserDownload] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [run, setRun] = useState<ExportRun | null>(null);
    const base = `${getCore().config.backendAPI}/jobs/${job.id}/overlay-video`;
    const pending = run?.state === 'queued' || run?.state === 'running';
    const busy = submitting || pending || downloading;
    let progressStatus: 'active' | 'success' | 'exception' = 'active';
    if (run?.state === 'failed') progressStatus = 'exception';
    if (run?.state === 'ready') progressStatus = 'success';

    useEffect(() => {
        if (!run || !pending) return undefined;
        const controller = new AbortController();
        let timer: number;
        const poll = async (): Promise<void> => {
            try {
                const { data } = await Axios.get<ExportRun>(`${base}/${run.id}`, {
                    signal: controller.signal, timeout: 30000,
                });
                setRun(data);
                setError('');
                if (data.state === 'ready' || data.state === 'failed') return;
            } catch (reason) {
                if (controller.signal.aborted) return;
                setError(errorMessage(reason));
                if (Axios.isAxiosError(reason) && [403, 404].includes(reason.response?.status || 0)) {
                    setRun((previous) => (previous ? { ...previous, state: 'failed' } : previous));
                    return;
                }
            }
            if (!controller.signal.aborted) timer = window.setTimeout(poll, 2000);
        };
        poll();
        return () => { controller.abort(); window.clearTimeout(timer); };
    }, [run?.id, pending, base]);

    const start = async (): Promise<void> => {
        setSubmitting(true);
        setDownloadProgress(null);
        setError('');
        try {
            await dispatch(saveAnnotationsAsync());
            const { data } = await Axios.post<ExportRun>(base, {
                start_frame: range[0],
                stop_frame: range[1],
                opacity: opacity / 100,
                show_names: showNames,
                show_legend: showLegend,
                show_phase: true,
            }, { timeout: 60000 });
            setRun(data);
        } catch (reason) {
            setError(errorMessage(reason));
        } finally { setSubmitting(false); }
    };

    const download = async (): Promise<void> => {
        if (!run || downloading) return;
        setDownloading(true);
        setBrowserDownload(false);
        setDownloadProgress(0);
        setError('');
        try {
            const completed = await downloadWithProgress(
                `${base}/${run.id}/download`, `job-${job.id}-A-B-${run.id}.mp4`, ({ percent, browserManaged }) => {
                    setDownloadProgress(percent);
                    setBrowserDownload(Boolean(browserManaged));
                },
            );
            if (!completed) setDownloadProgress(null);
        } catch (reason) {
            setDownloadProgress(null);
            setError(errorMessage(reason));
        } finally { setDownloading(false); }
    };

    return (
        <>
            {visible === undefined && (
                <Button type='link' onClick={() => { dispatch(switchPlay(false)); setOpen(true); }}>
                    Export annotated video
                </Button>
            )}
            <Modal
                title='Export annotated video · A + B'
                open={open}
                width={800}
                footer={null}
                maskClosable={false}
                closable={!submitting}
                keyboard={!submitting}
                onCancel={() => setOpen(false)}
            >
                <Space direction='vertical' style={{ width: '100%' }}>
                    <Typography.Paragraph>
                        Export one synchronized side-by-side MP4: A shows the original image on the left;
                        B shows annotations and phases on the right, with optional object names, IDs, and a legend.
                        Starting an export saves current annotations first. Unaccepted SAM2 results are not included.
                    </Typography.Paragraph>
                    {error && <Alert type='error' showIcon message={error} />}
                    {open && <VideoRangeSelector job={job} value={range} disabled={busy} onChange={setRange} />}
                    <Typography.Text>{`Overlay opacity: ${opacity}%`}</Typography.Text>
                    <Slider aria-label='Overlay opacity' min={0} max={100} value={opacity} onChange={setOpacity} disabled={busy} />
                    <Space wrap>
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

                    </Space>
                    {open && (
                        <VideoExportPreview
                            job={job}
                            range={range}
                            opacity={opacity}
                            showNames={showNames}
                            showLegend={showLegend}
                        />
                    )}
                    <Typography.Text type='secondary'>
                        Phase is always included beside B without covering the image. Source frame
                        timing is preserved; deleted frames are skipped.
                        Exports a silent MP4. Supports masks, rectangles, polygons, polylines, points, and ellipses.
                    </Typography.Text>
                    {run && (
                        <>
                            <Typography.Text>Generation progress</Typography.Text>
                            <Progress percent={run.progress} status={progressStatus} />
                            {pending && (
                                <Alert
                                    type='info'
                                    showIcon
                                    message={run.state === 'queued' ? 'Waiting for video export to start…' : 'Generating video…'}
                                    description='You can close this dialog and keep working. Reopen it later to download the video.'
                                />
                            )}
                            {run.state === 'failed' && <Alert type='error' showIcon message={run.error || 'Export failed. Please try again.'} />}
                            {run.state === 'ready' && (
                                <Alert type='success' showIcon message='Video ready. Download it within 24 hours.' />
                            )}
                        </>
                    )}
                    {(downloading || downloadProgress !== null) && (
                        <>
                            <Typography.Text>
                                {downloadStatus(downloadProgress ?? 0, browserDownload)}
                            </Typography.Text>
                            {!browserDownload && (
                                <Progress
                                    percent={downloadProgress ?? 0}
                                    status={downloadProgress === 100 ? 'success' : 'active'}
                                    format={downloadProgress === null ? () => 'Downloading…' : undefined}
                                />
                            )}
                        </>
                    )}
                    <Space>
                        <Button
                            type='primary'
                            loading={submitting}
                            disabled={busy || range[0] > range[1]}
                            onClick={start}
                        >
                            {submitting ? 'Saving annotations and starting export…' : 'Save and export'}
                        </Button>
                        {run?.state === 'ready' && (
                            <Button onClick={download} loading={downloading} disabled={downloading}>
                                Download A + B MP4
                            </Button>
                        )}
                    </Space>
                </Space>
            </Modal>
        </>
    );
}
