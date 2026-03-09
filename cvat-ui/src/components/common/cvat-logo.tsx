// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { useSelector } from 'react-redux';
import { CombinedState } from 'reducers';

const FALLBACK_LOGO_PATH = '/static/logo.svg';

function CVATLogo(): JSX.Element {
    const src = useSelector(
        (state: CombinedState) => state.about.server.logoURL || FALLBACK_LOGO_PATH,
    );

    return (
        <div className='cvat-logo-icon'>
            <img src={src} alt='iLabel Logo' />
        </div>
    );
}

export default React.memo(CVATLogo);
