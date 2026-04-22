// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import './styles.scss';

import React from 'react';
import Text from 'antd/lib/typography/Text';
import Title from 'antd/lib/typography/Title';
import { Row, Col } from 'antd/lib/grid';

import GoBackButton from 'components/common/go-back-button';

import HistoryRightPanel from './history-right-panel';
import HistoryTreePanel from './history-tree';
import useHistoryBrowser, { PROJECT_SORT_OPTIONS } from './use-history-browser';

function HistoryPage(): JSX.Element {
    const {
        treeData,
        treeLoading,
        expandedKeys,
        selectedKeys,
        selection,
        projectSearchInput,
        projectSort,
        normalizedProjectSearch,
        summaryLoading,
        summaryJobs,
        summaryPage,
        summaryPageSize,
        summaryTotal,
        jobDetailsLoading,
        selectedJob,
        historyDateRangeLabel,
        historyDateRange,
        historyLoading,
        paginatedHistoryRows,
        historyPage,
        historyPageSize,
        historyPaginationTotal,
        handleProjectSearchInputChange,
        handleProjectSearch,
        handleProjectSortChange,
        handleTreeExpand,
        handleTreeSelect,
        handleToggleStandaloneRoot,
        handleTreeLoadData,
        handleSelectionBack,
        handleSummaryChange,
        handleSelectSummaryJob,
        handleHistoryDateRangeChange,
        handleResetHistoryDateRange,
        handleSetAllTime,
        handleHistoryChange,
    } = useHistoryBrowser();

    return (
        <div className='cvat-history-page'>
            <div className='cvat-history-wrapper'>
                <Row justify='center'>
                    <Col span={22} xl={20} className='cvat-task-top-bar'>
                        <GoBackButton />
                    </Col>
                </Row>
                <Row justify='center' className='cvat-history-inner-wrapper'>
                    <Col span={22} xl={20} className='cvat-history-inner'>
                        <div className='cvat-history-header'>
                            <Title level={3}>History</Title>
                            <Text type='secondary'>
                                Browse projects and standalone tasks, drill into jobs, and inspect assignee, stage,
                                and state changes.
                            </Text>
                        </div>
                        <Row gutter={16} className='cvat-history-content'>
                            <Col xs={24} lg={7}>
                                <HistoryTreePanel
                                    treeData={treeData}
                                    treeLoading={treeLoading}
                                    expandedKeys={expandedKeys}
                                    selectedKeys={selectedKeys}
                                    projectSearchInput={projectSearchInput}
                                    projectSort={projectSort}
                                    normalizedProjectSearch={normalizedProjectSearch}
                                    projectSortOptions={PROJECT_SORT_OPTIONS}
                                    onProjectSearchInputChange={handleProjectSearchInputChange}
                                    onProjectSearch={handleProjectSearch}
                                    onProjectSortChange={handleProjectSortChange}
                                    onToggleStandaloneRoot={handleToggleStandaloneRoot}
                                    onLoadData={handleTreeLoadData}
                                    onExpand={handleTreeExpand}
                                    onSelect={handleTreeSelect}
                                />
                            </Col>
                            <Col xs={24} lg={17}>
                                <HistoryRightPanel
                                    selection={selection}
                                    onNavigateBack={handleSelectionBack}
                                    summaryLoading={summaryLoading}
                                    summaryJobs={summaryJobs}
                                    summaryPage={summaryPage}
                                    summaryPageSize={summaryPageSize}
                                    summaryTotal={summaryTotal}
                                    onSummaryChange={handleSummaryChange}
                                    onSelectSummaryJob={handleSelectSummaryJob}
                                    jobDetailsLoading={jobDetailsLoading}
                                    selectedJob={selectedJob}
                                    historyDateRangeLabel={historyDateRangeLabel}
                                    historyDateRange={historyDateRange}
                                    onHistoryDateRangeChange={handleHistoryDateRangeChange}
                                    onResetHistoryDateRange={handleResetHistoryDateRange}
                                    onSetAllTime={handleSetAllTime}
                                    historyLoading={historyLoading}
                                    historyRows={paginatedHistoryRows}
                                    historyPage={historyPage}
                                    historyPageSize={historyPageSize}
                                    historyPaginationTotal={historyPaginationTotal}
                                    onHistoryChange={handleHistoryChange}
                                />
                            </Col>
                        </Row>
                    </Col>
                </Row>
            </div>
        </div>
    );
}

export default React.memo(HistoryPage);
