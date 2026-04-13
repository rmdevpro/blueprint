'use strict';

/**
 * AUTH-ANSI: Auth URL extraction verification.
 *
 * The auth URL extraction logic lives in a <script> block in public/index.html
 * (checkForAuthIssue). It cannot be imported as a Node module.
 *
 * Per WPR-105 "Imports real code" criterion: we MUST NOT reimplement the algorithm
 * locally in tests. The previous version of this file copied the regex, indexOf,
 * and cleanup logic into a local extractAuthUrlFromBuffer() — that function would
 * pass even if the real application code were deleted or broken.
 *
 * The ONLY valid mock-layer tests for this code are:
 *   1. Verify the application source contains the expected constants and patterns
 *      (a guard that detects if the real code is removed or restructured).
 *   2. Verify the HTML file is parseable and contains the checkForAuthIssue function.
 *
 * Behavioral verification of the actual extraction algorithm is done exclusively
 * in the browser layer (BRW-28 in auth-modal.spec.js), which executes the real
 * checkForAuthIssue() function in its native browser context.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.join(__dirname, '../../public/index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

test('AUTH-ANSI: application defines checkForAuthIssue function', () => {
  assert.ok(
    indexHtml.includes('function checkForAuthIssue'),
    'public/index.html must define checkForAuthIssue function',
  );
});

test('AUTH-ANSI: application uses OAUTH_URL_START constant for auth detection', () => {
  assert.ok(
    indexHtml.includes("const OAUTH_URL_START = 'https://claude.com/cai/oauth/authorize?'"),
    'Application must define OAUTH_URL_START constant',
  );
  assert.ok(
    indexHtml.includes('.indexOf(OAUTH_URL_START)'),
    'Application must use OAUTH_URL_START in its auth detection logic',
  );
});

test('AUTH-ANSI: application includes ANSI stripping regex', () => {
  assert.ok(
    indexHtml.includes(String.raw`/\x1b\[[0-9;]*[a-zA-Z]/g`),
    'Application must use ANSI stripping regex for terminal output cleaning',
  );
});

test('AUTH-ANSI: application searches for Paste marker after URL', () => {
  assert.ok(
    indexHtml.includes(".indexOf('Paste'"),
    'Application must look for Paste marker to delimit the auth URL',
  );
});

test('AUTH-ANSI: checkForAuthIssue calls showAuthModal on detection', () => {
  assert.ok(
    indexHtml.includes('showAuthModal'),
    'checkForAuthIssue must trigger showAuthModal when auth URL is detected',
  );
});
