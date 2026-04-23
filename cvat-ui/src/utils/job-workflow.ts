// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import { JobStage, JobState } from 'cvat-core-wrapper';

export function getJobStateForStageChange(
    currentStage: JobStage,
    currentState: JobState,
    nextStage: JobStage,
): JobState {
    // Match backend behavior: if stage changes and state is not picked explicitly, state becomes NEW.
    return nextStage === currentStage ? currentState : JobState.NEW;
}
