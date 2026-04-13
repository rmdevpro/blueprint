'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch { process.exit(0); }

const { resetBaseline } = require('../helpers/reset-state');
const SS = require('path').join(__dirname, 'screenshots');

describe('settings (browser)', () => {
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

  it('BRW-13: theme change applies CSS variables and persists to server', async () => {
    await page.click('#sidebar-footer button');
    await page.locator('#setting-theme').selectOption('light');
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());
    assert.ok(bg.includes('#f5f5f5') || bg.includes('245'), `Expected light bg, got: ${bg}`);
    // Gray-box: verify the setting was persisted to the server via API
    const serverSettings = await page.evaluate(async () => {
      const r = await fetch('/api/settings');
      return r.json();
    });
    // The theme setting should be stored on the server
    const storedTheme = serverSettings.theme ? JSON.parse(serverSettings.theme) : null;
    assert.ok(storedTheme === 'light' || serverSettings.theme === '"light"',
      `Theme setting must be persisted to server as 'light', got: ${serverSettings.theme}`);
    // Switch back to dark
    await page.locator('#setting-theme').selectOption('dark');
    await page.screenshot({ path: `${SS}/settings--theme.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('settings modal opens and closes', async () => {
    await page.click('#sidebar-footer button');
    assert.ok(await page.locator('#settings-modal').evaluate(el => el.classList.contains('visible')));
    await page.click('.settings-close');
    assert.ok(!(await page.locator('#settings-modal').evaluate(el => el.classList.contains('visible'))));
    await page.screenshot({ path: `${SS}/settings--close.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('BRW-15: settings persist after page reload with server verification', async () => {
    await page.click('#sidebar-footer button');
    await page.locator('#setting-theme').selectOption('blueprint-dark');
    await page.waitForTimeout(600);
    await page.click('.settings-close');
    // Gray-box: verify server received the setting BEFORE reload
    const preReloadSettings = await page.evaluate(async () => {
      const r = await fetch('/api/settings');
      return r.json();
    });
    assert.ok(preReloadSettings.theme,
      'Theme setting must be saved to server before reload');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim());
    assert.ok(bg.includes('#081220') || bg.includes('081220'), `Expected blueprint-dark bg after reload, got: ${bg}`);
    await page.screenshot({ path: `${SS}/settings--persist.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
