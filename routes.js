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

const { registerMcpRoutes } = require('./mcp-tools');
const { registerOpenAIRoutes } = require('./openai-compat');
const { registerWebhookRoutes } = require('./webhooks');
const { registerExternalMcpRoutes } = require('./mcp-external');
const { registerQuorumRoutes } = require('./quorum');
const jqftConnector = require('jqueryfiletree/dist/connectors/jqueryFileTree');

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const PROJECT_NAME_MAX_LEN = 255;
const SESSION_NAME_MAX_LEN = 255;
const PROMPT_MAX_LEN = 50000;
const MESSAGE_CONTENT_MAX_LEN = 100000;
const SEARCH_QUERY_MAX_LEN = 200;
const TASK_TEXT_MAX_LEN = 1000;
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
    tmuxExists: _tmuxExists,
    enforceTmuxLimit,
    resolveSessionId,
    runSmartCompaction,
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
        if (unmatched.length > 0) {
          const realFile = unmatched.shift();
          const realId = basename(realFile, '.jsonl');
          db.upsertSession(realId, projectId, tmp.name || null);
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

  async function buildSessionList(dbSessions, sessDir) {
    const sessions = [];
    for (const s of dbSessions) {
      const jsonlPath = join(sessDir, `${s.id}.jsonl`);
      const fileMeta = await sessionUtils.parseSessionFile(jsonlPath);
      sessions.push({
        id: s.id,
        name: s.name || fileMeta?.name || 'Untitled Session',
        timestamp: fileMeta?.timestamp || s.updated_at,
        messageCount: fileMeta?.messageCount || 0,
        tmux: tmuxName(s.id),
        active: await safe.tmuxExists(tmuxName(s.id)),
        state: s.state || (s.archived ? 'archived' : 'active'),
        archived: !!s.archived,
      });
    }
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return sessions;
  }

  // ── GET /api/mounts ────────────────────────────────────────────────────────

  app.get('/api/mounts', async (req, res) => {
    try {
      const { stdout } = await execFileAsync('mount');
      const mounts = stdout
        .trim()
        .split('\n')
        .map((line) => {
          if (/proc|sys|dev|tmpfs|cgroup|mqueue|overlay/.test(line)) return null;
          const match = line.match(/on\s+(\S+)\s+type\s+(\S+)/);
          return match ? { path: match[1], type: match[2] } : null;
        })
        .filter(Boolean);
      res.json(mounts);
    } catch (err) {
      logger.warn('GET /api/mounts failed', { module: 'routes', err: err.message });
      res.json([]);
    }
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

        projects.push({ name: projectName, path: projectPath, sessions, missing: dirMissing });
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
      const { project, prompt } = req.body;
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
        /* expected for ENOENT: no sessions dir yet */
      }

      const tmpId = `new_${Date.now()}`;
      const tmux = tmuxName(tmpId);

      await ensureSettings();

      const model = db.getSetting('default_model', '"claude-sonnet-4-6"');
      const claudeArgs = [];
      try {
        const m = JSON.parse(model);
        if (m) claudeArgs.push('--model', m);
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) {
          logger.debug('Invalid default_model JSON in settings', { module: 'routes' });
        } else {
          throw parseErr;
        }
      }

      await enforceTmuxLimit();
      safe.tmuxCreateClaude(tmux, projectPath, claudeArgs);

      const proj = db.ensureProject(project, projectPath);
      const nameMaxLen = config.get('session.nameMaxLength', 60);
      const sessionName =
        prompt && prompt.replace(/\s+/g, ' ').trim()
          ? prompt.substring(0, nameMaxLen).replace(/\n/g, ' ').trim()
          : 'New Session';
      db.upsertSession(tmpId, proj.id, sessionName);

      if (prompt) {
        const promptDelayMs = config.get('session.promptInjectionDelayMs', 2000);
        setTimeout(async () => {
          try {
            await safe.tmuxSendKeysAsync(tmux, prompt);
          } catch (err) {
            logger.error('Failed to send initial prompt', { module: 'routes', err: err.message });
          }
        }, promptDelayMs);
      }

      resolveSessionId(tmpId, { tmux, sessionsDir: sessDir, existingFiles, projectId: proj.id });
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
      safe.tmuxCreateBash(tmux, projectPath);
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
        const claudeArgs = sessionId.startsWith('new_') ? [] : ['--resume', sessionId];
        safe.tmuxCreateClaude(tmux, projectPath, claudeArgs);
        await sleep(1000);
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

  // ── Project notes ─────────────────────────────────────────────────────────

  app.get('/api/projects/:name/notes', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ notes: db.getProjectNotes(project.id) });
  });

  app.put('/api/projects/:name/notes', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    const notes = req.body.notes || '';
    if (notes.length > NOTES_MAX_LEN)
      return res.status(400).json({ error: `notes too long (max ${NOTES_MAX_LEN})` });
    db.setProjectNotes(project.id, notes);
    res.json({ saved: true });
  });

  // ── Session notes ─────────────────────────────────────────────────────────

  app.get('/api/sessions/:id/notes', (req, res) => {
    if (!validateSessionId(req.params.id))
      return res.status(400).json({ error: 'invalid session ID format' });
    res.json({ notes: db.getSessionNotes(req.params.id) });
  });

  app.put('/api/sessions/:id/notes', (req, res) => {
    if (!validateSessionId(req.params.id))
      return res.status(400).json({ error: 'invalid session ID format' });
    const notes = req.body.notes || '';
    if (notes.length > NOTES_MAX_LEN)
      return res.status(400).json({ error: `notes too long (max ${NOTES_MAX_LEN})` });
    db.setSessionNotes(req.params.id, notes);
    res.json({ saved: true });
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

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
    if (text.length > TASK_TEXT_MAX_LEN)
      return res.status(400).json({ error: `text too long (max ${TASK_TEXT_MAX_LEN})` });
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

  // ── Inter-session messages ────────────────────────────────────────────────

  app.get('/api/projects/:name/messages', (req, res) => {
    const project = db.getProject(req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });
    res.json({ messages: db.getRecentMessages(project.id) });
  });

  app.post('/api/projects/:name/messages', async (req, res) => {
    try {
      const project = db.getProject(req.params.name);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const { from_session, to_session, content } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      if (content.length > MESSAGE_CONTENT_MAX_LEN)
        return res.status(400).json({ error: `content too long (max ${MESSAGE_CONTENT_MAX_LEN})` });

      const msg = db.sendMessage(project.id, from_session || null, to_session || null, content);
      fireEvent('message_sent', {
        message_id: msg.id,
        project: req.params.name,
        from_session,
        to_session,
        content,
      });

      if (to_session) {
        const bridgeDir = join(db.DATA_DIR, 'bridges');
        await mkdir(bridgeDir, { recursive: true });
        const bridgeFile = join(bridgeDir, `msg_${crypto.randomUUID()}.md`);
        await writeFile(bridgeFile, `# Message from ${from_session || 'human'}\n\n${content}\n`);

        const tmux = tmuxName(to_session);
        let delivered = false;
        if (await safe.tmuxExists(tmux)) {
          try {
            const claudeTimeout = config.get('claude.defaultTimeoutMs', 120000);
            await safe.claudeExecAsync(
              [
                '--resume',
                to_session,
                '--dangerously-skip-permissions',
                '--no-session-persistence',
                '--print',
                bridgeFile,
              ],
              { cwd: project.path, timeout: claudeTimeout },
            );
            delivered = true;
          } catch (err) {
            logger.error('Failed to deliver bridge file', {
              module: 'routes',
              to_session,
              err: err.message,
            });
          }
        }

        const bridgeCleanupSentMs = config.get('bridge.cleanupSentMs', 5000);
        const bridgeCleanupUnsentMs = config.get('bridge.cleanupUnsentMs', 3600000);
        setTimeout(
          async () => {
            try {
              await unlink(bridgeFile);
            } catch (cleanupErr) {
              if (cleanupErr.code !== 'ENOENT')
                logger.debug('Bridge file cleanup failed', {
                  module: 'routes',
                  err: cleanupErr.message,
                });
            }
          },
          delivered ? bridgeCleanupSentMs : bridgeCleanupUnsentMs,
        );
      }
      res.json(msg);
    } catch (err) {
      logger.error('Error sending message', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Settings ──────────────────────────────────────────────────────────────

  app.get('/api/settings', (req, res) => {
    const settings = db.getAllSettings();
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
    res.json({ saved: true });
  });

  // ── CLAUDE.md management ──────────────────────────────────────────────────

  app.get('/api/claude-md/global', async (req, res) => {
    try {
      const file = join(process.env.HOME || '/home/hopper', '.claude', 'CLAUDE.md');
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
      const file = join(process.env.HOME || '/home/hopper', '.claude', 'CLAUDE.md');
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

  // ── Smart compaction ──────────────────────────────────────────────────────

  app.post('/api/sessions/:sessionId/smart-compact', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!validateSessionId(sessionId))
        return res.status(400).json({ error: 'invalid session ID format' });
      const { project } = req.body;
      if (!project) return res.status(400).json({ error: 'project required' });
      const result = await runSmartCompaction(sessionId, project);
      res.json(result);
    } catch (err) {
      logger.error('Smart compaction error', { module: 'routes', err: err.message });
      res.status(500).json({ error: err.message });
    }
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
  registerOpenAIRoutes(app);
  registerWebhookRoutes(app);
  registerExternalMcpRoutes(app);
  registerQuorumRoutes(app);

  return { checkAuthStatus, trustDir };
}

module.exports = registerCoreRoutes;
