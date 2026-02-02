// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import Tag from 'antd/lib/tag';
import './environment-badge.scss';

// Read at build time - value is baked into the bundle
const ENV_LABEL = process.env.CVAT_ENV_LABEL || '';

// Environment color mapping
const ENV_COLORS: Record<string, string> = {
    INT: '#ff4136', // Red - testing/development
    STG: '#1890ff', // Blue - staging/production
};

function EnvironmentBadge(): JSX.Element | null {
    if (!ENV_LABEL) {
        return null; // No badge for local dev or unspecified environments
    }

    const label = ENV_LABEL.toUpperCase();
    const color = ENV_COLORS[label] || '#888888';

    return (
        <Tag className='cvat-environment-badge' color={color}>
            {label}
        </Tag>
    );
}

export default React.memo(EnvironmentBadge);
