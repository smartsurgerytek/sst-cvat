// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

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

    function createIssueFromMask(issueDescription) {
        const maskStroke = [{
            method: 'brush',
            coordinates: [[300, 300], [320, 320], [340, 300]],
        }];

        cy.get('.cvat-issue-mask-control')
            .should('exist')
            .and('not.have.class', 'cvat-disabled-canvas-control')
            .click();
        cy.get('.cvat-issue-mask-control').should('have.class', 'cvat-active-canvas-control');
        cy.get('.cvat-brush-tools-toolbox').should('exist').and('be.visible');

        cy.drawMask(maskStroke);
        cy.get('.cvat-issue-mask-control').click();
        cy.get('.cvat-brush-tools-toolbox').should('not.be.visible');
        cy.get('.cvat-issue-mask-control').should('not.have.class', 'cvat-active-canvas-control');

        cy.intercept('POST', '/api/issues?*').as('createIssue');
        cy.get('.cvat-create-issue-dialog').should('be.visible').within(() => {
            cy.get('#issue_description').type(issueDescription);
            cy.get('[type="submit"]').click();
        });
        cy.wait('@createIssue').its('response.statusCode').should('equal', 201);
        cy.get('.cvat-create-issue-dialog').should('not.exist');
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

        createIssueFromMask(issueDescription);

        cy.saveJob();
        openJob();
        cy.contains('[role="tab"]', 'Issues').click();
        cy.get('.cvat-objects-sidebar-issues-list')
            .contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .should('exist');
    });

    it('annotation mode: convert to mask -> save -> reload and verify mask exists', () => {
        const issueDescription = 'Issue from mask';
        let issueId = null;

        setJobStage('annotation');
        openJob();
        cy.changeWorkspace('Standard');

        cy.contains('[role="tab"]', 'Issues').click();
        cy.get('.cvat-objects-sidebar-issues-list').then(($list) => {
            const issueExists = $list.find('.cvat-objects-sidebar-issue-item')
                .filter((_, el) => el.textContent?.includes(issueDescription)).length > 0;
            if (!issueExists) {
                createIssueFromMask(issueDescription);
                cy.contains('[role="tab"]', 'Issues').click();
            }
        });

        cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .invoke('attr', 'id')
            .then((idAttr) => {
                issueId = Number(idAttr.match(/\d+$/)[0]);
            });

        cy.contains('.cvat-hidden-issue-label', issueDescription).click();
        cy.get('.cvat-issue-dialog').should('be.visible');
        cy.get('.cvat-issue-dialog-remove-button').should('not.exist');
        cy.intercept('PATCH', '/api/issues/*').as('resolveIssueFromDialog');
        cy.get('.cvat-issue-dialog-footer').contains('button', 'Resolve').click();
        cy.wait('@resolveIssueFromDialog').its('response.statusCode').should('equal', 200);

        cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .find('.cvat-issues-reopen-button')
            .should('be.visible');
        cy.then(() => {
            cy.get(`#cvat_canvas_issue_region_${issueId}`).should('not.exist');
        });
        cy.contains('.cvat-hidden-issue-label', issueDescription).should('not.exist');

        cy.intercept('PATCH', '/api/issues/*').as('reopenIssueFromList');
        cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
            .find('.cvat-issues-reopen-button')
            .click();
        cy.wait('@reopenIssueFromList').its('response.statusCode').should('equal', 200);
        cy.then(() => {
            cy.get(`#cvat_canvas_issue_region_${issueId}`).should('exist');
        });
        cy.contains('.cvat-hidden-issue-label', issueDescription).should('exist');

        cy.get('.cvat-objects-sidebar-issues-list').within(() => {
            cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
                .find('.cvat-issues-convert-to-mask-button')
                .should('be.visible')
                .click();
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
