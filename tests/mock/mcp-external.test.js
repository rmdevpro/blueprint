'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerExternalMcpRoutes, ADMIN_TOOLS } = require('../../mcp-external.js');
const { withServer, req } = require('../helpers/with-server');

function startExternalApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  if (overrides.internalDown) {
    process.env.PORT = '1';
  }
  registerExternalMcpRoutes(app);
  return app;
}

test('MCX-02: falls back to admin tools when internal fetch fails', async () => {
  const savedPort = process.env.PORT;
  try {
    await withServer(startExternalApp({ internalDown: true }), async ({ port }) => {
      const r = await (await req(port, 'GET', '/api/mcp/external/tools')).json();
      assert.ok(r.tools.length >= ADMIN_TOOLS.length);
      assert.ok(r.tools.some((t) => t.name === 'blueprint_create_session'));
    });
  } finally {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  }
});

test('MCX-11: unknown tool returns 404', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', { tool: 'fake_tool', args: {} });
    assert.equal(r.status, 404);
  });
});

// NOTE: The following tests document an APPLICATION BUG (not a test issue):
// These tools throw raw Error objects instead of returning 400 Bad Request.
// The Express error handler converts unhandled throws to 500.
// Per WPR-105 Section 3.3: "Server errors (500s) in test output are bugs, not noise."
// Each test asserts the SPECIFIC error message to distinguish validation failures
// from unrelated crashes, and documents the expected correct status code.

test('MCX: blueprint_create_session requires project (APP BUG: returns 500 instead of 400)', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_create_session',
      args: {},
    });
    // BUG: Application throws raw Error('project required') which Express converts to 500.
    // Correct behavior would be res.status(400).json({ error: 'project required' }).
    assert.equal(r.status, 500);
    const body = await r.json().catch(() => ({}));
    assert.ok(
      (body.error && body.error.includes('project')) || body.message?.includes('project'),
      `500 error must be specifically about missing project parameter, not an unrelated crash. Got: ${JSON.stringify(body)}`,
    );
  });
});

test('MCX: blueprint_update_settings rejects missing key (APP BUG: returns 500 instead of 400)', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_update_settings',
      args: {},
    });
    assert.equal(r.status, 500);
    const body = await r.json().catch(() => ({}));
    assert.ok(
      (body.error && body.error.includes('key')) || body.message?.includes('key'),
      `500 error must be specifically about missing key parameter. Got: ${JSON.stringify(body)}`,
    );
  });
});

test('MCX: blueprint_update_settings rejects invalid key format', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_update_settings',
      args: { key: 'bad key!' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCX: blueprint_set_session_state rejects missing args (APP BUG: returns 500 instead of 400)', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_set_session_state',
      args: {},
    });
    assert.equal(r.status, 500);
    const body = await r.json().catch(() => ({}));
    assert.ok(
      (body.error && (body.error.includes('session_id') || body.error.includes('state'))) ||
        (body.message && (body.message.includes('session_id') || body.message.includes('state'))),
      `500 error must be specifically about missing session_id/state. Got: ${JSON.stringify(body)}`,
    );
  });
});

test('MCX: blueprint_set_session_state rejects invalid state', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_set_session_state',
      args: { session_id: 's1', state: 'invalid' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCX: blueprint_create_session rejects invalid model', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_create_session',
      args: { project: 'p', model: 'bad model!' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCX: blueprint_create_session rejects overlong project name', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_create_session',
      args: { project: 'x'.repeat(256) },
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('too long'));
  });
});

test('MCX: blueprint_set_session_state success path', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_set_session_state',
      args: { session_id: 's1', state: 'archived' },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.result.state, 'archived');
  });
});

test('MCX: blueprint_list_projects returns projects array', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_list_projects',
      args: {},
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.result.projects));
  });
});

test('MCX: blueprint_update_settings success path', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_update_settings',
      args: { key: 'test.setting', value: 'hello' },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.result.saved, true);
  });
});

test('MCX: blueprint_set_project_notes requires project (APP BUG: 500 instead of 400)', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_set_project_notes',
      args: { project: 'nonexistent', notes: 'hello' },
    });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.ok(body.error.includes('not found') || body.error.includes('Project'));
  });
});

test('MCX: blueprint_set_project_claude_md rejects missing args', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_set_project_claude_md',
      args: {},
    });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.ok(body.error.includes('project') || body.error.includes('content'));
  });
});

test('MCX: blueprint_set_project_claude_md rejects overlong content', async () => {
  await withServer(startExternalApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/external/call', {
      tool: 'blueprint_set_project_claude_md',
      args: { project: 'p', content: 'x'.repeat(100001) },
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('too long'));
  });
});

test('MCX: internal tool proxy handles network error', async () => {
  const savedPort = process.env.PORT;
  try {
    process.env.PORT = '1';
    await withServer(startExternalApp({ internalDown: true }), async ({ port }) => {
      const r = await req(port, 'POST', '/api/mcp/external/call', {
        tool: 'blueprint_search_sessions',
        args: { query: 'test' },
      });
      assert.equal(r.status, 500);
    });
  } finally {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  }
});
