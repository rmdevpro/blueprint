'use strict';

const {
  readdir,
  readFile,
  writeFile,
  stat,
  unlink,
  mkdir,
  appendFile,
  access,
} = require('fs/promises');
const { join, basename } = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const crypto = require('crypto');

const express = require('express');
const { registerMcpRoutes } = require('./mcp-tools');
const { registerWebhookRoutes } = require('./webhooks');
const jqftConnector = require('jqueryfiletree/dist/connectors/jqueryFileTree');

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PROJECT_NAME_MAX_LEN = 255;
const SESSION_NAME_MAX_LEN = 255;
const PROMPT_MAX_LEN = 50000;
const MESSAGE_CONTENT_MAX_LEN = 100000;
const SEARCH_QUERY_MAX_LEN = 200;
const TASK_TITLE_MAX_LEN = 500;
const TASK_DESC_MAX_LEN = 10000;
const TASK_FOLDER_MAX_LEN = 1000;
const NOTES_MAX_LEN = 100000;
const VALID_STATES = ['active', 'archived', 'hidden'];

function validateSessionId(sessionId) {
  if (!sessionId) return false;
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) return true;
  return SESSION_ID_PATTERN.test(sessionId);
}

function registerCoreRoutes(
  app,
  {
    db,
    safe,
    config,
    sessionUtils,
    keepalive,
    fireEvent,
    logger,
    tmuxName,
    tmuxExists,
    enforceTmuxLimit,
    resolveSessionId,
    getBrowserCount,
    CLAUDE_HOME,
    WORKSPACE,
    ensureSettings,
    sleep,
  },
) {
  const fileLocks = new Map();
  async function _lockedAppend(path, data) {
    const current = fileLocks.get(path) || Promise.resolve();
    const next = current
      .then(() => appendFile(path, data))
      .catch((err) => {
        logger.error('Append write failed', {
          module: 'routes',
          op: 'lockedAppend',
          err: err.message,
          path,
        });
      })
      .finally(() => {
        if (fileLocks.get(path) === next) fileLocks.delete(path);
      });
    fileLocks.set(path, next);
    return next;
  }

  async function checkAuthStatus() {
    const credsFile = join(CLAUDE_HOME, '.credentials.json');
    try {
      const raw = await readFile(credsFile, 'utf-8');
      let creds;
      try {
        creds = JSON.parse(raw);
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError)
          return { valid: false, reason: 'malformed_credentials' };
        throw parseErr;
      }
      const oauth = creds.claudeAiOauth;
      if (!oauth || !oauth.accessToken) return { valid: false, reason: 'no_credentials' };
      if (oauth.accessToken === 'expired' || oauth.refreshToken === 'expired')
        return { valid: false, reason: 'invalid_credentials' };
      if (!oauth.refreshToken) {
        const expiresAt = oauth.expiresAt || 0;
        if (Date.now() > expiresAt) return { valid: false, reason: 'expired_no_refresh' };
      }
      return { valid: true, expiresAt: oauth.expiresAt };
    } catch (err) {
      if (err.code === 'ENOENT') return { valid: false, reason: 'no_credentials_file' };
      logger.error('Unexpected error checking auth status', {
        module: 'routes',
        op: 'checkAuthStatus',
        err: err.message,
      });
      return { valid: false, reason: 'read_error' };
    }
  }

  let _trustDirLock = Promise.resolve();
  async function trustDir(dirPath) {
    const prev = _trustDirLock;
    let unlock;
    _trustDirLock = new Promise((r) => {
      unlock = r;
    });
    await prev;
    try {
      const configFile = join(CLAUDE_HOME, '.claude.json');
      let cfg = {};
      try {
        cfg = JSON.parse(await readFile(configFile, 'utf-8'));
      } catch (err) {
        if (err.code === 'ENOENT') {
          /* first run */
        } else if (err instanceof SyntaxError) {
          logger.error('.claude.json is corrupt — skipping trustDir', { module: 'routes' });
          return;
        } else {
          logger.warn('Failed to parse .claude.json', {
            module: 'routes',
            op: 'trustDir',
            err: err.message,
          });
        }
      }
      if (!cfg.projects) cfg.projects = {};
      if (cfg.projects[dirPath] && cfg.projects[dirPath].hasTrustDialogAccepted) {
        return;
      }
      cfg.projects[dirPath] = {
        hasTrustDialogAccepted: true,
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
      };
      await writeFile(configFile, JSON.stringify(cfg, null, 2));
    } finally {
      unlock();
    }
  }

  // ── Helper: reconcile stale sessions for a project ─────────────────────────

  async function reconcileStaleSessionsForProject(currentSessions, sessDir, projectId) {
    const staleTmps = currentSessions.filter((s) => s.id.startsWith('new_'));
    if (staleTmps.length === 0) return;

    const dbIds = new Set(currentSessions.map((s) => s.id));
    try {
      const files = await readdir(sessDir);
      const unmatched = files.filter(
        (f) => f.endsWith('.jsonl') && !dbIds.has(basename(f, '.jsonl')),
      );
      for (const tmp of staleTmps) {
        // Non-Claude CLIs don't create JSONL files — keep the new_* ID
        const cliType = tmp.cli_type || 'claude';
        if (cliType !== 'claude') {
          if (!(await safe.tmuxExists(tmuxName(tmp.id)))) {
            db.deleteSession(tmp.id);
          }
          continue;
        }
        if (unmatched.length > 0) {
          const realFile = unmatched.shift();
          const realId = basename(realFile, '.jsonl');
          db.upsertSession(realId, projectId, tmp.name || null, cliType);
          if (tmp.user_renamed) db.renameSession(realId, tmp.name);
          if (tmp.notes) db.setSessionNotes(realId, tmp.notes);
          if (tmp.state && tmp.state !== 'active') db.setSessionState(realId, tmp.state);
          db.deleteSession(tmp.id);
          const oldTmux = tmuxName(tmp.id);
          const newTmux = tmuxName(realId);
          try {
            await safe.tmuxExecAsync(['rename-session', '-t', oldTmux, newTmux]);
          } catch (renameErr) {
            if (
              renameErr.message &&
              (renameErr.message.includes('no server running') ||
                renameErr.message.includes('error connecting to'))
            ) {
              /* expected: tmux server not running */
            } else {
              logger.debug('tmux rename skipped during reconcile', {
                module: 'routes',
                err: renameErr.message,
              });
            }
          }
        } else if (!(await safe.tmuxExists(tmuxName(tmp.id)))) {
          db.deleteSession(tmp.id);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Error reconciling stale sessions', { module: 'routes', err: err.message });
      }
      /* expected for ENOENT: no sessions dir */
    }
  }

  // Caches to avoid re-reading session files on every /api/state call
  let _geminiSessionsCache = null;
  let _geminiCacheTime = 0;
  let _codexSessionsCache = null;
  let _codexCacheTime = 0;
  const NONCLAUD_CACHE_TTL = 10000; // 10s

  function _getGeminiSessions() {
    const now = Date.now();
    if (_geminiSessionsCache && (now - _geminiCacheTime) < NONCLAUD_CACHE_TTL) return _geminiSessionsCache;
    _geminiSessionsCache = sessionUtils.discoverGeminiSessions();
    _geminiCacheTime = now;
    return _geminiSessionsCache;
  }

  function _getCodexSessions() {
    const now = Date.now();
    if (_codexSessionsCache && (now - _codexCacheTime) < NONCLAUD_CACHE_TTL) return _codexSessionsCache;
    _codexSessionsCache = sessionUtils.discoverCodexSessions();
    _codexCacheTime = now;
    return _codexSessionsCache;
  }

  // Track which disk sessions have been claimed so we don't double-assign
  const _claimedGemini = new Set();
  const _claimedCodex = new Set();
  let _claimResetTime = 0;

  function _resetClaims() {
    const now = Date.now();
    if (now - _claimResetTime > NONCLAUD_CACHE_TTL) {
      _claimedGemini.clear();
      _claimedCodex.clear();
      _claimResetTime = now;
    }
  }

  function _matchFromList(diskSessions, claimed, session, getIdFn, storeIdFn) {
    // 1. Match by cli_session_id
    if (session.cli_session_id) {
      const match = diskSessions.find(d => !claimed.has(d.filePath) && getIdFn(d) === session.cli_session_id);
      if (match) { claimed.add(match.filePath); return match; }
    }
    // 2. Match by creation time proximity (within 60s)
    if (session.created_at) {
      const created = new Date(session.created_at).getTime();
      const match = diskSessions.find(d => {
        if (claimed.has(d.filePath) || !d.timestamp) return false;
        return Math.abs(new Date(d.timestamp).getTime() - created) < 60000;
      });
      if (match) {
        claimed.add(match.filePath);
        if (!session.cli_session_id) storeIdFn(session, match);
        return match;
      }
    }
    // 3. Order-based: take the first unclaimed disk session
    const unclaimed = diskSessions.find(d => !claimed.has(d.filePath));
    if (unclaimed) {
      claimed.add(unclaimed.filePath);
      if (!session.cli_session_id) storeIdFn(session, unclaimed);
      return unclaimed;
    }
    return null;
  }

  function _getNonClaudeMetadata(session) {
    const cliType = session.cli_type || 'claude';
    if (cliType === 'claude') return null;
    _resetClaims();

    if (cliType === 'gemini') {
      const sorted = _getGeminiSessions().sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });
      return _matchFromList(sorted, _claimedGemini, session,
        (d) => d.sessionId,
        (sess, match) => {
          if (match.sessionId) {
            try { db.setCliSessionId(sess.id, match.sessionId); } catch { /* race ok */ }
          }
        }
      );
    }

    if (cliType === 'codex') {
      const sorted = _getCodexSessions().sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });
      return _matchFromList(sorted, _claimedCodex, session,
        (d) => {
          // Codex files: /sessions/YYYY/MM/DD/rollout-{timestamp}-{uuid}.jsonl
          // Extract the UUID from the filename for resume
          const name = basename(d.filePath, '.jsonl');
          const uuidMatch = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
          return uuidMatch ? uuidMatch[1] : name;
        },
        (sess, match) => {
          const name = basename(match.filePath, '.jsonl');
          const uuidMatch = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
          const rolloutId = uuidMatch ? uuidMatch[1] : name;
          if (rolloutId && rolloutId !== 'sessions') {
            try { db.setCliSessionId(sess.id, rolloutId); } catch { /* race ok */ }
          }
        }
      );
    }

    return null;
  }

  async function buildSessionList(dbSessions, sessDir) {
    const sessions = [];
    for (const s of dbSessions) {
      const cliType = s.cli_type || 'claude';
      let fileMeta = null;

      if (cliType === 'claude') {
        const jsonlPath = join(sessDir, `${s.id}.jsonl`);
        fileMeta = await sessionUtils.parseSessionFile(jsonlPath);
      } else {
        fileMeta = _getNonClaudeMetadata(s);
      }

      sessions.push({
        id: s.id,
        name: s.name || fileMeta?.name || 'Untitled Session',
        timestamp: fileMeta?.timestamp || s.updated_at,
        messageCount: fileMeta?.messageCount || 0,
        model: s.model_override || fileMeta?.model || '',
        tmux: tmuxName(s.id),
        active: await safe.tmuxExists(tmuxName(s.id)),
        state: s.state || (s.archived ? 'archived' : 'active'),
        cli_type: cliType,
        archived: !!s.archived,
      });
    }
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return sessions;
  }

  // ── GET /api/mounts ────────────────────────────────────────────────────────

  app.get('/api/mounts', async (req, res) => {
    const mounts = [];
    // Always include the workspace
    const workspace = safe.WORKSPACE;
    mounts.push({ path: workspace });
    // Add any directories under /mnt
    try {
      const entries = await readdir('/mnt', { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) mounts.push({ path: '/mnt/' + e.name });
      }
    } catch (_err) {
      /* /mnt may not exist */
    }
    res.json(mounts);
  });

  // ── GET /api/browse ────────────────────────────────────────────────────────
  // AD-001: No path containment checks. Blueprint provides full filesystem access.

  app.get('/api/browse', async (req, res) => {
    try {
      const targetPath = (req.query.path || '/').replace(/\/+/g, '/') || '/';
      const entries = await readdir(targetPath, { withFileTypes: true });
      const dirs = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, type: 'directory' });
        } else if (entry.isSymbolicLink()) {
          try {
            const realStat = await stat(join(targetPath, entry.name));
            if (realStat.isDirectory()) dirs.push({ name: entry.name, type: 'directory' });
          } catch (symErr) {
            if (symErr.code !== 'ENOENT')
              logger.debug('Symlink stat failed', { module: 'routes', err: symErr.message });
            /* expected: dangling symlink */
          }
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: targetPath, parent: join(targetPath, '..'), entries: dirs });
    } catch (err) {
      res.status(400).json({ error: `Cannot browse: ${err.message}` });
    }
  });

  // ── GET /api/file ──────────────────────────────────────────────────────────
  // AD-001: No path containment checks. Blueprint provides full filesystem access.

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

  app.put('/api/file', express.text({ limit: '2mb' }), async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      await writeFile(filePath, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/file-raw', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).send('path required');
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return res.status(400).send('not a file');
      if (fileStat.size > 10 * 1024 * 1024) return res.status(413).send('file too large (>10MB)');
      res.sendFile(filePath);
    } catch (err) {
      res.status(400).send(`Cannot read file: ${err.message}`);
    }
  });

  app.post('/api/file-new', async (req, res) => {
    try {
      const filePath = req.body.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const { access } = require('fs/promises');
      try { await access(filePath); return res.status(409).json({ error: 'file already exists' }); } catch {}
      await writeFile(filePath, '');
      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/rename', async (req, res) => {
    try {
      const { oldPath, newPath } = req.body;
      if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath required' });
      const { rename } = require('fs/promises');
      await rename(oldPath, newPath);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/file', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const { rm } = require('fs/promises');
      await rm(filePath, { recursive: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/move', async (req, res) => {
    try {
      const { source, destination } = req.body;
      if (!source || !destination) return res.status(400).json({ error: 'source and destination required' });
      const { rename } = require('fs/promises');
      const { basename, join } = require('path');
      const destPath = join(destination, basename(source));
      await rename(source, destPath);
      res.json({ ok: true, path: destPath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── POST /api/jqueryfiletree ───────────────────────────────────────────────

  app.post('/api/jqueryfiletree', jqftConnector.getDirList);

  // ── POST /api/projects ─────────────────────────────────────────────────────

  app.post('/api/projects', async (req, res) => {
    try {
      let { path: projectPath, name } = req.body;
      if (!projectPath) return res.status(400).json({ error: 'path required' });
      if (name && name.length > PROJECT_NAME_MAX_LEN)
        return res.status(400).json({ error: `name too long (max ${PROJECT_NAME_MAX_LEN})` });
      projectPath = projectPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

      if (projectPath.startsWith('http') || projectPath.startsWith('git@')) {
        const repoName = name || projectPath.split('/').pop().replace('.git', '');
        const targetPath = join(WORKSPACE, repoName);
        try {
          await stat(targetPath);
          return res.status(409).json({ error: 'Directory already exists' });
        } catch (statErr) {
          if (statErr.code !== 'ENOENT') throw statErr;
          /* expected: directory does not exist yet */
        }
        try {
          await safe.gitCloneAsync(projectPath, targetPath);
        } catch (gitErr) {
          logger.warn('Git clone failed', {
            module: 'routes',
            url: projectPath.substring(0, 100),
            err: gitErr.message?.substring(0, 200),
          });
          return res
            .status(400)
            .json({ error: `Git clone failed: ${gitErr.message?.substring(0, 200)}` });
        }
        db.ensureProject(repoName, targetPath);
        await trustDir(targetPath);
        return res.json({ name: repoName, path: targetPath, cloned: true });
      }

      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(404).json({ error: 'Path does not exist' });
        throw statErr;
      }
      const projectName = name || basename(projectPath);
      db.ensureProject(projectName, projectPath);
      await trustDir(projectPath);
      return res.json({ name: projectName, path: projectPath, added: true });
    } catch (err) {
      logger.error('Error adding project', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:name/remove', (req, res) => {
    try {
      const project = db.getProject(req.params.name);
      if (!project) return res.status(404).json({ error: 'project not found' });
      db.deleteProject(project.id);
      res.json({ removed: req.params.name });
    } catch (err) {
      logger.error('Error removing project', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Auth endpoints ─────────────────────────────────────────────────────────

  app.get('/api/auth/status', async (req, res) => {
    try {
      res.json(await checkAuthStatus());
    } catch (err) {
      res.json({ valid: false, reason: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      await safe.claudeExecAsync(['--print', 'test'], { timeout: 10000 });
      res.json({ valid: true });
    } catch (err) {
      res.json({ valid: false, reason: err.message });
    }
  });

  // ── Keepalive endpoints ────────────────────────────────────────────────────

  app.get('/api/keepalive/status', async (req, res) => {
    const status = await keepalive.getStatus();
    res.json({ ...status, browsers: getBrowserCount() });
  });

  app.put('/api/keepalive/mode', (req, res) => {
    const { mode, idleMinutes } = req.body;
    if (!['always', 'browser', 'idle'].includes(mode))
      return res.status(400).json({ error: 'mode must be always, browser, or idle' });
    if (
      idleMinutes !== undefined &&
      (typeof idleMinutes !== 'number' || idleMinutes < 1 || idleMinutes > 1440)
    ) {
      return res.status(400).json({ error: 'idleMinutes must be a number between 1 and 1440' });
    }
    keepalive.setMode(mode, idleMinutes);
    if (mode === 'always' && !keepalive.isRunning()) keepalive.start();
    if (mode === 'browser' && getBrowserCount() === 0) keepalive.stop();
    res.json({ mode: keepalive.getMode(), running: keepalive.isRunning() });
  });

  // ── GET /api/state ─────────────────────────────────────────────────────────

  app.get('/api/state', async (req, res) => {
    try {
      const projects = [];
      const dbProjects = db.getProjects();

      for (const dbProject of dbProjects) {
        const projectName = dbProject.name;
        const projectPath = dbProject.path;
        const project = dbProject;

        let dirMissing = false;
        try {
          await stat(projectPath);
        } catch (err) {
          if (err.code === 'ENOENT') {
            dirMissing = true;
          } else {
            logger.warn('Error checking project directory', {
              module: 'routes',
              project: projectName,
              err: err.message,
            });
            dirMissing = true;
          }
        }

        const sessDir = safe.findSessionsDir(projectPath);

        try {
          const sessionFiles = await readdir(sessDir);
          for (const file of sessionFiles) {
            if (!file.endsWith('.jsonl')) continue;
            const sessionId = basename(file, '.jsonl');
            // Skip JSONL files that belong to non-Claude sessions (Gemini/Codex UUIDs
            // may end up here as empty files — don't overwrite their DB records)
            const existing = db.getSession(sessionId);
            if (existing && existing.cli_type && existing.cli_type !== 'claude') continue;
            const fileMeta = await sessionUtils.parseSessionFile(join(sessDir, file));
            if (fileMeta) db.upsertSession(sessionId, project.id, fileMeta.name);
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.warn('Error reading sessions dir in state handler', {
              module: 'routes',
              project: projectName,
              err: err.message,
            });
          }
          /* expected for ENOENT: no sessions dir */
        }

        const currentSessions = db.getSessionsForProject(project.id);
        await reconcileStaleSessionsForProject(currentSessions, sessDir, project.id);

        const dbSessions = db.getSessionsForProject(project.id);
        const sessions = await buildSessionList(dbSessions, sessDir);

        for (const s of sessions) {
          s.project_missing = dirMissing;
        }

        projects.push({ name: projectName, path: projectPath, sessions, missing: dirMissing, state: project.state || 'active' });
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.timestamp || '1970-01-01';
        const bTime = b.sessions[0]?.timestamp || '1970-01-01';
        return new Date(bTime) - new Date(aTime);
      });

      res.json({ projects, workspace: WORKSPACE });
    } catch (err) {
      logger.error('Error listing state', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/sessions ────────────────────────────────────────────────────

  app.post('/api/sessions', async (req, res) => {
    try {
      const { project, prompt, cli_type } = req.body;
      const cliType = cli_type || 'claude';
      const VALID_CLI_TYPES = ['claude', 'gemini', 'codex'];
      if (!VALID_CLI_TYPES.includes(cliType))
        return res.status(400).json({ error: `invalid cli_type: ${cliType}. Must be one of: ${VALID_CLI_TYPES.join(', ')}` });
      if (!project) return res.status(400).json({ error: 'project required' });
      if (project.length > PROJECT_NAME_MAX_LEN)
        return res
          .status(400)
          .json({ error: `project name too long (max ${PROJECT_NAME_MAX_LEN})` });
      if (prompt && prompt.length > PROMPT_MAX_LEN)
        return res.status(400).json({ error: `prompt too long (max ${PROMPT_MAX_LEN})` });

      const dbProject = db.getProject(project);
      const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(410).json({ error: 'Project directory not found' });
        throw statErr;
      }

      const sessDir = safe.findSessionsDir(projectPath);
      let existingFiles = new Set();
      try {
        const files = await readdir(sessDir);
        existingFiles = new Set(files.filter((f) => f.endsWith('.jsonl')));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn('Error reading sessions dir for existing files', {
            module: 'routes',
            err: err.message,
          });
        }
      }

      // Claude sessions get a temp ID that resolves to a real UUID when the JSONL appears.
      // Non-Claude CLIs don't create JSONLs, so give them a permanent UUID up front.
      const tmpId = cliType === 'claude'
        ? `new_${Date.now()}`
        : require('crypto').randomUUID();
      const tmux = tmuxName(tmpId);

      await ensureSettings();
      await enforceTmuxLimit();

      // Launch the appropriate CLI
      const cliArgs = [];
      if (cliType === 'claude') {
        const model = db.getSetting('default_model', '"claude-sonnet-4-6"');
        try {
          const m = JSON.parse(model);
          if (m) cliArgs.push('--model', m);
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) {
            logger.debug('Invalid default_model JSON in settings', { module: 'routes' });
          } else {
            throw parseErr;
          }
        }
      }
      safe.tmuxCreateCLI(tmux, projectPath, cliType, cliArgs);

      const proj = db.ensureProject(project, projectPath);
      const nameMaxLen = config.get('session.nameMaxLength', 60);
      const sessionName =
        prompt && prompt.replace(/\s+/g, ' ').trim()
          ? prompt.substring(0, nameMaxLen).replace(/\n/g, ' ').trim()
          : 'New Session';
      db.upsertSession(tmpId, proj.id, sessionName, cliType);

      if (prompt && cliType === 'claude') {
        // Only inject prompt for Claude — it triggers JSONL creation for session resolution.
        // Gemini/Codex have startup dialogs (trust, auth) that would consume the prompt.
        // They get permanent UUIDs at creation, so no JSONL resolution needed.
        const promptDelayMs = config.get('session.promptInjectionDelayMs', 2000);
        setTimeout(async () => {
          try {
            if (!(await tmuxExists(tmux))) {
              logger.warn('Session died before prompt could be sent', { module: 'routes', tmux, tmpId: tmpId.substring(0, 15) });
              return;
            }
            await safe.tmuxSendKeysAsync(tmux, prompt);
          } catch (err) {
            logger.error('Failed to send initial prompt', { module: 'routes', err: err.message });
          }
        }, promptDelayMs);
      }

      resolveSessionId(tmpId, { tmux, sessionsDir: sessDir, existingFiles, projectId: proj.id, cliType });
      fireEvent('session_created', { session_id: tmpId, project });
      res.json({ id: tmpId, tmux, project, name: sessionName });
    } catch (err) {
      logger.error('Error creating session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/terminals ───────────────────────────────────────────────────

  app.post('/api/terminals', async (req, res) => {
    try {
      const { project } = req.body;
      if (!project) return res.status(400).json({ error: 'project required' });
      if (project.length > PROJECT_NAME_MAX_LEN)
        return res
          .status(400)
          .json({ error: `project name too long (max ${PROJECT_NAME_MAX_LEN})` });
      const dbProject = db.getProject(project);
      const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(410).json({ error: 'Project directory not found' });
        throw statErr;
      }
      const termId = `t_${Date.now()}`;
      const tmux = tmuxName(termId);
      await enforceTmuxLimit();
      safe.tmuxCreateCLI(tmux, projectPath, 'bash');
      res.json({ id: termId, tmux, project, name: 'Terminal' });
    } catch (err) {
      logger.error('Error creating terminal', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/sessions/:sessionId/resume ──────────────────────────────────

  app.post('/api/sessions/:sessionId/resume', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { project } = req.body;
      if (!project) return res.status(400).json({ error: 'project required' });
      const dbProject = db.getProject(project);
      const projectPath = dbProject ? dbProject.path : safe.resolveProjectPath(project);
      try {
        await stat(projectPath);
      } catch (statErr) {
        if (statErr.code === 'ENOENT')
          return res.status(410).json({ error: 'Project directory not found' });
        throw statErr;
      }
      const tmux = tmuxName(sessionId);
      if (!(await safe.tmuxExists(tmux))) {
        await ensureSettings();
        const session = db.getSession(sessionId);
        const cliType = session?.cli_type || 'claude';
        let resumeArgs = [];
        if (cliType === 'claude' && !sessionId.startsWith('new_')) {
          resumeArgs = ['--resume', sessionId];
        }
        if (cliType === 'gemini') {
          // Gemini doesn't support resume-by-ID reliably — launch fresh
          // It will pick up project context from its own state files
          resumeArgs = [];
        }
        if (cliType === 'codex') {
          const cliSessId = session?.cli_session_id;
          resumeArgs = cliSessId ? ['resume', cliSessId] : ['resume', '--last'];
        }
        safe.tmuxCreateCLI(tmux, projectPath, cliType, resumeArgs);
        // Wait for CLI to start — resume with JSONL loading takes longer than fresh start
        await sleep(3000);
        // Verify tmux actually started
        if (!(await tmuxExists(tmux))) {
          return res.status(503).json({ error: 'Session failed to start. The CLI may have exited.' });
        }
      }
      res.json({ id: sessionId, tmux, project });
    } catch (err) {
      logger.error('Error resuming session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUT /api/sessions/:sessionId/name ─────────────────────────────────────

  app.put('/api/sessions/:sessionId/name', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { name } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
      if (name.length > SESSION_NAME_MAX_LEN)
        return res.status(400).json({ error: `name too long (max ${SESSION_NAME_MAX_LEN})` });
      db.renameSession(sessionId, name.trim());
      try {
        const session = db.getSessionFull(sessionId);
        if (session && session.project_name) {
          const projectPath = db.getProject(session.project_name)?.path;
          if (projectPath) {
            const sessDir = safe.findSessionsDir(projectPath);
            const jsonlFile = join(sessDir, `${sessionId}.jsonl`);
            const summaryEntry = JSON.stringify({
              type: 'summary',
              summary: name.trim(),
              timestamp: new Date().toISOString(),
            });
            try {
              await appendFile(jsonlFile, '\n' + summaryEntry);
            } catch (appendErr) {
              if (appendErr.code !== 'ENOENT') {
                logger.warn('Failed to append summary to JSONL', {
                  module: 'routes',
                  sessionId: sessionId.substring(0, 8),
                  err: appendErr.message,
                });
              }
              /* expected for ENOENT: session file may not exist */
            }
          }
        }
      } catch (outerErr) {
        logger.debug('Best-effort summary append failed', {
          module: 'routes',
          err: outerErr.message,
        });
      }
      res.json({ id: sessionId, name: name.trim() });
    } catch (err) {
      logger.error('Error renaming session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Session config ────────────────────────────────────────────────────────

  app.get('/api/sessions/:sessionId/config', (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const session = db.getSessionFull(sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      res.json({
        id: session.id,
        name: session.name,
        state: session.state || (session.archived ? 'archived' : 'active'),
        notes: session.notes || '',
        project: session.project_name,
      });
    } catch (err) {
      logger.error('Error getting session config', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/sessions/:sessionId/config', (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { name, state, notes } = req.body;
      if (name !== undefined) {
        if (name.length > SESSION_NAME_MAX_LEN)
          return res.status(400).json({ error: `name too long (max ${SESSION_NAME_MAX_LEN})` });
        db.renameSession(sessionId, name);
      }
      if (state !== undefined) {
        if (!VALID_STATES.includes(state))
          return res
            .status(400)
            .json({ error: `state must be one of: ${VALID_STATES.join(', ')}` });
        db.setSessionState(sessionId, state);
      }
      if (notes !== undefined) {
        if (notes.length > NOTES_MAX_LEN)
          return res.status(400).json({ error: `notes too long (max ${NOTES_MAX_LEN})` });
        db.setSessionNotes(sessionId, notes);
      }
      res.json({ saved: true });
    } catch (err) {
      logger.error('Error updating session config', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUT /api/sessions/:sessionId/archive (legacy) ─────────────────────────

  app.put('/api/sessions/:sessionId/archive', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { archived } = req.body;
      db.setSessionState(sessionId, archived ? 'archived' : 'active');
      res.json({ id: sessionId, archived: !!archived });
    } catch (err) {
      logger.error('Error archiving session', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  function normalizeFolderPath(p) {
    if (!p || p === '/') return '/';
    return '/' + p.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  }

  function buildTaskTree(tasks) {
    const root = { path: '/', name: 'Workspace', tasks: [], children: {} };
    for (const task of tasks) {
      const parts = task.folder_path.replace(/^\//, '').split('/').filter(Boolean);
      let node = root;
      for (const part of parts) {
        if (!node.children[part]) {
          node.children[part] = {
            path: node.path === '/' ? '/' + part : node.path + '/' + part,
            name: part, tasks: [], children: {},
          };
        }
        node = node.children[part];
      }
      node.tasks.push(task);
    }
    function prune(node) {
      for (const key of Object.keys(node.children)) {
        prune(node.children[key]);
        if (node.children[key].tasks.length === 0 && Object.keys(node.children[key].children).length === 0) {
          delete node.children[key];
        }
      }
    }
    prune(root);
    return root;
  }

  app.get('/api/tasks/tree', (req, res) => {
    const filter = req.query.filter || 'todo';
    const tasks = db.getAllTasks(filter);
    res.json({ tree: buildTaskTree(tasks) });
  });

  app.post('/api/tasks', (req, res) => {
    const { folder_path, title, description, created_by } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (title.length > TASK_TITLE_MAX_LEN) return res.status(400).json({ error: 'title too long' });
    if (description && description.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'description too long' });
    const path = normalizeFolderPath(folder_path);
    if (path.length > TASK_FOLDER_MAX_LEN) return res.status(400).json({ error: 'folder_path too long' });
    const task = db.addTask(path, title, description || '', null, created_by || 'human');
    fireEvent('task_added', { task_id: task.id, folder_path: path, title });
    res.json(task);
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = db.getTask(Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'task not found' });
    const history = db.getTaskHistory(task.id);
    res.json({ ...task, history });
  });

  app.put('/api/tasks/reorder', (req, res) => {
    const { orders } = req.body;
    if (!Array.isArray(orders)) return res.status(400).json({ error: 'orders array required' });
    db.reorderTasks(orders);
    res.json({ reordered: true });
  });

  app.put('/api/tasks/:id/move', (req, res) => {
    const id = Number(req.params.id);
    const { folder_path, sort_order } = req.body;
    if (!folder_path) return res.status(400).json({ error: 'folder_path required' });
    const path = normalizeFolderPath(folder_path);
    db.moveTask(id, path, sort_order);
    res.json({ moved: true });
  });

  app.put('/api/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = db.getTask(id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const { title, description, status } = req.body;
    if (title !== undefined) {
      if (!title || title.length > TASK_TITLE_MAX_LEN) return res.status(400).json({ error: 'invalid title' });
      db.updateTaskTitle(id, title);
    }
    if (description !== undefined) {
      if (description.length > TASK_DESC_MAX_LEN) return res.status(400).json({ error: 'description too long' });
      db.updateTaskDescription(id, description);
    }
    if (status !== undefined) {
      if (!['todo', 'done', 'archived'].includes(status)) return res.status(400).json({ error: 'invalid status' });
      db.updateTaskStatus(id, status);
    }
    res.json(db.getTask(id));
  });

  app.delete('/api/tasks/:id', (req, res) => {
    db.deleteTask(Number(req.params.id));
    res.json({ deleted: true });
  });

  // ── Inter-session messages ────────────────────────────────────────────────

  // Inter-session messaging removed — tmux handles agent communication natively.
  // See issue #51 for the tmux-based agent mesh architecture.

  // ── Settings ──────────────────────────────────────────────────────────────

  app.get('/api/settings', (req, res) => {
    const settings = db.getAllSettings();
    const defaults = {
      default_model: 'claude-sonnet-4-6',
      thinking_level: 'none',
      keepalive_mode: 'always',
      keepalive_idle_minutes: 30,
      vector_embedding_provider: 'huggingface',
      vector_custom_url: '',
      vector_custom_key: '',
      vector_collection_documents: { enabled: true, dims: 384, patterns: ['*.md', '*.txt', '*.pdf', '*.rst', '*.adoc'] },
      vector_collection_code: { enabled: false, dims: 384, patterns: ['*.js', '*.ts', '*.py', '*.go', '*.rs', '*.java', '*.sh', 'Dockerfile', 'Makefile', '*.yml', '*.yaml', '*.json'] },
      vector_collection_claude: { enabled: true, dims: 384 },
      vector_collection_gemini: { enabled: true, dims: 384 },
      vector_collection_codex: { enabled: true, dims: 384 },
      vector_ignore_patterns: 'node_modules/**\n.git/**\n*.lock\n*.min.js\ndist/**\nbuild/**',
      vector_additional_paths: [],
    };
    res.json({ ...defaults, ...settings });
  });

  app.put('/api/settings', (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    db.setSetting(key, JSON.stringify(value));

    if (key === 'keepalive_mode') {
      const idleMins = db.getSetting('keepalive_idle_minutes', '30');
      keepalive.setMode(value, parseInt(idleMins, 10));
      if (value === 'always' && !keepalive.isRunning()) keepalive.start();
      if (value === 'browser' && getBrowserCount() === 0) keepalive.stop();
    }
    if (key === 'keepalive_idle_minutes') {
      const mode = db.getSetting('keepalive_mode', '"always"');
      try {
        keepalive.setMode(JSON.parse(mode), parseInt(value, 10));
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) {
          logger.debug('Invalid keepalive_mode JSON in settings', { module: 'routes' });
        } else {
          throw parseErr;
        }
      }
    }
    if (key === 'vector_embedding_provider') {
      // Provider changed — old embeddings are incompatible. Clear sync state and re-index.
      try {
        db.db.prepare('DELETE FROM qdrant_sync').run();
        const qdrant = require('./qdrant-sync');
        for (const col of ['documents', 'code', 'claude', 'gemini', 'codex']) {
          qdrant.reindexCollection(col).catch(err =>
            logger.error('Re-index after provider change failed', { module: 'routes', collection: col, err: err.message })
          );
        }
        logger.info('Embedding provider changed — clearing sync state and re-indexing all collections', { module: 'routes', provider: value });
      } catch (err) {
        logger.error('Failed to trigger re-index on provider change', { module: 'routes', err: err.message });
      }
    }
    res.json({ saved: true });
  });

  // ── CLI Credentials Check ─────────────────────────────────────────────────

  app.get('/api/cli-credentials', (req, res) => {
    const fs = require('fs');
    const { join } = require('path');
    const home = safe.HOME;

    // Gemini: check for credentials file OR GOOGLE_API_KEY in env OR key in DB settings
    const geminiCredFile = join(home, '.gemini', 'gemini-credentials.json');
    const hasGemini = fs.existsSync(geminiCredFile) ||
      !!process.env.GOOGLE_API_KEY ||
      !!db.getSetting('gemini_api_key', '');

    // Codex: check auth.json for OPENAI_API_KEY
    let hasOpenai = !!process.env.OPENAI_API_KEY || !!db.getSetting('codex_api_key', '');
    if (!hasOpenai) {
      try {
        const codexAuth = JSON.parse(fs.readFileSync(join(home, '.codex', 'auth.json'), 'utf-8'));
        hasOpenai = !!codexAuth.OPENAI_API_KEY;
      } catch { /* no auth file */ }
    }

    res.json({ gemini: hasGemini, openai: hasOpenai });
  });

  // ── Qdrant / Vector Search ────────────────────────────────────────────────

  app.get('/api/qdrant/status', async (req, res) => {
    try {
      const qdrantSync = require('./qdrant-sync');
      const statusData = await qdrantSync.status();
      res.json(statusData);
    } catch (err) {
      res.json({ available: false, error: err.message });
    }
  });

  app.post('/api/qdrant/reindex', async (req, res) => {
    const { collection } = req.body;
    if (!collection) return res.status(400).json({ error: 'collection required' });
    try {
      const qdrantSync = require('./qdrant-sync');
      qdrantSync.reindexCollection(collection).catch(err =>
        logger.error('Reindex error', { module: 'routes', collection, err: err.message })
      );
      res.json({ started: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── CLAUDE.md management ──────────────────────────────────────────────────

  app.get('/api/claude-md/global', async (req, res) => {
    try {
      const file = join(process.env.HOME || '/data', '.claude', 'CLAUDE.md');
      const content = await readFile(file, 'utf-8');
      res.json({ content });
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.json({ content: '' });
      } else {
        logger.warn('Error reading global CLAUDE.md', { module: 'routes', err: err.message });
        res.json({ content: '' });
      }
    }
  });

  app.put('/api/claude-md/global', async (req, res) => {
    try {
      const file = join(process.env.HOME || '/data', '.claude', 'CLAUDE.md');
      await writeFile(file, req.body.content || '');
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:name/claude-md', async (req, res) => {
    try {
      const dbProj = db.getProject(req.params.name);
      const projectPath = dbProj ? dbProj.path : join(WORKSPACE, req.params.name);
      const file = join(projectPath, 'CLAUDE.md');
      let content = '';
      try {
        content = await readFile(file, 'utf-8');
      } catch (readErr) {
        if (readErr.code === 'ENOENT') {
          const template = db.getSetting('default_project_claude_md', '""');
          try {
            content = JSON.parse(template);
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              logger.debug('Invalid default_project_claude_md JSON', { module: 'routes' });
              content = '';
            } else {
              throw parseErr;
            }
          }
          if (content) await writeFile(file, content);
        } else {
          throw readErr;
        }
      }
      res.json({ content });
    } catch (err) {
      logger.error('Error reading project CLAUDE.md', { module: 'routes', err: err.message });
      res.json({ content: '' });
    }
  });

  app.put('/api/projects/:name/claude-md', async (req, res) => {
    try {
      const dbProj = db.getProject(req.params.name);
      const projectPath = dbProj ? dbProj.path : join(WORKSPACE, req.params.name);
      const file = join(projectPath, 'CLAUDE.md');
      await writeFile(file, req.body.content || '');
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── MCP Servers config ────────────────────────────────────────────────────

  app.get('/api/mcp-servers', async (req, res) => {
    try {
      const configFile = join(CLAUDE_HOME, 'settings.json');
      const raw = await readFile(configFile, 'utf-8');
      const cfg = JSON.parse(raw);
      res.json({ servers: cfg.mcpServers || {} });
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) {
        res.json({ servers: {} });
      } else {
        logger.error('Error reading MCP servers config', { module: 'routes', err: err.message });
        res.json({ servers: {} });
      }
    }
  });

  app.put('/api/mcp-servers', async (req, res) => {
    try {
      const { servers } = req.body;
      const configFile = join(CLAUDE_HOME, 'settings.json');
      let cfg = {};
      try {
        cfg = JSON.parse(await readFile(configFile, 'utf-8'));
      } catch (readErr) {
        if (readErr.code !== 'ENOENT' && !(readErr instanceof SyntaxError)) throw readErr;
        /* expected: fresh config or corrupt — start clean */
      }
      cfg.mcpServers = servers || {};
      await writeFile(configFile, JSON.stringify(cfg, null, 2));
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Search ────────────────────────────────────────────────────────────────

  app.get('/api/search', async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || q.length < 2) return res.json({ results: [] });
      if (q.length > SEARCH_QUERY_MAX_LEN)
        return res.status(400).json({ error: `query too long (max ${SEARCH_QUERY_MAX_LEN})` });
      const results = await sessionUtils.searchSessions(q, null, 20);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Session summary ───────────────────────────────────────────────────────

  app.post('/api/sessions/:sessionId/summary', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { project } = req.body;
      if (!project) return res.status(400).json({ error: 'project required' });
      const result = await sessionUtils.summarizeSession(sessionId, project);
      res.json({ summary: result.summary, recentMessages: result.recentMessages });
    } catch (err) {
      logger.error('Error generating summary', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message?.substring(0, 100) });
    }
  });

  // ── Token usage ───────────────────────────────────────────────────────────

  app.get('/api/sessions/:sessionId/tokens', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { project } = req.query;
      if (!project) return res.json({ tokens: null });
      const result = await sessionUtils.getTokenUsage(sessionId, project);
      res.json(result);
    } catch (err) {
      logger.error('Error getting token usage', { module: 'routes', err: err.message });
      res.json({ input_tokens: 0, model: null, max_tokens: 200000 });
    }
  });

  // ── Session management ───────────────────────────────────────────────────

  app.post('/api/sessions/:sessionId/session', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { mode = 'info', tailLines = 60 } = req.body;
      const entry = db.getSession(sessionId);
      const project = entry ? entry.project_name : (req.body.project || '');
      const projectHash = (project ? safe.resolveProjectPath(project) : '').replace(/[^a-zA-Z0-9]/g, '-');
      const sessionFile = join(CLAUDE_HOME, 'projects', projectHash, `${sessionId}.jsonl`);

      if (mode === 'info') {
        let exists = false;
        try { await stat(sessionFile); exists = true; } catch {}
        return res.json({ sessionId, sessionFile, exists });
      }
      if (mode === 'resume') {
        let tail = '';
        try {
          const content = await readFile(sessionFile, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          tail = formatSessionTail(lines.slice(-tailLines));
        } catch (err) {
          tail = '(could not read session file: ' + err.message + ')';
        }
        return res.json({ prompt: config.getPrompt('session-resume', { SESSION_TAIL: tail }) });
      }
      if (mode === 'transition') {
        return res.json({ prompt: config.getPrompt('session-transition', {}) });
      }
      return res.status(400).json({ error: 'Unknown mode. Use info, transition, or resume.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:sessionId/restart', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const tmux = tmuxName(sessionId);
      if (await tmuxExists(tmux)) {
        await safe.tmuxKill(tmux);
      }
      const session = db.getSessionFull(sessionId) || db.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const cwd = session.project_path || WORKSPACE;
      const cliType = session.cli_type || 'claude';
      let restartArgs = [];
      if (cliType === 'claude' && !sessionId.startsWith('new_')) restartArgs = ['--resume', sessionId];
      if (cliType === 'gemini') {
        // Gemini doesn't support resume-by-ID reliably — launch fresh
        restartArgs = [];
      }
      if (cliType === 'codex') {
        const cliSessId = session.cli_session_id;
        restartArgs = cliSessId ? ['resume', cliSessId] : ['resume', '--last'];
      }
      safe.tmuxCreateCLI(tmux, cwd, cliType, restartArgs);
      res.json({ ok: true, sessionId, tmux });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── File operations ─────────────────────────────────────────────────────

  app.post('/api/mkdir', async (req, res) => {
    try {
      const dirPath = req.body.path;
      if (!dirPath || dirPath === '/') return res.status(400).json({ error: 'path required' });
      await mkdir(dirPath, { recursive: true });
      res.json({ ok: true, path: dirPath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
    try {
      const targetDir = req.headers['x-upload-dir'];
      const fileName = req.headers['x-upload-filename'];
      if (!targetDir || !fileName) return res.status(400).json({ error: 'x-upload-dir and x-upload-filename headers required' });
      const filePath = join(targetDir, basename(fileName));
      await writeFile(filePath, req.body);
      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Project config ──────────────────────────────────────────────────────

  app.get('/api/projects/:name/config', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ name: project.name, state: project.state || 'active', notes: project.notes || '', path: project.path });
  });

  app.put('/api/projects/:name/config', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const { name, state, notes } = req.body;
    if (name && name !== project.name) db.renameProject(project.id, name);
    if (state) db.setProjectState(project.id, state);
    if (notes !== undefined) db.setProjectNotes(project.id, notes);
    res.json({ ok: true });
  });

  // ── Health endpoint ───────────────────────────────────────────────────────

  app.get('/health', async (req, res) => {
    const deps = { db: 'unknown', workspace: 'unknown', auth: 'unknown' };
    let healthy = true;
    try {
      db.getProjects();
      deps.db = 'healthy';
    } catch (err) {
      deps.db = 'degraded';
      healthy = false;
      logger.warn('Health check: db degraded', { module: 'routes', err: err.message });
    }
    try {
      await access(WORKSPACE);
      deps.workspace = 'healthy';
    } catch (err) {
      deps.workspace = 'degraded';
      healthy = false;
      logger.warn('Health check: workspace degraded', { module: 'routes', err: err.message });
    }
    try {
      const auth = await checkAuthStatus();
      deps.auth = auth.valid ? 'healthy' : 'degraded';
      // Auth is informational only — does not affect overall healthy status
    } catch (_err) {
      deps.auth = 'degraded';
    }
    res
      .status(healthy ? 200 : 503)
      .json({ status: healthy ? 'ok' : 'degraded', dependencies: deps });
  });

  // ── Register sub-route modules ────────────────────────────────────────────

  registerMcpRoutes(app);
  registerWebhookRoutes(app);

  return { checkAuthStatus, trustDir };
}

function formatSessionTail(lines) {
  const turns = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = Array.isArray(entry.message.content)
          ? entry.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          : String(entry.message.content);
        if (text.trim()) turns.push(`**User:** ${text.trim()}`);
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = Array.isArray(entry.message.content)
          ? entry.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          : String(entry.message.content);
        if (text.trim()) turns.push(`**Assistant:** ${text.trim()}`);
      }
    } catch { /* skip malformed lines */ }
  }
  return turns.join('\n\n');
}

module.exports = registerCoreRoutes;
