// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

import { isLikelyRle } from '../../support/utils';

context('Review controls: issue mask (validation + annotation)', () => {
    let taskID = null;
    let jobID = null;
    const taskName = `Review controls: issue mask ${Date.now()}`;

    const taskSpec = {
        name: taskName,
        labels: [{
            name: 'mask label',
            attributes: [],
            type: 'mask',
        }, {
            name: 'mask label 2',
            attributes: [],
            type: 'mask',
        }],
        project_id: null,
        source_storage: { location: 'local' },
        target_storage: { location: 'local' },
    };

    const dataSpec = {
        server_files: ['archive.zip'],
        image_quality: 70,
        use_zip_chunks: true,
        use_cache: true,
        sorting_method: 'lexicographical',
    };

    function openJob() {
        cy.visit(`/tasks/${taskID}/jobs/${jobID}`);
        cy.url().should('match', /\/tasks\/\d+\/jobs\/\d+/);
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
    }

    function setJobStage(stage) {
        cy.visit(`/tasks/${taskID}`);
        cy.get('.cvat-task-details').should('exist');
        cy.setJobStage(jobID, stage);
    }

    function buildMask(width, height, blocks) {
        const mask = new Array(width * height).fill(0);
        blocks.forEach(({
            x, y, w, h,
        }) => {
            for (let yy = y; yy < y + h; yy++) {
                for (let xx = x; xx < x + w; xx++) {
                    mask[yy * width + xx] = 1;
                }
            }
        });
        return mask;
    }

    function mask2Rle(mask) {
        return mask.reduce((acc, val, idx, arr) => {
            if (idx > 0) {
                if (arr[idx - 1] === val) {
                    acc[acc.length - 1] += 1;
                } else {
                    acc.push(1);
                }
                return acc;
            }
            if (val > 0) {
                acc.push(0, 1);
            } else {
                acc.push(1);
            }
            return acc;
        }, []);
    }

    function createMaskIssueViaApi(issueDescription) {
        const width = 10;
        const height = 8;
        const mask = buildMask(width, height, [
            {
                x: 1, y: 1, w: 2, h: 2,
            },
            {
                x: 6, y: 4, w: 2, h: 2,
            },
        ]);
        const rle = mask2Rle(mask);
        const position = [...rle, 0, 0, width - 1, height - 1];
        expect(isLikelyRle(position)).to.equal(true);

        return cy.window().its('cvat').should('not.be.undefined').then(async (cvat) => {
            const response = await cvat.server.request('/api/issues', {
                method: 'POST',
                data: {
                    frame: 0,
                    position,
                    job: jobID,
                    message: issueDescription,
                    is_mask_issue: true,
                },
            });
            expect(response.data.is_mask_issue).to.equal(true);
            expect(isLikelyRle(response.data.position)).to.equal(true);
        });
    }

    function createIssueFromMask(
        issueDescription,
        maskStroke = null,
        returnWorkspace = null,
        options = {},
    ) {
        const {
            verifyLabelTextSelect = false,
            selectedLabelText = 'mask label',
        } = options;
        const strokes = maskStroke || [{
            method: 'brush',
            coordinates: [[300, 300], [320, 320], [340, 300]],
        }, {
            method: 'brush',
            coordinates: [[420, 320], [440, 340], [460, 320]],
        }];

        cy.changeWorkspace('Review');
        cy.get('body').then(($body) => {
            if ($body.find('.cvat-issue-mask-control').length) {
                cy.get('.cvat-issue-mask-control')
                    .should('exist')
                    .and('not.have.class', 'cvat-disabled-canvas-control')
                    .click();
                cy.get('.cvat-issue-mask-control').should('have.class', 'cvat-active-canvas-control');
                cy.get('.cvat-brush-tools-toolbox').should('exist').and('be.visible');

                cy.drawMask(strokes);
                cy.get('.cvat-issue-mask-control').click();
                cy.get('.cvat-brush-tools-toolbox').should('not.be.visible');
                cy.get('.cvat-issue-mask-control').should('not.have.class', 'cvat-active-canvas-control');

                cy.intercept('POST', '/api/issues?*').as('createIssue');
                cy.get('.cvat-create-issue-dialog').should('be.visible');
                if (verifyLabelTextSelect) {
                    cy.get('.cvat-create-issue-dialog').then(($dialog) => {
                        const hasLabelTextSelector = $dialog
                            .find('.cvat-create-issue-dialog-shortcut-selector').length > 0;

                        if (hasLabelTextSelector) {
                            const prefixText = 'Issue ';
                            const suffixText = ' from mask';
                            cy.get('.cvat-create-issue-dialog #issue_description').clear();
                            cy.get('.cvat-create-issue-dialog #issue_description')
                                .type(`${prefixText}${suffixText}`);
                            cy.get('.cvat-create-issue-dialog #issue_description')
                                .then(($input) => {
                                    const input = $input[0];
                                    const cursorPosition = prefixText.length;
                                    input.focus();
                                    input.setSelectionRange(cursorPosition, cursorPosition);
                                });
                            cy.get('.cvat-create-issue-dialog .cvat-create-issue-dialog-shortcut-selector')
                                .click();
                            cy.get('.ant-select-dropdown')
                                .should('exist')
                                .contains('.ant-select-item-option', selectedLabelText)
                                .click();
                            cy.get('.cvat-create-issue-dialog #issue_description')
                                .should('have.value', `${prefixText}${selectedLabelText}${suffixText}`);
                            cy.get('.cvat-create-issue-dialog #issue_description').clear();
                            cy.get('.cvat-create-issue-dialog #issue_description').type(issueDescription);
                        } else {
                            cy.get('.cvat-create-issue-dialog #issue_description').clear();
                            cy.get('.cvat-create-issue-dialog #issue_description').type(issueDescription);
                        }
                    });
                } else {
                    cy.get('.cvat-create-issue-dialog #issue_description').type(issueDescription);
                }
                cy.get('.cvat-create-issue-dialog [type="submit"]').click();
                cy.wait('@createIssue').then((interception) => {
                    expect(interception.response.statusCode).to.equal(201);
                    expect(interception.request.body.is_mask_issue).to.equal(true);
                    expect(isLikelyRle(interception.request.body.position)).to.equal(true);
                    expect(interception.request.body.message).to.equal(issueDescription);
                });
                cy.get('.cvat-create-issue-dialog').should('not.exist');
            } else {
                return createMaskIssueViaApi(issueDescription).then(() => {
                    cy.reload();
                });
            }
            return null;
        });

        if (returnWorkspace) {
            cy.changeWorkspace(returnWorkspace);
        }
    }

    before(() => {
        cy.visit('/auth/login');
        cy.login();

        cy.headlessCreateTask(taskSpec, dataSpec).then((response) => {
            taskID = response.taskID;
            [jobID] = response.jobIDs;
        });
    });

    after(() => {
        if (taskID) {
            cy.headlessDeleteTask(taskID);
        }
    });

    it('validation mode: create issue -> save -> reload and verify issue exists', () => {
        const issueDescription = 'Issue from mask';

        setJobStage('validation');
        openJob();

        createIssueFromMask(
            issueDescription,
            null,
            null,
            {
                verifyLabelTextSelect: true,
                selectedLabelText: 'mask label 2',
            },
        );

        cy.saveJob();
        openJob();
        cy.contains('[role="tab"]', 'Issues').click();
        cy.get('.cvat-objects-sidebar-issues-list')
            .contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .should('exist');
    });

    it('annotation mode: convert to mask -> save -> reload and verify mask exists', () => {
        const issueDescription = 'Issue from mask';

        setJobStage('annotation');
        openJob();
        cy.changeWorkspace('Standard');

        cy.contains('[role="tab"]', 'Issues').click();
        cy.get('.cvat-objects-sidebar-issues-list').then(($list) => {
            const issueExists = $list.find('.cvat-objects-sidebar-issue-item')
                .filter((_, el) => el.textContent && el.textContent.includes(issueDescription)).length > 0;
            if (!issueExists) {
                createIssueFromMask(issueDescription, null, 'Standard');
                cy.contains('[role="tab"]', 'Issues').click();
            }
        });

        cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .invoke('attr', 'id')
            .then((idAttr) => {
                const match = idAttr && idAttr.match(/\d+$/);
                if (!match) {
                    throw new Error(`Invalid issue item id: ${idAttr}`);
                }
                return Number(match[0]);
            })
            .as('issueId');

        cy.contains('.cvat-hidden-issue-label', issueDescription).click();
        cy.get('.cvat-issue-dialog').should('be.visible');
        cy.get('.cvat-issue-dialog-remove-button').should('not.exist');
        cy.intercept('PATCH', '/api/issues/*').as('resolveIssueFromDialog');
        cy.get('.cvat-issue-dialog-footer').contains('button', 'Resolve').click();
        cy.wait('@resolveIssueFromDialog').its('response.statusCode').should('equal', 200);

        cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .find('.cvat-issues-reopen-button')
            .should('be.visible');
        cy.get('@issueId').then((issueId) => {
            cy.get(`#cvat_canvas_issue_region_${issueId}`).should('not.exist');
        });
        cy.contains('.cvat-hidden-issue-label', issueDescription).should('not.exist');

        cy.intercept('PATCH', '/api/issues/*').as('reopenIssueFromList');
        cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .find('.cvat-issues-reopen-button')
            .click();
        cy.wait('@reopenIssueFromList').its('response.statusCode').should('equal', 200);
        cy.get('@issueId').then((issueId) => {
            cy.get(`#cvat_canvas_issue_region_${issueId}`).should('exist').then(($element) => {
                expect($element[0].tagName.toLowerCase()).to.equal('g');
                expect($element.find('polygon').length).to.be.at.least(2);
            });
        });
        cy.contains('.cvat-hidden-issue-label', issueDescription).should('exist');

        cy.contains('.cvat-hidden-issue-label', issueDescription).click();
        cy.get('.cvat-issue-dialog').should('be.visible').then(($dialog) => {
            const hasDialogConvertButton = $dialog.find('.cvat-issue-dialog-convert-to-mask-button').length > 0;
            if (hasDialogConvertButton) {
                cy.get('.cvat-issue-dialog-convert-to-mask-button')
                    .should('be.visible')
                    .click();
            } else {
                cy.get('.cvat-objects-sidebar-issues-list').within(() => {
                    cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
                        .find('.cvat-issues-convert-to-mask-button')
                        .should('be.visible')
                        .click();
                });
            }
        });

        cy.get('.ant-modal').contains('Convert issue to mask');
        cy.get('.ant-modal-footer .ant-btn-primary').should('not.be.disabled').click();

        cy.contains('[role="tab"]', 'Objects').click();
        cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
        cy.get('.cvat-objects-sidebar-state-item-object-type-text').first().invoke('text').then((text) => {
            expect(text.toLowerCase()).to.contain('mask');
        });

        cy.get('.cvat-objects-sidebar-state-item-label-selector').first().click();
        cy.get('.ant-select-dropdown')
            .should('exist')
            .contains('.ant-select-item-option', 'mask label 2')
            .click();
        cy.saveJob();

        openJob();
        cy.contains('[role="tab"]', 'Objects').click();
        cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
        cy.get('.cvat-objects-sidebar-state-item-object-type-text').first().invoke('text').then((text) => {
            expect(text.toLowerCase()).to.contain('mask');
        });
    });
});
