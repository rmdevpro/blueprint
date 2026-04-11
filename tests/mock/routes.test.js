'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fixtures = require('../fixtures/test-data');
const registerCoreRoutes = require('../../routes.js');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  const projects = new Map(), projectById = new Map(), sessions = new Map(), tasks = new Map(), settings = new Map();
  let pSeq = 1, tSeq = 1;
  const db = {
    getProjects: () => [...projects.values()], getProject: n => projects.get(n), getProjectById: id => projectById.get(id),
    ensureProject: (n, p) => { if (projects.has(n)) return projects.get(n); const r = { id: pSeq++, name: n, path: p, notes: '' }; projects.set(n, r); projectById.set(r.id, r); return r; },
    deleteProject: id => { const r = projectById.get(id); if (r) { projects.delete(r.name); projectById.delete(id); } },
    getSessionsForProject: pid => [...sessions.values()].filter(s => s.project_id === pid),
    getSession: id => sessions.get(id), getSessionByPrefix: pfx => [...sessions.values()].find(s => s.id.startsWith(pfx)),
    getSessionFull: id => { const s = sessions.get(id); if (!s) return; const p = projectById.get(s.project_id); return { ...s, project_name: p?.name }; },
    upsertSession: (id, pid, name) => { const e = sessions.get(id) || { id, project_id: pid, archived: 0, state: 'active', notes: '' }; const r = { ...e, id, project_id: pid, name: e.name ?? name, updated_at: new Date().toISOString() }; sessions.set(id, r); return r; },
    renameSession: (id, name) => { const s = sessions.get(id); if (s) { s.name = name; s.user_renamed = 1; } },
    setSessionState: (id, st) => { const s = sessions.get(id); if (s) { s.state = st; s.archived = st === 'archived' ? 1 : 0; } },
    archiveSession: (id, a) => { const s = sessions.get(id); if (s) { s.archived = a ? 1 : 0; s.state = a ? 'archived' : 'active'; } },
    deleteSession: id => sessions.delete(id),
    getProjectNotes: id => projectById.get(id)?.notes || '', setProjectNotes: (id, n) => { const p = projectById.get(id); if (p) p.notes = n; },
    getSessionNotes: id => sessions.get(id)?.notes || '', setSessionNotes: (id, n) => { const s = sessions.get(id); if (s) s.notes = n; },
    getTasks: pid => [...tasks.values()].filter(t => t.project_id === pid),
    addTask: (pid, text, cb = 'human') => { const r = { id: tSeq++, project_id: pid, text, status: 'todo', created_by: cb, completed_at: null }; tasks.set(r.id, r); return r; },
    completeTask: id => { const t = tasks.get(Number(id)); if (t) { t.status = 'done'; t.completed_at = new Date().toISOString(); } },
    reopenTask: id => { const t = tasks.get(Number(id)); if (t) { t.status = 'todo'; t.completed_at = null; } },
    deleteTask: id => tasks.delete(Number(id)),
    getUnreadMessages: () => [], getRecentMessages: () => [], sendMessage: () => ({ id: 1 }), markMessageRead() {},
    getAllSettings: () => Object.fromEntries(settings), getSetting: (k, fb = null) => settings.has(k) ? settings.get(k) : fb, setSetting: (k, v) => settings.set(k, v),
    DATA_DIR: '/tmp/bp-data',
  };
  registerCoreRoutes(app, {
    db, safe: { resolveProjectPath: n => `/workspace/${n}`, findSessionsDir: () => '/tmp/sessions', tmuxCreateClaude() {}, tmuxCreateBash() {}, tmuxExists: async () => false, tmuxExecAsync: async () => '', tmuxSendKeysAsync: async () => {}, claudeExecAsync: async () => 'ok', gitCloneAsync: async () => 'cloned' },
    config: { get: (k, fb) => ({ 'session.nameMaxLength': 255, 'session.promptInjectionDelayMs': 1, 'claude.defaultTimeoutMs': 1000, 'bridge.cleanupSentMs': 1, 'bridge.cleanupUnsentMs': 1 }[k] ?? fb), getPrompt: () => 'prompt' },
    sessionUtils: { parseSessionFile: async () => null, searchSessions: async () => [], summarizeSession: async () => ({ summary: 's', recentMessages: [] }), getTokenUsage: async () => ({ input_tokens: 0, model: null, max_tokens: 200000 }) },
    keepalive: { getStatus: async () => ({ running: false, mode: 'always', token_expires_in_minutes: 0, token_expires_at: new Date(0).toISOString() }), setMode() {}, getMode: () => 'always', isRunning: () => false, start() {}, stop() {} },
    fireEvent: () => {}, logger: { info() {}, warn() {}, error() {}, debug() {} },
    tmuxName: id => `bp_${id}`, tmuxExists: async () => false, enforceTmuxLimit: async () => {},
    resolveSessionId: async () => {}, runSmartCompaction: async () => ({ compacted: true }),
    getBrowserCount: () => 0, CLAUDE_HOME: '/tmp/claude', WORKSPACE: '/workspace', ensureSettings: async () => {}, sleep: async () => {},
  });
  return { app, db };
}

async function withServer(fn) {
  const { app, db } = makeApp();
  db.ensureProject('test-project', '/workspace/test-project');
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try { await fn({ port, db }); }
  finally { await new Promise(r => server.close(r)); }
}

async function req(port, method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`http://127.0.0.1:${port}${path}`, opts);
}

test('PRJ-07: rejects overlong project name', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects', { path: '/workspace/x', name: fixtures.routes.overlongProjectName })).status, 400);
  });
});

test('PRJ-08: duplicate project name is idempotent', async () => {
  await withServer(async ({ port, db }) => {
    const count1 = db.getProjects().length;
    await req(port, 'POST', '/api/projects', { path: '/workspace/test-project', name: 'test-project' });
    assert.equal(db.getProjects().length, count1); // no new row
  });
});

test('SES-12: invalid session IDs rejected', async () => {
  await withServer(async ({ port }) => {
    for (const id of fixtures.routes.invalidSessionIds) {
      // Empty string yields /api/sessions//config, which Express 404s before the
      // handler — 404 still constitutes rejection. Any 4xx is acceptable.
      const { status } = await req(port, 'GET', `/api/sessions/${encodeURIComponent(id)}/config`);
      assert.ok(status >= 400 && status < 500, `expected 4xx for "${id}", got ${status}`);
    }
  });
});

test('TSK-06: rejects overlong task text', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects/test-project/tasks', { text: fixtures.routes.overlongTaskText })).status, 400);
  });
});

test('TSK-07: created_by field persists', async () => {
  await withServer(async ({ port, db }) => {
    const r = await (await req(port, 'POST', '/api/projects/test-project/tasks', { text: 'task', created_by: 'agent' })).json();
    assert.equal(r.created_by, 'agent');
  });
});

test('MSG-04: rejects overlong message content', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects/test-project/messages', { content: fixtures.routes.overlongMessage })).status, 400);
  });
});

test('MSG-04: rejects missing content', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects/test-project/messages', {})).status, 400);
  });
});

test('FS-05: /api/file rejects missing path', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'GET', '/api/file')).status, 400);
  });
});

test('session name overlong rejected', async () => {
  await withServer(async ({ port, db }) => {
    const p = db.ensureProject('p2', '/workspace/p2');
    db.upsertSession('s_valid', p.id, 'Good');
    assert.equal((await req(port, 'PUT', '/api/sessions/s_valid/name', { name: fixtures.routes.overlongSessionName })).status, 400);
  });
});

test('notes overlong rejected', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'PUT', '/api/projects/test-project/notes', { notes: fixtures.routes.overlongNotes })).status, 400);
  });
});

test('search overlong rejected', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'GET', `/api/search?q=${encodeURIComponent(fixtures.routes.overlongSearch)}`)).status, 400);
  });
});

test('keepalive mode validation', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'invalid' })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 0 })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 1441 })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'always' })).status, 200);
  });
});

test('session state validation', async () => {
  await withServer(async ({ port, db }) => {
    const p = db.ensureProject('p3', '/workspace/p3');
    db.upsertSession('sv1', p.id, 'S');
    assert.equal((await req(port, 'PUT', '/api/sessions/sv1/config', { state: 'invalid_state' })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/sessions/sv1/config', { state: 'archived' })).status, 200);
  });
});
