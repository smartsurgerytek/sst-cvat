// Copyright (C) CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

/// <reference types="cypress" />

context('Objects sidebar multi-select and batch label change', { scrollBehavior: false }, () => {
    let taskID = null;
    let createdShapeIDs = [];

    const taskName = `Multi select label change ${Date.now()}`;
    const firstLabelName = 'label 1';
    const secondLabelName = 'label 2';
    const bulkLabelSelectorAnchor = '.cvat-objects-sidebar-bulk-label-selector-anchor';
    const modifierKey = Cypress.platform === 'darwin' ? 'Meta' : 'Control';
    const modifierClickOption = Cypress.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true };

    const taskSpec = {
        name: taskName,
        labels: [{
            name: firstLabelName,
            attributes: [],
            type: 'any',
        }, {
            name: secondLabelName,
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

    const rectangleA = {
        points: 'By 2 Points',
        type: 'Shape',
        labelName: firstLabelName,
        firstX: 250,
        firstY: 350,
        secondX: 350,
        secondY: 450,
    };

    const rectangleB = {
        points: 'By 2 Points',
        type: 'Shape',
        labelName: firstLabelName,
        firstX: 250,
        firstY: 180,
        secondX: 350,
        secondY: 280,
    };

    function sidebarRow(id) {
        return `#cvat-objects-sidebar-state-item-${id}`;
    }

    function canvasShape(id) {
        return `#cvat_canvas_shape_${id}`;
    }

    function sidebarCheckbox(id) {
        return `${sidebarRow(id)} .ant-checkbox-input`;
    }

    function sidebarCheckboxControl(id) {
        return `${sidebarRow(id)} .ant-checkbox`;
    }

    function rowLabelSelector(id) {
        return `${sidebarRow(id)} .cvat-objects-sidebar-state-item-label-selector`;
    }

    function createTwoRectangles() {
        cy.createRectangle(rectangleA);
        cy.createRectangle(rectangleB);
        cy.document().then((doc) => {
            createdShapeIDs = Array.from(
                doc.querySelectorAll('.cvat-objects-sidebar-state-item[id^="cvat-objects-sidebar-state-item-"]'),
            )
                .map((rowElement) => {
                    const matchResult = rowElement.id.match(/\d+$/);
                    return Number(matchResult ? matchResult[0] : NaN);
                })
                .filter((id) => Number.isInteger(id))
                .sort((firstID, secondID) => firstID - secondID)
                .slice(-2);
            expect(createdShapeIDs).to.have.length(2);
        });
        cy.then(() => {
            createdShapeIDs.forEach((id) => {
                cy.get(canvasShape(id)).should('exist').and('be.visible');
            });
        });
    }

    function withCreatedShapeIDs(callback) {
        cy.then(() => {
            expect(createdShapeIDs).to.have.length(2);
            callback(createdShapeIDs);
        });
    }

    function chooseRowLabel(id, labelName) {
        cy.get(rowLabelSelector(id)).click();
        cy.get('.ant-select-dropdown')
            .not('.ant-select-dropdown-hidden')
            .filter(':visible')
            .last()
            .within(() => {
                cy.get(`.ant-select-item-option[title="${labelName}"]`).click();
            });
    }

    function debugSidebarSelectionUI(tag = 'debug') {
        cy.get('.cvat-workspace-selector').invoke('text').then((workspaceText) => {
            Cypress.log({
                name: 'workspace',
                message: `[${tag}] ${workspaceText.trim()}`,
            });
        });

        cy.document().then((doc) => {
            const sidebarRows = Array.from(
                doc.querySelectorAll('.cvat-objects-sidebar-state-item[id^="cvat-objects-sidebar-state-item-"]'),
            );
            const rowIDs = sidebarRows
                .map((rowElement) => rowElement.id)
                .slice(0, 8);
            const checkboxCount = doc.querySelectorAll(
                '.cvat-objects-sidebar-state-item .ant-checkbox-input',
            ).length;

            Cypress.log({
                name: 'sidebar',
                message: `[${tag}] rows=${sidebarRows.length}, checkboxes=${checkboxCount}, ids=${rowIDs.join(', ')}`,
            });
        });
    }

    function triggerModifierKeyUpOnWindow(key = modifierKey) {
        cy.window().then((win) => {
            win.dispatchEvent(new win.KeyboardEvent('keyup', {
                key,
                bubbles: true,
                cancelable: true,
            }));
        });
    }

    before(() => {
        cy.visit('/auth/login');
        cy.login();

        cy.headlessCreateTask(taskSpec, dataSpec).then((response) => {
            taskID = response.taskID;
        });
    });

    after(() => {
        if (taskID) {
            cy.headlessDeleteTask(taskID);
        }
    });

    beforeEach(() => {
        cy.viewport(1920, 1080);
        expect(taskID).to.be.a('number');
        cy.openTaskById(taskID);
        cy.openJob();
        cy.get('.cvat-canvas-container').should('exist').and('be.visible');
        cy.changeWorkspace('Standard');
        cy.get('.cvat-workspace-selector').should('contain.text', 'Standard');
        createTwoRectangles();
        debugSidebarSelectionUI('beforeEach');
    });

    it('does not show floating dropdown for checkbox multi-select and applies batch label via row label selector', () => {
        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            debugSidebarSelectionUI('checkbox-test-start');
            cy.get(sidebarCheckboxControl(firstShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckboxControl(secondShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');

            cy.get(bulkLabelSelectorAnchor).should('not.exist');

            chooseRowLabel(firstShapeID, secondLabelName);

            cy.get(rowLabelSelector(firstShapeID)).should('contain.text', secondLabelName);
            cy.get(rowLabelSelector(secondShapeID)).should('contain.text', secondLabelName);
            cy.get(sidebarCheckbox(firstShapeID)).should('not.be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.be.checked');
            cy.get('.cvat-objects-sidebar-state-multi-selected-item').should('not.exist');
        });
    });

    it('shows floating dropdown only for canvas ctrl/cmd multi-select after modifier release', () => {
        cy.get(bulkLabelSelectorAnchor).should('not.exist');

        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            debugSidebarSelectionUI('canvas-test-start');
            cy.get(canvasShape(firstShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(canvasShape(secondShapeID)).click({ ...modifierClickOption, force: true });

            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');
            cy.get(bulkLabelSelectorAnchor).should('not.exist');
        });

        triggerModifierKeyUpOnWindow();
        cy.get(bulkLabelSelectorAnchor).should('exist');

        cy.get('body').click(10, 10);
        cy.get(bulkLabelSelectorAnchor).should('not.exist');
    });

    it('keeps review workspace behavior unchanged (no checkbox multi-select, no floating batch label dropdown)', () => {
        cy.changeWorkspace('Review');
        cy.get('.cvat-workspace-selector').should('contain.text', 'Review');

        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            cy.get(sidebarCheckbox(firstShapeID)).should('not.exist');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.exist');

            cy.get(canvasShape(firstShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(canvasShape(secondShapeID)).click({ ...modifierClickOption, force: true });
            triggerModifierKeyUpOnWindow();

            cy.get(bulkLabelSelectorAnchor).should('not.exist');
        });
    });
});
