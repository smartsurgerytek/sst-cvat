// Copyright (C) 2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useEffect, useRef } from 'react';

export default function useDraggable(
    getPosition: () => number[],
    onDrag: (diffX: number, diffY: number) => void,
    component: JSX.Element,
): JSX.Element {
    const ref = useRef<HTMLDivElement>(null);
    const getPositionRef = useRef(getPosition);
    const onDragRef = useRef(onDrag);

    useEffect(() => {
        getPositionRef.current = getPosition;
        onDragRef.current = onDrag;
    }, [getPosition, onDrag]);

    useEffect(() => {
        const element = ref.current;
        if (!element) return () => {};

        const click = [0, 0];
        const position = getPositionRef.current();
        let activePointerID: number | null = null;

        const pointerMoveListener = (event: PointerEvent): void => {
            if (event.pointerId !== activePointerID) {
                return;
            }

            const dy = event.clientY - click[0];
            const dx = event.clientX - click[1];
            onDragRef.current(position[0] + dy, position[1] + dx);
            event.stopPropagation();
            event.preventDefault();
        };

        const finishDrag = (event?: PointerEvent): void => {
            if (activePointerID === null || (event && event.pointerId !== activePointerID)) {
                return;
            }

            if (element.hasPointerCapture(activePointerID)) {
                element.releasePointerCapture(activePointerID);
            }

            window.removeEventListener('pointermove', pointerMoveListener);
            window.removeEventListener('pointerup', finishDrag);
            window.removeEventListener('pointercancel', finishDrag);
            activePointerID = null;
        };

        const pointerDownListener = (event: PointerEvent): void => {
            if (activePointerID !== null) {
                return;
            }

            const [initialTop, initialLeft] = getPositionRef.current();
            position[0] = initialTop;
            position[1] = initialLeft;
            click[0] = event.clientY;
            click[1] = event.clientX;
            activePointerID = event.pointerId;
            element.setPointerCapture(activePointerID);
            window.addEventListener('pointermove', pointerMoveListener);
            window.addEventListener('pointerup', finishDrag);
            window.addEventListener('pointercancel', finishDrag);
            event.stopPropagation();
            event.preventDefault();
        };

        element.addEventListener('pointerdown', pointerDownListener);

        return () => {
            element.removeEventListener('pointerdown', pointerDownListener);
            window.removeEventListener('pointermove', pointerMoveListener);
            window.removeEventListener('pointerup', finishDrag);
            window.removeEventListener('pointercancel', finishDrag);
            if (activePointerID !== null && element.hasPointerCapture(activePointerID)) {
                element.releasePointerCapture(activePointerID);
            }
        };
    }, []);

    return (
        <div ref={ref}>
            {component}
        </div>
    );
}
