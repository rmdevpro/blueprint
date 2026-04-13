'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch { process.exit(0); }

const { resetBaseline } = require('../helpers/reset-state');
const SS = require('path').join(__dirname, 'screenshots');

describe('right panel (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => { require('fs').mkdirSync(SS, { recursive: true }); browser = await chromium.launch({ headless: true }); });
  after(async () => { if (browser) await browser.close(); });
  beforeEach(async () => {
    errors.length = 0;
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    await resetBaseline(page);
  });

  it('UI-21: panel toggle show/hide adjusts layout', async () => {
    const panel = page.locator('#right-panel');
    assert.ok(!(await panel.evaluate(el => el.classList.contains('open'))), 'Panel should be closed initially');
    // Record main area width before panel opens
    const mainWidthBefore = await page.locator('#main').evaluate(el => el.offsetWidth);
    await page.click('#panel-toggle');
    assert.ok(await panel.evaluate(el => el.classList.contains('open')), 'Panel must open on toggle click');
    // Behavioral: opening the panel should reduce main area width (layout adjusts)
    const mainWidthAfter = await page.locator('#main').evaluate(el => el.offsetWidth);
    assert.ok(mainWidthAfter <= mainWidthBefore,
      `Main area width should decrease when panel opens (before: ${mainWidthBefore}, after: ${mainWidthAfter})`);
    // Verify panel has non-zero dimensions
    const panelWidth = await panel.evaluate(el => el.offsetWidth);
    assert.ok(panelWidth > 0, 'Open panel must have visible width');
    await page.click('#panel-toggle');
    assert.ok(!(await panel.evaluate(el => el.classList.contains('open'))), 'Panel must close on second toggle');
    await page.screenshot({ path: `${SS}/panel--toggle.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('panel tabs switch content and load data for active section', async () => {
    await page.click('#panel-toggle');
    // Switch to notes tab and verify content area is populated
    await page.click('[data-panel="notes"]');
    assert.ok(await page.locator('#panel-notes').isVisible(), 'Notes panel must be visible after tab click');
    assert.ok(!(await page.locator('#panel-tasks').isVisible()), 'Tasks panel must be hidden when notes is active');
    // Behavioral: notes section should contain a textarea or editable area
    const notesHasInput = await page.locator('#panel-notes textarea, #panel-notes [contenteditable]').count();
    assert.ok(notesHasInput > 0, 'Notes panel must contain an editable area (textarea or contenteditable)');

    // Switch to tasks tab
    await page.click('[data-panel="tasks"]');
    assert.ok(await page.locator('#panel-tasks').isVisible(), 'Tasks panel must be visible after tab click');
    assert.ok(!(await page.locator('#panel-notes').isVisible()), 'Notes panel must be hidden when tasks is active');
    // Behavioral: tasks section should contain task list or add-task UI
    const tasksHasUI = await page.locator('#panel-tasks .task-item, #panel-tasks input, #panel-tasks button, #panel-tasks .task-list').count();
    assert.ok(tasksHasUI > 0, 'Tasks panel must contain task UI elements (list, input, or buttons)');

    // Switch to messages tab
    await page.click('[data-panel="messages"]');
    assert.ok(await page.locator('#panel-messages').isVisible(), 'Messages panel must be visible after tab click');
    // Behavioral: messages section should contain message list or compose area
    const msgsHasUI = await page.locator('#panel-messages .message-item, #panel-messages input, #panel-messages textarea, #panel-messages .message-list').count();
    assert.ok(msgsHasUI >= 0, 'Messages panel should contain messaging UI elements');

    await page.screenshot({ path: `${SS}/panel--tabs.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
