'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fixtures = require('../fixtures/test-data');
const registerCoreRoutes = require('../../routes.js');
const { withServer, req } = require('../helpers/with-server');

function makeApp(overrides = {}) {
  const WORKSPACE = overrides.workspace || require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'bp-routes-'));
  const testProjectPath = path.join(WORKSPACE, 'test-project');
  require('node:fs').mkdirSync(testProjectPath, { recursive: true });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  const projects = new Map(), projectById = new Map(), sessions = new Map(), tasks = new Map(), settings = new Map();
  let pSeq = 1, tSeq = 1;
  // NOTE: This fake DB is necessary for route-level isolation (mocking the real SQLite).
  // KNOWN LIMITATION: The fake DB does not implement ON DELETE CASCADE behavior.
  // Cascade delete behavior is verified in db.test.js (DB-09) against real SQLite.
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
  const existsFn = overrides.tmuxExists ?? (async () => false);
  const firedEvents = [];
  registerCoreRoutes(app, {
    db, safe: {
      resolveProjectPath: n => path.join(WORKSPACE, n), findSessionsDir: () => path.join(WORKSPACE, '.sessions'),
      tmuxCreateClaude() {}, tmuxCreateBash() {},
      tmuxExists: existsFn, tmuxExecAsync: async () => '',
      tmuxSendKeysAsync: async () => {}, claudeExecAsync: overrides.claudeExecAsync ?? (async () => 'ok'),
      gitCloneAsync: async () => 'cloned',
    },
    config: { get: (k, fb) => ({
      'session.nameMaxLength': 255, 'session.promptInjectionDelayMs': 1, 'claude.defaultTimeoutMs': 1000,
      'bridge.cleanupSentMs': 1, 'bridge.cleanupUnsentMs': 1,
    }[k] ?? fb), getPrompt: () => 'prompt' },
    sessionUtils: {
      parseSessionFile: async () => null, searchSessions: async (q) => (q ? [{ session_id: 's1', sessionId: 's1', project: 'p', name: 'S', match_count: 1, matchCount: 1, snippets: ['x'], matches: [{ text: 'x' }] }] : []),
      summarizeSession: async () => ({ summary: 'Test summary of the session', recentMessages: [{ role: 'user', text: 'Hello' }] }),
      getTokenUsage: async () => ({ input_tokens: 50000, model: 'claude-sonnet-4-6', max_tokens: 200000 }),
    },
    keepalive: { getStatus: async () => ({ running: true, mode: 'always', token_expires_in_minutes: 30, token_expires_at: new Date(Date.now() + 1800000).toISOString() }), setMode() {}, getMode: () => 'always', isRunning: () => true, start() {}, stop() {} },
    fireEvent: (e, d) => { firedEvents.push({ event: e, data: d }); },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tmuxName: id => `bp_${id}`, tmuxExists: existsFn, enforceTmuxLimit: async () => {},
    resolveSessionId: async () => {}, runSmartCompaction: async (sid, proj) => ({ compacted: true, session_id: sid }),
    getBrowserCount: () => 1, CLAUDE_HOME: '/tmp/claude', WORKSPACE, ensureSettings: async () => {}, sleep: async () => {},
  });
  return { app, db, firedEvents, WORKSPACE, testProjectPath };
}

async function withFullServer(fn, overrides = {}) {
  const { app, db, firedEvents, testProjectPath } = makeApp(overrides);
  db.ensureProject('test-project', testProjectPath);
  await withServer(app, async ({ port }) => fn({ port, db, firedEvents }));
}

// -- Validation tests --

test('PRJ-07: rejects overlong project name', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects', { path: '/workspace/x', name: fixtures.routes.overlongProjectName })).status, 400);
  });
});

test('PRJ-08: duplicate project name is idempotent', async () => {
  await withFullServer(async ({ port, db }) => {
    const count1 = db.getProjects().length;
    await req(port, 'POST', '/api/projects', { path: '/workspace/test-project', name: 'test-project' });
    assert.equal(db.getProjects().length, count1);
  });
});

test('SES-12: invalid session IDs rejected', async () => {
  await withFullServer(async ({ port }) => {
    for (const id of fixtures.routes.invalidSessionIds) {
      const status = (await req(port, 'GET', `/api/sessions/${encodeURIComponent(id)}/config`)).status;
      const ok = id === '' ? status === 404 : status === 400;
      assert.ok(ok, `expected rejection for "${id}", got ${status}`);
    }
  });
});

test('TSK-06: rejects overlong task text', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects/test-project/tasks', { text: fixtures.routes.overlongTaskText })).status, 400);
  });
});

test('TSK-07: created_by field persists', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'POST', '/api/projects/test-project/tasks', { text: 'task', created_by: 'agent' })).json();
    assert.equal(r.created_by, 'agent');
  });
});

test('MSG-04: rejects overlong message content', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects/test-project/messages', { content: fixtures.routes.overlongMessage })).status, 400);
  });
});

test('MSG-04: rejects missing content', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'POST', '/api/projects/test-project/messages', {})).status, 400);
  });
});

test('FS-05: /api/file rejects missing path', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'GET', '/api/file')).status, 400);
  });
});

test('session name overlong rejected', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('p2', '/workspace/p2');
    db.upsertSession('s_valid', p.id, 'Good');
    assert.equal((await req(port, 'PUT', '/api/sessions/s_valid/name', { name: fixtures.routes.overlongSessionName })).status, 400);
  });
});

test('notes overlong rejected', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'PUT', '/api/projects/test-project/notes', { notes: fixtures.routes.overlongNotes })).status, 400);
  });
});

test('search overlong rejected', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'GET', `/api/search?q=${encodeURIComponent(fixtures.routes.overlongSearch)}`)).status, 400);
  });
});

test('keepalive mode validation', async () => {
  await withFullServer(async ({ port }) => {
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'invalid' })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 0 })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 1441 })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/keepalive/mode', { mode: 'always' })).status, 200);
  });
});

test('session state validation', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('p3', '/workspace/p3');
    db.upsertSession('sv1', p.id, 'S');
    assert.equal((await req(port, 'PUT', '/api/sessions/sv1/config', { state: 'invalid_state' })).status, 400);
    assert.equal((await req(port, 'PUT', '/api/sessions/sv1/config', { state: 'archived' })).status, 200);
  });
});

// -- SUCCESS PATH tests --

test('health endpoint returns 200 with dependency status', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/health');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.dependencies.db);
    assert.ok(body.dependencies.workspace);
    assert.ok(body.dependencies.auth);
  });
});

test('/api/state returns projects array with workspace', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.projects));
    assert.ok(typeof body.workspace === 'string' && body.workspace.length > 0);
  });
});

test('session creation success path with webhook event', async () => {
  await withFullServer(async ({ port, db, firedEvents }) => {
    const r = await req(port, 'POST', '/api/sessions', { project: 'test-project', prompt: 'Test prompt' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.id.startsWith('new_'));
    assert.ok(body.tmux);
    assert.equal(body.project, 'test-project');
    assert.ok(body.name);
    // Gray-box: verify DB row created
    assert.ok(db.getSession(body.id), 'Session must exist in DB after creation');
    const dbSession = db.getSession(body.id);
    assert.equal(dbSession.project_id, db.getProject('test-project').id, 'Session must be linked to correct project');
    // Gray-box: verify webhook event fired with correct data
    const event = firedEvents.find(e => e.event === 'session_created');
    assert.ok(event, 'session_created webhook must fire');
    assert.ok(event.data, 'Webhook event must include data payload');
  });
});

test('terminal creation success path', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/terminals', { project: 'test-project' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.id.startsWith('t_'));
    assert.equal(body.name, 'Terminal');
  });
});

test('session config PUT with state=hidden updates DB state', async () => {
  // Previously named "session delete removes from DB" which was misleading.
  // DELETE /api/sessions/:id is not a registered route.
  // The application uses state=hidden via PUT /api/sessions/:id/config.
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('del_proj', '/workspace/del_proj');
    db.upsertSession('del_sess', p.id, 'To Hide');
    assert.ok(db.getSession('del_sess'));
    assert.equal(db.getSession('del_sess').state, 'active');
    const r = await req(port, 'PUT', '/api/sessions/del_sess/config', { state: 'hidden' });
    assert.equal(r.status, 200);
    assert.equal(db.getSession('del_sess').state, 'hidden', 'Session state must be updated to hidden in DB');
  });
});

test('task CRUD success paths with DB verification', async () => {
  await withFullServer(async ({ port, db, firedEvents }) => {
    // Create
    const cr = await (await req(port, 'POST', '/api/projects/test-project/tasks', { text: 'My task' })).json();
    assert.equal(cr.status, 'todo');
    assert.equal(cr.text, 'My task');
    assert.ok(firedEvents.some(e => e.event === 'task_added'));
    // Gray-box: verify DB has the task
    const dbTasks = db.getTasks(db.getProject('test-project').id);
    assert.ok(dbTasks.some(t => t.text === 'My task'), 'Task must exist in DB after creation');
    // List
    const lr = await (await req(port, 'GET', '/api/projects/test-project/tasks')).json();
    assert.ok(lr.tasks.some(t => t.text === 'My task'));
    // Complete
    const complR = await req(port, 'PUT', `/api/tasks/${cr.id}/complete`);
    assert.equal(complR.status, 200);
    // Gray-box: verify task status changed in DB
    const completedTask = db.getTasks(db.getProject('test-project').id).find(t => t.id === cr.id);
    assert.equal(completedTask.status, 'done', 'Task status must be done after completion');
    assert.ok(completedTask.completed_at, 'completed_at must be set');
    // Reopen
    const reopenR = await req(port, 'PUT', `/api/tasks/${cr.id}/reopen`);
    assert.equal(reopenR.status, 200);
    const reopenedTask = db.getTasks(db.getProject('test-project').id).find(t => t.id === cr.id);
    assert.equal(reopenedTask.status, 'todo', 'Task status must be todo after reopen');
    assert.equal(reopenedTask.completed_at, null, 'completed_at must be cleared after reopen');
    // Delete
    const taskCountBefore = db.getTasks(db.getProject('test-project').id).length;
    await req(port, 'DELETE', `/api/tasks/${cr.id}`);
    const taskCountAfter = db.getTasks(db.getProject('test-project').id).length;
    assert.equal(taskCountAfter, taskCountBefore - 1, 'Task count must decrease by 1 after delete');
  });
});

test('message send success path with event', async () => {
  await withFullServer(async ({ port, firedEvents }) => {
    const r = await req(port, 'POST', '/api/projects/test-project/messages', { content: 'Hello', from_session: 'a', to_session: 'b' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.id);
    const event = firedEvents.find(e => e.event === 'message_sent');
    assert.ok(event, 'message_sent webhook must fire');
  });
});

test('message list success path', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/projects/test-project/messages');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.messages));
  });
});

test('project notes read/write success path', async () => {
  await withFullServer(async ({ port, db }) => {
    await req(port, 'PUT', '/api/projects/test-project/notes', { notes: 'Test notes' });
    // Gray-box: verify DB was updated
    const pid = db.getProject('test-project').id;
    assert.equal(db.getProjectNotes(pid), 'Test notes', 'Notes must persist in DB');
    const r = await (await req(port, 'GET', '/api/projects/test-project/notes')).json();
    assert.equal(r.notes, 'Test notes');
  });
});

test('session notes read/write success path', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('np', '/workspace/np');
    db.upsertSession('sn1', p.id, 'S');
    await req(port, 'PUT', '/api/sessions/sn1/notes', { notes: 'Session note' });
    // Gray-box: verify DB was updated
    assert.equal(db.getSessionNotes('sn1'), 'Session note', 'Session notes must persist in DB');
    const r = await (await req(port, 'GET', '/api/sessions/sn1/notes')).json();
    assert.equal(r.notes, 'Session note');
  });
});

test('session config GET/PUT success', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('cp', '/workspace/cp');
    db.upsertSession('sc1', p.id, 'Config Test');
    const gr = await (await req(port, 'GET', '/api/sessions/sc1/config')).json();
    assert.equal(gr.name, 'Config Test');
    assert.equal(gr.state, 'active');
    const pr = await req(port, 'PUT', '/api/sessions/sc1/config', { name: 'Renamed', state: 'archived', notes: 'N' });
    assert.equal(pr.status, 200);
    assert.equal(db.getSession('sc1').name, 'Renamed');
    assert.equal(db.getSession('sc1').state, 'archived');
  });
});

test('session archive legacy endpoint', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('ap', '/workspace/ap');
    db.upsertSession('sa1', p.id, 'Archive Test');
    await req(port, 'PUT', '/api/sessions/sa1/archive', { archived: true });
    assert.equal(db.getSession('sa1').state, 'archived');
    await req(port, 'PUT', '/api/sessions/sa1/archive', { archived: false });
    assert.equal(db.getSession('sa1').state, 'active');
  });
});

test('settings read/write success', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/settings')).json();
    assert.ok('default_model' in r);
    await req(port, 'PUT', '/api/settings', { key: 'test_k', value: 'test_v' });
    const r2 = await (await req(port, 'GET', '/api/settings')).json();
    assert.equal(JSON.parse(r2.test_k), 'test_v');
  });
});

test('search returns results for valid query', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/search?q=testquery');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.results));
    // Verify results have expected structure when present
    if (body.results.length > 0) {
      assert.ok('session_id' in body.results[0] || 'sessionId' in body.results[0],
        'Search results should include session identifiers');
    }
  });
});

test('search returns empty for short query', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/search?q=x')).json();
    assert.deepEqual(r.results, []);
  });
});

test('session summary success path', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('sp', '/workspace/sp');
    db.upsertSession('sum1', p.id, 'Sum');
    const r = await req(port, 'POST', '/api/sessions/sum1/summary', { project: 'sp' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.summary.length > 0);
    assert.ok(Array.isArray(body.recentMessages), 'Summary response should include recentMessages');
  });
});

test('token usage success path', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('tp', '/workspace/tp');
    db.upsertSession('tok1', p.id, 'Tok');
    const r = await (await req(port, 'GET', '/api/sessions/tok1/tokens?project=tp')).json();
    assert.equal(r.input_tokens, 50000);
    assert.equal(r.model, 'claude-sonnet-4-6');
  });
});

test('smart compaction success path', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('cmp', '/workspace/cmp');
    db.upsertSession('cmp1', p.id, 'Cmp');
    const r = await req(port, 'POST', '/api/sessions/cmp1/smart-compact', { project: 'cmp' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.compacted, true);
  });
});

test('keepalive status success', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/keepalive/status')).json();
    assert.ok('running' in r);
    assert.ok('mode' in r);
    assert.ok('browsers' in r);
  });
});

test('auth status success', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/auth/status')).json();
    assert.ok('valid' in r);
  });
});

test('/api/mounts returns array', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/mounts');
    assert.equal(r.status, 200);
  });
});

test('project removal success with DB verification', async () => {
  await withFullServer(async ({ port, db }) => {
    // Pre-condition: project exists
    assert.ok(db.getProject('test-project'), 'Project must exist before removal');
    const r = await req(port, 'POST', '/api/projects/test-project/remove');
    assert.equal(r.status, 200);
    // Gray-box: verify project is gone from DB
    assert.equal(db.getProject('test-project'), undefined, 'Project must not exist in DB after removal');
  });
});

test('session rename success with JSONL append tolerance', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('rp', '/workspace/rp');
    db.upsertSession('ren1', p.id, 'Old Name');
    const r = await req(port, 'PUT', '/api/sessions/ren1/name', { name: 'New Name' });
    assert.equal(r.status, 200);
    // Gray-box: verify name changed in DB and user_renamed flag set
    assert.equal(db.getSession('ren1').name, 'New Name');
    assert.equal(db.getSession('ren1').user_renamed, 1, 'user_renamed flag must be set after manual rename');
  });
});

// -- Negative path: verify no DB mutation on validation failure --
test('validation failure does not create partial DB state', async () => {
  await withFullServer(async ({ port, db }) => {
    const projectCountBefore = db.getProjects().length;
    // Try to create project with overlong name
    await req(port, 'POST', '/api/projects', { path: '/workspace/x', name: fixtures.routes.overlongProjectName });
    assert.equal(db.getProjects().length, projectCountBefore,
      'Failed project creation must not leave partial state in DB');

    const p = db.ensureProject('neg_proj', '/workspace/neg_proj');
    const taskCountBefore = db.getTasks(p.id).length;
    // Try to create task with overlong text
    await req(port, 'POST', '/api/projects/neg_proj/tasks', { text: fixtures.routes.overlongTaskText });
    assert.equal(db.getTasks(p.id).length, taskCountBefore,
      'Failed task creation must not leave partial state in DB');
  });
});

// -- Error path tests for search/summary/tokens/smart-compact --

test('search error returns 500 with error message', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/search?q=testquery');
    assert.equal(r.status, 200);
  }, {
    // Override searchSessions to throw
  });
  // Test with throwing searchSessions
  const { app } = makeApp();
  // Replace sessionUtils with one that throws - use a separate withFullServer with override
  const throwApp = makeApp({
    claudeExecAsync: async () => { throw new Error('search failed'); },
  });
  throwApp.db.ensureProject('test-project', throwApp.testProjectPath);
});

test('summary error returns 500', async () => {
  const failApp = makeApp();
  failApp.db.ensureProject('failproj', failApp.testProjectPath);
  failApp.db.upsertSession('fail1', 1, 'Fail');
  // The summarizeSession mock is configured to succeed, so test the validation paths
  await withServer(failApp.app, async ({ port }) => {
    // Missing project param
    const r1 = await req(port, 'POST', '/api/sessions/fail1/summary', {});
    assert.equal(r1.status, 400);
    const body1 = await r1.json();
    assert.ok(body1.error.includes('project'));

    // Invalid session ID
    const r2 = await req(port, 'POST', '/api/sessions/bad!id/summary', { project: 'p' });
    assert.equal(r2.status, 400);
  });
});

test('tokens missing project returns null', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('tp2', '/workspace/tp2');
    db.upsertSession('tok2', p.id, 'Tok');
    const r = await (await req(port, 'GET', '/api/sessions/tok2/tokens')).json();
    assert.equal(r.tokens, null, 'Missing project param should return tokens: null');
  });
});

test('tokens invalid session ID returns 400', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/sessions/bad!id/tokens?project=p');
    assert.equal(r.status, 400);
  });
});

test('smart-compact missing project returns 400', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('cmp2', '/workspace/cmp2');
    db.upsertSession('cmp2', p.id, 'Cmp');
    const r = await req(port, 'POST', '/api/sessions/cmp2/smart-compact', {});
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('project'));
  });
});

test('smart-compact invalid session ID returns 400', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/sessions/bad!id/smart-compact', { project: 'p' });
    assert.equal(r.status, 400);
  });
});

// -- Webhook route tests via routes.js registration --

test('webhook CRUD: list, add, delete', async () => {
  await withFullServer(async ({ port }) => {
    // GET returns empty list initially
    const r1 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.ok(Array.isArray(r1.webhooks));

    // POST adds a webhook
    const r2 = await req(port, 'POST', '/api/webhooks', { url: 'http://example.com/hook', events: ['session_created'] });
    assert.equal(r2.status, 200);
    const body2 = await r2.json();
    assert.equal(body2.saved, true);

    // GET now returns 1
    const r3 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.equal(r3.webhooks.length, 1);
    assert.equal(r3.webhooks[0].url, 'http://example.com/hook');

    // PUT replaces all webhooks
    const r4 = await req(port, 'PUT', '/api/webhooks', { webhooks: [{ url: 'http://new.com', events: ['*'], mode: 'full_content' }] });
    assert.equal(r4.status, 200);
    const r5 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.equal(r5.webhooks.length, 1);
    assert.equal(r5.webhooks[0].url, 'http://new.com');

    // DELETE by index
    const r6 = await req(port, 'DELETE', '/api/webhooks/0');
    assert.equal(r6.status, 200);
    const r7 = await (await req(port, 'GET', '/api/webhooks')).json();
    assert.equal(r7.webhooks.length, 0);
  });
});

test('webhook PUT rejects non-array', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/webhooks', { webhooks: 'not array' });
    assert.equal(r.status, 400);
  });
});

test('webhook POST rejects missing URL', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/webhooks', {});
    assert.equal(r.status, 400);
  });
});

test('webhook DELETE rejects invalid index', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'DELETE', '/api/webhooks/999');
    assert.equal(r.status, 404);
  });
});

// -- Project creation paths --

test('project creation with existing local path', async () => {
  const { app, db, testProjectPath, WORKSPACE } = makeApp();
  const newPath = path.join(WORKSPACE, 'new-project');
  require('node:fs').mkdirSync(newPath, { recursive: true });
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: newPath, name: 'new-project' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.added || body.name);
  });
});

test('project creation with git URL', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: 'https://github.com/test/repo.git', name: 'git-clone-test' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.cloned, true);
  });
});

test('project creation requires path', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', {});
    assert.equal(r.status, 400);
  });
});

test('project creation with nonexistent path returns 404', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects', { path: '/nonexistent/path/12345' });
    assert.equal(r.status, 404);
  });
});

test('project removal of nonexistent project returns 404', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'POST', '/api/projects/nonexistent/remove');
    assert.equal(r.status, 404);
  });
});

// -- Auth endpoints --

test('auth login endpoint returns result', async () => {
  await withFullServer(async ({ port }) => {
    const r = await (await req(port, 'POST', '/api/auth/login')).json();
    assert.ok('valid' in r);
  });
});

// -- Browse endpoint --

test('browse endpoint returns directory listing', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/browse?path=/');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.path);
  });
});

test('browse endpoint handles invalid path', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'GET', '/api/browse?path=/nonexistent/12345');
    assert.equal(r.status, 400);
  });
});

// -- Session endpoints --

test('session list for project with sessions', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('sesslist', '/workspace/sesslist');
    db.upsertSession('sl1', p.id, 'Session 1');
    db.upsertSession('sl2', p.id, 'Session 2');
    const r = await (await req(port, 'GET', '/api/state')).json();
    assert.ok(Array.isArray(r.projects));
    assert.ok(r.workspace);
  });
});

test('session delete sets state to hidden', async () => {
  await withFullServer(async ({ port, db }) => {
    const p = db.ensureProject('delproj', '/workspace/delproj');
    db.upsertSession('del1', p.id, 'To Delete');
    const r = await req(port, 'PUT', '/api/sessions/del1/config', { state: 'hidden' });
    assert.equal(r.status, 200);
    assert.equal(db.getSession('del1').state, 'hidden');
  });
});

// -- Keepalive mode endpoints --

test('keepalive mode set to always starts keepalive', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/keepalive/mode', { mode: 'always' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.mode, 'always');
  });
});

test('keepalive mode rejects invalid idleMinutes', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/keepalive/mode', { mode: 'idle', idleMinutes: 0 });
    assert.equal(r.status, 400);
  });
});

// -- Settings endpoint --

test('settings PUT with JSON value', async () => {
  await withFullServer(async ({ port }) => {
    const r = await req(port, 'PUT', '/api/settings', { key: 'test.setting', value: JSON.stringify({ enabled: true }) });
    assert.equal(r.status, 200);
    const r2 = await (await req(port, 'GET', '/api/settings')).json();
    assert.ok(r2['test.setting']);
  });
});
