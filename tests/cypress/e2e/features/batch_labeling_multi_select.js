// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Batch labeling via multi-select', () => {
    let taskID = null;
    let jobID = null;

    const labelOne = 'label 1';
    const labelTwo = 'label 2';

    const taskPayload = {
        name: 'Batch labeling via multi-select',
        labels: [{
            name: labelOne,
            attributes: [],
            type: 'any',
        }, {
            name: labelTwo,
            attributes: [],
            type: 'any',
        }],
        project_id: null,
        source_storage: { location: 'local' },
        target_storage: { location: 'local' },
    };

    const dataPayload = {
        server_files: ['archive.zip'],
        image_quality: 70,
        use_zip_chunks: true,
        use_cache: true,
        sorting_method: 'lexicographical',
    };

    before(() => {
        cy.prepareUserSession();
        cy.headlessCreateTask(taskPayload, dataPayload).then((response) => {
            taskID = response.taskID;
            [jobID] = response.jobIDs;

            cy.headlessCreateObjects([{
                objectType: 'shape',
                type: 'rectangle',
                frame: 0,
                points: [200, 100, 350, 250],
                labelName: labelOne,
                occluded: false,
            }, {
                objectType: 'shape',
                type: 'rectangle',
                frame: 0,
                points: [400, 200, 550, 350],
                labelName: labelOne,
                occluded: false,
            }], jobID);
        });
    });

    beforeEach(() => {
        cy.visit(`/tasks/${taskID}/jobs/${jobID}`);
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
    });

    it('Changes labels for multi-selected shapes from the sidebar selection bar', () => {
        cy.get('.cvat-objects-sidebar-states-list .cvat-objects-sidebar-state-item')
            .should('have.length', 2);

        cy.get('#cvat-objects-sidebar-state-item-1')
            .find('.ant-checkbox-input')
            .click({ force: true });
        cy.get('#cvat-objects-sidebar-state-item-2')
            .find('.ant-checkbox-input')
            .click({ force: true });

        cy.get('.cvat-objects-sidebar-selection-bar')
            .should('exist')
            .and('contain', 'Selected: 2');

        cy.get('.cvat-objects-sidebar-selection-label').click();
        cy.get('.ant-select-dropdown')
            .not('.ant-select-dropdown-hidden')
            .last()
            .contains('.ant-select-item-option-content', labelTwo)
            .click();

        cy.get('#cvat-objects-sidebar-state-item-1')
            .find('.cvat-objects-sidebar-state-item-label-selector')
            .should('contain', labelTwo);
        cy.get('#cvat-objects-sidebar-state-item-2')
            .find('.cvat-objects-sidebar-state-item-label-selector')
            .should('contain', labelTwo);

        cy.get('.cvat-objects-sidebar-selection-bar').should('not.exist');
    });

    after(() => {
        if (taskID !== null) {
            cy.headlessDeleteTask(taskID);
        }
        cy.logout();
    });
});
