'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { registerExternalMcpRoutes, ADMIN_TOOLS } = require('../../mcp-external.js');

test('MCX-02: falls back to admin tools when internal fetch fails', async () => {
  // No PORT binding in the test — internal fetch to localhost:3000 fails with
  // ECONNREFUSED, triggering the fallback path.
  delete process.env.PORT;
  const app = express(); app.use(express.json()); registerExternalMcpRoutes(app);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/mcp/external/tools`);
    const body = await r.json();
    assert.ok(body.tools.length >= ADMIN_TOOLS.length);
    assert.ok(body.tools.some(t => t.name === 'blueprint_create_session'));
  } finally { await new Promise(r => server.close(r)); }
});

test('MCX-11: unknown tool returns 404', async () => {
  const app = express(); app.use(express.json()); registerExternalMcpRoutes(app);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/mcp/external/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'fake_tool', args: {} }),
    });
    assert.equal(r.status, 404);
  } finally { await new Promise(r => server.close(r)); }
});
