// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Review controls: raw compare', () => {
    const RAW_COMPARE_LISTENER_KEY = '__cvatRawCompareListener';
    let taskID = null;
    let jobID = null;
    const taskName = `Review controls: raw compare ${Date.now()}`;

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

    afterEach(() => {
        cy.window().then((win) => {
            if (win[RAW_COMPARE_LISTENER_KEY]) {
                win.removeEventListener('cvat.rawCompareToggle', win[RAW_COMPARE_LISTENER_KEY]);
                delete win[RAW_COMPARE_LISTENER_KEY];
            }
        });
    });

    it('toggles and dispatches events', () => {
        cy.window().then((win) => {
            const spy = cy.spy();
            win[RAW_COMPARE_LISTENER_KEY] = spy;
            win.addEventListener('cvat.rawCompareToggle', spy);
            cy.wrap(spy).as('rawCompareToggle');
        });

        cy.get('.cvat-raw-frame-control')
            .should('exist')
            .and('not.have.class', 'cvat-disabled-canvas-control')
            .click();
        cy.get('.cvat-raw-frame-control').should('have.class', 'cvat-active-canvas-control');
        cy.get('@rawCompareToggle').should('have.been.called');
        cy.get('@rawCompareToggle').then((spy) => {
            const event = spy.getCall(spy.callCount - 1).args[0];
            expect(event.detail.active).to.equal(true);
        });

        cy.get('.cvat-raw-frame-control').click();
        cy.get('.cvat-raw-frame-control').should('not.have.class', 'cvat-active-canvas-control');
        cy.get('@rawCompareToggle').then((spy) => {
            const event = spy.getCall(spy.callCount - 1).args[0];
            expect(event.detail.active).to.equal(false);
        });
    });
});
