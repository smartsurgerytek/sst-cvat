// Copyright (C) 2021-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Row, Col } from 'antd/lib/grid';
import Checkbox, { CheckboxChangeEvent } from 'antd/lib/checkbox';
import Text from 'antd/lib/typography/Text';
import InputNumber from 'antd/lib/input-number';
import Select from 'antd/lib/select';
import Slider from 'antd/lib/slider';

import {
    switchGrid,
    changeGridColor,
    changeGridOpacity,
    changeGridSize,
} from 'actions/settings-actions';
import { clamp } from 'utils/math';
import { GridColor, CombinedState, PlayerSettingsState } from 'reducers';

const minGridSize = 5;
const maxGridSize = 1000;

export default function ImageSetupsContent(): JSX.Element {
    const dispatch = useDispatch();
    const {
        gridOpacity,
        gridColor,
        gridSize,
        grid: gridEnabled,
    } = useSelector((state: CombinedState): PlayerSettingsState => state.settings.player);

    return (
        <div className='cvat-canvas-image-setups-content'>
            <Text>Image grid</Text>
            <hr />
            <Row justify='space-between' align='middle' gutter={8}>
                <Col span={1} />
                <Col span={6}>
                    <Text className='cvat-text-color'> Size </Text>
                </Col>
                <Col span={8}>
                    <Text className='cvat-text-color'> Color </Text>
                </Col>
                <Col span={8}>
                    <Text className='cvat-text-color'> Opacity </Text>
                </Col>
            </Row>
            <Row justify='space-between' align='middle' gutter={8}>
                <Col span={1}>
                    <Checkbox
                        className='cvat-text-color cvat-image-setups-grid'
                        checked={gridEnabled}
                        onChange={(event: CheckboxChangeEvent): void => {
                            dispatch(switchGrid(event.target.checked));
                        }}
                    />
                </Col>
                <Col span={6} className='cvat-image-setups-grid-size'>
                    <InputNumber
                        className='cvat-image-setups-grid-size-input'
                        min={minGridSize}
                        max={maxGridSize}
                        value={gridSize}
                        disabled={!gridEnabled}
                        onChange={(value: number | undefined | null | string): void => {
                            if (typeof value !== 'undefined' && value !== null) {
                                const converted = Math.floor(clamp(+value, minGridSize, maxGridSize));
                                dispatch(changeGridSize(converted));
                            }
                        }}
                    />
                </Col>
                <Col span={8} className='cvat-image-setups-grid-color'>
                    <Select
                        className='cvat-image-setups-grid-color-input'
                        value={gridColor}
                        disabled={!gridEnabled}
                        onChange={(color: GridColor): void => {
                            dispatch(changeGridColor(color));
                        }}
                    >
                        <Select.Option key='white' value={GridColor.White}>
                            White
                        </Select.Option>
                        <Select.Option key='black' value={GridColor.Black}>
                            Black
                        </Select.Option>
                        <Select.Option key='red' value={GridColor.Red}>
                            Red
                        </Select.Option>
                        <Select.Option key='green' value={GridColor.Green}>
                            Green
                        </Select.Option>
                        <Select.Option key='blue' value={GridColor.Blue}>
                            Blue
                        </Select.Option>
                    </Select>
                </Col>
                <Col span={8} className='cvat-image-setups-grid-opacity'>
                    <Slider
                        className='cvat-image-setups-grid-opacity-input'
                        min={0}
                        max={100}
                        value={gridOpacity}
                        disabled={!gridEnabled}
                        onChange={(value: number | [number, number]): void => {
                            dispatch(changeGridOpacity(value as number));
                        }}
                    />
                </Col>
            </Row>
        </div>
    );
}
