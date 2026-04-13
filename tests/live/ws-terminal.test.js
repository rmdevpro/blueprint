'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');
const { connectWs } = require('../helpers/ws-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('WS-01: nonexistent session sends error and closes', async () => {
  const c = await connectWs('/ws/bp_nonexistent_xyz');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(c.msgs.some((m) => m.includes('No tmux session')));
  c.close();
});

test('WS-02/03: bidirectional terminal flow', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /workspace/ws_proj');
  await post('/api/projects', { path: '/workspace/ws_proj', name: 'ws_proj' });
  const r = await post('/api/terminals', { project: 'ws_proj' });
  assert.equal(r.status, 200, `Terminal creation failed: ${JSON.stringify(r.data)}`);
  const c = await connectWs(`/ws/${r.data.tmux}`);
  // Wait for bash prompt to initialize before sending command
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (c.msgs.join('').includes('$') || c.msgs.join('').includes('hopper@')) break;
  }
  c.msgs.length = 0; // Clear prompt output
  c.send('echo test_ws_bidirectional\r');
  await new Promise((r) => setTimeout(r, 3000));
  const output = c.msgs.join('');
  assert.ok(
    output.includes('test_ws_bidirectional'),
    `Expected output to contain test string, got: ${output.substring(0, 200)}`,
  );
  c.close();
});
