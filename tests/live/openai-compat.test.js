'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post } = require('../helpers/http-client');

test('OAI-01: GET /v1/models returns model list', async () => {
  const r = await get('/v1/models');
  assert.equal(r.status, 200);
  assert.ok(r.data.data.find((m) => m.id === 'claude-sonnet-4-6'));
  assert.ok(r.data.data.find((m) => m.id === 'claude-opus-4-6'));
});

test('OAI-09: empty messages array rejected', async () => {
  const r = await post('/v1/chat/completions', { model: 'claude-sonnet-4-6', messages: [] });
  assert.equal(r.status, 400);
});

test('OAI-09: no user message rejected', async () => {
  const r = await post('/v1/chat/completions', {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'system', content: 'hi' }],
  });
  assert.equal(r.status, 400);
});
