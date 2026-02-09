// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Objects sidebar: multi-select and bulk label change', () => {
    const taskName = 'multi_select_label_change_task';
    const firstLabel = 'vehicle';
    const secondLabel = 'person';
    const selectedStateClass = 'cvat-objects-sidebar-state-selected-item';
    const serverFiles = ['smallArchive.zip'];
    const rectangleShapes = [
        {
            objectType: 'shape',
            labelName: firstLabel,
            frame: 0,
            type: 'rectangle',
            points: [100, 100, 180, 180],
            occluded: false,
        },
        {
            objectType: 'shape',
            labelName: firstLabel,
            frame: 0,
            type: 'rectangle',
            points: [220, 100, 300, 180],
            occluded: false,
        },
        {
            objectType: 'shape',
            labelName: firstLabel,
            frame: 0,
            type: 'rectangle',
            points: [340, 100, 420, 180],
            occluded: false,
        },
    ];
    let taskID = null;

    const silentGet = (selector, options = {}) => cy.get(selector, { log: false, ...options });
    const getVisibleSidebarStateItem = (stateID) => (
        silentGet(`#cvat-objects-sidebar-state-item-${stateID}`).filter(':visible').first()
    );

    function disableAllureListenersForThisSpec() {
        // Work around allure-cypress serializer overflow for this spec only.
        if (typeof Cypress.removeAllListeners === 'function') {
            Cypress.removeAllListeners('log:added');
            Cypress.removeAllListeners('fail');
        }
    }

    function changeObjectLabel(stateID, labelName) {
        getVisibleSidebarStateItem(stateID).within(() => {
            silentGet('.cvat-objects-sidebar-state-item-label-selector').click({ log: false });
        });

        silentGet('.cvat-objects-sidebar-state-item-label-selector-dropdown')
            .not('.ant-select-dropdown-hidden')
            .find(`.ant-select-item-option[title="${labelName}"]`)
            .first()
            .click({ log: false });
    }

    function checkObjectLabel(stateID, labelName) {
        getVisibleSidebarStateItem(stateID).within(() => {
            silentGet('.cvat-objects-sidebar-state-item-label-selector')
                .should('contain.text', labelName);
        });
    }

    function getVisibleBulkLabelDropdown() {
        return silentGet('.cvat-objects-sidebar-bulk-label-selector-dropdown')
            .not('.ant-select-dropdown-hidden')
            .first();
    }

    function chooseLabelFromVisibleDropdown(labelName) {
        getVisibleBulkLabelDropdown()
            .find(`.ant-select-item-option[title="${labelName}"]`)
            .first()
            .click({ log: false });
    }

    function getSidebarStateIDs() {
        return silentGet('.cvat-objects-sidebar-state-item')
            .should('have.length.at.least', 3)
            .then(($items) => [...$items]
                .filter((item) => item.offsetParent !== null)
                .map((item) => Number(item.id.match(/-(\d+)$/)[1])))
            .then((ids) => [...new Set(ids)].sort((a, b) => a - b))
            .then((ids) => {
                expect(ids.length).to.be.at.least(3);
                return ids;
            });
    }

    function selectSidebarState(stateID, options = {}) {
        getVisibleSidebarStateItem(stateID).then(($item) => {
            const element = $item.get(0);
            const win = element.ownerDocument.defaultView;
            const rect = element.getBoundingClientRect();
            element.dispatchEvent(new win.MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: win,
                clientX: rect.left + Math.min(10, rect.width / 2),
                clientY: rect.top + Math.min(10, rect.height / 2),
                ...options,
            }));
        });
    }

    before(() => {
        disableAllureListenersForThisSpec();
        cy.visit('/auth/login');
        cy.headlessLogin();

        const taskSpec = {
            name: taskName,
            labels: [
                { name: firstLabel, type: 'any', attributes: [] },
                { name: secondLabel, type: 'any', attributes: [] },
            ],
            source_storage: { location: 'local' },
            target_storage: { location: 'local' },
        };
        const dataSpec = {
            server_files: serverFiles,
            image_quality: 70,
            use_zip_chunks: true,
            use_cache: true,
            sorting_method: 'lexicographical',
        };

        cy.headlessCreateTask(taskSpec, dataSpec).then(({ taskID: createdTaskID }) => {
            taskID = createdTaskID;
            cy.openTaskById(taskID);
            cy.getJobIDFromIdx(0).then((jobID) => {
                cy.headlessCreateObjects(rectangleShapes, jobID);
            });
            cy.openJob(0, false);
        });
    });

    after(() => {
        if (taskID !== null) {
            cy.headlessDeleteTask(taskID);
        }
        cy.headlessLogout();
    });

    it('supports Ctrl/Cmd click selection in sidebar and canvas and applies label in bulk', () => {
        silentGet('.cvat_canvas_shape', { timeout: 20000 }).should('have.length', 3);

        getSidebarStateIDs().then(([firstID, secondID, thirdID]) => {
            changeObjectLabel(secondID, secondLabel);
            checkObjectLabel(firstID, firstLabel);
            checkObjectLabel(secondID, secondLabel);
            checkObjectLabel(thirdID, firstLabel);

            // Make source state (2nd click with Ctrl) have a different label than the target one.
            selectSidebarState(secondID);
            selectSidebarState(firstID, { ctrlKey: true });
            getVisibleSidebarStateItem(firstID)
                .should('have.class', selectedStateClass);
            getVisibleSidebarStateItem(secondID)
                .should('have.class', selectedStateClass);
            cy.get('body', { log: false }).trigger('keyup', { key: 'Control' }, { log: false });
            getVisibleBulkLabelDropdown().should('be.visible');

            chooseLabelFromVisibleDropdown(secondLabel);
            checkObjectLabel(firstID, secondLabel);
            checkObjectLabel(secondID, secondLabel);
            checkObjectLabel(thirdID, firstLabel);
            getVisibleSidebarStateItem(firstID)
                .should('not.have.class', selectedStateClass);
            getVisibleSidebarStateItem(secondID)
                .should('not.have.class', selectedStateClass);

            // Same rule for canvas flow: source state is the Ctrl-clicked one.
            silentGet(`#cvat_canvas_shape_${thirdID}`).click({ force: true, log: false });
            silentGet(`#cvat_canvas_shape_${firstID}`).click({ force: true, ctrlKey: true, log: false });
            getVisibleSidebarStateItem(firstID)
                .should('have.class', selectedStateClass);
            getVisibleSidebarStateItem(thirdID)
                .should('have.class', selectedStateClass);
            getVisibleSidebarStateItem(secondID)
                .should('not.have.class', selectedStateClass);
            cy.get('body', { log: false }).trigger('keyup', { key: 'Control' }, { log: false });
            getVisibleBulkLabelDropdown().should('be.visible');

            cy.get('body').click(0, 0, { force: true, log: false });
            getVisibleSidebarStateItem(firstID)
                .should('not.have.class', selectedStateClass);
            getVisibleSidebarStateItem(thirdID)
                .should('not.have.class', selectedStateClass);

            silentGet(`#cvat_canvas_shape_${thirdID}`).click({ force: true, log: false });
            silentGet(`#cvat_canvas_shape_${firstID}`).click({ force: true, ctrlKey: true, log: false });
            getVisibleSidebarStateItem(firstID)
                .should('have.class', selectedStateClass);
            getVisibleSidebarStateItem(thirdID)
                .should('have.class', selectedStateClass);
            cy.get('body', { log: false }).trigger('keyup', { key: 'Control' }, { log: false });
            getVisibleBulkLabelDropdown().should('be.visible');

            chooseLabelFromVisibleDropdown(firstLabel);
            checkObjectLabel(firstID, firstLabel);
            checkObjectLabel(secondID, secondLabel);
            checkObjectLabel(thirdID, firstLabel);
            getVisibleSidebarStateItem(firstID)
                .should('not.have.class', selectedStateClass);
            getVisibleSidebarStateItem(thirdID)
                .should('not.have.class', selectedStateClass);
        });
    });
});
