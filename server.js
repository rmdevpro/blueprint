const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { readdir, readFile, writeFile, stat, unlink, mkdir, copyFile } = require('fs/promises');
const { watchFile, unwatchFile } = require('fs');
const { join, basename } = require('path');
const { execSync, execFileSync } = require('child_process');
const db = require('./db');
const safe = require('./safe-exec');
const keepalive = require('./keepalive');
const { registerMcpRoutes } = require('./mcp-tools');
const { registerOpenAIRoutes } = require('./openai-compat');
const { fireEvent, registerWebhookRoutes } = require('./webhooks');
const { registerExternalMcpRoutes } = require('./mcp-external');
const { registerQuorumRoutes } = require('./quorum');
const config = require('./config');
const sessionUtils = require('./session-utils');

const PORT = process.env.PORT || 3000;
const CLAUDE_HOME = safe.CLAUDE_HOME;
const WORKSPACE = safe.WORKSPACE;
let browserCount = 0;

// Prevent server crashes from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err.message, err.stack);
  process.exit(1); // Let Docker restart cleanly rather than limp in undefined state
});
process.on('unhandledRejection', (err) => {
  console.error('[server] Unhandled rejection:', err);
});
// CLAUDE_HOME and WORKSPACE imported from safe-exec above

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(join(__dirname, 'public')));

// Serve xterm.js from node_modules
app.use('/lib/xterm', express.static(join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/lib/xterm-fit', express.static(join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/lib/xterm-web-links', express.static(join(__dirname, 'node_modules/@xterm/addon-web-links')));

// ── API: Browse filesystem ────────────────────────────────────────────────

app.get('/api/browse', async (req, res) => {
  try {
    const targetPath = (req.query.path || '/').replace(/\/+/g, '/') || '/';
    const entries = await readdir(targetPath, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, type: 'directory' });
      } else if (entry.isSymbolicLink()) {
        try {
          const realStat = await stat(join(targetPath, entry.name));
          if (realStat.isDirectory()) dirs.push({ name: entry.name, type: 'directory' });
        } catch {}
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: targetPath, parent: join(targetPath, '..'), entries: dirs });
  } catch (err) {
    res.status(400).json({ error: `Cannot browse: ${err.message}` });
  }
});

// ── API: Read file contents ───────────────────────────────────────────────

app.get('/api/file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).send('path required');
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) return res.status(400).send('not a file');
    if (fileStat.size > 1024 * 1024) return res.status(413).send('file too large (>1MB)');
    const content = await readFile(filePath, 'utf-8');
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(400).send(`Cannot read file: ${err.message}`);
  }
});

// ── jQuery File Tree connector ────────────────────────────────────────────
const jqftConnector = require('jqueryfiletree/dist/connectors/jqueryFileTree');
app.post('/api/jqueryfiletree', jqftConnector.getDirList);

// Serve jQuery File Tree static assets
app.use('/lib/jqueryfiletree', express.static(join(__dirname, 'node_modules/jqueryfiletree/dist')));
app.use('/lib/jquery', express.static(join(__dirname, 'node_modules/jquery/dist')));

// ── API: Add/Remove projects ───────────────────────────────────────────────

app.post('/api/projects', async (req, res) => {
  try {
    let { path: projectPath, name } = req.body;
    if (!projectPath) return res.status(400).json({ error: 'path required' });
    projectPath = projectPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

    // Check if it's a git clone URL
    if (projectPath.startsWith('http') || projectPath.startsWith('git@')) {
      const repoName = name || projectPath.split('/').pop().replace('.git', '');
      const targetPath = join(WORKSPACE, repoName);
      try {
        await stat(targetPath);
        return res.status(409).json({ error: 'Directory already exists' });
      } catch {}
      safe.gitClone(projectPath, targetPath);
      const project = db.ensureProject(repoName, targetPath);
      await trustDir(targetPath);
      return res.json({ name: repoName, path: targetPath, cloned: true });
    }

    // It's a local path — just register in DB, no symlinks
    try {
      await stat(projectPath);
    } catch {
      return res.status(404).json({ error: 'Path does not exist' });
    }
    const projectName = name || basename(projectPath);
    const project = db.ensureProject(projectName, projectPath);
    await trustDir(projectPath);
    return res.json({ name: projectName, path: projectPath, added: true });
  } catch (err) {
    console.error('Error adding project:', err);
    res.status(500).json({ error: err.message });
  }
});

// Remove project from Blueprint list (does NOT delete any files)
app.post('/api/projects/:name/remove', (req, res) => {
  try {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    db.deleteProject(project.id);
    res.json({ removed: req.params.name });
  } catch (err) {
    console.error('Error removing project:', err);
    res.status(500).json({ error: err.message });
  }
});

async function trustDir(dirPath) {
  const configFile = join(CLAUDE_HOME, '.claude.json');
  let config = {};
  try { config = JSON.parse(await readFile(configFile, 'utf-8')); } catch {
    // .claude.json doesn't exist yet — will create
  }
  if (!config.projects) config.projects = {};
  config.projects[dirPath] = {
    hasTrustDialogAccepted: true,
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
  };
  await writeFile(configFile, JSON.stringify(config, null, 2));
}

// ── API: Auth status check ─────────────────────────────────────────────────

app.get('/api/auth/status', async (req, res) => {
  try {
    const status = await checkAuthStatus();
    res.json(status);
  } catch (err) {
    res.json({ valid: false, reason: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    // Spawn a non-interactive claude login and return the URL
    const result = await safe.claudeExecAsync(['--print', 'test'], { timeout: 10000 });
    // If it works, auth is fine
    res.json({ valid: true });
  } catch (err) {
    res.json({ valid: false, reason: err.message });
  }
});

async function checkAuthStatus() {
  const credsFile = join(CLAUDE_HOME, '.credentials.json');
  try {
    const raw = await readFile(credsFile, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;

    if (!oauth || !oauth.accessToken) {
      return { valid: false, reason: 'no_credentials' };
    }

    if (oauth.accessToken === 'expired' || oauth.refreshToken === 'expired') {
      return { valid: false, reason: 'invalid_credentials' };
    }

    // Check if access token is expired (with 5 min buffer)
    // The CLI handles refresh automatically via the refresh token,
    // so we only flag as invalid if there's no refresh token
    if (!oauth.refreshToken) {
      const expiresAt = oauth.expiresAt || 0;
      if (Date.now() > expiresAt) {
        return { valid: false, reason: 'expired_no_refresh' };
      }
    }

    return { valid: true, expiresAt: oauth.expiresAt };
  } catch {
    return { valid: false, reason: 'no_credentials_file' };
  }
}

// ── API: Keepalive status ──────────────────────────────────────────────────

app.get('/api/keepalive/status', (req, res) => {
  res.json({ ...keepalive.getStatus(), browsers: browserCount });
});

app.put('/api/keepalive/mode', (req, res) => {
  const { mode, idleMinutes } = req.body;
  if (!['always', 'browser', 'idle'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be always, browser, or idle' });
  }
  keepalive.setMode(mode, idleMinutes);
  // If switching to 'always' and not running, start it
  if (mode === 'always' && !keepalive.isRunning()) keepalive.start();
  // If switching to 'browser' and no browsers, stop it
  if (mode === 'browser' && browserCount === 0) keepalive.stop();
  res.json({ mode: keepalive.getMode(), running: keepalive.isRunning() });
});

// ── API: List projects and their sessions ──────────────────────────────────

app.get('/api/state', async (req, res) => {
  try {
    const projects = [];

    // Only show projects explicitly added by the user (stored in DB)
    const dbProjects = db.getProjects();

    for (const dbProject of dbProjects) {
      const projectName = dbProject.name;
      const projectPath = dbProject.path;
      const project = dbProject;

      // Check if project directory still exists
      let dirMissing = false;
      try { await stat(projectPath); } catch { dirMissing = true; }

      // Claude stores sessions under ~/.claude/projects/{encoded-path}/
      const sessionsDir = safe.findSessionsDir(projectPath);

      // Sync JSONL files → DB
      try {
        const sessionFiles = await readdir(sessionsDir);
        for (const file of sessionFiles) {
          if (!file.endsWith('.jsonl')) continue;
          const sessionId = basename(file, '.jsonl');
          const fileMeta = await sessionUtils.parseSessionFile(join(sessionsDir, file));
          if (fileMeta) {
            db.upsertSession(sessionId, project.id, fileMeta.name);
          }
        }
      } catch {
        // No sessions dir for this project yet
      }

      // Resolve any remaining new_* sessions against unmatched JSONL files
      const currentSessions = db.getSessionsForProject(project.id);
      const staleTmps = currentSessions.filter(s => s.id.startsWith('new_'));
      if (staleTmps.length > 0) {
        const dbIds = new Set(currentSessions.map(s => s.id));
        try {
          const files = await readdir(sessionsDir);
          const unmatched = files.filter(f => f.endsWith('.jsonl') && !dbIds.has(basename(f, '.jsonl')));
          for (const tmp of staleTmps) {
            if (unmatched.length > 0) {
              const realFile = unmatched.shift();
              const realId = basename(realFile, '.jsonl');
              db.upsertSession(realId, project.id, tmp.name || null);
              if (tmp.user_renamed) db.renameSession(realId, tmp.name);
              if (tmp.notes) db.setSessionNotes(realId, tmp.notes);
              if (tmp.state && tmp.state !== 'active') db.setSessionState(realId, tmp.state);
              db.deleteSession(tmp.id);
              const oldTmux = tmuxName(tmp.id);
              const newTmux = tmuxName(realId);
              try { safe.tmuxExec(['rename-session', '-t', oldTmux, newTmux]); } catch {}
              console.log(`[state-resolve] ${tmp.id.substring(0, 12)} → ${realId.substring(0, 8)}`);
            } else if (!tmuxExists(tmuxName(tmp.id))) {
              // No JSONL and tmux dead — clean up
              db.deleteSession(tmp.id);
            }
          }
        } catch {}
      }

      // Read sessions from DB (source of truth for names, archive status)
      const dbSessions = db.getSessionsForProject(project.id);

      // Enrich with live data from JSONL files
      const sessions = [];
      for (const s of dbSessions) {
        const jsonlPath = join(sessionsDir, `${s.id}.jsonl`);
        const fileMeta = await sessionUtils.parseSessionFile(jsonlPath);
        sessions.push({
          id: s.id,
          name: s.name || fileMeta?.name || 'Untitled Session',
          timestamp: fileMeta?.timestamp || s.updated_at,
          messageCount: fileMeta?.messageCount || 0,
          tmux: tmuxName(s.id),
          active: tmuxExists(tmuxName(s.id)),
          state: s.state || (s.archived ? 'archived' : 'active'),
          archived: !!s.archived,
          project_missing: dirMissing,
        });
      }

      sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      projects.push({ name: projectName, path: projectPath, sessions, missing: dirMissing });
    }

    projects.sort((a, b) => {
      const aTime = a.sessions[0]?.timestamp || '1970-01-01';
      const bTime = b.sessions[0]?.timestamp || '1970-01-01';
      return new Date(bTime) - new Date(aTime);
    });

    res.json({ projects, workspace: WORKSPACE });
  } catch (err) {
    console.error('Error listing state:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Create new session ────────────────────────────────────────────────

app.post('/api/sessions', async (req, res) => {
  try {
    const { project, prompt } = req.body;
    if (!project) return res.status(400).json({ error: 'project required' });

    const dbProject = db.getProject(project);
    const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
    try {
      await stat(projectPath);
    } catch {
      return res.status(410).json({ error: 'Project directory not found — it may have been moved or deleted' });
    }

    // Snapshot existing JSONL files before creating session
    const sessionsDir = safe.findSessionsDir(projectPath);
    let existingFiles = new Set();
    try {
      const files = await readdir(sessionsDir);
      existingFiles = new Set(files.filter(f => f.endsWith('.jsonl')));
    } catch {
      // No sessions dir yet — first session for this project
    }

    const tmpId = `new_${Date.now()}`;
    const tmux = tmuxName(tmpId);

    await ensureSettings();

    const model = db.getSetting('default_model', '"claude-sonnet-4-6"');
    const claudeArgs = [];
    try { const m = JSON.parse(model); if (m) claudeArgs.push('--model', m); } catch {
      // Invalid JSON in default_model setting — use CLI default
    }

    await enforceTmuxLimit(); // Kill oldest if over limit
    safe.tmuxCreateClaude(tmux, projectPath, claudeArgs);

    // Return immediately — don't wait. Terminal connects instantly.
    // Store the snapshot so the background resolver can find the real UUID.
    const proj = db.ensureProject(project, projectPath);
    const nameMaxLen = config.get('session.nameMaxLength', 60);
    const sessionName = (prompt && prompt.replace(/\s+/g, ' ').trim()) ? prompt.substring(0, nameMaxLen).replace(/\n/g, ' ').trim() : 'New Session';
    db.upsertSession(tmpId, proj.id, sessionName);

    // If a prompt was provided, inject it into the tmux session after a brief delay
    // to allow Claude CLI to finish starting up
    if (prompt) {
      setTimeout(() => {
        try { safe.tmuxSendKeys(tmux, prompt); } catch (err) {
          console.error(`[session] Failed to send initial prompt to ${tmux}:`, err.message);
        }
      }, config.get('session.promptInjectionDelayMs', 2000));
    }

    // Background: resolve real UUID after JSONL appears
    resolveSessionId(tmpId, tmux, sessionsDir, existingFiles, proj.id);

    fireEvent('session_created', { session_id: tmpId, project });
    res.json({ id: tmpId, tmux, project, name: sessionName });
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Create plain bash terminal ───────────────────────────────────────

app.post('/api/terminals', async (req, res) => {
  try {
    const { project } = req.body;
    if (!project) return res.status(400).json({ error: 'project required' });

    const dbProject = db.getProject(project);
    const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
    try {
      await stat(projectPath);
    } catch {
      return res.status(410).json({ error: 'Project directory not found' });
    }

    const termId = `t_${Date.now()}`;
    const tmux = tmuxName(termId);

    await enforceTmuxLimit();
    safe.tmuxCreateBash(tmux, projectPath);

    res.json({ id: termId, tmux, project, name: 'Terminal' });
  } catch (err) {
    console.error('Error creating terminal:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Resume session ────────────────────────────────────────────────────

app.post('/api/sessions/:sessionId/resume', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { project } = req.body;
    if (!project) return res.status(400).json({ error: 'project required' });

    const dbProject = db.getProject(project);
    const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
    try {
      await stat(projectPath);
    } catch {
      return res.status(410).json({ error: 'Project directory not found — it may have been moved or deleted' });
    }
    const tmux = tmuxName(sessionId);

    if (!safe.tmuxExists(tmux)) {
      await ensureSettings();
      // Temp sessions (new_*) have no Claude session to resume — create fresh
      const claudeArgs = sessionId.startsWith('new_') ? [] : ['--resume', sessionId];
      safe.tmuxCreateClaude(tmux, projectPath, claudeArgs);

      await sleep(1000);
    }

    res.json({ id: sessionId, tmux, project });
  } catch (err) {
    console.error('Error resuming session:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Rename session ────────────────────────────────────────────────────

app.put('/api/sessions/:sessionId/name', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });

    db.renameSession(sessionId, name.trim());

    // Propagate rename to CLI by appending a summary entry to the JSONL
    // The CLI reads session names from summary entries in the JSONL file
    try {
      const session = db.getSessionFull(sessionId);
      if (session && session.project_name) {
        const projectPath = db.getProject(session.project_name)?.path;
        if (projectPath) {
          const sessionsDir = safe.findSessionsDir(projectPath);
          const jsonlFile = join(sessionsDir, `${sessionId}.jsonl`);
          const { appendFileSync } = require('fs');
          const summaryEntry = JSON.stringify({
            type: 'summary',
            summary: name.trim(),
            timestamp: new Date().toISOString(),
          });
          try { appendFileSync(jsonlFile, '\n' + summaryEntry); } catch {}
        }
      }
    } catch {}

    res.json({ id: sessionId, name: name.trim() });
  } catch (err) {
    console.error('Error renaming session:', err);
    res.status(500).json({ error: err.message });
  }
});

/* DISABLED: Hard deletion causes zombie sessions. /api/state (lines 240-253)
 * re-syncs JSONL files from disk into the DB on every call, so deleted sessions
 * reappear. The unlink can also fail silently (file locks, wrong path), leaving
 * orphaned JSONL that the sync loop resurrects. The temp-ID resolver (lines 256-283)
 * then mis-pairs orphaned files with new sessions, causing identity swaps.
 * Use archive/hidden state instead — PUT /api/sessions/:id/config { state: 'archived' }
 * See: GitHub Issue #457
 *
 * app.delete('/api/sessions/:sessionId', async (req, res) => {
 *   try {
 *     const { sessionId } = req.params;
 *     const project = req.query.project || req.body?.project;
 *     if (!project) return res.status(400).json({ error: 'project required (pass as query param ?project=name)' });
 *     const tmux = tmuxName(sessionId);
 *     if (safe.tmuxExists(tmux)) { safe.tmuxKill(tmux); }
 *     const dbProj = db.getProject(project);
 *     const projectPath = dbProj ? dbProj.path : safe.resolveProjectPath(project);
 *     const sessionsDir = safe.findSessionsDir(projectPath);
 *     const jsonlFile = join(sessionsDir, `${sessionId}.jsonl`);
 *     try { await unlink(jsonlFile); } catch {}
 *     db.deleteSession(sessionId);
 *     db.deleteSessionMeta(sessionId);
 *     res.json({ deleted: sessionId });
 *   } catch (err) {
 *     console.error('Error deleting session:', err);
 *     res.status(500).json({ error: err.message });
 *   }
 * });
 */

// ── API: Session config (state, model, notes) ─────────────────────────────

app.get('/api/sessions/:sessionId/config', (req, res) => {
  try {
    const session = db.getSessionFull(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });
    res.json({
      id: session.id,
      name: session.name,
      state: session.state || (session.archived ? 'archived' : 'active'),
      notes: session.notes || '',
      project: session.project_name,
    });
  } catch (err) {
    console.error('Error getting session config:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sessions/:sessionId/config', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { name, state, notes } = req.body;

    if (name !== undefined) db.renameSession(sessionId, name);
    if (state !== undefined) db.setSessionState(sessionId, state);
    if (notes !== undefined) db.setSessionNotes(sessionId, notes);

    res.json({ saved: true });
  } catch (err) {
    console.error('Error updating session config:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Archive / Unarchive session (legacy, kept for compat) ─────────────

app.put('/api/sessions/:sessionId/archive', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { archived } = req.body;

    db.setSessionState(sessionId, archived ? 'archived' : 'active');
    res.json({ id: sessionId, archived: !!archived });
  } catch (err) {
    console.error('Error archiving session:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Project notes ─────────────────────────────────────────────────────

app.get('/api/projects/:name/notes', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'project not found' });
  res.json({ notes: db.getProjectNotes(project.id) });
});

app.put('/api/projects/:name/notes', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'project not found' });
  db.setProjectNotes(project.id, req.body.notes || '');
  res.json({ saved: true });
});

// ── API: Session notes ─────────────────────────────────────────────────────

app.get('/api/sessions/:id/notes', (req, res) => {
  res.json({ notes: db.getSessionNotes(req.params.id) });
});

app.put('/api/sessions/:id/notes', (req, res) => {
  db.setSessionNotes(req.params.id, req.body.notes || '');
  res.json({ saved: true });
});

// ── API: Tasks ─────────────────────────────────────────────────────────────

app.get('/api/projects/:name/tasks', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'project not found' });
  res.json({ tasks: db.getTasks(project.id) });
});

app.post('/api/projects/:name/tasks', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const { text, created_by } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const task = db.addTask(project.id, text, created_by || 'human');
  fireEvent('task_added', { task_id: task.id, project: req.params.name, text });
  res.json(task);
});

app.put('/api/tasks/:id/complete', (req, res) => {
  db.completeTask(req.params.id);
  res.json({ done: true });
});

app.put('/api/tasks/:id/reopen', (req, res) => {
  db.reopenTask(req.params.id);
  res.json({ reopened: true });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.deleteTask(req.params.id);
  res.json({ deleted: true });
});

// ── API: Inter-session messages ────────────────────────────────────────────

app.get('/api/projects/:name/messages', (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'project not found' });
  res.json({ messages: db.getRecentMessages(project.id) });
});

app.post('/api/projects/:name/messages', async (req, res) => {
  const project = db.getProject(req.params.name);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const { from_session, to_session, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  const msg = db.sendMessage(project.id, from_session || null, to_session || null, content);
  fireEvent('message_sent', { message_id: msg.id, project: req.params.name, from_session, to_session, content });

  // If targeting a specific session, inject via file bridge
  if (to_session) {
    const { randomUUID } = require('crypto');
    const bridgeDir = join(db.DATA_DIR, 'bridges');
    await mkdir(bridgeDir, { recursive: true });
    const bridgeFile = join(bridgeDir, `msg_${randomUUID()}.md`);
    await writeFile(bridgeFile, `# Message from ${from_session || 'human'}\n\n${content}\n`);

    const tmux = tmuxName(to_session);
    let delivered = false;
    if (safe.tmuxExists(tmux)) {
      try {
        await safe.claudeExecAsync(['--resume', to_session, '--dangerously-skip-permissions', '--no-session-persistence', '--print', bridgeFile],
          { cwd: project.path, timeout: 30000 });
        delivered = true;
      } catch (err) {
        console.error(`[messages] Failed to deliver bridge file to ${to_session}:`, err.message?.substring(0, 100));
      }
    }

    // Clean up: delivered files after 5s, undelivered after 1 hour
    setTimeout(async () => {
      try { await unlink(bridgeFile); } catch {}
    }, delivered ? 5000 : 3600000);
  }

  res.json(msg);
});

// ── API: Settings ──────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const settings = db.getAllSettings();
  // Defaults
  const defaults = {
    default_model: 'claude-sonnet-4-6',
    thinking_level: 'none',
    keepalive_mode: 'always',
    keepalive_idle_minutes: 30,
    tasks_enabled: true,
  };
  res.json({ ...defaults, ...settings });
});

app.put('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  db.setSetting(key, JSON.stringify(value));

  // Apply keepalive settings immediately
  if (key === 'keepalive_mode') {
    const idleMins = db.getSetting('keepalive_idle_minutes', '30');
    keepalive.setMode(value, parseInt(idleMins));
    if (value === 'always' && !keepalive.isRunning()) keepalive.start();
    if (value === 'browser' && browserCount === 0) keepalive.stop();
  }
  if (key === 'keepalive_idle_minutes') {
    const mode = db.getSetting('keepalive_mode', '"always"');
    try { keepalive.setMode(JSON.parse(mode), parseInt(value)); } catch {
      // Invalid JSON in keepalive_mode setting — ignore
    }
  }

  res.json({ saved: true });
});

// ── API: CLAUDE.md management ──────────────────────────────────────────────

app.get('/api/claude-md/global', async (req, res) => {
  try {
    const file = join(process.env.HOME || '/home/hopper', '.claude', 'CLAUDE.md');
    const content = await readFile(file, 'utf-8').catch(() => '');
    res.json({ content });
  } catch { res.json({ content: '' }); }
});

app.put('/api/claude-md/global', async (req, res) => {
  try {
    const file = join(process.env.HOME || '/home/hopper', '.claude', 'CLAUDE.md');
    await writeFile(file, req.body.content || '');
    res.json({ saved: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/projects/:name/claude-md', async (req, res) => {
  try {
    const dbProj = db.getProject(req.params.name);
    const projectPath = dbProj ? dbProj.path : join(WORKSPACE, req.params.name);
    const file = join(projectPath, 'CLAUDE.md');
    let content = '';
    try { content = await readFile(file, 'utf-8'); } catch {
      // If no project CLAUDE.md exists, use the default template
      const template = db.getSetting('default_project_claude_md', '""');
      try { content = JSON.parse(template); } catch { content = ''; }
      if (content) {
        await writeFile(file, content);
      }
    }
    res.json({ content });
  } catch { res.json({ content: '' }); }
});

app.put('/api/projects/:name/claude-md', async (req, res) => {
  try {
    const dbProj = db.getProject(req.params.name);
    const projectPath = dbProj ? dbProj.path : join(WORKSPACE, req.params.name);
    const file = join(projectPath, 'CLAUDE.md');
    await writeFile(file, req.body.content || '');
    res.json({ saved: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: MCP Servers ───────────────────────────────────────────────────────

app.get('/api/mcp-servers', async (req, res) => {
  try {
    const configFile = join(CLAUDE_HOME, 'settings.json');
    const raw = await readFile(configFile, 'utf-8');
    const config = JSON.parse(raw);
    res.json({ servers: config.mcpServers || {} });
  } catch {
    res.json({ servers: {} });
  }
});

app.put('/api/mcp-servers', async (req, res) => {
  try {
    const { servers } = req.body;
    const configFile = join(CLAUDE_HOME, 'settings.json');
    let config = {};
    try {
      const raw = await readFile(configFile, 'utf-8');
      config = JSON.parse(raw);
    } catch {}
    config.mcpServers = servers || {};
    await writeFile(configFile, JSON.stringify(config, null, 2));
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Session search ────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ results: [] });
    const results = await sessionUtils.searchSessions(q, null, 20);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Session summary ───────────────────────────────────────────────────

app.post('/api/sessions/:sessionId/summary', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { project } = req.body;
    if (!project) return res.status(400).json({ error: 'project required' });
    const result = await sessionUtils.summarizeSession(sessionId, project);
    res.json({ summary: result.summary, recentMessages: result.recentMessages });
  } catch (err) {
    console.error('Error generating summary:', err.message);
    res.status(500).json({ error: err.message?.substring(0, 100) });
  }
});

// ── API: Session token usage ───────────────────────────────────────────────

app.get('/api/sessions/:sessionId/tokens', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { project } = req.query;
    if (!project) return res.json({ tokens: null });
    const result = await sessionUtils.getTokenUsage(sessionId, project);
    res.json(result);
  } catch {
    res.json({ input_tokens: 0, model: null, max_tokens: 200000 });
  }
});

// ── API: Smart Compaction ──────────────────────────────────────────────────

const compactionState = new Map(); // sessionId → { nudged65, nudged75, nudged85, autoTriggered }
const MAX_COMPACTION_ENTRIES = 100;

// JSONL file watchers (replace polling)
const sessionWsClients = new Map();   // tmuxSession → ws
const jsonlWatchPaths = new Map();    // tmuxSession → { jsonlPath, sessionId, project }
const jsonlDebounceTimers = new Map(); // tmuxSession → timer

app.post('/api/sessions/:sessionId/smart-compact', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { project } = req.body;
    if (!project) return res.status(400).json({ error: 'project required' });

    const result = await runSmartCompaction(sessionId, project);
    res.json(result);
  } catch (err) {
    console.error('Smart compaction error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Guard against concurrent compaction on the same session
const compactionLocks = new Set();

async function runSmartCompaction(sessionId, project) {
  if (compactionLocks.has(sessionId)) {
    console.log(`[compact] Session ${sessionId.substring(0, 8)} already compacting — skipping`);
    return { compacted: false, reason: 'compaction already in progress' };
  }
  compactionLocks.add(sessionId);

  try {
    return await _runSmartCompaction(sessionId, project);
  } finally {
    compactionLocks.delete(sessionId);
  }
}

async function _runSmartCompaction(sessionId, project) {
  const dbProj = db.getProject(project);
  const projectPath = dbProj ? dbProj.path : safe.resolveProjectPath(project);
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session ID');

  // If sessionId is a new_* temp ID, resolve it to the real UUID for JSONL access.
  // JSONL files are always UUID-named; new_* only exists in the DB during the resolution window.
  // Keep the original ID for tmux — the session is still named after the new_* ID until resolved.
  const tmuxSessionId = sessionId;
  if (sessionId.startsWith('new_')) {
    if (!dbProj) {
      return { compacted: false, reason: 'temp session: project not found in DB' };
    }
    const sDir = safe.findSessionsDir(projectPath);
    try {
      const files = await readdir(sDir);
      const knownIds = new Set(db.getSessionsForProject(dbProj.id).map(s => s.id));
      const unmatched = files.filter(f => f.endsWith('.jsonl') && !knownIds.has(basename(f, '.jsonl')));
      if (unmatched.length === 1) {
        sessionId = basename(unmatched[0], '.jsonl');
        if (compactionLocks.has(sessionId)) {
          return { compacted: false, reason: 'compaction already in progress' };
        }
      } else {
        return { compacted: false, reason: 'temp session not yet resolved -- retry later' };
      }
    } catch {
      return { compacted: false, reason: 'cannot resolve temp session ID' };
    }
  }

  const tmux = tmuxName(tmuxSessionId);
  if (!safe.tmuxExists(tmux)) {
    return { compacted: false, reason: 'session not running' };
  }

  console.log(`[compact] Starting smart compaction for session ${sessionId.substring(0, 8)} in ${project}`);

  const { execFile: execFileAsync } = require('child_process');
  const pollInterval = config.get('compaction.pollIntervalMs', 3000);
  const captureLines = config.get('compaction.tmuxCaptureLines', 50);
  const safeTmux = safe.sanitizeTmuxName(tmux);
  const maxPrepTurns = config.get('compaction.maxPrepTurns', 10);
  const maxRecoveryTurns = config.get('compaction.maxRecoveryTurns', 6);
  const checkerModel = config.get('compaction.checkerModel', 'claude-haiku-4-5-20251001');

  const capturePaneAsync = () => new Promise((resolve, reject) => {
    execFileAsync('tmux', ['capture-pane', '-t', safeTmux, '-p', '-S', `-${captureLines}`], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });

  // Strip ANSI escape codes from tmux output
  const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

  // Wait for Session A to finish responding (prompt character appears)
  const waitForPrompt = async (timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    let lastOutput = '';
    while (Date.now() < deadline) {
      await sleep(pollInterval);
      try {
        const output = stripAnsi(await capturePaneAsync());
        const lines = output.split('\n').filter(l => l.trim());
        // Check last 4 non-empty lines — status bar occupies the final line(s),
        // pushing the actual ❯ prompt to second-to-last or earlier.
        if (lines.slice(-4).some(l => /^\s*❯\s*$/.test(l)) && output !== lastOutput) {
          return output;
        }
        lastOutput = output;
      } catch (err) {
        if (!safe.tmuxExists(tmux)) return null;
      }
    }
    // Timeout — return whatever we have
    try { return stripAnsi(await capturePaneAsync()); } catch { return ''; }
  };

  // Send a message to Session B (the checker) and get its response
  let checkerSessionId = null;
  const sendToChecker = async (message) => {
    const args = ['--print', '--dangerously-skip-permissions', '--model', checkerModel];
    if (checkerSessionId) {
      args.push('--resume', checkerSessionId);
    }
    args.push(message);
    try {
      const response = (await safe.claudeExecAsync(args, { cwd: projectPath, timeout: 120000 })).trim();
      // Capture session ID from first call for resume
      if (!checkerSessionId) {
        // Find the most recently modified JSONL (the one the checker just created)
        const sessionsDir = safe.findSessionsDir(projectPath);
        try {
          const files = await readdir(sessionsDir);
          const jsonls = files.filter(f => f.endsWith('.jsonl'));
          let newest = null;
          let newestMtime = 0;
          for (const f of jsonls) {
            const s = await stat(join(sessionsDir, f));
            if (s.mtimeMs > newestMtime) {
              newestMtime = s.mtimeMs;
              newest = f;
            }
          }
          if (newest) checkerSessionId = newest.replace('.jsonl', '');
          console.log(`[compact] Checker session ID: ${checkerSessionId?.substring(0, 12)}`);
        } catch {}
      }
      return response;
    } catch (err) {
      console.error(`[compact] Checker error: ${err.message}`);
      if (err.stderr) console.error(`[compact] Checker stderr: ${err.stderr?.substring(0, 500)}`);
      return null;
    }
  };

  // Parse JSON blueprint commands from checker response
  const parseBlueprint = (response) => {
    if (!response) return null;
    const lines = response.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{"blueprint"')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.blueprint) return parsed.blueprint;
        } catch {}
      }
    }
    return null;
  };

  // Extract the message to send to Session A (everything except blueprint JSON)
  const extractAgentMessage = (response) => {
    if (!response) return '';
    return response.split('\n')
      .filter(line => !line.trim().startsWith('{"blueprint"'))
      .join('\n')
      .trim();
  };

  // ── PRE-PHASE ─────────────────────────────────────────────────────────
  // Per guide Phase 1 Step 1: Blueprint creates recent_turns.md and enters plan mode
  // BEFORE opening Session B.

  // Compaction context dir
  const contextDir = join(db.DATA_DIR, 'compaction');
  await mkdir(contextDir, { recursive: true });
  const planCopyPath = join(contextDir, `plan_${sessionId.substring(0, 8)}.md`);
  const recentTurnsFile = join(contextDir, 'recent_turns.md');

  // Step 1a: Extract recent_turns.md from JSONL BEFORE compaction while history is full
  const sessionsDir = safe.findSessionsDir(projectPath);
  const jsonlFile = join(sessionsDir, `${sessionId}.jsonl`);
  const tailPercent = config.get('compaction.conversationTailPercent', 20);
  try {
    const jsonlContent = await readFile(jsonlFile, 'utf-8');
    const jsonlLines = jsonlContent.trim().split('\n');
    const exchanges = [];
    for (const line of jsonlLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content : JSON.stringify(entry.message.content);
          exchanges.push(`Human: ${text}`);
        } else if (entry.type === 'assistant' && entry.message?.content) {
          const blocks = Array.isArray(entry.message.content) ? entry.message.content : [entry.message.content];
          const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (text) exchanges.push(`Assistant: ${text}`);
        }
      } catch {}
    }
    const tailCount = Math.max(1, Math.floor(exchanges.length * tailPercent / 100));
    const tail = exchanges.slice(-tailCount);
    await writeFile(recentTurnsFile, tail.join('\n\n---\n\n') + '\n');
    console.log(`[compact] Wrote recent_turns.md: ${tail.length}/${exchanges.length} exchanges`);
  } catch (err) {
    console.error('[compact] Failed to write recent_turns.md:', err.message?.substring(0, 100));
    await writeFile(recentTurnsFile, '(No conversation history available)\n');
  }

  // Step 1b: Enter plan mode
  let baselineOutput = '';
  try { baselineOutput = stripAnsi(await capturePaneAsync()); } catch {}

  safe.tmuxSendKeys(tmux, '/plan');
  console.log('[compact] Sent /plan to agent — waiting for plan mode to activate...');

  const planModeDeadline = Date.now() + 30000;
  let planModeActive = false;
  while (Date.now() < planModeDeadline) {
    await sleep(pollInterval);
    try {
      const output = stripAnsi(await capturePaneAsync());
      if (output !== baselineOutput) { planModeActive = true; break; }
    } catch {}
  }
  if (!planModeActive) {
    console.error('[compact] Timed out waiting for plan mode to activate');
    return { compacted: false, reason: 'failed to enter plan mode' };
  }
  console.log('[compact] Plan mode active');

  // Helper: look up plan file path via session slug
  const getPlanFilePath = async () => {
    const slug = await sessionUtils.getSessionSlug(sessionId, projectPath);
    if (!slug) return null;
    return join(sessionUtils.CLAUDE_HOME, 'plans', `${slug}.md`);
  };

  // Helper: copy plan file to compaction dir — B reads via its Read tool
  const copyPlanFile = async () => {
    const planPath = await getPlanFilePath();
    if (!planPath) return null;
    try {
      await copyFile(planPath, planCopyPath);
      return planCopyPath;
    } catch { return null; }
  };

  // Helper: read A's latest assistant text from JSONL (not tmux capture)
  const agentJsonlFile = join(safe.findSessionsDir(projectPath), `${sessionId}.jsonl`);
  const readLatestAssistantText = async () => {
    try {
      const raw = await readFile(agentJsonlFile, 'utf-8');
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.content) {
            const blocks = Array.isArray(entry.message.content)
              ? entry.message.content : [entry.message.content];
            const text = blocks
              .filter(b => b && (b.type === 'text' || typeof b === 'string'))
              .map(b => (typeof b === 'string' ? b : b.text))
              .join('\n').trim();
            if (text) return text;
          }
        } catch {}
      }
    } catch {}
    return null;
  };

  // ── PHASE 1: PREP ──────────────────────────────────────────────────────

  // Step 2: Initialize Session B with compaction-prep.md
  console.log('[compact] Initializing process checker (Session B)...');
  const checkerPrompt = config.getPrompt('compaction-prep', {});
  let checkerResponse = await sendToChecker(checkerPrompt);
  let command = parseBlueprint(checkerResponse);

  if (command !== 'ready_to_connect') {
    console.error('[compact] Checker did not signal ready_to_connect — aborting');
    return { compacted: false, reason: 'checker failed to initialize' };
  }
  console.log('[compact] Checker ready.');

  // Step 3: Send exact prep prompt to A (Blueprint always sends this — never B)
  const prepPrompt = config.getPrompt('compaction-prep-to-agent', {}).trim();
  safe.tmuxSendKeys(tmux, prepPrompt);
  console.log('[compact] Sent prep prompt to agent');

  // Step 4: Notify B it is connected — nothing else
  await sendToChecker('This is Blueprint. You are now connected to the agent.');
  console.log('[compact] Notified B: connected');

  // Step 5: Mediation loop — A responds, Blueprint reads JSONL, sends to B, B coaches
  let prepDone = false;
  let agentMessage = '';
  for (let turn = 1; turn <= maxPrepTurns; turn++) {
    const agentOutput = await waitForPrompt(120000);
    if (agentOutput === null) {
      console.error('[compact] tmux session died during prep — aborting');
      return { compacted: false, reason: 'tmux session died during prep' };
    }

    const assistantText = await readLatestAssistantText();
    checkerResponse = await sendToChecker(assistantText ?? agentOutput);
    command = parseBlueprint(checkerResponse);

    if (command === 'error') {
      console.error('[compact] Checker signaled error — aborting prep');
      return { compacted: false, reason: 'checker signaled error during prep' };
    }

    if (command === 'read_plan_file') {
      console.log('[compact] Checker requested plan file — copying...');
      const copiedPath = await copyPlanFile();
      if (copiedPath) {
        checkerResponse = await sendToChecker(`Blueprint: The plan file has been copied to ${copiedPath}. Please Read that file to review its contents.`);
      } else {
        checkerResponse = await sendToChecker('Blueprint: The plan file does not exist yet — the agent is still editing in plan mode. Continue guiding until all sections are complete, then send {"blueprint": "exit_plan_mode"}.');
      }
      command = parseBlueprint(checkerResponse);
    }

    if (command === 'exit_plan_mode') {
      // Step 6: Exit plan mode programmatically via BTab
      console.log('[compact] exit_plan_mode received — exiting plan mode');
      safe.tmuxSendKey(tmux, 'BTab');
      await sleep(2000);
      await waitForPrompt(30000);

      // Copy plan file (for verification only — no message to B)
      const copiedPath = await copyPlanFile();
      if (copiedPath) {
        console.log(`[compact] Plan file copied: ${planCopyPath}`);
      } else {
        console.log('[compact] Warning: plan file not found after exit_plan_mode');
      }

      // Step 7: Immediately send Git prompt to A (Blueprint sends directly — not B)
      console.log('[compact] Sending Git prompt to agent');
      safe.tmuxSendKeys(tmux, 'If Git has been used during the session, update all Git issues and Commit all uncommitted work. If Git was not used during this session simply reply as such.');

      // Wait for A to finish Git work, send A's response to B
      const gitOutput = await waitForPrompt(120000);
      if (gitOutput) {
        const gitAssistantText = await readLatestAssistantText();
        checkerResponse = await sendToChecker(gitAssistantText ?? gitOutput);
        command = parseBlueprint(checkerResponse);
      }
      // B should now send ready_to_compact after seeing A's Git response
    }

    if (command === 'ready_to_compact') {
      prepDone = true;
      console.log(`[compact] Prep complete after ${turn} turns`);
      break;
    }

    // Relay B's coaching message to A
    agentMessage = extractAgentMessage(checkerResponse);
    if (agentMessage) {
      safe.tmuxSendKeys(tmux, agentMessage);
      console.log(`[compact] Prep turn ${turn}: relayed checker message to agent`);
    }
  }

  if (!prepDone) {
    console.log('[compact] Prep turn limit reached — proceeding with compaction anyway');
  }

  // Verify plan file
  try {
    const planStat = await stat(planCopyPath);
    console.log(`[compact] Plan file verified: ${planStat.size} bytes`);
  } catch {
    console.log('[compact] Warning: plan file not found after prep');
  }

  // ── PHASE 2: COMPACT ───────────────────────────────────────────────────

  try {
    safe.tmuxSendKeys(tmux, '/compact');
    console.log('[compact] Sent /compact to session');
  } catch (err) {
    console.error('[compact] Failed to send /compact:', err.message?.substring(0, 100));
    return { compacted: false, reason: 'failed to send /compact' };
  }

  const compactTimeout = config.get('compaction.compactTimeoutMs', 300000);
  const compactDeadline = Date.now() + compactTimeout;
  let compactionDone = false;
  let lastCompactionOutput = '';

  while (Date.now() < compactDeadline) {
    await sleep(pollInterval);
    try {
      const output = stripAnsi(await capturePaneAsync());
      const lines = output.split('\n').filter(l => l.trim());
      if (lines.slice(-4).some(l => /^\s*❯\s*$/.test(l)) && output !== lastCompactionOutput) {
        compactionDone = true;
        console.log('[compact] Compaction completed (prompt detected)');
        break;
      }
      lastCompactionOutput = output;
    } catch (err) {
      if (!safe.tmuxExists(tmux)) {
        console.error('[compact] tmux session disappeared during compaction');
        break;
      }
    }
  }
  if (!compactionDone) {
    console.log('[compact] Compaction poll timed out — proceeding with recovery');
  }

  // ── PHASE 3: RECOVERY ──────────────────────────────────────────────────

  // Step 8: Notify B compaction is complete — nothing else
  await sendToChecker(`This is Blueprint. Compaction is complete. The conversation tail file is at ${recentTurnsFile}. You are now reconnected to the agent.`);
  console.log('[compact] Notified B: compaction complete');

  // Step 9: Blueprint sends exact recovery prompt to A (never B's composition)
  const recoveryPrompt = config.getPrompt('compaction-resume', { CONVERSATION_TAIL_FILE: recentTurnsFile }).trim();
  safe.tmuxSendKeys(tmux, recoveryPrompt);
  console.log('[compact] Sent recovery prompt to agent');

  // Step 10: Recovery mediation loop — A responds, B coaches until resume_complete
  for (let turn = 1; turn <= maxRecoveryTurns; turn++) {
    const agentOutput = await waitForPrompt(120000);
    if (agentOutput === null) break;

    const recoveryAssistantText = await readLatestAssistantText();
    checkerResponse = await sendToChecker(recoveryAssistantText ?? agentOutput);
    command = parseBlueprint(checkerResponse);

    if (command === 'resume_complete') {
      console.log(`[compact] Recovery complete after ${turn} turns`);
      break;
    }

    agentMessage = extractAgentMessage(checkerResponse);
    if (agentMessage) {
      safe.tmuxSendKeys(tmux, agentMessage);
      console.log(`[compact] Recovery turn ${turn}: relayed checker message to agent`);
    }
  }

  // Clean up recent_turns.md after a delay
  const cleanupDelay = config.get('compaction.contextCleanupDelayMs', 60000);
  setTimeout(async () => {
    try { await unlink(recentTurnsFile); } catch {}
  }, cleanupDelay);

  console.log(`[compact] Smart compaction complete for session ${sessionId.substring(0, 8)}`);
  return { compacted: true, prep_completed: prepDone, compaction_completed: compactionDone, tail_file: recentTurnsFile };
}

// Check token usage and nudge/auto-compact
async function checkCompactionNeeds(sessionId, project) {
  // Skip unresolved temp sessions — JSONL is UUID-named, not new_*
  if (sessionId.startsWith('new_')) return;
  try {
    const usage = await sessionUtils.getTokenUsage(sessionId, project);
    const inputTokens = usage.input_tokens;
    const model = usage.model;
    const maxTokens = usage.max_tokens;
    const pct = maxTokens > 0 ? (inputTokens / maxTokens) * 100 : 0;

    if (!compactionState.has(sessionId)) {
      // Evict oldest entries if map is too large
      if (compactionState.size >= MAX_COMPACTION_ENTRIES) {
        const oldest = compactionState.keys().next().value;
        compactionState.delete(oldest);
      }
      compactionState.set(sessionId, { nudged65: false, nudged75: false, nudged85: false, autoTriggered: false });
    }
    const state = compactionState.get(sessionId);

    const tmux = tmuxName(sessionId);
    if (!tmuxExists(tmux)) return;

    const thresholds = config.get('compaction.thresholds', { advisory: 65, warning: 75, urgent: 85, auto: 90 });

    if (pct >= thresholds.auto && !state.autoTriggered) {
      state.autoTriggered = true;
      console.log(`[compact] Session ${sessionId.substring(0, 8)} at ${pct.toFixed(0)}% — AUTO COMPACTING`);
      safe.tmuxSendKeys(tmux, config.getPrompt('compaction-auto', { PERCENT: pct.toFixed(0) }));
      setTimeout(() => runSmartCompaction(sessionId, project), config.get('compaction.pollIntervalMs', 3000));
    } else if (pct >= thresholds.urgent && !state.nudged85) {
      state.nudged85 = true;
      safe.tmuxSendKeys(tmux, config.getPrompt('compaction-nudge-urgent', { PERCENT: pct.toFixed(0), AUTO_THRESHOLD: thresholds.auto }));
    } else if (pct >= thresholds.warning && !state.nudged75) {
      state.nudged75 = true;
      safe.tmuxSendKeys(tmux, config.getPrompt('compaction-nudge-warning', { PERCENT: pct.toFixed(0) }));
    } else if (pct >= thresholds.advisory && !state.nudged65) {
      state.nudged65 = true;
      safe.tmuxSendKeys(tmux, config.getPrompt('compaction-nudge-advisory', { PERCENT: pct.toFixed(0) }));
    }
  } catch (err) {
    console.error(`[compact] checkCompactionNeeds failed for ${sessionId.substring(0, 8)}:`, err.message?.substring(0, 100));
  }
}

// ── MCP Tools ──────────────────────────────────────────────────────────────

registerMcpRoutes(app);
registerOpenAIRoutes(app);
registerWebhookRoutes(app);
registerExternalMcpRoutes(app);
registerQuorumRoutes(app);

// ── WebSocket: Terminal PTY bridge ─────────────────────────────────────────

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/ws\/(.+)$/);

  if (!match) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleTerminalConnection(ws, match[1]);
  });
});

function handleTerminalConnection(ws, tmuxSession) {
  // Sanitize the session name from the URL to prevent tmux target injection
  tmuxSession = safe.sanitizeTmuxName(tmuxSession);
  if (!tmuxExists(tmuxSession)) {
    ws.send(JSON.stringify({ type: 'error', message: `No tmux session: ${tmuxSession}` }));
    ws.close();
    return;
  }

  const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSession], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  browserCount++;
  keepalive.onBrowserConnect();
  cancelTmuxCleanup(tmuxSession); // User reconnected — cancel pending cleanup
  console.log(`[ws] PTY attached to tmux session "${tmuxSession}", PID: ${ptyProcess.pid} (browsers: ${browserCount})`);

  // Track WS for token push; start JSONL watcher
  sessionWsClients.set(tmuxSession, ws);
  startJsonlWatcher(tmuxSession);

  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[ws] PTY exited (code ${exitCode}) for tmux "${tmuxSession}"`);
    if (ws.readyState === ws.OPEN) {
      ws.send('\r\n\x1b[33m[Session detached]\x1b[0m\r\n');
      ws.close();
    }
  });

  ws.on('message', (data) => {
    const msg = data.toString();

    if (msg.startsWith('{')) {
      try {
        const ctrl = JSON.parse(msg);
        if (ctrl.type === 'resize') { ptyProcess.resize(ctrl.cols, ctrl.rows); return; }
        if (ctrl.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      } catch {}
    }

    ptyProcess.write(msg);
  });

  ws.on('close', () => {
    browserCount = Math.max(0, browserCount - 1);
    keepalive.onBrowserDisconnect(browserCount);
    console.log(`[ws] Browser disconnected from tmux "${tmuxSession}" (browsers: ${browserCount})`);
    ptyProcess.kill();

    // Clean up WS tracking and JSONL watcher
    sessionWsClients.delete(tmuxSession);
    stopJsonlWatcher(tmuxSession);

    // Schedule tmux session cleanup if not reconnected
    scheduleTmuxCleanup(tmuxSession);
  });

  ws.on('error', (err) => {
    console.error(`[ws] WebSocket error for tmux "${tmuxSession}":`, err.message);
    ptyProcess.kill();
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Background resolver: maps new_ temp IDs to real Claude UUIDs
// Polls for JSONL to appear, then migrates DB entry and renames tmux session
const pendingResolutions = new Map(); // tmpId → { tmux, sessionsDir, existingFiles, projectId }

async function resolveSessionId(tmpId, tmux, sessionsDir, existingFiles, projectId) {
  const maxAttempts = 30; // 30 x 2s = 60s max wait
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    try {
      const currentFiles = await readdir(sessionsDir);
      const newFiles = currentFiles.filter(f => f.endsWith('.jsonl') && !existingFiles.has(f));
      if (newFiles.length >= 1) {
        const realId = basename(newFiles[0], '.jsonl');
        console.log(`[session-resolve] ${tmpId.substring(0, 12)} → ${realId.substring(0, 8)}`);

        // Migrate DB: copy name/notes/state from tmp entry to real entry
        const tmpSession = db.getSession(tmpId);
        db.upsertSession(realId, projectId, tmpSession?.name || null);
        // If user explicitly renamed the temp session, force that name onto the real entry.
        // upsertSession's COALESCE preserves existing names, so an explicit rename is needed.
        if (tmpSession?.user_renamed) {
          db.renameSession(realId, tmpSession.name);
        }
        if (tmpSession?.notes) db.setSessionNotes(realId, tmpSession.notes);
        if (tmpSession?.state && tmpSession.state !== 'active') db.setSessionState(realId, tmpSession.state);

        // Delete the temp entry
        db.deleteSession(tmpId);

        // Rename tmux session to match real UUID
        const newTmux = tmuxName(realId);
        try { safe.tmuxExec(['rename-session', '-t', tmux, newTmux]); } catch {
          // tmux session may have been killed — rename is best-effort
        }

        return;
      }
    } catch (err) {
      // readdir may fail if sessions dir doesn't exist yet — keep polling
      if (i === 0) console.log(`[session-resolve] Waiting for JSONL to appear for ${tmpId.substring(0, 12)}...`);
    }
  }
  console.log(`[session-resolve] ${tmpId.substring(0, 12)} — timeout, JSONL never appeared`);
  // Only clean up if the tmux session is also dead — if it's still running,
  // the user may just not have typed yet. Leave it for startup cleanup.
  if (!safe.tmuxExists(tmux)) {
    db.deleteSession(tmpId);
    console.log(`[session-resolve] ${tmpId.substring(0, 12)} — cleaned up orphaned temp session (tmux dead)`);
  } else {
    console.log(`[session-resolve] ${tmpId.substring(0, 12)} — tmux still running, leaving for later resolution`);
  }
}

// Resolve stale new_* sessions on startup (handles server restart during resolution)
async function resolveStaleNewSessions() {
  const dbProjects = db.getProjects();
  for (const dbProj of dbProjects) {
    const sessions = db.getSessionsForProject(dbProj.id);
    const staleSessions = sessions.filter(s => s.id.startsWith('new_'));
    if (staleSessions.length === 0) continue;

    const sessionsDir = safe.findSessionsDir(dbProj.path);
    let files;
    try { files = await readdir(sessionsDir); } catch { continue; }
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    // For each stale new_* session, check if there's a JSONL file that isn't in the DB
    const dbSessionIds = new Set(sessions.map(s => s.id));
    const unresolvedJsonls = jsonlFiles.filter(f => !dbSessionIds.has(basename(f, '.jsonl')));

    for (const stale of staleSessions) {
      if (unresolvedJsonls.length > 0) {
        const jsonlFile = unresolvedJsonls.shift();
        const realId = basename(jsonlFile, '.jsonl');
        console.log(`[startup-resolve] ${stale.id.substring(0, 15)} → ${realId.substring(0, 8)}`);
        db.upsertSession(realId, dbProj.id, stale.name || null);
        if (stale.notes) db.setSessionNotes(realId, stale.notes);
        if (stale.state && stale.state !== 'active') db.setSessionState(realId, stale.state);
        db.deleteSession(stale.id);
      } else {
        // No matching JSONL — this temp session never produced output, clean it up
        console.log(`[startup-resolve] Removing orphaned temp session: ${stale.id.substring(0, 15)}`);
        db.deleteSession(stale.id);
      }
    }
  }
}

// ── Tmux session cleanup ───────────────────────────────────────────────────

const TMUX_CLEANUP_DELAY = parseInt(process.env.TMUX_CLEANUP_MINUTES || '30') * 60 * 1000;
const MAX_TMUX_SESSIONS = parseInt(process.env.MAX_TMUX_SESSIONS || '5');
const tmuxCleanupTimers = new Map(); // tmuxSession → timer

function scheduleTmuxCleanup(tmuxSession) {
  // Cancel any existing timer for this session
  if (tmuxCleanupTimers.has(tmuxSession)) {
    clearTimeout(tmuxCleanupTimers.get(tmuxSession));
  }

  const timer = setTimeout(() => {
    tmuxCleanupTimers.delete(tmuxSession);
    // Only kill if no WebSocket is currently attached
    if (safe.tmuxExists(tmuxSession)) {
      safe.tmuxKill(tmuxSession);
      // Clean up compaction state for this session
      const sessionId = tmuxSession.replace('bp_', '');
      compactionState.delete(sessionId);
      console.log(`[cleanup] Killed idle tmux session: ${tmuxSession}`);
    }
  }, TMUX_CLEANUP_DELAY);

  tmuxCleanupTimers.set(tmuxSession, timer);
}

function cancelTmuxCleanup(tmuxSession) {
  if (tmuxCleanupTimers.has(tmuxSession)) {
    clearTimeout(tmuxCleanupTimers.get(tmuxSession));
    tmuxCleanupTimers.delete(tmuxSession);
  }
}

// Enforce max concurrent tmux sessions — kill oldest when limit exceeded.
// tmux is disposable — JSONL persists, --resume recreates anytime.
async function enforceTmuxLimit() {
  try {
    const { execFile } = require('child_process');
    const output = await new Promise((resolve, reject) => {
      execFile('tmux', ['list-sessions', '-F', '#{session_name} #{session_activity}'], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
    const sessions = output.trim().split('\n').filter(Boolean)
      .map(line => {
        const parts = line.split(' ');
        return { name: parts[0], lastActivity: parseInt(parts[1]) || 0 };
      })
      .filter(s => s.name.startsWith('bp_'))
      .sort((a, b) => a.lastActivity - b.lastActivity); // least recently active first

    while (sessions.length > MAX_TMUX_SESSIONS) {
      const oldest = sessions.shift();
      safe.tmuxKill(oldest.name);
      console.log(`[cleanup] Killed oldest tmux session: ${oldest.name} (limit: ${MAX_TMUX_SESSIONS})`);
    }
  } catch {
    // No tmux server running or list-sessions failed — no sessions to enforce
  }
}

// Startup: kill all orphaned tmux sessions.
// tmux is disposable — JSONL persists, --resume recreates anytime.
function cleanupOrphanedTmuxSessions() {
  try {
    const { execSync } = require('child_process');
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    const sessions = output.trim().split('\n').filter(Boolean);
    let cleaned = 0;
    for (const session of sessions) {
      if (session.startsWith('bp_')) {
        safe.tmuxKill(session);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[startup] Cleaned up ${cleaned} orphaned tmux sessions`);
    }
  } catch {
    // No tmux server running — nothing to clean up
  }
}

// Startup: clean up old bridge files (H4 fix)
function cleanupOldBridgeFiles() {
  const bridgeDir = join(WORKSPACE, '.blueprint', 'bridges');
  try {
    const { readdirSync, statSync, unlinkSync } = require('fs');
    const files = readdirSync(bridgeDir);
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const file of files) {
      const fullPath = join(bridgeDir, file);
      const mtime = statSync(fullPath).mtimeMs;
      if (mtime < twoHoursAgo) {
        unlinkSync(fullPath);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[startup] Cleaned up ${cleaned} old bridge files`);
  } catch {
    // Bridge dir may not exist yet — nothing to clean up
  }
}

function tmuxName(sessionId) {
  // Use 12 chars instead of 8 to reduce collision risk for timestamp-based new_ IDs
  return safe.sanitizeTmuxName(`bp_${sessionId.substring(0, 12)}`);
}

function tmuxExists(name) {
  return safe.tmuxExists(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSettings() {
  const settingsFile = join(CLAUDE_HOME, 'settings.json');
  try {
    await stat(settingsFile);
  } catch {
    await mkdir(CLAUDE_HOME, { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2));
  }
}

// parseSessionFile is now in session-utils.js (shared module)
const parseSessionFile = sessionUtils.parseSessionFile;

// ── Startup ────────────────────────────────────────────────────────────────

async function registerMcpServer() {
  const settingsFile = join(CLAUDE_HOME, 'settings.json');
  let config = {};
  try {
    const raw = await readFile(settingsFile, 'utf-8');
    config = JSON.parse(raw);
  } catch {
    // Settings file doesn't exist yet — will create with defaults
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Always ensure the Blueprint MCP server uses stdio (command), not HTTP
  // Old deployments may have a stale HTTP entry from a previous container
  if (!config.mcpServers.blueprint || !config.mcpServers.blueprint.command) {
    config.mcpServers.blueprint = {
      command: 'node',
      args: [join(__dirname, 'mcp-server.js')],
      env: { BLUEPRINT_PORT: String(PORT) },
    };
    await writeFile(settingsFile, JSON.stringify(config, null, 2));
    console.log('[startup] Registered Blueprint MCP server');
  }
}

async function trustProjectDirs() {
  const configFile = join(CLAUDE_HOME, '.claude.json');
  let config = {};
  try {
    const raw = await readFile(configFile, 'utf-8');
    config = JSON.parse(raw);
  } catch {}

  if (!config.projects) config.projects = {};

  // Trust all DB project paths
  const dbProjects = db.getProjects();
  let changed = false;
  for (const project of dbProjects) {
    const p = project.path;
    if (!config.projects[p]) config.projects[p] = {};
    if (!config.projects[p].hasTrustDialogAccepted) {
      config.projects[p].hasTrustDialogAccepted = true;
      config.projects[p].enabledMcpjsonServers = [];
      config.projects[p].disabledMcpjsonServers = [];
      changed = true;
    }
  }

  if (changed) {
    await writeFile(configFile, JSON.stringify(config, null, 2));
    console.log('[startup] Trusted project directories');
  }
}

// ── JSONL file watchers (replaces client-side 15s token poll) ──────────────

function startJsonlWatcher(tmuxSession) {
  const prefix = tmuxSession.replace(/^bp_/, '');
  if (prefix.startsWith('new_')) return; // no JSONL yet for temp sessions
  const session = db.getSessionByPrefix(prefix);
  if (!session) return;
  const jsonlPath = join(safe.findSessionsDir(session.project_path), `${session.id}.jsonl`);
  jsonlWatchPaths.set(tmuxSession, { jsonlPath, sessionId: session.id, project: session.project_name });

  watchFile(jsonlPath, { persistent: false, interval: 2000 }, () => {
    const entry = jsonlWatchPaths.get(tmuxSession);
    if (!entry) return;
    if (jsonlDebounceTimers.has(tmuxSession)) clearTimeout(jsonlDebounceTimers.get(tmuxSession));
    jsonlDebounceTimers.set(tmuxSession, setTimeout(async () => {
      jsonlDebounceTimers.delete(tmuxSession);
      try {
        const usage = await sessionUtils.getTokenUsage(entry.sessionId, entry.project);
        const ws = sessionWsClients.get(tmuxSession);
        if (ws && ws.readyState === 1 /* OPEN */) {
          ws.send(JSON.stringify({ type: 'token_update', data: usage }));
        }
        await checkCompactionNeeds(entry.sessionId, entry.project);
      } catch {}
    }, 500));
  });
}

function stopJsonlWatcher(tmuxSession) {
  const entry = jsonlWatchPaths.get(tmuxSession);
  if (entry) {
    unwatchFile(entry.jsonlPath);
    jsonlWatchPaths.delete(tmuxSession);
  }
  if (jsonlDebounceTimers.has(tmuxSession)) {
    clearTimeout(jsonlDebounceTimers.get(tmuxSession));
    jsonlDebounceTimers.delete(tmuxSession);
  }
}

function startSettingsWatcher() {
  const settingsPath = join(CLAUDE_HOME, 'settings.json');
  watchFile(settingsPath, { persistent: false, interval: 5000 }, async () => {
    try {
      const data = JSON.parse(await readFile(settingsPath, 'utf-8'));
      const update = JSON.stringify({ type: 'settings_update', model: data.model || null, effortLevel: data.effortLevel || null });
      for (const ws of sessionWsClients.values()) {
        if (ws.readyState === 1 /* OPEN */) ws.send(update);
      }
    } catch {}
  });
}

// Fallback compaction monitor for headless sessions (no browser WS) — slow interval
function startCompactionMonitor() {
  setInterval(async () => {
    try {
      const dbProjects = db.getProjects();
      for (const dbProj of dbProjects) {
        const sessionsDir = safe.findSessionsDir(dbProj.path);
        try {
          const files = await readdir(sessionsDir);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const sessionId = basename(file, '.jsonl');
            const tmux = tmuxName(sessionId);
            // Skip sessions already covered by a JSONL watcher
            if (tmuxExists(tmux) && !jsonlWatchPaths.has(tmux)) {
              await checkCompactionNeeds(sessionId, dbProj.name);
            }
          }
        } catch {
          // No sessions dir for this project — skip
        }
      }
    } catch (err) {
      console.error('[compact-monitor] Error scanning sessions:', err.message?.substring(0, 100));
    }
  }, config.get('polling.compactionMonitorIntervalMs', 300000)); // 5 min fallback for headless
}

// Export testable functions for unit tests
module.exports = { parseSessionFile: sessionUtils.parseSessionFile, checkAuthStatus, tmuxName, tmuxExists, sleep };

// Only start server when run directly (not when required by tests)
if (require.main === module) {
ensureSettings()
  .then(() => registerMcpServer())
  .then(() => trustProjectDirs())
  .then(() => {
    cleanupOrphanedTmuxSessions();
    cleanupOldBridgeFiles();
    resolveStaleNewSessions().catch(err => console.error('[startup-resolve] Error:', err.message));
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Blueprint running on http://0.0.0.0:${PORT}`);
      keepalive.start();
      startCompactionMonitor();
      startSettingsWatcher();
    });
  });
} // end if (require.main === module)
