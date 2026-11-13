// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import Modal from 'antd/lib/modal';
import Select from 'antd/lib/select';
import Space from 'antd/lib/space';
import Typography from 'antd/lib/typography';
import Tabs from 'antd/lib/tabs';
import { Job, LabelType, Source } from 'cvat-core-wrapper';
import { CombinedState } from 'reducers';
import {
    changeFrameAsync, fetchAnnotationsAsync, saveAnnotationsAsync, switchPlay,
} from 'actions/annotation-actions';
import {
    phaseFrames, phaseRanges, planPhaseChange, planPhaseEdit,
} from 'utils/phase-annotations';
import VideoRangeSelector from './video-range-selector';
import PhaseResultsManager, { PhaseRange } from './phase-results-manager';

interface Props {
    job: Job;
    visible?: boolean;
    onVisibleChange?: (visible: boolean) => void;
}

export default function VideoPhase({ job, visible, onVisibleChange }: Props): JSX.Element {
    const dispatch = useDispatch();
    const frame = useSelector((state: CombinedState) => state.annotation.player.frame.number);
    const labels = useSelector((state: CombinedState) => state.annotation.job.labels);
    const meta = useSelector((state: CombinedState) => state.annotation.job.meta);
    const included = useSelector((state: CombinedState) => state.annotation.job.frameNumbers);
    const phaseLabels = labels.filter((label) => label.type === LabelType.TAG);
    const [internalOpen, setInternalOpen] = useState(false);
    const open = visible ?? internalOpen;
    const setOpen = onVisibleChange ?? setInternalOpen;
    const [activeTab, setActiveTab] = useState('annotate');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [labelID, setLabelID] = useState<number>();
    const [start, setStart] = useState(frame);
    const [stop, setStop] = useState(frame);
    const [ranges, setRanges] = useState<ReturnType<typeof phaseRanges>>([]);

    const refresh = async (): Promise<void> => {
        const { tags } = await job.annotations.export();
        setRanges(phaseRanges(tags.filter((tag) => phaseLabels.some((label) => label.id === tag.label_id))));
    };

    useEffect(() => {
        if (open) {
            dispatch(switchPlay(false));
            setStart(frame);
            setStop(frame);
            setLabelID(phaseLabels[0]?.id);
            setError('');
            setMessage('');
        }
    }, [open]);

    useEffect(() => {
        if (open) refresh().catch((reason) => setError(String(reason)));
    }, [open, job]);

    const reload = async (): Promise<void> => {
        setBusy(true);
        setError('');
        try { await refresh(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
    };

    const removeRange = async (range: PhaseRange): Promise<void> => {
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const { tags } = await job.annotations.export();
            const selected = tags.filter((tag) => tag.label_id === range.labelID &&
                tag.frame >= range.start && tag.frame <= range.stop);
            if (selected.length) {
                await job.annotations.commit(
                    { tags: [], shapes: [], tracks: [] },
                    { tags: selected, shapes: [], tracks: [] },
                    frame,
                );
                await dispatch(fetchAnnotationsAsync());
            }
            await refresh();
            setMessage(`Removed ${selected.length} frame tags. Use Undo to restore them and Save to persist changes.`);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally { setBusy(false); }
    };

    const editRange = async (original: PhaseRange, updated: PhaseRange): Promise<boolean> => {
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const label = phaseLabels.find((item) => item.id === updated.labelID);
            if (!label) throw new Error('Select a phase label.');
            const frames = phaseFrames(
                updated.start, updated.stop, job.startFrame, job.stopFrame, included, meta?.deletedFrames || {},
            );
            if (!frames.length) throw new Error('There are no available frames in this range.');
            const { tags } = await job.annotations.export();
            const { removed, missing } = planPhaseEdit(tags, original, frames, updated.labelID);
            const added = missing.map((number) => ({
                label_id: updated.labelID,
                frame: number,
                group: 0,
                source: Source.MANUAL,
                attributes: label.attributes.map((attribute) => ({
                    spec_id: attribute.id as number,
                    value: attribute.defaultValue,
                })),
            }));
            if (removed.length || added.length) {
                await job.annotations.commit(
                    { tags: added, shapes: [], tracks: [] },
                    { tags: removed, shapes: [], tracks: [] },
                    frame,
                );
                await dispatch(fetchAnnotationsAsync());
            }
            await refresh();
            setMessage('Range updated. Use Undo to restore it and Save to persist changes.');
            return true;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            return false;
        } finally { setBusy(false); }
    };

    const apply = async (remove: boolean): Promise<void> => {
        let saving = false;
        setBusy(true);
        setError('');
        setMessage('');
        try {
            const label = phaseLabels.find((item) => item.id === labelID);
            if (!label || label.id === undefined) throw new Error('Select a phase label.');
            const selectedLabelID = label.id;
            const frames = phaseFrames(start, stop, job.startFrame, job.stopFrame, included, meta?.deletedFrames || {});
            if (!frames.length) throw new Error('No available frames in this range.');
            const { tags } = await job.annotations.export();
            const { missing, existing } = planPhaseChange(tags, frames, selectedLabelID);
            const added = remove ? [] : missing.map((number) => ({
                label_id: selectedLabelID,
                frame: number,
                group: 0,
                source: Source.MANUAL,
                attributes: label.attributes.map((attribute) => ({
                    spec_id: attribute.id as number,
                    value: attribute.defaultValue,
                })),
            }));
            await job.annotations.commit(
                { tags: added, shapes: [], tracks: [] },
                { tags: remove ? existing : [], shapes: [], tracks: [] },
                frame,
            );
            await dispatch(fetchAnnotationsAsync());
            await refresh();
            if (!remove) {
                saving = true;
                await dispatch(saveAnnotationsAsync());
                saving = false;
                await refresh();
            }
            setMessage(remove ?
                `Removed ${existing.length} frame tags. Save to persist changes.` :
                `Added ${added.length} frame tags and saved automatically.`);
        } catch (reason) {
            const detail = reason instanceof Error ? reason.message : String(reason);
            setError(saving ?
                `Automatic save failed. Changes remain in this session. Click Add range to retry: ${detail}` : detail);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            {visible === undefined && (
                <Button
                    type='link'
                    onClick={() => setOpen(true)}
                >
                    Phase
                </Button>
            )}
            <Modal
                title='Phase · Video phase annotation'
                open={open}
                footer={null}
                width={activeTab === 'manage' ? 960 : 760}
                maskClosable={false}
                closable={!busy}
                keyboard={!busy}
                onCancel={() => setOpen(false)}
            >
                <Space direction='vertical' style={{ width: '100%' }}>
                    <Typography.Paragraph>
                        Select a phase and an inclusive frame range. Each frame is stored as a tag that supports
                        undo and dataset export.
                        Phases can overlap. Use Manage ranges to edit phase labels and endpoints.
                    </Typography.Paragraph>
                    {!phaseLabels.length && (
                        <Alert
                            type='info'
                            showIcon
                            message='Add a Tag label to the project or task, then reopen the job.'
                        />
                    )}
                    {error && <Alert type='error' message={error} showIcon />}
                    {message && <Alert type='success' message={message} showIcon />}
                    <Tabs
                        activeKey={activeTab}
                        onChange={setActiveTab}
                        items={[
                            { key: 'annotate', label: 'Annotate range', disabled: busy },
                            { key: 'manage', label: `Manage ranges (${ranges.length})`, disabled: busy },
                        ]}
                    />
                    {activeTab === 'annotate' && (
                        <>
                            <Select
                                aria-label='Phase label'
                                placeholder='Select a phase'
                                style={{ width: '100%' }}
                                value={labelID}
                                onChange={setLabelID}
                                disabled={busy}
                                options={phaseLabels.map((label) => ({ value: label.id, label: label.name }))}
                            />
                            {open && (
                                <VideoRangeSelector
                                    job={job}
                                    onEndFrameCommit={(number) => { dispatch(changeFrameAsync(number)); }}
                                    value={[start, stop]}
                                    disabled={busy}
                                    onChange={([first, last]) => { setStart(first); setStop(last); }}
                                />
                            )}
                            <Space>
                                <Button type='primary' loading={busy} disabled={labelID === undefined} onClick={() => apply(false)}>
                                    Add range
                                </Button>
                                <Button danger disabled={busy || labelID === undefined} onClick={() => apply(true)}>
                                    Remove phase from range
                                </Button>
                            </Space>
                        </>
                    )}
                    <Typography.Text type='secondary'>Adding a range automatically saves the current job annotations. Duplicates and deleted frames are skipped. Save after editing or removing ranges.</Typography.Text>
                    {activeTab === 'manage' && (
                        <PhaseResultsManager
                            ranges={ranges}
                            labels={phaseLabels}
                            frame={frame}
                            busy={busy}
                            firstFrame={job.startFrame}
                            lastFrame={job.stopFrame}
                            onEdit={editRange}
                            onRefresh={reload}
                            onSelect={(range) => {
                                setLabelID(range.labelID);
                                setStart(range.start);
                                setStop(range.stop);
                                setActiveTab('annotate');
                            }}
                            onNavigate={(number) => {
                                setOpen(false);
                                dispatch(changeFrameAsync(number));
                            }}
                            onRemove={removeRange}
                        />
                    )}
                </Space>
            </Modal>
        </>
    );
}
