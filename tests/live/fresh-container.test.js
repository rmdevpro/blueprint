'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, BASE_URL } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('FRS-01/ENT-03: data directories exist', () => {
  const dbExists = dockerExec('test -f /data/.workbench/workbench.db && echo yes || echo no');
  assert.equal(dbExists, 'yes', '/data/.workbench/workbench.db should exist');
});

test('ENT-02: process runs as workbench user', () => {
  assert.equal(dockerExec('whoami'), 'workbench');
});

test('ENT-09: onboarding flags set correctly', () => {
  const raw = dockerExec('cat /data/.claude/.claude.json 2>/dev/null || echo "null"');
  if (raw !== 'null') {
    const cfg = JSON.parse(raw);
    assert.equal(cfg.hasCompletedOnboarding, true, 'hasCompletedOnboarding should be true');
  }
});

test('ENT-10: workbench home owned by workbench', () => {
  const owner = dockerExec('stat -c %U /data/.workbench');
  assert.equal(owner, 'workbench');
});

test('ENG-13: health returns 200', async () => {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`${BASE_URL}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  const r = await get('/health');
  assert.equal(r.status, 200);
});

test('ENG-05: no hardcoded secrets in application code', () => {
  // Look for API_KEY=<literal-secret-looking-value> rather than every
  // occurrence of API_KEY=. Previous version false-positived on
  // `export GEMINI_API_KEY=${shellEscape(process.env.GEMINI_API_KEY)}`
  // in safe-exec.js — that's a plumbing line, not a hardcoded secret.
  const count = parseInt(
    dockerExec(
      `grep -rnE "API_KEY=['\\\"]?[a-zA-Z0-9_-]{12,}['\\\"]?" /app/*.js 2>/dev/null | grep -v 'process.env' | grep -v 'shellEscape' | grep -v 'api_key_env' | grep -v 'node_modules' | wc -l`,
    ) || '0',
  );
  assert.equal(count, 0, 'No hardcoded API keys should exist');
});

test('FRS-07: tmux kill-session actually removes a session', async () => {
  // Create a known session, verify it exists, kill it, verify it's gone
  const name = 'wb_frs07_test';
  dockerExec(`tmux new-session -d -s ${name} -x 200 -y 50`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const before = dockerExec('tmux ls -F "#{session_name}" 2>/dev/null || true');
  assert.ok(before.includes(name), `Session ${name} must exist after creation`);
  dockerExec(`tmux kill-session -t ${name} 2>/dev/null || true`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = dockerExec('tmux ls -F "#{session_name}" 2>/dev/null || true');
  assert.ok(!after.includes(name), `Session ${name} must be gone after kill`);
});

test('ENT-05 / FRS-03: settings.json exists', () => {
  const r = dockerExec('test -f /data/.claude/settings.json && echo exists || echo missing');
  assert.equal(r, 'exists');
});
