// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { JobStage, JobState } from 'cvat-core-wrapper';

export function getJobStateForStageChange(
    currentStage: JobStage,
    currentState: JobState,
    nextStage: JobStage,
): JobState {
    return nextStage === currentStage ? currentState : JobState.NEW;
}
