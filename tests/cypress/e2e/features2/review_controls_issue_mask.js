// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Review controls: issue mask', () => {
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

    beforeEach(() => {
        cy.visit(`/tasks/${taskID}/jobs/${jobID}`);
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
        cy.changeWorkspace('Review');
        cy.get('.cvat-workspace-selector').should('contain', 'Review');
    });

    it('creates an issue from a drawn mask', () => {
        const issueDescription = 'Issue from mask';
        const rectangleIssueDescription = 'Rectangle issue';
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
        cy.get('body').type('m', { force: true });
        cy.get('.cvat-brush-tools-toolbox').should('not.be.visible');
        cy.get('.cvat-issue-mask-control').should('not.have.class', 'cvat-active-canvas-control');

        cy.intercept('POST', '/api/issues?*').as('createIssue');
        cy.get('.cvat-create-issue-dialog').should('be.visible').within(() => {
            cy.get('#issue_description').type(issueDescription);
            cy.get('[type="submit"]').click();
        });
        cy.wait('@createIssue').its('response.statusCode').should('equal', 201);
        cy.get('.cvat-create-issue-dialog').should('not.exist');

        cy.createIssueFromControlButton({
            type: 'rectangle',
            description: rectangleIssueDescription,
            firstX: 450,
            firstY: 120,
            secondX: 520,
            secondY: 200,
        });

        cy.changeWorkspace('Standard');
        cy.get('.cvat-workspace-selector').should('contain', 'Standard');
        cy.contains('[role="tab"]', 'Issues').click();
        cy.get('.cvat-objects-sidebar-issues-list').within(() => {
            cy.contains('.cvat-objects-sidebar-issue-item', issueDescription).should('exist');
            cy.contains('.cvat-objects-sidebar-issue-item', issueDescription)
                .find('.cvat-issues-convert-to-mask-button')
                .should('be.visible')
                .click();
            cy.contains('.cvat-objects-sidebar-issue-item', rectangleIssueDescription)
                .find('.cvat-issues-convert-to-mask-button')
                .should('not.exist');
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

        cy.visit(`/tasks/${taskID}/jobs/${jobID}`);
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
        cy.changeWorkspace('Standard');
        cy.get('.cvat-workspace-selector').should('contain', 'Standard');
        cy.contains('[role="tab"]', 'Objects').click();
        cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
        cy.get('.cvat-objects-sidebar-state-item-object-type-text').first().invoke('text').then((text) => {
            expect(text.toLowerCase()).to.contain('mask');
        });
    });
});
