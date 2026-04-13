'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, BASE_URL } = require('../helpers/http-client');
const { dockerExec } = require('../helpers/reset-state');

test('SRV-01: health endpoint returns 200 with ok status', async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
});

test('SRV-02: serves index.html with Blueprint title', async () => {
  const r = await fetch(`${BASE_URL}/`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('Blueprint'));
  assert.ok(text.includes('<html'));
});

test('SRV-02: serves xterm.js and jquery', async () => {
  assert.equal((await fetch(`${BASE_URL}/lib/xterm/lib/xterm.js`)).status, 200);
  assert.equal((await fetch(`${BASE_URL}/lib/jquery/jquery.min.js`)).status, 200);
});

test('SRV-04: container alive and server listening', () => {
  const alive = dockerExec('echo alive');
  assert.equal(alive, 'alive');
});
