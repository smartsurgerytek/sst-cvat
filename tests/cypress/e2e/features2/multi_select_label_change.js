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

    const rectangleC = {
        points: 'By 2 Points',
        type: 'Shape',
        labelName: firstLabelName,
        firstX: 420,
        firstY: 180,
        secondX: 520,
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

    function collectLatestShapeIDs(count) {
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
                .slice(-count);
            expect(createdShapeIDs).to.have.length(count);
        });
    }

    function createTwoRectangles() {
        cy.createRectangle(rectangleA);
        cy.createRectangle(rectangleB);
        collectLatestShapeIDs(2);
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

    function triggerModifierKeyUpOnWindow(key = modifierKey) {
        cy.window().then((win) => {
            win.dispatchEvent(new win.KeyboardEvent('keyup', {
                key,
                bubbles: true,
                cancelable: true,
            }));
        });
    }

    function triggerModifierKeyDownOnWindow(key = modifierKey) {
        cy.window().then((win) => {
            win.dispatchEvent(new win.KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                repeat: false,
            }));
        });
    }

    function assertNoMultiSelectionUI() {
        cy.get('.cvat-objects-sidebar-state-multi-selected-item').should('not.exist');
        cy.get(bulkLabelSelectorAnchor).should('not.exist');
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
    });

    it('does not show floating dropdown for checkbox multi-select and applies batch label via row label selector', () => {
        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            cy.get(sidebarCheckboxControl(firstShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckboxControl(secondShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');
            cy.get(sidebarRow(firstShapeID)).trigger('mouseenter');
            cy.get(sidebarRow(firstShapeID)).should('have.class', 'cvat-objects-sidebar-state-active-item');

            cy.get(bulkLabelSelectorAnchor).should('not.exist');

            chooseRowLabel(firstShapeID, secondLabelName);

            cy.get(rowLabelSelector(firstShapeID)).should('contain.text', secondLabelName);
            cy.get(rowLabelSelector(secondShapeID)).should('contain.text', secondLabelName);
            cy.get(sidebarRow(firstShapeID)).should('have.class', 'cvat-objects-sidebar-state-active-item');
            cy.get(sidebarCheckbox(firstShapeID)).should('not.be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.be.checked');
            cy.get('.cvat-objects-sidebar-state-multi-selected-item').should('not.exist');
        });
    });

    it('keeps existing multi-selection when changing label on an unselected row', () => {
        cy.createRectangle(rectangleC);
        collectLatestShapeIDs(3);

        cy.then(() => {
            const [firstShapeID, secondShapeID, thirdShapeID] = createdShapeIDs;

            cy.get(sidebarCheckboxControl(firstShapeID)).click({ force: true });
            cy.get(sidebarCheckboxControl(secondShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(thirdShapeID)).should('not.be.checked');

            chooseRowLabel(thirdShapeID, secondLabelName);

            cy.get(rowLabelSelector(thirdShapeID)).should('contain.text', secondLabelName);
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(thirdShapeID)).should('not.be.checked');
        });
    });

    it('clears checkbox multi-selection when ctrl/cmd is pressed again', () => {
        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            cy.get(sidebarCheckboxControl(firstShapeID)).click({ force: true });
            cy.get(sidebarCheckboxControl(secondShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');

            triggerModifierKeyDownOnWindow();

            cy.get(sidebarCheckbox(firstShapeID)).should('not.be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.be.checked');
            assertNoMultiSelectionUI();
        });
    });

    it('shows floating dropdown only for canvas ctrl/cmd multi-select after modifier release', () => {
        cy.get(bulkLabelSelectorAnchor).should('not.exist');

        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
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

    it('closes floating dropdown when window loses focus', () => {
        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            cy.get(canvasShape(firstShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(canvasShape(secondShapeID)).click({ ...modifierClickOption, force: true });
        });

        triggerModifierKeyUpOnWindow();
        cy.get(bulkLabelSelectorAnchor).should('exist');

        cy.window().then((win) => {
            win.dispatchEvent(new win.Event('blur'));
        });

        cy.get(bulkLabelSelectorAnchor).should('not.exist');
    });

    it('clears existing canvas multi-selection when ctrl/cmd is pressed again', () => {
        cy.get(bulkLabelSelectorAnchor).should('not.exist');
        cy.createRectangle(rectangleC);
        collectLatestShapeIDs(3);

        cy.then(() => {
            const [firstShapeID, secondShapeID, thirdShapeID] = createdShapeIDs;

            cy.get(canvasShape(firstShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(canvasShape(secondShapeID)).click({ ...modifierClickOption, force: true });
            triggerModifierKeyUpOnWindow();

            cy.get(bulkLabelSelectorAnchor).should('exist');
            cy.get('body').click(10, 10);
            cy.get(bulkLabelSelectorAnchor).should('not.exist');

            triggerModifierKeyDownOnWindow();
            cy.get(sidebarCheckbox(firstShapeID)).should('not.be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.be.checked');
            cy.get(sidebarCheckbox(thirdShapeID)).should('not.be.checked');
            cy.get('.cvat-objects-sidebar-state-multi-selected-item').should('not.exist');
            cy.get(bulkLabelSelectorAnchor).should('not.exist');
        });
    });

    it('clears single canvas ctrl/cmd selection when modifier key is pressed again', () => {
        cy.get(bulkLabelSelectorAnchor).should('not.exist');

        withCreatedShapeIDs(([firstShapeID]) => {
            cy.get(canvasShape(firstShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(bulkLabelSelectorAnchor).should('not.exist');
        });

        triggerModifierKeyDownOnWindow();

        withCreatedShapeIDs(([firstShapeID]) => {
            cy.get(sidebarCheckbox(firstShapeID)).should('not.be.checked');
        });
        cy.get('.cvat-objects-sidebar-state-multi-selected-item').should('not.exist');
        cy.get(bulkLabelSelectorAnchor).should('not.exist');
    });

    it('shows floating dropdown when ctrl/cmd deselection leaves exactly two selected canvas objects', () => {
        cy.get(bulkLabelSelectorAnchor).should('not.exist');
        cy.createRectangle(rectangleC);
        collectLatestShapeIDs(3);

        cy.then(() => {
            const [firstShapeID, secondShapeID, thirdShapeID] = createdShapeIDs;

            cy.get(canvasShape(firstShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(canvasShape(secondShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(canvasShape(thirdShapeID)).click({ ...modifierClickOption, force: true });

            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(thirdShapeID)).should('be.checked');
            cy.get(bulkLabelSelectorAnchor).should('not.exist');

            cy.get(canvasShape(thirdShapeID)).click({ ...modifierClickOption, force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(thirdShapeID)).should('not.be.checked');
            cy.get(bulkLabelSelectorAnchor).should('not.exist');
        });

        triggerModifierKeyUpOnWindow();
        cy.get(bulkLabelSelectorAnchor).should('exist');

        cy.get('body').click(10, 10);
        cy.get(bulkLabelSelectorAnchor).should('not.exist');
    });

    it('clears multi-selection when switching frames', () => {
        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            cy.get(sidebarCheckboxControl(firstShapeID)).click({ force: true });
            cy.get(sidebarCheckboxControl(secondShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');

            cy.goToNextFrame(1);
            assertNoMultiSelectionUI();

            cy.goToPreviousFrame(0);
            cy.get(sidebarRow(firstShapeID)).should('exist');
            cy.get(sidebarRow(secondShapeID)).should('exist');
            cy.get(sidebarCheckbox(firstShapeID)).should('not.be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.be.checked');
            assertNoMultiSelectionUI();
        });
    });

    it('clears multi-selection when switching workspaces and returning from readonly review workspace', () => {
        withCreatedShapeIDs(([firstShapeID, secondShapeID]) => {
            cy.get(sidebarCheckboxControl(firstShapeID)).click({ force: true });
            cy.get(sidebarCheckboxControl(secondShapeID)).click({ force: true });
            cy.get(sidebarCheckbox(firstShapeID)).should('be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('be.checked');

            cy.changeWorkspace('Review');
            cy.get('.cvat-workspace-selector').should('contain.text', 'Review');
            cy.get(sidebarCheckbox(firstShapeID)).should('not.exist');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.exist');
            assertNoMultiSelectionUI();

            cy.changeWorkspace('Standard');
            cy.get('.cvat-workspace-selector').should('contain.text', 'Standard');
            cy.get(sidebarRow(firstShapeID)).should('exist');
            cy.get(sidebarRow(secondShapeID)).should('exist');
            cy.get(sidebarCheckbox(firstShapeID)).should('not.be.checked');
            cy.get(sidebarCheckbox(secondShapeID)).should('not.be.checked');
            assertNoMultiSelectionUI();
        });
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
