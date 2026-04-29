'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post } = require('../helpers/http-client');
const { resetBaseline } = require('../helpers/reset-state');
const { queryCount } = require('../helpers/db-query');

test('MCP-01: GET /api/mcp/tools lists 44 flat tools', async () => {
  const r = await get('/api/mcp/tools');
  assert.equal(r.status, 200);
  assert.equal(r.data.tools.length, 44, `expected 44 tools, got ${r.data.tools.length}`);
  // Spot-check that the names are flat (no double-prefix) and grouped by domain
  for (const name of r.data.tools) {
    assert.ok(/^(file|session|project|task|log)_/.test(name), `tool name not flat: ${name}`);
  }
});

test('MCP-06: task_add increments DB row count and task_list surfaces it', async () => {
  await resetBaseline();
  const countBefore = queryCount('tasks', "folder_path = '/'");

  const addResult = await post('/api/mcp/call', {
    tool: 'task_add',
    args: { folder_path: '/', title: 'mcp-task-test' },
  });
  assert.ok(addResult.data.result, `task_add returned no result: ${JSON.stringify(addResult.data)}`);

  const countAfter = queryCount('tasks', "folder_path = '/'");
  assert.equal(
    countAfter,
    countBefore + 1,
    `DB task count must increment by 1 after task_add (before: ${countBefore}, after: ${countAfter})`,
  );

  // task_list was consolidated into task_find in 980bb6c
  const listed = await post('/api/mcp/call', {
    tool: 'task_find',
    args: { folder_path: '/' },
  });
  assert.ok(listed.data.result.tasks.some((t) => t.title === 'mcp-task-test'));
});

test('MCP unknown tool returns 404', async () => {
  const r = await post('/api/mcp/call', { tool: 'nonexistent_tool', args: {} });
  assert.equal(r.status, 404);
});
