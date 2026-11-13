// SPDX-License-Identifier: MIT

export interface PhaseTag {
    label_id: number;
    frame: number;
}

export function phaseFrames(
    start: number | null,
    stop: number | null,
    first: number,
    last: number,
    included: number[],
    deleted: Record<number, boolean>,
): number[] {
    if (start === null || stop === null || !Number.isInteger(start) || !Number.isInteger(stop) ||
        start < first || stop > last || start > stop) {
        throw new Error('Enter an inclusive frame range within this job.');
    }
    return included.filter((frame) => frame >= start && frame <= stop && !deleted[frame]);
}

export function planPhaseChange<T extends PhaseTag>(tags: T[], frames: number[], labelID: number): {
    missing: number[];
    existing: T[];
} {
    const selected = new Set(frames);
    const existing = tags.filter((tag) => tag.label_id === labelID && selected.has(tag.frame));
    const occupied = new Set(existing.map((tag) => tag.frame));
    return { existing, missing: frames.filter((frame) => !occupied.has(frame)) };
}

export function phaseRanges(tags: PhaseTag[]): { labelID: number; start: number; stop: number }[] {
    const byLabel = new Map<number, Set<number>>();
    tags.forEach((tag) => {
        if (!byLabel.has(tag.label_id)) byLabel.set(tag.label_id, new Set());
        byLabel.get(tag.label_id)!.add(tag.frame);
    });
    const ranges: { labelID: number; start: number; stop: number }[] = [];
    byLabel.forEach((frames, labelID) => {
        let current: typeof ranges[number] | undefined;
        [...frames].sort((a, b) => a - b).forEach((frame) => {
            if (current && current.stop + 1 === frame) current.stop = frame;
            else {
                current = { labelID, start: frame, stop: frame };
                ranges.push(current);
            }
        });
    });
    return ranges.sort((a, b) => a.start - b.start || a.labelID - b.labelID);
}

export function planPhaseEdit<T extends PhaseTag>(
    tags: T[],
    original: { labelID: number; start: number; stop: number },
    frames: number[],
    labelID: number,
): { removed: T[]; missing: number[] } {
    const selected = new Set(frames);
    const removed = tags.filter((tag) => tag.label_id === original.labelID &&
        tag.frame >= original.start && tag.frame <= original.stop &&
        (tag.label_id !== labelID || !selected.has(tag.frame)));
    const { missing } = planPhaseChange(tags, frames, labelID);
    return { removed, missing };
}
