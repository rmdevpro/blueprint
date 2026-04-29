'use strict';

/**
 * Regression validation gate — proves the test harness catches real breakage.
 * Required by all four reviewers and §18.0 traceability.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRegression } = require('../helpers/regression-validation');
const { resetBaseline } = require('../helpers/reset-state');

test('REGVAL: regression validation proves tests catch breakage', async () => {
  await resetBaseline();
  const results = await validateRegression();

  // All scenarios must pass
  for (const r of results) {
    assert.ok(
      r.passed,
      `Regression scenario "${r.scenario}" failed: ${r.error || r.note || 'unknown'}`,
    );
  }

  // Must have validated at least 2 scenarios
  assert.ok(
    results.length >= 2,
    `Regression validation must cover at least 2 scenarios, ran ${results.length}`,
  );

  // Report results
  const passCount = results.filter((r) => r.passed).length;
  assert.equal(
    passCount,
    results.length,
    `All ${results.length} regression scenarios must pass, ${passCount} passed`,
  );
});

test('REGVAL: malformed input regression — overlong names rejected', async () => {
  const { post } = require('../helpers/http-client');

  // Overlong project name must be rejected
  const longName = 'X'.repeat(300);
  const r1 = await post('/api/projects', {
    path: '/workspace/regval_test',
    name: longName,
  });
  assert.ok(
    r1.status >= 400,
    `Overlong project name (300 chars) must be rejected, got ${r1.status}`,
  );

  // Overlong session name must be rejected
  const longSessName = 'Y'.repeat(5000);
  const r2 = await post('/api/sessions', { project: 'test', name: longSessName });
  assert.ok(
    r2.status >= 400,
    `Overlong session name (5000 chars) must be rejected, got ${r2.status}`,
  );
});

test('REGVAL: overlong input regression — server does not crash on huge payloads', async () => {
  const { post } = require('../helpers/http-client');

  // 10KB project name — must be rejected, not crash
  const longName = 'A'.repeat(10000);
  const r = await post('/api/projects', { path: '/workspace/test', name: longName });
  assert.ok(r.status >= 400, `Overlong project name must be rejected, got ${r.status}`);

  // 10KB session name — must be rejected
  const longSessionName = 'B'.repeat(10000);
  const r2 = await post('/api/sessions', { project: 'test', name: longSessionName });
  assert.ok(r2.status >= 400, `Overlong session name must be rejected, got ${r2.status}`);
});
