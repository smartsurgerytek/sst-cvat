// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React, { useState } from 'react';
import { Row, Col } from 'antd/lib/grid';
import { MoreOutlined } from '@ant-design/icons';
import Dropdown from 'antd/lib/dropdown';
import Text from 'antd/lib/typography/Text';
<<<<<<< HEAD
<<<<<<< HEAD
import Checkbox, { CheckboxChangeEvent } from 'antd/lib/checkbox';
=======
>>>>>>> a28b777b0 (MSA-736 : Add Finish Job button in the annotation top bar to save and mark)
=======
import Checkbox, { CheckboxChangeEvent } from 'antd/lib/checkbox';
>>>>>>> 396d2f935 (feat(objects-sidebar): add multi-select bulk label change)

import { ColorBy } from 'reducers';
import CVATTooltip from 'components/common/cvat-tooltip';
import LabelSelector from 'components/label-selector/label-selector';
import { ObjectType, ShapeType } from 'cvat-core-wrapper';
import ItemMenu from './object-item-menu';
import ColorPicker from './color-picker';

interface Props {
    jobInstance: any;
    readonly: boolean;
    clientID: number;
    serverID: number | null;
    labelID: number;
    labels: any[];
    shapeType: ShapeType;
    objectType: ObjectType;
    isGroundTruth: boolean;
    color: string;
    colorBy: ColorBy;
    type: string;
    locked: boolean;
    selected: boolean;
    changeColorShortcut: string;
    copyShortcut: string;
    pasteShortcut: string;
    propagateShortcut: string;
    toBackgroundShortcut: string;
    toForegroundShortcut: string;
    removeShortcut: string;
    sliceShortcut: string;
    runAnnotationsActionShortcut: string;
    changeColor(color: string): void;
    changeLabel(label: any): void;
    copy(): void;
    remove(): void;
    propagate(): void;
    createURL(): void;
    switchOrientation(): void;
    toBackground(): void;
    toForeground(): void;
    resetCuboidPerspective(): void;
    runAnnotationAction(): void;
    edit(): void;
    slice(): void;
    select(event?: React.MouseEvent, forceToggle?: boolean): void;
}

function ItemTopComponent(props: Props): JSX.Element {
    const {
        readonly,
        clientID,
        serverID,
        labelID,
        labels,
        shapeType,
        objectType,
        color,
        colorBy,
        type,
        locked,
        selected,
        changeColorShortcut,
        copyShortcut,
        pasteShortcut,
        propagateShortcut,
        toBackgroundShortcut,
        toForegroundShortcut,
        removeShortcut,
        sliceShortcut,
        runAnnotationsActionShortcut,
        isGroundTruth,
        changeColor,
        changeLabel,
        copy,
        remove,
        propagate,
        createURL,
        switchOrientation,
        toBackground,
        toForeground,
        resetCuboidPerspective,
        runAnnotationAction,
        edit,
        slice,
        jobInstance,
<<<<<<< HEAD
<<<<<<< HEAD
        select,
        onSelect,
=======
>>>>>>> a28b777b0 (MSA-736 : Add Finish Job button in the annotation top bar to save and mark)
=======
        select,
>>>>>>> 396d2f935 (feat(objects-sidebar): add multi-select bulk label change)
    } = props;

    const [colorPickerVisible, setColorPickerVisible] = useState(false);

    const onCheckboxChange = (event: CheckboxChangeEvent): void => {
        event.stopPropagation();
<<<<<<< HEAD
        if (onSelect) {
            onSelect();
            return;
        }
        const nativeEvent = event.nativeEvent as MouseEvent | KeyboardEvent;
        const withSelectionModifier = Boolean(nativeEvent.ctrlKey || nativeEvent.metaKey);
        select(nativeEvent as unknown as React.MouseEvent, withSelectionModifier);
=======
        select(undefined, true);
>>>>>>> 396d2f935 (feat(objects-sidebar): add multi-select bulk label change)
    };

    return (
        <Row align='middle'>
<<<<<<< HEAD
<<<<<<< HEAD
            <Col span={2}>
                <Checkbox
                    checked={selected}
                    disabled={readonly}
                    onChange={onCheckboxChange}
                    onClick={(event): void => event.stopPropagation()}
                    onMouseDown={(event): void => event.stopPropagation()}
                    onMouseUp={(event): void => event.stopPropagation()}
                />
            </Col>
            <Col span={7}>
=======
            <Col span={10}>
>>>>>>> a28b777b0 (MSA-736 : Add Finish Job button in the annotation top bar to save and mark)
=======
            <Col span={2}>
                <Checkbox
                    checked={selected}
                    onChange={onCheckboxChange}
                    onClick={(event): void => event.stopPropagation()}
                />
            </Col>
            <Col span={7}>
>>>>>>> 396d2f935 (feat(objects-sidebar): add multi-select bulk label change)
                <Text style={{ fontSize: 12 }}>{clientID}</Text>
                {isGroundTruth ? <Text style={{ fontSize: 12 }}>&nbsp;GT</Text> : null}
                <br />
                <Text
                    type='secondary'
                    style={{ fontSize: 10 }}
                    className='cvat-objects-sidebar-state-item-object-type-text'
                >
                    {type}
                </Text>
            </Col>
            <Col span={13}>
                <CVATTooltip title='Change current label'>
                    <LabelSelector
                        disabled={locked || readonly || shapeType === ShapeType.SKELETON}
                        size='small'
                        labels={labels}
                        value={labelID}
                        onChange={changeLabel}
                        onClick={(event): void => event.stopPropagation()}
                        onMouseDown={(event): void => event.stopPropagation()}
<<<<<<< HEAD
                        onMouseUp={(event): void => event.stopPropagation()}
=======
>>>>>>> 396d2f935 (feat(objects-sidebar): add multi-select bulk label change)
                        popupClassName='cvat-objects-sidebar-state-item-label-selector-dropdown'
                        className='cvat-objects-sidebar-state-item-label-selector'
                    />
                </CVATTooltip>
            </Col>
            { !isGroundTruth && (
                colorPickerVisible ? (
                    <ColorPicker
                        visible
                        value={color}
                        onVisibleChange={setColorPickerVisible}
                        onChange={(_color: string) => {
                            changeColor(_color);
                        }}
                    >
                        <Col span={2}>
                            <MoreOutlined />
                        </Col>
                    </ColorPicker>
                ) : (
                    <Dropdown
                        destroyPopupOnHide
                        placement='bottomLeft'
                        trigger={['click']}
                        className='cvat-object-item-menu-button'
                        menu={ItemMenu({
                            jobInstance,
                            readonly,
                            locked,
                            serverID,
                            shapeType,
                            objectType,
                            color,
                            colorBy,
                            colorPickerVisible,
                            changeColorShortcut,
                            copyShortcut,
                            pasteShortcut,
                            propagateShortcut,
                            toBackgroundShortcut,
                            toForegroundShortcut,
                            removeShortcut,
                            sliceShortcut,
                            runAnnotationsActionShortcut,
                            changeColor,
                            copy,
                            remove,
                            propagate,
                            createURL,
                            switchOrientation,
                            toBackground,
                            toForeground,
                            resetCuboidPerspective,
                            setColorPickerVisible,
                            edit,
                            slice,
                            runAnnotationAction,
                        })}
                    >
                        <Col span={2}>
                            <MoreOutlined />
                        </Col>
                    </Dropdown>
                )
            )}
        </Row>
    );
}

export default React.memo(ItemTopComponent);
