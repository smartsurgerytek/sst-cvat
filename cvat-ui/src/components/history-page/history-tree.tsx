// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import Card from 'antd/lib/card';
import Tree from 'antd/lib/tree';
import Empty from 'antd/lib/empty';
import Spin from 'antd/lib/spin';
import Input from 'antd/lib/input';
import Select from 'antd/lib/select';

import { HistoryTreeNode } from './history-utils';

interface ProjectSortOption {
    value: string;
    label: string;
}

interface HistoryTreePanelProps {
    treeData: HistoryTreeNode[];
    treeLoading: boolean;
    expandedKeys: string[];
    selectedKeys: string[];
    projectSearchInput: string;
    projectSort: string;
    normalizedProjectSearch: string;
    projectSortOptions: ProjectSortOption[];
    onProjectSearchInputChange: (value: string) => void;
    onProjectSearch: (value: string) => void;
    onProjectSortChange: (value: string) => void;
    onToggleStandaloneRoot: (node: HistoryTreeNode) => void;
    onLoadData: (node: HistoryTreeNode) => Promise<void>;
    onExpand: (keys: string[], node: HistoryTreeNode) => void;
    onSelect: (keys: string[], node: HistoryTreeNode) => void;
}

function HistoryTreePanel(props: HistoryTreePanelProps): JSX.Element {
    const {
        treeData,
        treeLoading,
        expandedKeys,
        selectedKeys,
        projectSearchInput,
        projectSort,
        normalizedProjectSearch,
        projectSortOptions,
        onProjectSearchInputChange,
        onProjectSearch,
        onProjectSortChange,
        onToggleStandaloneRoot,
        onLoadData,
        onExpand,
        onSelect,
    } = props;

    return (
        <Card title='Projects & standalone tasks' className='cvat-history-card'>
            <div className='cvat-history-tree-toolbar'>
                <Input.Search
                    allowClear
                    enterButton
                    value={projectSearchInput}
                    onChange={(event) => {
                        const { value } = event.target;
                        onProjectSearchInputChange(value);
                    }}
                    onSearch={(value) => {
                        onProjectSearchInputChange(value);
                        onProjectSearch(value.trim());
                    }}
                    placeholder='Search project name'
                />
                <Select
                    value={projectSort}
                    onChange={(value: string) => onProjectSortChange(value)}
                    className='cvat-history-tree-sort'
                >
                    {projectSortOptions.map((option) => (
                        <Select.Option key={option.value} value={option.value}>
                            {option.label}
                        </Select.Option>
                    ))}
                </Select>
            </div>
            <Spin spinning={treeLoading}>
                {treeData.length ? (
                    <Tree
                        blockNode
                        className='cvat-history-tree'
                        treeData={treeData}
                        expandedKeys={expandedKeys}
                        selectedKeys={selectedKeys}
                        titleRender={(nodeData) => {
                            const historyNode = nodeData as HistoryTreeNode;

                            if (historyNode.nodeType === 'standalone-root') {
                                // This is a UI-only root. Expand/collapse it without selecting it.
                                const isExpanded = expandedKeys.includes(historyNode.key);
                                return (
                                    <span
                                        role='button'
                                        tabIndex={0}
                                        aria-expanded={isExpanded}
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            onToggleStandaloneRoot(historyNode);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                onToggleStandaloneRoot(historyNode);
                                            }
                                        }}
                                    >
                                        {historyNode.title}
                                    </span>
                                );
                            }

                            return historyNode.title;
                        }}
                        loadData={(node) => {
                            const historyNode = node as HistoryTreeNode;
                            return historyNode.nodeType === 'load-more' ?
                                Promise.resolve() :
                                onLoadData(historyNode);
                        }}
                        onExpand={(keys, info) => {
                            onExpand(keys as string[], info.node as HistoryTreeNode);
                        }}
                        onSelect={(keys, info) => {
                            onSelect(keys as string[], info.node as HistoryTreeNode);
                        }}
                    />
                ) : (
                    <Empty
                        description={
                            normalizedProjectSearch ?
                                'No matching projects' :
                                'No projects or standalone tasks available'
                        }
                    />
                )}
            </Spin>
        </Card>
    );
}

export default React.memo(HistoryTreePanel);
