// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Review controls: finish button', () => {
    let taskID = null;
    let jobID = null;
    const taskName = `Review controls: finish button ${Date.now()}`;

    const taskSpec = {
        name: taskName,
        labels: [{
            name: 'label 1',
            attributes: [],
            type: 'any',
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
        cy.viewport(1920, 1080);
        cy.visit(`/tasks/${taskID}/jobs/${jobID}`);
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
        cy.changeWorkspace('Review');
        cy.get('.cvat-workspace-selector').should('contain', 'Review');
    });

    it('opens confirmation modal and cancels', () => {
        cy.get('.cvat-annotation-header-finish-job-button')
            .should('exist')
            .and('not.be.disabled');
        cy.get('.cvat-annotation-header-finish-job-button').click();
        cy.get('.cvat-modal-content-finish-job')
            .should('exist')
            .and('contain', 'Finish this job?');
        cy.get('.cvat-modal-content-finish-job').within(() => {
            cy.contains('button', 'Finish job').should('exist');
            cy.contains('button', 'Cancel').click();
        });
        cy.get('.cvat-modal-content-finish-job').should('not.exist');
    });
});
