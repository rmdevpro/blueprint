'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.exit(0);
}

const { resetBaseline } = require('../helpers/reset-state');
const SS = require('path').join(__dirname, 'screenshots');

describe('file browser (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    if (browser) await browser.close();
  });
  beforeEach(async () => {
    errors.length = 0;
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await resetBaseline(page);
  });

  it('BRW-09: file browser panel loads and displays file tree entries', async () => {
    await page.click('#panel-toggle');
    await page.click('[data-panel="files"]');
    assert.ok(
      await page.locator('#file-browser-tree').isVisible(),
      'File tree container must be visible',
    );
    // Behavioral: wait for the tree to load actual entries from the server
    // The jqueryFileTree plugin populates the container via /api/jqueryfiletree
    await page.waitForTimeout(1500); // Allow async file tree load
    const treeEntryCount = await page
      .locator('#file-browser-tree li, #file-browser-tree .jqueryFileTree li')
      .count();
    assert.ok(
      treeEntryCount > 0,
      'File tree must contain at least one entry after loading (directories/files from the workspace)',
    );
    // Gray-box: verify the file tree API is responsive
    const apiOk = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/jqueryfiletree', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'dir=/',
        });
        return r.ok;
      } catch {
        return false;
      }
    });
    assert.ok(apiOk, 'File tree API /api/jqueryfiletree must respond successfully');
    await page.screenshot({ path: `${SS}/files--panel.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
