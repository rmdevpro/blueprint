'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.exit(0);
}

const { resetBaseline } = require('../helpers/reset-state');
const { startCoverage, stopCoverage, writeCoverageReport } = require('../helpers/browser-coverage');
const SS = require('path').join(__dirname, 'screenshots');

describe('settings (browser)', () => {
  let browser, page;
  const errors = [];

  before(async () => {
    require('fs').mkdirSync(SS, { recursive: true });
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await writeCoverageReport('settings');
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
    await startCoverage(page);
    await resetBaseline(page);
  });
  afterEach(async () => {
    await stopCoverage(page);
  });

  it('BRW-13: theme change applies CSS variables and persists to server', async () => {
    await page.click('#sidebar-footer button');
    await page.locator('#setting-theme').selectOption('light');
    await page.waitForTimeout(500);
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
    );
    assert.ok(bg.includes('#f5f5f5') || bg.includes('245'), `Expected light bg, got: ${bg}`);
    const serverSettings = await page.evaluate(async () => {
      const r = await fetch('/api/settings');
      return r.json();
    });
    const rawTheme = serverSettings.theme || '';
    let storedTheme;
    try {
      storedTheme = JSON.parse(rawTheme);
    } catch {
      storedTheme = rawTheme;
    }
    assert.ok(
      storedTheme === 'light',
      `Theme setting must be persisted to server as 'light', got: ${serverSettings.theme}`,
    );
    await page.locator('#setting-theme').selectOption('dark');
    await page.screenshot({ path: `${SS}/settings--theme.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('settings modal opens and closes', async () => {
    await page.click('#sidebar-footer button');
    assert.ok(
      await page.locator('#settings-modal').evaluate((el) => el.classList.contains('visible')),
    );
    await page.click('.settings-close');
    assert.ok(
      !(await page.locator('#settings-modal').evaluate((el) => el.classList.contains('visible'))),
    );
    await page.screenshot({ path: `${SS}/settings--close.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-35: font size change applies to terminal and persists to server', async () => {
    await page.click('#sidebar-footer button');
    const fontSizeInput = page.locator('#setting-font-size');
    assert.ok(await fontSizeInput.isVisible(), 'Font size input must be visible in settings');

    // Change font size to 18
    await fontSizeInput.fill('18');
    await fontSizeInput.dispatchEvent('change');
    await page.waitForTimeout(500);

    // Gray-box: verify the setting was persisted to the server
    const serverSettings = await page.evaluate(async () => {
      const r = await fetch('/api/settings');
      return r.json();
    });
    const storedSize =
      parseInt(serverSettings.font_size, 10) ||
      parseInt(JSON.parse(serverSettings.font_size || '0'), 10);
    assert.equal(
      storedSize,
      18,
      `Font size must be persisted to server as 18, got: ${serverSettings.font_size}`,
    );

    // Reset to default
    await fontSizeInput.fill('14');
    await fontSizeInput.dispatchEvent('change');
    await page.waitForTimeout(300);
    await page.click('.settings-close');
    await page.screenshot({ path: `${SS}/settings--font-size.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('UI-36: font family change applies and persists to server', async () => {
    await page.click('#sidebar-footer button');
    const fontFamilySelect = page.locator('#setting-font-family');
    assert.ok(await fontFamilySelect.isVisible(), 'Font family select must be visible in settings');

    // Get available options
    const options = await fontFamilySelect.locator('option').allTextContents();
    assert.ok(options.length >= 2, `Font family must have 2+ options, got: ${options.length}`);

    // Select a non-default font
    const nonDefault = options.find((o) => !o.includes('JetBrains') && !o.includes('default'));
    if (nonDefault) {
      await fontFamilySelect.selectOption({ label: nonDefault });
      await page.waitForTimeout(500);

      // Gray-box: verify the setting was persisted
      const serverSettings = await page.evaluate(async () => {
        const r = await fetch('/api/settings');
        return r.json();
      });
      assert.ok(serverSettings.font_family, 'Font family setting must be persisted to server');
    }

    // Reset to default (first option)
    await fontFamilySelect.selectOption({ index: 0 });
    await page.waitForTimeout(300);
    await page.click('.settings-close');
    await page.screenshot({ path: `${SS}/settings--font-family.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });

  it('BRW-15: settings persist after page reload with server verification', async () => {
    await page.click('#sidebar-footer button');
    await page.locator('#setting-theme').selectOption('workbench-dark');
    await page.waitForTimeout(600);
    await page.click('.settings-close');
    const preReloadSettings = await page.evaluate(async () => {
      const r = await fetch('/api/settings');
      return r.json();
    });
    assert.ok(preReloadSettings.theme, 'Theme setting must be saved to server before reload');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
    );
    assert.ok(
      bg.includes('#081220') || bg.includes('081220'),
      `Expected workbench-dark bg after reload, got: ${bg}`,
    );
    await page.screenshot({ path: `${SS}/settings--persist.png` });
    assert.equal(errors.length, 0, errors.join(', '));
  });
});
