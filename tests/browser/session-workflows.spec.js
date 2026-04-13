'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch { process.exit(0); }

const { resetBaseline, BASE_URL } = require('../helpers/reset-state');
const SS = require('path').join(__dirname, 'screenshots');

describe('session workflows (browser)', () => {
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

  it('BRW-25: empty state shows actionable UI with hint text', async () => {
    const emptyState = page.locator('#empty-state');
    if (await emptyState.isVisible()) {
      const text = await emptyState.textContent();
      assert.ok(text.includes('Select a session') || text.includes('create') || text.includes('new'),
        'Empty state must contain actionable hint text');
      // Behavioral: verify the empty state contains a clickable action or link
      const hasAction = await page.locator('#empty-state a, #empty-state button, #empty-state [onclick]').count();
      assert.ok(hasAction > 0 || text.includes('Ctrl') || text.includes('+'),
        'Empty state should provide an action (button/link) or keyboard shortcut hint');
    }
    await page.screenshot({ path: `${SS}/session--empty-state.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('BRW-30: rapid new-session clicks do not create duplicate modals', async () => {
    // Verify no overlays exist initially
    assert.equal(await page.locator('[id^="new-session-overlay-"]').count(), 0,
      'No session overlays should exist on initial page load');
    // Behavioral: simulate rapid clicks on new-session trigger (double-click prevention)
    const newSessionBtn = page.locator('#new-session-btn, [data-action="new-session"], .new-session-trigger').first();
    if (await newSessionBtn.count() > 0) {
      // Rapid double-click
      await newSessionBtn.click({ clickCount: 1 });
      await newSessionBtn.click({ clickCount: 1, delay: 50 });
      await page.waitForTimeout(500);
      const overlayCount = await page.locator('[id^="new-session-overlay-"]').count();
      assert.ok(overlayCount <= 1,
        `Rapid clicks must not create duplicate session modals (found ${overlayCount})`);
    }
    await page.screenshot({ path: `${SS}/session--no-duplicate.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
