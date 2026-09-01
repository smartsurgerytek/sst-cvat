// Copyright (C) 2021-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Row, Col } from 'antd/lib/grid';
import Text from 'antd/lib/typography/Text';
import Slider from 'antd/lib/slider';
import Button from 'antd/lib/button';

import {
    changeBrightnessLevel,
    changeContrastLevel,
    changeSaturationLevel,
    resetImageFilters,
} from 'actions/settings-actions';
import { CombinedState, PlayerSettingsState } from 'reducers';
import GammaFilter from './canvas/views/canvas2d/gamma-filter';

export default function ColorSettingsBlock(): JSX.Element {
    const dispatch = useDispatch();
    const {
        brightnessLevel,
        contrastLevel,
        saturationLevel,
    } = useSelector((state: CombinedState): PlayerSettingsState => state.settings.player);

    return (
        <div className='cvat-color-settings-block'>
            <Row justify='space-around'>
                <Col span={24}>
                    <Row className='cvat-image-setups-brightness'>
                        <Col span={24}>
                            <Text type='secondary'>Brightness</Text>
                        </Col>
                        <Col span={24}>
                            <Slider
                                min={50}
                                max={200}
                                value={brightnessLevel}
                                onChange={(value: number | [number, number]): void => {
                                    dispatch(changeBrightnessLevel(value as number));
                                }}
                            />
                        </Col>
                    </Row>
                    <Row className='cvat-image-setups-contrast'>
                        <Col span={24}>
                            <Text type='secondary'>Contrast</Text>
                        </Col>
                        <Col span={24}>
                            <Slider
                                min={50}
                                max={200}
                                value={contrastLevel}
                                onChange={(value: number | [number, number]): void => {
                                    dispatch(changeContrastLevel(value as number));
                                }}
                            />
                        </Col>
                    </Row>
                    <Row className='cvat-image-setups-saturation'>
                        <Col span={24}>
                            <Text type='secondary'>Saturation</Text>
                        </Col>
                        <Col span={24}>
                            <Slider
                                min={0}
                                max={300}
                                value={saturationLevel}
                                onChange={(value: number | [number, number]): void => {
                                    dispatch(changeSaturationLevel(value as number));
                                }}
                            />
                        </Col>
                    </Row>
                </Col>
            </Row>
            <GammaFilter />
            <Row className='cvat-image-setups-reset-color-settings' justify='center' style={{ marginTop: 8 }}>
                <Col>
                    <Button
                        className='cvat-image-setups-reset-color-settings-button'
                        size='small'
                        onClick={() => {
                            const defaultValue = 100;
                            dispatch(changeBrightnessLevel(defaultValue));
                            dispatch(changeContrastLevel(defaultValue));
                            dispatch(changeSaturationLevel(defaultValue));
                            dispatch(resetImageFilters());
                        }}
                    >
                        Reset color settings
                    </Button>
                </Col>
            </Row>
        </div>
    );
}
