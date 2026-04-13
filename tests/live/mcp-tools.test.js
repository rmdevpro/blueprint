'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');

test('MCP-01: GET /api/mcp/tools lists at least 14 tools', async () => {
  const r = await get('/api/mcp/tools');
  assert.equal(r.status, 200);
  assert.ok(r.data.tools.length >= 14);
});

test('MCP-06g/06f: add task and get tasks via MCP', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /workspace/mcp_proj');
  await post('/api/projects', { path: '/workspace/mcp_proj', name: 'mcp_proj' });
  const addResult = await post('/api/mcp/call', {
    tool: 'blueprint_add_task',
    args: { project: 'mcp_proj', text: 'mcp-task-test' },
  });
  assert.ok(addResult.data.result);
  const r = await post('/api/mcp/call', {
    tool: 'blueprint_get_tasks',
    args: { project: 'mcp_proj' },
  });
  assert.ok(r.data.result.tasks.some((t) => t.text === 'mcp-task-test'));
});

test('MCP unknown tool returns 404', async () => {
  const r = await post('/api/mcp/call', { tool: 'nonexistent_tool', args: {} });
  assert.equal(r.status, 404);
});
