// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';
import React, { useState, useEffect, useCallback } from 'react';
import { useSelector, useDispatch, shallowEqual } from 'react-redux';

import {
    ActiveControl, CombinedState, NewIssueSource, Workspace,
} from 'reducers';

import { commentIssueAsync, resolveIssueAsync, reopenIssueAsync } from 'actions/review-actions';
import {
    AnnotationConflict, ConflictSeverity, JobStage, ObjectState, QualityConflict, ShapeType,
} from 'cvat-core-wrapper';
import { Canvas, CanvasMode } from 'cvat-canvas-wrapper';
import { highlightConflict, updateActiveControl } from 'actions/annotation-actions';
import openCVWrapper from 'utils/opencv-wrapper/opencv-wrapper';
import CreateIssueDialog from './create-issue-dialog';
import HiddenIssueLabel from './hidden-issue-label';
import IssueDialog from './issue-dialog';
import ConflictLabel from './conflict-label';

interface ConflictMappingElement {
    description: string;
    severity: ConflictSeverity;
    x: number;
    y: number;
    serverID: number;
    conflict: QualityConflict;
}

type IssueRegionPoints = number[] | number[][];
type IssueRegionSet = Record<number, { hidden: boolean; points: IssueRegionPoints }>;
type IssueBounds = { minX: number; minY: number; maxX: number; maxY: number };

const isLikelyRle = (points: number[]): boolean => {
    if (!Array.isArray(points) || points.length < 5) return false;
    const [left, top, right, bottom] = points.slice(-4);
    if (![left, top, right, bottom].every(Number.isFinite)) return false;
    const width = right - left + 1;
    const height = bottom - top + 1;
    if (width <= 0 || height <= 0) return false;
    const rle = points.slice(0, -4);
    if (!rle.length || rle.some((value) => !Number.isFinite(value) || value < 0)) return false;
    const total = rle.reduce((acc, value) => acc + value, 0);
    return Math.abs(total - width * height) < 0.001;
};

const getRleBounds = (points: number[]): IssueBounds | null => {
    if (points.length < 4) return null;
    const [left, top, right, bottom] = points.slice(-4);
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    if (right < left || bottom < top) return null;
    return {
        minX: left,
        minY: top,
        maxX: right,
        maxY: bottom,
    };
};

const boundsToPolygon = (bounds: IssueBounds): number[] => ([
    bounds.minX, bounds.minY,
    bounds.maxX, bounds.minY,
    bounds.maxX, bounds.maxY,
    bounds.minX, bounds.maxY,
]);

const flattenPoints = (points: IssueRegionPoints): number[] => (
    Array.isArray(points[0]) ? (points as number[][]).flat() : (points as number[])
);

const getBoundsFromPoints = (points: IssueRegionPoints): IssueBounds | null => {
    const flat = flattenPoints(points);
    if (!flat.length) return null;
    const xs = flat.filter((_, idx) => idx % 2 === 0);
    const ys = flat.filter((_, idx) => idx % 2 !== 0);
    if (!xs.length || !ys.length) return null;
    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
    };
};

const getMaskContours = async (points: number[]): Promise<number[][] | null> => {
    try {
        const contours = await openCVWrapper.getContoursFromState({
            shapeType: ShapeType.MASK,
            points,
        } as any);
        return contours.length ? contours : null;
    } catch (error) {
        return null;
    }
};

export default function IssueAggregatorComponent(): JSX.Element | null {
    const dispatch = useDispatch();

    const {
        frameIssues,
        issuesHidden,
        issuesResolvedHidden,
        canvasInstance,
        canvasIsReady,
        annotationsZLayer,
        newIssuePosition,
        newIssueSource,
        issueFetching,
        qualityConflicts,
        objectStates,
        showConflicts,
        highlightedConflict,
        activeControl,
        jobStage,
        workspace,
    } = useSelector((state: CombinedState) => ({
        frameIssues: state.review.frameIssues,
        issuesHidden: state.review.issuesHidden,
        issuesResolvedHidden: state.review.issuesResolvedHidden,
        canvasInstance: state.annotation.canvas.instance,
        canvasIsReady: state.annotation.canvas.ready,
        annotationsZLayer: state.annotation.annotations.zLayer.cur,
        newIssuePosition: state.review.newIssue.position,
        newIssueSource: state.review.newIssue.source,
        issueFetching: state.review.fetching.issueId,
        qualityConflicts: state.review.frameConflicts,
        objectStates: state.annotation.annotations.states,
        showConflicts: state.settings.shapes.showGroundTruth,
        highlightedConflict: state.annotation.annotations.highlightedConflict,
        activeControl: state.annotation.canvas.activeControl,
        jobStage: state.annotation.job.instance?.stage,
        workspace: state.annotation.workspace,
    }), shallowEqual);

    const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
    const [geometry, setGeometry] = useState<Canvas['geometry'] | null>(null);
    const [canvasRect, setCanvasRect] = useState<DOMRect | null>(null);
    const highlightedObjectsIDs = highlightedConflict?.annotationConflicts
        ?.map((annotationConflict: AnnotationConflict) => annotationConflict.serverID);

    const canvasReady = canvasInstance instanceof Canvas && canvasIsReady;
    const isReviewWorkspace = workspace === Workspace.REVIEW;
    const isValidationReviewMode = isReviewWorkspace && jobStage === JobStage.VALIDATION;
    const hideResolvedIssuesOnCanvas = !isValidationReviewMode;

    const onEnter = useCallback((conflict: QualityConflict) => {
        if (canvasReady && activeControl === ActiveControl.CURSOR) {
            dispatch(highlightConflict(conflict));
        }
    }, [canvasReady, activeControl]);
    const onLeave = useCallback(() => {
        if (canvasReady && activeControl === ActiveControl.CURSOR) {
            dispatch(highlightConflict(null));
        }
    }, [canvasReady, activeControl]);

    const [conflictMapping, setConflictMapping] = useState<ConflictMappingElement[]>([]);
    const [issueBounds, setIssueBounds] = useState<Record<number, IssueBounds>>({});

    const issueLabels: JSX.Element[] = [];
    const issueDialogs: JSX.Element[] = [];
    const conflictLabels: JSX.Element[] = [];

    const onCreateIssue = useCallback(() => {
        if (canvasReady && canvasInstance.mode() === CanvasMode.SELECT_REGION) {
            canvasInstance.selectRegion(false);
            dispatch(updateActiveControl(ActiveControl.CURSOR));
        }
    }, [canvasReady, canvasInstance]);

    useEffect(() => {
        if (canvasReady) {
            const { geometry: updatedGeometry } = canvasInstance;
            setGeometry(updatedGeometry);

            const canvasElement = window.document.getElementById('cvat_canvas_wrapper');
            if (canvasElement) {
                setCanvasRect(canvasElement.getBoundingClientRect());
            }

            const geometryListener = (): void => {
                setGeometry(canvasInstance.geometry);
            };

            canvasInstance.html().addEventListener('canvas.zoom', geometryListener);
            canvasInstance.html().addEventListener('canvas.fit', geometryListener);
            canvasInstance.html().addEventListener('canvas.reshape', geometryListener);

            return () => {
                canvasInstance.html().removeEventListener('canvas.zoom', geometryListener);
                canvasInstance.html().removeEventListener('canvas.fit', geometryListener);
                canvasInstance.html().removeEventListener('canvas.reshape', geometryListener);
            };
        }

        return () => {};
    }, [canvasReady]);

    useEffect(() => {
        if (!canvasReady) {
            return () => {};
        }

        let canceled = false;

        const buildRegions = async (): Promise<void> => {
            const regions: IssueRegionSet = {};
            const boundsMap: Record<number, IssueBounds> = {};
            const visibleIssues = !issuesHidden ? frameIssues.filter((_issue: any) => (
                (!issuesResolvedHidden || !_issue.resolved) &&
                (!hideResolvedIssuesOnCanvas || !_issue.resolved)
            )) : [];

            for (const issue of visibleIssues) {
                const position = issue.position as number[];
                const isMaskIssue = issue.isMaskIssue === true;
                let displayPoints: IssueRegionPoints | null = null;
                let bounds = null;

                if (isMaskIssue && Array.isArray(position) && isLikelyRle(position)) {
                    bounds = getRleBounds(position);
                    const contours = await getMaskContours(position);
                    if (contours) {
                        displayPoints = contours;
                    } else if (bounds) {
                        displayPoints = boundsToPolygon(bounds);
                    }
                } else {
                    displayPoints = position;
                }

                if (displayPoints?.length) {
                    regions[issue.id] = {
                        points: displayPoints,
                        hidden: issue.resolved,
                    };
                    const computedBounds = bounds ?? getBoundsFromPoints(displayPoints);
                    if (computedBounds) {
                        boundsMap[issue.id] = computedBounds;
                    }
                }
            }

            if (newIssuePosition) {
                const isMaskIssue = newIssueSource === NewIssueSource.ISSUE_MASK;
                let displayPoints: IssueRegionPoints | null = null;
                let bounds = null;
                if (isMaskIssue && Array.isArray(newIssuePosition) && isLikelyRle(newIssuePosition)) {
                    bounds = getRleBounds(newIssuePosition);
                    const contours = await getMaskContours(newIssuePosition);
                    if (contours) {
                        displayPoints = contours;
                    } else if (bounds) {
                        displayPoints = boundsToPolygon(bounds);
                    }
                } else {
                    displayPoints = newIssuePosition;
                }

                if (displayPoints?.length) {
                    regions[0] = {
                        points: displayPoints,
                        hidden: false,
                    };
                    const computedBounds = bounds ?? getBoundsFromPoints(displayPoints);
                    if (computedBounds) {
                        boundsMap[0] = computedBounds;
                    }
                }
            }

            if (canceled) return;
            canvasInstance.setupIssueRegions(regions);
            setIssueBounds(boundsMap);

            if (newIssuePosition) {
                setExpandedIssue(null);
                const element = window.document.getElementById('cvat_canvas_issue_region_0');
                if (element) {
                    element.style.display = 'block';
                }
            }
        };

        void buildRegions();

        return () => {
            canceled = true;
        };
    }, [
        canvasReady,
        canvasInstance,
        frameIssues,
        issuesHidden,
        issuesResolvedHidden,
        hideResolvedIssuesOnCanvas,
        newIssuePosition,
        newIssueSource,
    ]);

    useEffect(() => {
        if (canvasReady && showConflicts && qualityConflicts.length) {
            const updatedConflictMapping = qualityConflicts
                .map((conflict: QualityConflict) => {
                    const mainAnnotationsConflict = conflict.annotationConflicts[0];
                    const state = objectStates.find((_state: ObjectState) => (
                        _state.serverID === mainAnnotationsConflict.serverID &&
                        _state.objectType === mainAnnotationsConflict.type
                    ));

                    if (state && state.zOrder <= annotationsZLayer && !state.hidden) {
                        const points = canvasInstance.setupConflictRegions(state);
                        if (points) {
                            return {
                                description: conflict.description,
                                severity: conflict.severity,
                                x: points[0],
                                y: points[1],
                                serverID: state.serverID,
                                conflict,
                            };
                        }
                    }

                    return null;
                }).filter((element) => element) as ConflictMappingElement[];

            setConflictMapping(updatedConflictMapping);
        } else {
            setConflictMapping([]);
        }
    }, [geometry, objectStates, showConflicts, canvasReady, qualityConflicts, annotationsZLayer]);

    if (!canvasReady || !geometry) {
        return null;
    }

    for (const issue of frameIssues) {
        if (issuesHidden) break;
        const issueResolved = issue.resolved;
        if ((issuesResolvedHidden && issueResolved) || (hideResolvedIssuesOnCanvas && issueResolved)) continue;
        const { id } = issue;
        const bounds = issueBounds[id];
        if (!bounds) continue;
        const offset = 15;
        const minX = bounds.minX + geometry.offset + offset;
        const minY = bounds.minY + geometry.offset + offset;
        const highlight = (): void => {
            const element = window.document.getElementById(`cvat_canvas_issue_region_${id}`);
            if (element) {
                element.style.display = 'block';
            }
        };

        const blur = (): void => {
            if (issueResolved) {
                const element = window.document.getElementById(`cvat_canvas_issue_region_${id}`);
                if (element) {
                    element.style.display = 'none';
                }
            }
        };

        if (expandedIssue === id) {
            issueDialogs.push(
                <IssueDialog
                    key={issue.id}
                    issue={issue}
                    top={minY}
                    left={minX}
                    angle={-geometry.angle}
                    scale={1 / geometry.scale}
                    isFetching={issueFetching !== null}
                    resolved={issueResolved}
                    allowRemoving={isReviewWorkspace}
                    highlight={highlight}
                    blur={blur}
                    clientCoordinates={canvasInstance.translateFromSVG([minX, minY]) as [number, number]}
                    canvasRect={canvasRect}
                    collapse={() => {
                        setExpandedIssue(null);
                    }}
                    resolve={() => {
                        dispatch(resolveIssueAsync(issue.id));
                        setExpandedIssue(null);
                    }}
                    reopen={() => {
                        dispatch(reopenIssueAsync(issue.id));
                    }}
                    comment={(message: string) => {
                        dispatch(commentIssueAsync(issue.id, message));
                    }}
                />,
            );
        } else {
            issueLabels.push(
                <HiddenIssueLabel
                    key={issue.id}
                    issue={issue}
                    top={minY}
                    left={minX}
                    angle={-geometry.angle}
                    scale={1 / geometry.scale}
                    resolved={issueResolved}
                    highlight={highlight}
                    blur={blur}
                    onClick={() => {
                        setExpandedIssue(id);
                    }}
                />,
            );
        }
    }

    const newIssueBounds = issueBounds[0];
    const createLeft = newIssueBounds ? newIssueBounds.maxX + geometry.offset : null;
    const createTop = newIssueBounds ? newIssueBounds.minY + geometry.offset : null;

    for (const conflict of conflictMapping) {
        const isConflictHighlighted = highlightedObjectsIDs?.includes(conflict.serverID) || false;
        conflictLabels.push(
            <ConflictLabel
                key={(Math.random() + 1).toString(36).substring(7)}
                text={conflict.description}
                top={conflict.y}
                left={conflict.x}
                angle={-geometry.angle}
                scale={1 / geometry.scale}
                severity={conflict.severity}
                darken={!isConflictHighlighted}
                conflict={conflict.conflict}
                onEnter={onEnter}
                onLeave={onLeave}
                tooltipVisible={isConflictHighlighted}
            />,
        );
    }

    return (
        <>
            {[NewIssueSource.ISSUE_TOOL, NewIssueSource.ISSUE_MASK].includes(newIssueSource as NewIssueSource) &&
            createLeft !== null && createTop !== null ? (
                <CreateIssueDialog
                    top={createTop}
                    left={createLeft}
                    angle={-geometry.angle}
                    scale={1 / geometry.scale}
                    onCreateIssue={onCreateIssue}
                    canvasRect={canvasRect}
                    clientCoordinates={canvasInstance.translateFromSVG([createLeft, createTop]) as [number, number]}
                />
            ) : null}
            {issueDialogs}
            {issueLabels}
            {conflictLabels}
        </>
    );
}
