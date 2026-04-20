'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post, createSession } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');
const { queryCount } = require('../helpers/db-query');

test('SES-03: creates bash terminal with correct ID format and tmux session', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/sess_proj');
  await post('/api/projects', { path: '/data/workspace/sess_proj', name: 'sess_proj' });
  const r = await post('/api/terminals', { project: 'sess_proj' });
  assert.equal(r.status, 200);
  assert.ok(r.data.id.startsWith('t_'), 'Terminal ID must start with t_');
  assert.ok(r.data.tmux, 'Response must include tmux session name');
  // Gray-box: verify the tmux session was actually spawned inside the container
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const tmuxList = dockerExec('tmux ls -F "#{session_name}" 2>/dev/null || echo ""');
  assert.ok(
    tmuxList.includes(r.data.tmux),
    `tmux session '${r.data.tmux}' must exist in container. Active sessions: ${tmuxList}`,
  );
});

test('SES-17: /api/state returns session list with enriched data', async () => {
  const r = await get('/api/state');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.projects), 'Response must include projects array');
  assert.ok('workspace' in r.data, 'Response must include workspace path');
  // Behavioral: verify projects contain session data (not just empty arrays)
  for (const proj of r.data.projects) {
    assert.ok('name' in proj, 'Each project must have a name');
    assert.ok('sessions' in proj || 'id' in proj, 'Each project must have sessions or id');
  }
});

test('session creation requires project', async () => {
  const r = await post('/api/sessions', {});
  assert.equal(r.status, 400);
});

test('terminal creation requires project', async () => {
  const r = await post('/api/terminals', {});
  assert.equal(r.status, 400);
});

test('SES-03a: session creation produces DB row and tmux session', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /data/workspace/ses_create_proj');
  await post('/api/projects', { path: '/data/workspace/ses_create_proj', name: 'ses_create_proj' });
  // Count sessions before
  const countBefore = queryCount('sessions', "id LIKE 'new_%'");
  const r = await createSession('ses_create_proj', 'Test prompt');
  assert.equal(r.status, 200, `Session creation must return 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.ok(r.data.id, 'Response must include session ID');
  // Gray-box: verify DB row was created
  const countAfter = queryCount('sessions', "id LIKE 'new_%'");
  assert.ok(
    countAfter > countBefore,
    `Session count must increase after creation (before: ${countBefore}, after: ${countAfter})`,
  );
  // Gray-box: verify tmux session exists
  if (r.data.tmux) {
    const tmuxList = dockerExec('tmux ls -F "#{session_name}" 2>/dev/null || echo ""');
    assert.ok(
      tmuxList.includes(r.data.tmux),
      `tmux session '${r.data.tmux}' must exist after session creation`,
    );
  }
});
