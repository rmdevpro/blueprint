'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get } = require('../helpers/http-client');

test('HLT-01: returns 200 when healthy with all dependency fields', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
  assert.ok('db' in r.data.dependencies);
  assert.ok('workspace' in r.data.dependencies);
  assert.ok('auth' in r.data.dependencies);
});

test('HLT-03: reports per-dependency status', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.dependencies.db, 'healthy');
  assert.equal(r.data.dependencies.workspace, 'healthy');
});

test('HLT-04: auth degraded does not flip HTTP status to 503', async () => {
  const r = await get('/health');
  if (r.data.dependencies.auth === 'degraded') {
    assert.equal(r.status, 200, 'Auth degraded should not cause 503');
  }
  assert.ok(r.data.dependencies.auth === 'healthy' || r.data.dependencies.auth === 'degraded');
});
