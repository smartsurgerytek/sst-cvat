// SPDX-License-Identifier: MIT
import React, { useMemo } from 'react';
import { ObjectState } from 'cvat-core-wrapper';
import { decodeMask } from 'utils/sam2-mask-processing';

export default function SeedPreviewOverlay({
    objects, width, height,
}: { objects: ObjectState[]; width: number; height: number }): JSX.Element {
    const shapes = useMemo(() => objects.map((object) => {
        const { points, label, clientID } = object;
        if (!points?.length) return null;
        const color = label.color || '#ffcc00';
        if (object.shapeType === 'mask') {
            const mask = decodeMask(points);
            const canvas = document.createElement('canvas');
            canvas.width = mask.width;
            canvas.height = mask.height;
            const context = canvas.getContext('2d')!;
            const pixels = context.createImageData(mask.width, mask.height);
            mask.pixels.forEach((value, index) => { pixels.data[index * 4 + 3] = value ? 255 : 0; });
            context.putImageData(pixels, 0, 0);
            context.globalCompositeOperation = 'source-in';
            context.fillStyle = color;
            context.fillRect(0, 0, mask.width, mask.height);
            return (
                <image
                    key={clientID}
                    data-object-id={clientID}
                    x={mask.x}
                    y={mask.y}
                    width={mask.width}
                    height={mask.height}
                    href={canvas.toDataURL()}
                    opacity={0.5}
                >
                    <title>{`${label.name} #${object.serverID || clientID}`}</title>
                </image>
            );
        }
        if (object.shapeType === 'polygon') {
            return (
                <polygon
                    key={clientID}
                    data-object-id={clientID}
                    points={points.reduce<string[]>((pairs, value, index) => {
                        if (index % 2 === 0) pairs.push(`${value},${points[index + 1]}`);
                        return pairs;
                    }, []).join(' ')}
                    fill={color}
                    fillOpacity={0.35}
                    stroke={color}
                    strokeWidth={2}
                    vectorEffect='non-scaling-stroke'
                />
            );
        }
        const [left, top, right, bottom] = points;
        return (
            <rect
                key={clientID}
                data-object-id={clientID}
                x={left}
                y={top}
                width={right - left}
                height={bottom - top}
                transform={`rotate(${object.rotation || 0} ${(left + right) / 2} ${(top + bottom) / 2})`}
                fill='none'
                stroke={color}
                strokeWidth={2}
                vectorEffect='non-scaling-stroke'
            />
        );
    }), [objects]);
    return (
        <svg
            aria-label='Selected start-frame objects'
            data-object-count={objects.length}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio='xMidYMid meet'
            style={{
                position: 'absolute', inset: 0, width: '100%', height: 220, pointerEvents: 'none',
            }}
        >
            {shapes}
        </svg>
    );
}
