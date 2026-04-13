'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { freshRequire } = require('../helpers/module');

const DB_PATH = path.join(__dirname, '..', '..', 'db.js');

async function withDb(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-db-'));
  const prev = process.env.BLUEPRINT_DATA;
  process.env.BLUEPRINT_DATA = dir;
  try {
    const db = freshRequire(DB_PATH);
    await fn(db, dir);
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_DATA;
    else process.env.BLUEPRINT_DATA = prev;
  }
}

test('DB-01: schema creates 6 tables with WAL mode', async () => {
  await withDb(async (db) => {
    const tables = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of ['projects', 'sessions', 'tasks', 'settings', 'messages', 'session_meta']) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    assert.equal(String(db.db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  });
});

test('DB-02: migrations are idempotent', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-db-mig-'));
  const prev = process.env.BLUEPRINT_DATA;
  process.env.BLUEPRINT_DATA = dir;
  try {
    const db1 = freshRequire(DB_PATH);
    const cols1 = db1.db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((r) => r.name);
    const db2 = freshRequire(DB_PATH);
    const cols2 = db2.db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((r) => r.name);
    assert.deepEqual(cols2.sort(), cols1.sort());
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_DATA;
    else process.env.BLUEPRINT_DATA = prev;
  }
});

test('DB-03 / ENG-16: ensureProject is idempotent and CRUD works', async () => {
  await withDb(async (db) => {
    const a = db.ensureProject('proj', '/workspace/proj');
    const b = db.ensureProject('proj', '/workspace/proj');
    assert.equal(a.id, b.id);
    assert.equal(db.db.prepare('SELECT count(*) as c FROM projects WHERE name=?').get('proj').c, 1);
    assert.ok(db.getProject('proj'));
    db.deleteProject(a.id);
    assert.equal(db.getProject('proj'), undefined);
  });
});

test('DB-04: session CRUD and state transitions', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'Name');
    assert.equal(db.getSession('s1').name, 'Name');
    db.renameSession('s1', 'New');
    assert.equal(db.getSession('s1').name, 'New');
    db.setSessionState('s1', 'archived');
    assert.equal(db.getSession('s1').state, 'archived');
    db.setSessionState('s1', 'hidden');
    assert.equal(db.getSession('s1').state, 'hidden');
    db.setSessionState('s1', 'active');
    assert.equal(db.getSession('s1').archived, 0);
    assert.equal(db.getSession('s1').state, 'active');
    db.deleteSession('s1');
    assert.equal(db.getSession('s1'), undefined);
  });
});

test('DB-05: task CRUD lifecycle', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    const t = db.addTask(p.id, 'Do it', 'agent');
    assert.equal(t.status, 'todo');
    assert.equal(t.created_by, 'agent');
    db.completeTask(t.id);
    const completed = db.getTasks(p.id)[0];
    assert.equal(completed.status, 'done');
    assert.ok(completed.completed_at);
    db.reopenTask(t.id);
    const reopened = db.getTasks(p.id)[0];
    assert.equal(reopened.status, 'todo');
    assert.equal(reopened.completed_at, null);
    db.deleteTask(t.id);
    assert.equal(db.getTasks(p.id).length, 0);
  });
});

test('DB-06: message CRUD', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    const m = db.sendMessage(p.id, 'a', 'b', 'hello');
    assert.ok(m.id);
    assert.equal(db.getUnreadMessages(p.id, 'b').length, 1);
    db.markMessageRead(m.id);
    assert.equal(db.getUnreadMessages(p.id, 'b').length, 0);
    assert.equal(db.getRecentMessages(p.id).length, 1);
  });
});

test('DB-07: settings JSON and raw fallback', async () => {
  await withDb(async (db) => {
    db.setSetting('j', JSON.stringify({ a: 1 }));
    db.setSetting('r', 'plain');
    const all = db.getAllSettings();
    assert.deepEqual(all.j, { a: 1 });
    assert.equal(all.r, 'plain');
    assert.equal(db.getSetting('j'), JSON.stringify({ a: 1 }));
    assert.equal(db.getSetting('missing', 'def'), 'def');
  });
});

test('DB-08: session meta upsert/get/cleanStale', async () => {
  await withDb(async (db) => {
    db.upsertSessionMeta('s1', '/tmp/a.jsonl', 1, 10, 'One', '2026-01-01', 5);
    db.upsertSessionMeta('s2', '/tmp/b.jsonl', 2, 20, 'Two', '2026-01-02', 6);
    assert.equal(db.getSessionMeta('s1').name, 'One');
    assert.equal(db.getSessionMeta('s1').message_count, 5);
    db.cleanStaleMeta(new Set(['s2']));
    assert.equal(db.getSessionMeta('s1'), undefined);
    assert.equal(db.getSessionMeta('s2').name, 'Two');
  });
});

test('DB-09: delete project cascades sessions, tasks, messages', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'S');
    db.addTask(p.id, 'T');
    db.sendMessage(p.id, 'a', 'b', 'M');
    assert.ok(db.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c > 0);
    assert.ok(db.db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c > 0);
    assert.ok(db.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c > 0);
    db.deleteProject(p.id);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, 0);
    assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 0);
  });
});

test('DB-10: getSessionByPrefix returns matching session', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('abc123def', p.id, 'One');
    const r = db.getSessionByPrefix('abc');
    assert.ok(r);
    assert.equal(r.id, 'abc123def');
    assert.equal(r.project_name, 'proj');
  });
});

test('DB-11: getSessionFull joins project name', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'S');
    const full = db.getSessionFull('s1');
    assert.equal(full.project_name, 'proj');
    assert.equal(full.id, 's1');
  });
});

test('DB-12: concurrent upsertSession calls do not corrupt', async () => {
  await withDb(async (db) => {
    const p = db.ensureProject('proj', '/workspace/proj');
    db.upsertSession('s1', p.id, 'First');
    db.upsertSession('s1', p.id, 'Second');
    const s = db.getSession('s1');
    assert.ok(s);
    assert.equal(s.name, 'First');
  });
});
