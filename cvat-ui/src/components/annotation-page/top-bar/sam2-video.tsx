// Copyright (C) CVAT.ai Corporation
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Axios from 'axios';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Checkbox from 'antd/lib/checkbox';
import Modal from 'antd/lib/modal';
import notification from 'antd/lib/notification';
import Progress from 'antd/lib/progress';
import Select from 'antd/lib/select';
import Space from 'antd/lib/space';
import Typography from 'antd/lib/typography';

import {
    getCore, Job, ObjectType, ShapeType,
} from 'cvat-core-wrapper';
import { CombinedState } from 'reducers';
import { SAM2_TRACK_SHAPE, SAM2TrackShapeDetail } from 'utils/sam2-events';
import { fetchAnnotationsAsync, saveAnnotationsAsync, switchPlay } from 'actions/annotation-actions';
import SAM2EndFrame from './sam2-end-frame';
import SAM2MaskReview from './sam2-mask-review';
import SAM2ResultsManager from './sam2-results-manager';
import './sam2-review.scss';

interface Run {
    id: string;
    status: 'queued' | 'running' | 'ready' | 'accepted' | 'cancelled' | 'failed';
    progress: number;
    error: string;
    start_frame: number;
    stop_frame: number;
    model: string;
}

function runStage(run: Run): string {
    if (run.status !== 'running') return run.status;
    if (run.progress < 20) return 'Preparing video';
    if (run.progress < 90) return 'Tracking objects';
    return 'Finalizing masks';
}

export default function SAM2Video({ job }: { job: Job }): JSX.Element {
    const dispatch = useDispatch();
    const frame = useSelector((state: CombinedState) => state.annotation.player.frame.number);
    const states = useSelector((state: CombinedState) => state.annotation.annotations.states);
    const [open, setOpen] = useState(false);
    const [stop, setStop] = useState(job.stopFrame);
    const [selected, setSelected] = useState<number[]>([]);
    const [runs, setRuns] = useState<Run[]>([]);
    const [runID, setRunID] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [startStage, setStartStage] = useState('');
    const [stageSeconds, setStageSeconds] = useState(0);
    const [pollError, setPollError] = useState('');
    const [error, setError] = useState('');
    const [resultsRevision, setResultsRevision] = useState(0);
    const base = `${getCore().config.backendAPI}/jobs/${job.id}/video-inference`;
    const run = runs.find((item) => item.id === runID) || runs[0];
    const active = runs.some((item) => ['queued', 'running'].includes(item.status));
    const candidates = states.filter((state) => state.objectType === ObjectType.SHAPE &&
        [ShapeType.POLYGON, ShapeType.MASK].includes(state.shapeType) && !state.outside);

    const reportError = (reason: unknown): void => {
        const detail = Axios.isAxiosError(reason) ? reason.response?.data : null;
        if (detail) {
            setError(typeof detail === 'string' ? detail : JSON.stringify(detail));
        } else {
            setError(reason instanceof Error ? reason.message : 'Request failed');
        }
    };

    useEffect(() => {
        setStageSeconds(0);
        if (!startStage) return undefined;
        const started = Date.now();
        const timer = setInterval(() => setStageSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [startStage]);

    useEffect(() => {
        if (!open) return undefined;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async (): Promise<void> => {
            try {
                const response = await Axios.get<Run[]>(base, { timeout: 15000 });
                if (!disposed) {
                    setPollError('');
                    const received = new Set(response.data.map((item) => item.id));
                    setRuns((previous) => [...response.data, ...previous.filter((item) => !received.has(item.id))]);
                }
            } catch (reason) {
                if (!disposed) setPollError('Could not refresh inference progress. Retrying automatically.');
            } finally {
                if (!disposed) timer = setTimeout(refresh, 2500);
            }
        };
        refresh();
        return () => {
            disposed = true;
            clearTimeout(timer);
        };
    }, [open, base]);

    useEffect(() => {
        setSelected([]);
        setStop(Math.min(job.stopFrame, frame + 99));
    }, [frame, job.id]);

    useEffect(() => {
        const openForShape = (event: Event): void => {
            const { detail } = event as CustomEvent<SAM2TrackShapeDetail>;
            if (detail.jobID !== job.id) return;
            dispatch(switchPlay(false));
            setSelected([detail.clientID]);
            setError('');
            setOpen(true);
        };
        window.addEventListener(SAM2_TRACK_SHAPE, openForShape);
        return () => window.removeEventListener(SAM2_TRACK_SHAPE, openForShape);
    }, [job.id]);

    const start = async (): Promise<void> => {
        setBusy(true);
        setError('');
        setStartStage('Saving annotations');
        try {
            await dispatch(saveAnnotationsAsync());
            setStartStage('Reading saved objects');
            const saved = await job.annotations.get(frame, false, []);
            const prompts = saved.filter((state) => selected.includes(state.clientID as number)).map((state) => ({
                kind: 'shape',
                id: state.serverID,
                label_id: state.label.id,
                type: state.shapeType,
                points: state.points,
            }));
            if (prompts.length !== selected.length || !prompts.length) {
                throw new Error('Select the saved objects again before starting inference.');
            }
            setStartStage('Creating inference run');
            const response = await Axios.post<Run>(base, { start_frame: frame, stop_frame: stop, prompts }, {
                timeout: 60000,
            });
            setRunID(response.data.id);
            setRuns((previous) => [response.data, ...previous]);
        } catch (reason) {
            reportError(reason);
        } finally {
            setStartStage('');
            setBusy(false);
        }
    };

    const reloadMasks = async (): Promise<void> => {
        await job.annotations.clear({ reload: true });
        await job.actions.clear();
        await dispatch(fetchAnnotationsAsync());
        setResultsRevision((value) => value + 1);
    };

    const accept = async (): Promise<void> => {
        if (!run) return;
        setBusy(true);
        setError('');
        try {
            if (job.annotations.hasUnsavedChanges()) {
                throw new Error('You have unsaved annotations. Save them and rerun inference before accepting.');
            }
            await Axios.post(`${base}/${run.id}/accept`);
            await reloadMasks();
            setRuns((previous) => previous.map((item) => (
                item.id === run.id ? { ...item, status: 'accepted' } : item
            )));
            notification.success({ message: 'SAM2 results accepted', description: 'Masks are now editable on the canvas.' });
        } catch (reason) {
            reportError(reason);
        } finally {
            setBusy(false);
        }
    };

    const cancel = async (): Promise<void> => {
        if (!run) return;
        setBusy(true);
        try {
            const response = await Axios.delete<Run>(`${base}/${run.id}`);
            setRuns((previous) => previous.map((item) => (item.id === run.id ? response.data : item)));
        } catch (reason) {
            reportError(reason);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Button type='link' onClick={() => { dispatch(switchPlay(false)); setOpen(true); }}>SAM2 Video</Button>
            <Modal
                title='SAM2 video annotation'
                open={open}
                onCancel={() => setOpen(false)}
                maskClosable={false}
                keyboard={false}
                footer={null}
                width={1280}
                className='cvat-sam2-modal'
                style={{ top: 24 }}
                styles={{ body: { maxHeight: 'calc(100dvh - 130px)', overflowY: 'auto' } }}
            >
                <Space direction='vertical' size='middle' style={{ width: '100%' }}>
                    {error && <Alert type='error' message={error} showIcon closable onClose={() => setError('')} />}
                    {pollError && <Alert type='warning' message={pollError} showIcon />}
                    {startStage && (
                        <Alert
                            type={stageSeconds >= 30 ? 'warning' : 'info'}
                            message={`${startStage} · ${stageSeconds}s`}
                            description={stageSeconds >= 30 ?
                                'Still waiting for the server. The inference progress starts once a run is created.' :
                                'Preparing your request. Inference has not started yet.'}
                            showIcon
                        />
                    )}
                    <details className='cvat-sam2-section' open={!run}>
                        <summary role='button' tabIndex={0} onKeyDown={(event) => event.stopPropagation()}>建立推論 · Save and run SAM2</summary>
                        <div className='cvat-sam2-section-body'>
                            <Typography.Paragraph>
                        Draw polygon or mask shapes on a starting frame, select them below, then save and track.
                        Inference continues when this panel is closed.
                        Review independent mask layers before accepting the masks.
                            </Typography.Paragraph>
                            {!candidates.length && (
                                <Alert type='info' message='Draw a polygon or mask in Shape mode on this frame first.' />
                            )}
                            <Checkbox.Group
                                value={selected}
                                onChange={(values) => setSelected(values as number[])}
                                options={candidates.map((state) => ({
                                    value: state.clientID as number,
                                    label: `${state.label.name} #${state.serverID || state.clientID}`,
                                }))}
                            />
                            {open && (
                                <SAM2EndFrame job={job} start={frame} stop={stop} disabled={busy} onChange={setStop} />
                            )}
                            <Space wrap>
                                <Button type='primary' loading={busy} disabled={active || !selected.length || stop <= frame} onClick={start}>
                                    {startStage || 'Save and run SAM2'}
                                </Button>
                            </Space>
                            <Typography.Text type='secondary'>Up to 10 objects and 300 frames per run by default.</Typography.Text>
                        </div>
                    </details>
                    {!!runs.length && (
                        <Select
                            aria-label='SAM2 inference history'
                            style={{ width: '100%' }}
                            value={run?.id}
                            onChange={(id) => setRunID(id)}
                            options={runs.map((item) => ({
                                value: item.id,
                                label: `Frames ${item.start_frame}–${item.stop_frame} · ${item.status}` +
                                    ` · ${item.id.slice(0, 8)}`,
                            }))}
                        />
                    )}
                    {run && (
                        <>
                            <Typography.Text>
                                {`${run.model} · ${runStage(run)}`}
                            </Typography.Text>
                            <Progress percent={run.progress} status={run.status === 'failed' ? 'exception' : undefined} />
                            {run.error && <Alert message={run.error} type='error' />}
                            {['queued', 'running'].includes(run.status) && (
                                <Button disabled={busy} onClick={cancel}>Cancel inference</Button>
                            )}
                            {['ready', 'accepted'].includes(run.status) && (
                                <>
                                    <SAM2MaskReview
                                        key={run.id}
                                        job={job}
                                        base={base}
                                        run={run}
                                        resultsRevision={resultsRevision}
                                        onChanged={reloadMasks}
                                    />
                                    <Space wrap>
                                        <Button type='primary' disabled={run.status === 'accepted'} loading={busy} onClick={accept}>
                                            {run.status === 'accepted' ? 'Accepted' : 'Accept masks'}
                                        </Button>
                                        <Button href={`${base}/${run.id}/export`}>Download inference ZIP</Button>
                                    </Space>
                                    <Typography.Text type='secondary'>
                                        The ZIP is an inference snapshot. To export later manual edits,
                                        use Menu → Export job dataset.
                                        For another pass, correct a standalone shape on the desired frame and run again.
                                    </Typography.Text>
                                </>
                            )}
                        </>
                    )}
                    <details className='cvat-sam2-section'>
                        <summary role='button' tabIndex={0} onKeyDown={(event) => event.stopPropagation()}>結果管理 · Manage SAM2 masks</summary>
                        <div className='cvat-sam2-section-body'>
                            {open && (
                                <SAM2ResultsManager
                                    job={job}
                                    base={base}
                                    revision={resultsRevision}
                                    onChanged={reloadMasks}
                                />
                            )}
                        </div>
                    </details>
                </Space>
            </Modal>
        </>
    );
}
