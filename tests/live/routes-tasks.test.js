'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get, post, put, del } = require('../helpers/http-client');

async function cleanAllTasks() {
  const tree = await get('/api/tasks/tree?filter=all');
  const ids = [];
  function collect(node) {
    for (const t of node.tasks) ids.push(t.id);
    for (const child of Object.values(node.children)) collect(child);
  }
  collect(tree.data.tree);
  for (const id of ids) await del(`/api/tasks/${id}`);
}

test('TSK-01: create task with folder_path and title', async () => {

  const r = await post('/api/tasks', { folder_path: '/src/auth', title: 'Fix login bug' });
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Fix login bug');
  assert.equal(r.data.folder_path, '/src/auth');
  assert.equal(r.data.status, 'todo');
  assert.ok(r.data.id, 'must return task id');
});

test('TSK-02: create task at root /', async () => {
  const r = await post('/api/tasks', { title: 'Root task' });
  assert.equal(r.status, 200);
  assert.equal(r.data.folder_path, '/');
});

test('TSK-03: tree endpoint returns nested folder structure', async () => {
  await cleanAllTasks();
  await post('/api/tasks', { folder_path: '/src/auth', title: 'Task A' });
  await post('/api/tasks', { folder_path: '/src/db', title: 'Task B' });
  await post('/api/tasks', { folder_path: '/', title: 'Root task' });

  const r = await get('/api/tasks/tree?filter=todo');
  assert.equal(r.status, 200);
  assert.ok(r.data.tree, 'response must contain tree');
  assert.equal(r.data.tree.path, '/');
  assert.equal(r.data.tree.tasks.length, 1, 'root should have 1 task');
  assert.ok(r.data.tree.children.src, 'tree must have src folder');
  assert.ok(r.data.tree.children.src.children.auth, 'tree must have src/auth folder');
  assert.ok(r.data.tree.children.src.children.db, 'tree must have src/db folder');
  assert.equal(r.data.tree.children.src.children.auth.tasks.length, 1);
  assert.equal(r.data.tree.children.src.children.db.tasks.length, 1);
});

test('TSK-04: tree with filter=all includes done and archived', async () => {
  await cleanAllTasks();
  const t1 = await post('/api/tasks', { folder_path: '/', title: 'Active' });
  const t2 = await post('/api/tasks', { folder_path: '/', title: 'Done' });
  const t3 = await post('/api/tasks', { folder_path: '/', title: 'Archived' });
  await put(`/api/tasks/${t2.data.id}`, { status: 'done' });
  await put(`/api/tasks/${t3.data.id}`, { status: 'archived' });

  const filtered = await get('/api/tasks/tree?filter=todo');
  assert.equal(filtered.data.tree.tasks.length, 1, 'filter=todo should show only active');

  const all = await get('/api/tasks/tree?filter=all');
  assert.equal(all.data.tree.tasks.length, 3, 'filter=all should show all 3');
});

test('TSK-05: get task by ID returns task with history', async () => {

  const t = await post('/api/tasks', { folder_path: '/test', title: 'History test' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'History test');
  assert.ok(Array.isArray(r.data.history), 'must include history array');
  assert.ok(r.data.history.length >= 1, 'history must have at least created event');
  assert.equal(r.data.history[0].event_type, 'created');
});

test('TSK-06: update title records rename history', async () => {

  const t = await post('/api/tasks', { folder_path: '/', title: 'Old title' });
  await put(`/api/tasks/${t.data.id}`, { title: 'New title' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.title, 'New title');
  const renameEvent = r.data.history.find(h => h.event_type === 'renamed');
  assert.ok(renameEvent, 'must have renamed history event');
  assert.equal(renameEvent.old_value, 'Old title');
  assert.equal(renameEvent.new_value, 'New title');
});

test('TSK-07: update description records history', async () => {

  const t = await post('/api/tasks', { folder_path: '/', title: 'Desc test' });
  await put(`/api/tasks/${t.data.id}`, { description: 'Some notes here' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.description, 'Some notes here');
  const descEvent = r.data.history.find(h => h.event_type === 'description_changed');
  assert.ok(descEvent, 'must have description_changed history event');
});

test('TSK-08: complete task sets completed_at', async () => {

  const t = await post('/api/tasks', { folder_path: '/', title: 'Complete me' });
  await put(`/api/tasks/${t.data.id}`, { status: 'done' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.status, 'done');
  assert.ok(r.data.completed_at, 'completed_at must be set');
});

test('TSK-09: reopen task clears completed_at', async () => {

  const t = await post('/api/tasks', { folder_path: '/', title: 'Reopen me' });
  await put(`/api/tasks/${t.data.id}`, { status: 'done' });
  await put(`/api/tasks/${t.data.id}`, { status: 'todo' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.status, 'todo');
  assert.equal(r.data.completed_at, null);
});

test('TSK-10: archive task', async () => {

  const t = await post('/api/tasks', { folder_path: '/', title: 'Archive me' });
  await put(`/api/tasks/${t.data.id}`, { status: 'archived' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.status, 'archived');
});

test('TSK-11: move task to different folder records history', async () => {

  const t = await post('/api/tasks', { folder_path: '/old', title: 'Move me' });
  await put(`/api/tasks/${t.data.id}/move`, { folder_path: '/new/location' });
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.data.folder_path, '/new/location');
  const moveEvent = r.data.history.find(h => h.event_type === 'moved');
  assert.ok(moveEvent, 'must have moved history event');
  assert.equal(moveEvent.old_value, '/old');
  assert.equal(moveEvent.new_value, '/new/location');
});

test('TSK-12: batch reorder updates sort_order', async () => {
  await cleanAllTasks();
  const t1 = await post('/api/tasks', { folder_path: '/proj', title: 'First' });
  const t2 = await post('/api/tasks', { folder_path: '/proj', title: 'Second' });
  const t3 = await post('/api/tasks', { folder_path: '/proj', title: 'Third' });

  // Reverse the order
  await put('/api/tasks/reorder', {
    orders: [
      { id: t3.data.id, sort_order: 0 },
      { id: t2.data.id, sort_order: 1 },
      { id: t1.data.id, sort_order: 2 },
    ],
  });

  const tree = await get('/api/tasks/tree?filter=todo');
  const tasks = tree.data.tree.children.proj.tasks;
  assert.equal(tasks[0].title, 'Third');
  assert.equal(tasks[1].title, 'Second');
  assert.equal(tasks[2].title, 'First');
});

test('TSK-13: delete task removes from tree', async () => {

  const t = await post('/api/tasks', { folder_path: '/', title: 'Delete me' });
  await del(`/api/tasks/${t.data.id}`);
  const r = await get(`/api/tasks/${t.data.id}`);
  assert.equal(r.status, 404);
});

test('TSK-14: create task without title returns 400', async () => {
  const r = await post('/api/tasks', { folder_path: '/' });
  assert.equal(r.status, 400);
});

test('TSK-15: create task with title too long returns 400', async () => {
  const r = await post('/api/tasks', { folder_path: '/', title: 'x'.repeat(501) });
  assert.equal(r.status, 400);
});

test('TSK-16: tree pruning removes empty folders', async () => {

  const t = await post('/api/tasks', { folder_path: '/a/b/c', title: 'Deep task' });
  let tree = await get('/api/tasks/tree?filter=todo');
  assert.ok(tree.data.tree.children.a, 'folder a must exist');
  assert.ok(tree.data.tree.children.a.children.b.children.c, 'folder a/b/c must exist');

  await del(`/api/tasks/${t.data.id}`);
  tree = await get('/api/tasks/tree?filter=todo');
  assert.ok(!tree.data.tree.children.a, 'folder a must be pruned after task deleted');
});

test('TSK-17: sort order auto-increments', async () => {
  await cleanAllTasks();
  const t1 = await post('/api/tasks', { folder_path: '/proj', title: 'A' });
  const t2 = await post('/api/tasks', { folder_path: '/proj', title: 'B' });
  const t3 = await post('/api/tasks', { folder_path: '/proj', title: 'C' });
  assert.equal(t1.data.sort_order, 0);
  assert.equal(t2.data.sort_order, 1);
  assert.equal(t3.data.sort_order, 2);
});
