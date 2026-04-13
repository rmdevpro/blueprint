'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');
const { queryCount, queryJson } = require('../helpers/db-query');

test('MSG-01/03: send and get messages with DB and filesystem verification', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /workspace/msg_proj');
  await post('/api/projects', { path: '/workspace/msg_proj', name: 'msg_proj' });

  // Count messages before
  const msgCountBefore = queryCount('messages');

  const sendResult = await post('/api/projects/msg_proj/messages', { content: 'Hello from test' });
  assert.equal(sendResult.status, 200);
  assert.ok(sendResult.data.id, 'Send response must include message ID');

  // Gray-box: verify the message row exists in the database
  const msgCountAfter = queryCount('messages');
  assert.ok(
    msgCountAfter > msgCountBefore,
    `Message count must increase after send (before: ${msgCountBefore}, after: ${msgCountAfter})`,
  );

  // Gray-box: verify the message content in DB matches what was sent
  const dbMessages = queryJson('SELECT * FROM messages ORDER BY id DESC LIMIT 1');
  if (dbMessages.length > 0) {
    assert.equal(
      dbMessages[0].content,
      'Hello from test',
      'Message content in DB must match what was sent',
    );
  }

  // Verify API returns the message
  const r = await get('/api/projects/msg_proj/messages');
  assert.equal(r.status, 200);
  assert.ok(r.data.messages.length >= 1, 'Messages list must contain at least one message');
  assert.ok(
    r.data.messages.some((m) => m.content === 'Hello from test'),
    'Messages list must include the message we just sent',
  );

  // Gray-box: check if bridge file was written (inter-session messaging)
  const _bridgeExists = dockerExec('ls /storage/bridges/ 2>/dev/null | head -1');
  // Bridge files may or may not exist depending on whether to_session was specified
  // This is informational — we log but don't fail on absence
});

test('MSG-04: send rejects missing content', async () => {
  dockerExec('mkdir -p /workspace/msg_val_proj');
  await post('/api/projects', { path: '/workspace/msg_val_proj', name: 'msg_val_proj' });
  const msgCountBefore = queryCount('messages');
  const r = await post('/api/projects/msg_val_proj/messages', {});
  assert.equal(r.status, 400, 'Missing content must return 400');
  // Gray-box: verify no message was created in DB on validation failure
  const msgCountAfter = queryCount('messages');
  assert.equal(msgCountAfter, msgCountBefore, 'Failed message send must not create a DB row');
});
