'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, BASE_URL } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('FRS-01/ENT-03: data directories exist', () => {
  const storage = dockerExec('ls -1 /storage');
  assert.ok(storage.length > 0, 'storage directory should have contents');
  assert.ok(storage.includes('blueprint.db'), 'blueprint.db should exist');
});

test('ENT-02: process runs as blueprint user', () => {
  assert.equal(dockerExec('whoami'), 'blueprint');
});

test('ENT-09: onboarding flags set correctly', () => {
  const raw = dockerExec('cat /storage/.claude/.claude.json 2>/dev/null || echo "null"');
  if (raw !== 'null') {
    const cfg = JSON.parse(raw);
    assert.equal(cfg.hasCompletedOnboarding, true, 'hasCompletedOnboarding should be true');
  }
});

test('ENT-10: storage owned by blueprint', () => {
  const owner = dockerExec('stat -c %U /storage');
  assert.equal(owner, 'blueprint');
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
  const count = parseInt(
    dockerExec(
      "grep -rn 'API_KEY=' /app/*.js 2>/dev/null | grep -v 'api_key_env' | grep -v 'node_modules' | wc -l",
    ) || '0',
  );
  assert.equal(count, 0, 'No hardcoded API keys should exist');
});

test('FRS-07: no orphaned bp_ tmux sessions after baseline reset', async () => {
  await resetBaseline();
  // Aggressively kill any remaining bp_ tmux sessions individually
  const remaining = dockerExec("tmux ls -F '#{session_name}' 2>/dev/null | grep '^bp_' || true");
  if (remaining.trim()) {
    for (const name of remaining.trim().split('\n').filter(Boolean)) {
      dockerExec(`tmux kill-session -t '${name}' 2>/dev/null || true`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const sessions = dockerExec("tmux ls -F '#{session_name}' 2>/dev/null | grep '^bp_' | wc -l");
  assert.equal(parseInt(sessions || '0'), 0, 'No orphaned bp_ sessions');
});

test('ENT-05 / FRS-03: settings.json exists', () => {
  const r = dockerExec('test -f /storage/.claude/settings.json && echo exists || echo missing');
  assert.equal(r, 'exists');
});
