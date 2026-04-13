'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post, put, del } = require('../helpers/http-client');

test('WHK-01..04: webhook CRUD lifecycle', async () => {
  const list = await get('/api/webhooks');
  assert.ok(Array.isArray(list.data.webhooks));
  await post('/api/webhooks', { url: 'http://localhost:9999/test', events: ['*'] });
  const afterAdd = await get('/api/webhooks');
  assert.ok(afterAdd.data.webhooks.length > 0);
  await put('/api/webhooks', {
    webhooks: [{ url: 'http://localhost:9999/r', events: ['*'], mode: 'event_only' }],
  });
  const afterPut = await get('/api/webhooks');
  assert.equal(afterPut.data.webhooks.length, 1);
  const delResult = await del('/api/webhooks/0');
  assert.equal(delResult.data.deleted, true);
  assert.equal((await del('/api/webhooks/999')).status, 404);
});
