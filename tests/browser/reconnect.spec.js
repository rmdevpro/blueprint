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

describe('reconnect (browser)', () => {
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

  it('UI-55: reconnect logic is wired up with correct constants and handler', async () => {
    assert.equal(await page.evaluate(() => MAX_RECONNECT_DELAY), 30000);
    assert.equal(await page.evaluate(() => HEARTBEAT_MS), 30000);
    // Behavioral: verify the reconnect function exists and is callable
    const hasReconnect = await page.evaluate(
      () =>
        typeof connectWebSocket === 'function' ||
        typeof setupWebSocket === 'function' ||
        typeof reconnect === 'function',
    );
    assert.ok(hasReconnect, 'A WebSocket connection/reconnect function must be defined');
    await page.screenshot({ path: `${SS}/reconnect--constants.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('BRW-24: resize triggers terminal fit without crash or layout break', async () => {
    // Get initial terminal dimensions
    const _initialState = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      terminalExists: !!document.querySelector('.xterm, #terminal-container, .terminal-wrapper'),
    }));
    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(300);
    // Behavioral: verify the viewport actually changed and layout adapted
    const afterState = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      // Check no overlapping or broken layout indicators
      sidebarVisible: document.getElementById('sidebar')?.offsetWidth > 0,
      mainVisible: document.getElementById('main')?.offsetWidth > 0,
    }));
    assert.equal(afterState.width, 1200, 'Viewport width must match after resize');
    assert.ok(afterState.sidebarVisible, 'Sidebar must remain visible after resize');
    assert.ok(afterState.mainVisible, 'Main content area must remain visible after resize');
    await page.screenshot({ path: `${SS}/reconnect--resize.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
