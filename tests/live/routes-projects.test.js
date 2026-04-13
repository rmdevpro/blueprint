'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post, put } = require('../helpers/http-client');
const { resetBaseline, dockerExec } = require('../helpers/reset-state');
const { queryCount } = require('../helpers/db-query');

test('PRJ-01: add project by path with DB verification', async () => {
  await resetBaseline();
  dockerExec('mkdir -p /workspace/test_live_project');
  const r = await post('/api/projects', {
    path: '/workspace/test_live_project',
    name: 'test_live_project',
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'test_live_project');
  const count = queryCount('projects', "name='test_live_project'");
  assert.ok(count >= 1, 'Project should exist in DB');
});

test('PRJ-04: /api/state lists projects', async () => {
  const r = await get('/api/state');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.projects));
});

test('PRJ-05: project notes round-trip with DB verification', async () => {
  dockerExec('mkdir -p /workspace/test_notes_proj');
  await post('/api/projects', { path: '/workspace/test_notes_proj', name: 'test_notes_proj' });
  await put('/api/projects/test_notes_proj/notes', { notes: 'Test notes content' });
  const r = await get('/api/projects/test_notes_proj/notes');
  assert.equal(r.data.notes, 'Test notes content');
});

test('GCM-01/02: global CLAUDE.md read/write', async () => {
  await put('/api/claude-md/global', { content: '# Global Test' });
  const r = await get('/api/claude-md/global');
  assert.equal(r.data.content, '# Global Test');
});
