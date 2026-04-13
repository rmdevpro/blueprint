'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const childProcess = require('node:child_process');
const { registerOpenAIRoutes } = require('../../openai-compat.js');
const { withServer, req } = require('../helpers/with-server');

function startOaiApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  registerOpenAIRoutes(app);
  return app;
}

test('OAI-07: prompt > 100KB rejected', async () => {
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/v1/chat/completions', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'x'.repeat(100001) }],
    });
    assert.equal(r.status, 400);
  });
});

test('OAI-08: invalid model name rejected', async () => {
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/v1/chat/completions', {
      model: 'bad model!',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.type, 'invalid_request_error');
  });
});

test('OAI-11: Claude exec failure returns server_error', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) => cb(new Error('claude fail')));
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/v1/chat/completions', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.error.type, 'server_error');
  });
});

test('OAI: missing messages rejected', async () => {
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/v1/chat/completions', { model: 'claude-sonnet-4-6' });
    assert.equal(r.status, 400);
  });
});

test('OAI: empty messages array rejected', async () => {
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/v1/chat/completions', {
      model: 'claude-sonnet-4-6',
      messages: [],
    });
    assert.equal(r.status, 400);
  });
});

test('OAI: no user message rejected', async () => {
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/v1/chat/completions', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: 'hi' }],
    });
    assert.equal(r.status, 400);
  });
});

test('OAI-01: GET /v1/models returns model list', async () => {
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await (await req(port, 'GET', '/v1/models')).json();
    assert.ok(r.data.find((m) => m.id === 'claude-sonnet-4-6'));
    assert.ok(r.data.find((m) => m.id === 'claude-opus-4-6'));
    assert.ok(r.data.find((m) => m.id === 'claude-haiku-4-5-20251001'));
  });
});

test('OAI-02: non-streaming completion success', async (t) => {
  t.mock.method(childProcess, 'execFile', (_c, _a, _o, cb) =>
    cb(null, 'Test response from Claude'),
  );
  await withServer(startOaiApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/v1/chat/completions', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'Test response from Claude');
    assert.equal(body.choices[0].finish_reason, 'stop');
  });
});

test('OAI-04: bp: model prefix routes to session', async (t) => {
  const capturedArgs = [];
  t.mock.method(childProcess, 'execFile', (_c, args, _o, cb) => {
    capturedArgs.push(args);
    cb(null, 'response');
  });
  await withServer(startOaiApp(), async ({ port }) => {
    await req(port, 'POST', '/v1/chat/completions', {
      model: 'bp:my-session-id',
      messages: [{ role: 'user', content: 'test' }],
    });
    // Verify --resume was passed with the session ID
    assert.ok(capturedArgs[0].includes('--resume'));
    assert.ok(capturedArgs[0].includes('my-session-id'));
  });
});
