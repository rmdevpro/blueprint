'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const express = require('express');
const { withServer, req } = require('../helpers/with-server');

// Reuse the route test helper from routes.test.js
const registerCoreRoutes = require('../../routes');
const Database = require('better-sqlite3');
const safe = require('../../safe-exec');
const config = require('../../config');
const sessionUtils = require('../../session-utils');

function makeApp() {
  const tmpDir = path.join(os.tmpdir(), 'bp-newroute-' + Date.now());
  const WORKSPACE = path.join(tmpDir, 'workspace');
  const CLAUDE_HOME = path.join(tmpDir, 'claude');
  require('node:fs').mkdirSync(WORKSPACE, { recursive: true });
  require('node:fs').mkdirSync(CLAUDE_HOME, { recursive: true });

  const dbPath = path.join(tmpDir, 'test.db');
  const rawDb = new Database(dbPath);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  // Minimal schema
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      notes TEXT DEFAULT '',
      state TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT,
      archived INTEGER DEFAULT 0,
      state TEXT DEFAULT 'active',
      notes TEXT DEFAULT '',
      model_override TEXT,
      user_renamed INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const db = {
    getProjects: () => rawDb.prepare('SELECT * FROM projects').all(),
    getProject: (name) => rawDb.prepare('SELECT * FROM projects WHERE name = ?').get(name),
    ensureProject: (name, p) => {
      rawDb.prepare('INSERT OR IGNORE INTO projects (name, path) VALUES (?, ?)').run(name, p);
      return rawDb.prepare('SELECT * FROM projects WHERE name = ?').get(name);
    },
    getSession: (id) => {
      const s = rawDb.prepare('SELECT s.*, p.name as project_name FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?').get(id);
      return s;
    },
    upsertSession: (id, projId, name) => {
      rawDb.prepare('INSERT OR REPLACE INTO sessions (id, project_id, name) VALUES (?, ?, ?)').run(id, projId, name);
    },
    getProjectNotes: (id) => { const r = rawDb.prepare('SELECT notes FROM projects WHERE id = ?').get(id); return r?.notes || ''; },
    setProjectNotes: (id, notes) => rawDb.prepare('UPDATE projects SET notes = ? WHERE id = ?').run(notes, id),
    setProjectState: (id, state) => rawDb.prepare('UPDATE projects SET state = ? WHERE id = ?').run(state, id),
    renameProject: (id, name) => rawDb.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id),
    setSetting: (k, v) => rawDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, typeof v === 'string' ? v : JSON.stringify(v)),
    getSetting: (k, fb) => { const r = rawDb.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : fb; },
  };

  const app = express();
  app.use(express.json());

  const { checkAuthStatus } = registerCoreRoutes(app, {
    db,
    safe,
    config,
    sessionUtils,
    keepalive: { getStatus: async () => ({}), setMode() {}, getMode: () => 'always', isRunning: () => false, start() {}, stop() {} },
    fireEvent: () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tmuxName: (id) => `wb_${id}`,
    tmuxExists: async () => false,
    enforceTmuxLimit: async () => {},
    resolveSessionId: async () => {},
    getBrowserCount: () => 0,
    CLAUDE_HOME,
    WORKSPACE,
    ensureSettings: async () => {},
    sleep: async () => {},
  });

  return { app, db, WORKSPACE, CLAUDE_HOME, tmpDir };
}

// === mkdir tests ===

test('MKDIR-01: POST /api/mkdir creates directory', async () => {
  const { app, WORKSPACE } = makeApp();
  await withServer(app, async ({ port }) => {
    const targetPath = path.join(WORKSPACE, 'new-folder');
    const r = await req(port, 'POST', '/api/mkdir', { path: targetPath });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    const stat = await fsp.stat(targetPath);
    assert.ok(stat.isDirectory());
  });
});

test('MKDIR-02: POST /api/mkdir rejects empty path', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/mkdir', {});
    assert.equal(r.status, 400);
  });
});

// === upload tests ===

test('UPLOAD-01: POST /api/upload writes file', async () => {
  const { app, WORKSPACE } = makeApp();
  const dir = path.join(WORKSPACE, 'upload-test');
  await fsp.mkdir(dir, { recursive: true });
  await withServer(app, async ({ port }) => {
    const r = await fetch(`http://localhost:${port}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Dir': dir, 'X-Upload-Filename': 'test.txt' },
      body: 'hello upload',
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    const content = await fsp.readFile(path.join(dir, 'test.txt'), 'utf-8');
    assert.equal(content, 'hello upload');
  });
});

test('UPLOAD-02: POST /api/upload rejects missing headers', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await fetch(`http://localhost:${port}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: 'data',
    });
    assert.equal(r.status, 400);
  });
});

// === project config tests ===

test('PROJCFG-01: GET /api/projects/:name/config returns config', async () => {
  const { app, db, WORKSPACE } = makeApp();
  const projPath = path.join(WORKSPACE, 'cfg-proj');
  await fsp.mkdir(projPath, { recursive: true });
  db.ensureProject('cfg-proj', projPath);
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/projects/cfg-proj/config')).json();
    assert.equal(r.name, 'cfg-proj');
    assert.equal(r.state, 'active');
  });
});

test('PROJCFG-02: PUT /api/projects/:name/config saves state and notes', async () => {
  const { app, db, WORKSPACE } = makeApp();
  const projPath = path.join(WORKSPACE, 'cfg-proj2');
  await fsp.mkdir(projPath, { recursive: true });
  db.ensureProject('cfg-proj2', projPath);
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'PUT', '/api/projects/cfg-proj2/config', { state: 'archived', notes: 'test notes' });
    assert.equal(r.status, 200);
    const verify = await (await req(port, 'GET', '/api/projects/cfg-proj2/config')).json();
    assert.equal(verify.state, 'archived');
    assert.equal(verify.notes, 'test notes');
  });
});

test('PROJCFG-03: GET /api/projects/:name/config returns 404 for unknown project', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'GET', '/api/projects/nonexistent/config');
    assert.equal(r.status, 404);
  });
});

// === session endpoint tests ===

test('SESSION-01: POST /api/sessions/:id/session mode=info returns session info', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'POST', '/api/sessions/test123/session', { mode: 'info' })).json();
    assert.equal(r.sessionId, 'test123');
    assert.ok(r.sessionFile.includes('.jsonl'));
  });
});

test('SESSION-02: POST /api/sessions/:id/session mode=transition returns prompt', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'POST', '/api/sessions/test123/session', { mode: 'transition' })).json();
    assert.ok(r.prompt);
    assert.ok(r.prompt.includes('checklist'));
  });
});

test('SESSION-03: POST /api/sessions/:id/session mode=resume returns prompt with tail', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await (await req(port, 'POST', '/api/sessions/test123/session', { mode: 'resume' })).json();
    assert.ok(r.prompt);
    assert.ok(r.prompt.includes('resuming'));
  });
});

test('SESSION-04: POST /api/sessions/:id/session rejects unknown mode', async () => {
  const { app } = makeApp();
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions/test123/session', { mode: 'bogus' });
    assert.equal(r.status, 400);
  });
});
