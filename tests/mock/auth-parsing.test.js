'use strict';

/**
 * AUTH-ANSI: Auth URL extraction verification.
 *
 * This file verifies that the checkForAuthIssue function in public/index.html
 * works correctly by extracting the REAL function source and executing it via
 * the vm module — not reimplementing the algorithm or string-matching.
 *
 * The browser-layer test (BRW-28 in auth-modal.spec.js) exercises the function
 * in its native browser context. This mock-layer test verifies the algorithm
 * itself is correct with controlled inputs in isolation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const indexHtmlPath = path.join(__dirname, '../../public/index.html');
const indexHtml = fs.readFileSync(indexHtmlPath, 'utf-8');

/**
 * Extract checkForAuthIssue and its dependencies from index.html,
 * then create an isolated executable sandbox.
 */
function buildSandbox() {
  // Extract the OAUTH_URL_PATTERNS array source from the file (the function
  // iterates over it). The legacy OAUTH_URL_START scalar was replaced by a
  // per-CLI patterns array — bring the literal source into the sandbox.
  const patternsMatch = indexHtml.match(/const\s+OAUTH_URL_PATTERNS\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(patternsMatch, 'index.html must define OAUTH_URL_PATTERNS array');
  const oauthPatternsSource = patternsMatch[1];

  // Extract the full checkForAuthIssue function body from the source.
  // The function starts at 'function checkForAuthIssue' and ends at the next
  // function definition at the same indentation level (4 spaces).
  const funcStartIdx = indexHtml.indexOf('function checkForAuthIssue');
  assert.ok(funcStartIdx !== -1, 'index.html must contain checkForAuthIssue function');

  // Find the function end — look for the closing brace at the original indentation
  let braceDepth = 0;
  let funcEndIdx = -1;
  let inFunc = false;
  for (let i = funcStartIdx; i < indexHtml.length; i++) {
    if (indexHtml[i] === '{') {
      braceDepth++;
      inFunc = true;
    } else if (indexHtml[i] === '}') {
      braceDepth--;
      if (inFunc && braceDepth === 0) {
        funcEndIdx = i + 1;
        break;
      }
    }
  }
  assert.ok(funcEndIdx > funcStartIdx, 'Must find closing brace of checkForAuthIssue');
  const funcSource = indexHtml.substring(funcStartIdx, funcEndIdx);

  // Build a minimal sandbox with the exact dependencies the function uses.
  // Use 'var' so declarations become properties on the sandbox object,
  // accessible from the host. 'const'/'let' are block-scoped in vm contexts.
  // checkForAuthIssue depends on: OAUTH_URL_PATTERNS (per-CLI URL recipes),
  // authModalVisible (gate flag), tabs (Map<tabId, {cli_type}>),
  // oauthDetection ({claude/gemini/codex: bool} per-CLI enable),
  // ptyOutputBuffer (Map<tabId, string>), and showAuthModal.
  const capturedModals = [];
  const code = `
    var OAUTH_URL_PATTERNS = ${oauthPatternsSource};
    var authModalVisible = false;
    var ptyOutputBuffer = new Map();
    var tabs = new Map();
    var oauthDetection = { claude: true, gemini: true, codex: true };
    function showAuthModal(url, tabId) {
      authModalVisible = true;
      _capturedModals.push(url);
    }
    function _resetAuthState() {
      authModalVisible = false;
      ptyOutputBuffer.clear();
    }
    ${funcSource}
  `;

  const sandbox = {
    Map: global.Map,
    _capturedModals: capturedModals,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 5000 });

  return sandbox;
}

let sandbox;

test('AUTH-ANSI: extract and compile checkForAuthIssue from index.html', () => {
  sandbox = buildSandbox();
  assert.ok(
    typeof sandbox.checkForAuthIssue === 'function',
    'checkForAuthIssue must be defined as a function in the sandbox',
  );
  assert.ok(sandbox.ptyOutputBuffer instanceof Map, 'ptyOutputBuffer must be a Map');
});

test('AUTH-ANSI: checkForAuthIssue detects OAuth URL in clean input', () => {
  assert.ok(sandbox, 'Sandbox must be initialized');
  sandbox._capturedModals.length = 0;
  sandbox._resetAuthState();

  // The function takes (tabId, data) — it appends data to the buffer then scans
  sandbox.checkForAuthIssue(
    'test_clean',
    'Some output https://claude.com/cai/oauth/authorize?code=abc123 Paste code here',
  );

  assert.ok(
    sandbox._capturedModals.length > 0,
    'checkForAuthIssue must call showAuthModal when OAuth URL is present',
  );
  assert.ok(
    sandbox._capturedModals[0].startsWith('https://claude.com/cai/oauth/authorize?'),
    `Extracted URL must start with OAuth prefix, got: ${sandbox._capturedModals[0]}`,
  );
  assert.ok(
    sandbox._capturedModals[0].includes('code=abc123'),
    `URL must preserve query parameters, got: ${sandbox._capturedModals[0]}`,
  );
});

test('AUTH-ANSI: checkForAuthIssue strips ANSI codes before URL extraction', () => {
  assert.ok(sandbox, 'Sandbox must be initialized');
  sandbox._capturedModals.length = 0;
  sandbox._resetAuthState();

  sandbox.checkForAuthIssue(
    'test_ansi',
    '\x1b[31mhttps://claude.com/cai/oauth/authorize?code=xyz789\x1b[0m more text Paste code here',
  );

  assert.ok(
    sandbox._capturedModals.length > 0,
    'checkForAuthIssue must detect URL even when wrapped in ANSI codes',
  );
  assert.ok(
    sandbox._capturedModals[0].includes('code=xyz789'),
    `Extracted URL must preserve query params after ANSI stripping, got: ${sandbox._capturedModals[0]}`,
  );
  assert.ok(
    !sandbox._capturedModals[0].includes('\x1b'),
    'Extracted URL must not contain ANSI escape codes',
  );
});

test('AUTH-ANSI: checkForAuthIssue does not trigger on non-OAuth URLs', () => {
  assert.ok(sandbox, 'Sandbox must be initialized');
  sandbox._capturedModals.length = 0;
  sandbox._resetAuthState();

  sandbox.checkForAuthIssue('test_no_oauth', 'Visit https://example.com for more info');

  assert.equal(
    sandbox._capturedModals.length,
    0,
    'checkForAuthIssue must NOT trigger showAuthModal for non-OAuth URLs',
  );
});

test('AUTH-ANSI: checkForAuthIssue handles empty data gracefully', () => {
  assert.ok(sandbox, 'Sandbox must be initialized');
  sandbox._capturedModals.length = 0;
  sandbox._resetAuthState();

  // Call with empty data — should not throw
  assert.doesNotThrow(
    () => sandbox.checkForAuthIssue('test_empty', ''),
    'checkForAuthIssue must not throw for empty data',
  );
  assert.equal(sandbox._capturedModals.length, 0, 'Must not trigger showAuthModal for empty data');
});

test('AUTH-ANSI: authModalVisible flag prevents duplicate modal triggers', () => {
  assert.ok(sandbox, 'Sandbox must be initialized');
  sandbox._capturedModals.length = 0;
  sandbox._resetAuthState();

  const testData = 'https://claude.com/cai/oauth/authorize?code=first Paste code here';

  // First call should trigger
  sandbox.checkForAuthIssue('test_dedup', testData);
  assert.equal(sandbox._capturedModals.length, 1, 'First call must trigger showAuthModal');

  // Second call should be suppressed by authModalVisible flag
  sandbox.ptyOutputBuffer.clear();
  sandbox.checkForAuthIssue('test_dedup2', testData);
  assert.equal(
    sandbox._capturedModals.length,
    1,
    'Second call must be suppressed by authModalVisible flag — no duplicate modals',
  );
});
