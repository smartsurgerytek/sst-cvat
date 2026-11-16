// SPDX-License-Identifier: MIT
export const SAM2_TRACK_SHAPE = 'cvat:sam2-track-shape';

export interface SAM2TrackShapeDetail {
    jobID: number;
    clientID: number;
}

export function trackShapeWithSAM2(jobID: number, clientID: number): void {
    window.dispatchEvent(new CustomEvent<SAM2TrackShapeDetail>(SAM2_TRACK_SHAPE, {
        detail: { jobID, clientID },
    }));
}
