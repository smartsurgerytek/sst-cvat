// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import useHistoryRecords, { UseHistoryRecordsResult } from './use-history-records';
import useHistorySummary, { UseHistorySummaryResult } from './use-history-summary';
import useHistoryTree, { PROJECT_SORT_OPTIONS, UseHistoryTreeResult } from './use-history-tree';

export { PROJECT_SORT_OPTIONS };

interface UseHistoryBrowserResult extends UseHistoryTreeResult, UseHistorySummaryResult, UseHistoryRecordsResult {
}

export default function useHistoryBrowser(): UseHistoryBrowserResult {
    const historyTree = useHistoryTree();
    const historySummary = useHistorySummary(historyTree.selection);
    const historyRecords = useHistoryRecords(historyTree.selection);

    return {
        ...historyTree,
        ...historySummary,
        ...historyRecords,
    };
}
