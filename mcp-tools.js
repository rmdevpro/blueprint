'use strict';

const fs = require('fs');
const { readFile, readdir } = require('fs/promises');
const { join, basename, resolve, relative, sep } = require('path');
const { execSync } = require('child_process');
const safe = require('./safe-exec');
const sessionUtils = require('./session-utils');
const logger = require('./logger');

const WORKSPACE = safe.WORKSPACE;
const CLAUDE_HOME = safe.CLAUDE_HOME;
const HOME = safe.HOME;

const db = require('./db');

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateSessionId(sessionId) {
  if (!sessionId) return false;
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) return true;
  return SESSION_ID_PATTERN.test(sessionId);
}

function validateTaskId(taskId) {
  return taskId != null && Number.isFinite(Number(taskId));
}

/**
 * Resolve a workspace-relative path and validate it stays within the workspace.
 */
function resolveWorkspacePath(relPath) {
  const full = relPath ? resolve(WORKSPACE, relPath) : WORKSPACE;
  if (!full.startsWith(WORKSPACE)) throw new Error('path traversal blocked');
  return full;
}

// ── blueprint_files ──────────────────────────────────────────────────────────

async function handleFiles(args, res) {
  switch (args.action) {
    case 'list': {
      const target = resolveWorkspacePath(args.path || '');
      try {
        const entries = fs.readdirSync(target).map(name => {
          const full = join(target, name);
          const isDir = fs.statSync(full).isDirectory();
          return { name, type: isDir ? 'directory' : 'file' };
        });
        return { path: args.path || '/', entries };
      } catch (e) {
        return { path: args.path || '/', entries: [], error: e.code === 'ENOENT' ? 'directory not found' : e.message };
      }
    }
    case 'read': {
      if (!args.path) return res.status(400).json({ error: 'path required' });
      const filePath = resolveWorkspacePath(args.path);
      try {
        return { path: args.path, content: fs.readFileSync(filePath, 'utf-8') };
      } catch (e) {
        return { error: e.code === 'ENOENT' ? 'file not found' : e.message };
      }
    }
    case 'create': {
      if (!args.path || !args.content) return res.status(400).json({ error: 'path and content required' });
      const filePath = resolveWorkspacePath(args.path);
      const dir = require('path').dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(filePath)) return res.status(409).json({ error: 'file already exists, use update' });
      fs.writeFileSync(filePath, args.content);
      return { created: args.path };
    }
    case 'update': {
      if (!args.path || !args.content) return res.status(400).json({ error: 'path and content required' });
      const filePath = resolveWorkspacePath(args.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found, use create' });
      fs.writeFileSync(filePath, args.content);
      return { updated: args.path };
    }
    case 'delete': {
      if (!args.path) return res.status(400).json({ error: 'path required' });
      const filePath = resolveWorkspacePath(args.path);
      try {
        fs.unlinkSync(filePath);
        return { deleted: args.path };
      } catch (e) {
        return { error: e.code === 'ENOENT' ? 'file not found' : e.message };
      }
    }
    case 'grep': {
      if (!args.pattern) return res.status(400).json({ error: 'pattern required' });
      const ctx = args.context_lines || 2;
      const grepArgs = ['-rn', `--color=never`, `-C${ctx}`];
      if (args.file_type) grepArgs.push(`--include=*.${args.file_type}`);
      grepArgs.push('--', safe.shellEscape(args.pattern), safe.shellEscape(WORKSPACE));
      try {
        const out = execSync(`grep ${grepArgs.join(' ')}`, {
          encoding: 'utf-8',
          timeout: 10000,
          maxBuffer: 1024 * 1024,
        }).trim();
        const lines = out.split('\n').slice(0, 200);
        // Strip workspace prefix for cleaner output
        const cleaned = lines.map(l => l.replace(WORKSPACE + '/', ''));
        return { pattern: args.pattern, matches: cleaned };
      } catch (e) {
        // grep returns exit code 1 for no matches
        if (e.status === 1) return { pattern: args.pattern, matches: [] };
        return { error: e.message };
      }
    }
    case 'search_documents': {
      if (!args.query || args.query.length < 2)
        return res.status(400).json({ error: 'query must be at least 2 characters' });
      const qdrant = require('./qdrant-sync');
      return await qdrant.search(args.query, ['documents'], args.limit || 10);
    }
    case 'search_code': {
      if (!args.query || args.query.length < 2)
        return res.status(400).json({ error: 'query must be at least 2 characters' });
      const qdrant = require('./qdrant-sync');
      return await qdrant.search(args.query, ['code'], args.limit || 10);
    }
    default:
      return res.status(400).json({ error: `invalid action: ${args.action}` });
  }
}

// ── blueprint_sessions ───────────────────────────────────────────────────────

async function handleSessions(args, res) {
  switch (args.action) {
    case 'list': {
      const project = args.project;
      if (!project) return res.status(400).json({ error: 'project required' });
      return await listSessions(project);
    }
    case 'info': {
      // Lookup by session_id or by name query
      if (args.session_id) {
        if (!validateSessionId(args.session_id))
          return res.status(400).json({ error: 'invalid session_id format' });
        const session = db.getSessionFull(args.session_id);
        if (!session) return { error: 'session not found' };
        const tmuxName = `bp_${safe.sanitizeTmuxName(args.session_id)}`;
        const tmuxRunning = await safe.tmuxExists(tmuxName);
        const sessDir = sessionUtils.sessionsDir(session.project_path || '');
        const sessionFile = join(sessDir, `${args.session_id}.jsonl`);
        let fileExists = false;
        try { fs.statSync(sessionFile); fileExists = true; } catch {}
        return {
          session_id: session.id,
          name: session.name,
          project: session.project_name,
          state: session.state,
          notes: session.notes,
          tmux: tmuxName,
          tmux_running: tmuxRunning,
          session_file: sessionFile,
          file_exists: fileExists,
        };
      }
      if (args.query) {
        // Search sessions by name
        const matches = db.searchSessionsByName(args.query);
        const results = [];
        for (const s of matches) {
          const tmuxName = `bp_${safe.sanitizeTmuxName(s.id)}`;
          const tmuxRunning = await safe.tmuxExists(tmuxName);
          results.push({
            session_id: s.id,
            name: s.name,
            project: s.project_name,
            state: s.state,
            tmux: tmuxName,
            tmux_running: tmuxRunning,
          });
        }
        return results;
      }
      return res.status(400).json({ error: 'session_id or query required' });
    }
    case 'config': {
      if (!validateSessionId(args.session_id))
        return res.status(400).json({ error: 'invalid session_id format' });
      if (args.name !== undefined) db.renameSession(args.session_id, args.name);
      if (args.state !== undefined) db.setSessionState(args.session_id, args.state);
      if (args.notes !== undefined) db.setSessionNotes(args.session_id, args.notes);
      return { saved: true };
    }
    case 'tokens': {
      if (!validateSessionId(args.session_id))
        return res.status(400).json({ error: 'invalid session_id format' });
      return await sessionUtils.getTokenUsage(args.session_id, args.project);
    }
    case 'summarize': {
      if (!validateSessionId(args.session_id))
        return res.status(400).json({ error: 'invalid session_id format' });
      return await sessionUtils.summarizeSession(args.session_id, args.project);
    }
    case 'transition': {
      const r = await fetch(
        `http://localhost:${process.env.BLUEPRINT_PORT || 3000}/api/sessions/${args.session_id || 'current'}/session`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'transition' }),
        },
      );
      const data = await r.json();
      return data.prompt || data.error || 'No response';
    }
    case 'resume': {
      if (!validateSessionId(args.session_id))
        return res.status(400).json({ error: 'session_id required' });
      const r = await fetch(
        `http://localhost:${process.env.BLUEPRINT_PORT || 3000}/api/sessions/${args.session_id}/session`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'resume', tailLines: args.tail_lines || 60 }),
        },
      );
      const data = await r.json();
      return data.prompt || data.error || 'No response';
    }
    case 'grep': {
      if (!args.pattern) return res.status(400).json({ error: 'pattern required' });
      const cliFilter = args.cli ? args.cli.split(',').map(c => c.trim()) : ['claude', 'gemini', 'codex'];
      const results = {};

      for (const cli of cliFilter) {
        let searchDirs = [];
        switch (cli) {
          case 'claude':
            searchDirs = [join(CLAUDE_HOME, 'projects')];
            break;
          case 'gemini':
            searchDirs = [join(HOME, '.gemini', 'tmp')];
            break;
          case 'codex':
            searchDirs = [process.env.CODEX_HOME || join(HOME, '.codex', 'sessions')];
            break;
        }
        const matches = [];
        for (const dir of searchDirs) {
          if (!fs.existsSync(dir)) continue;
          try {
            const out = execSync(
              `grep -rn --color=never --include='*.jsonl' --include='*.json' -- ${safe.shellEscape(args.pattern)} ${safe.shellEscape(dir)}`,
              { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
            ).trim();
            if (out) {
              const lines = out.split('\n').slice(0, 50);
              matches.push(...lines.map(l => l.replace(dir + '/', '')));
            }
          } catch (e) {
            if (e.status !== 1) logger.error('Session grep error', { module: 'mcp-tools', cli, err: e.message });
          }
        }
        if (matches.length > 0) results[cli] = matches;
      }
      return { pattern: args.pattern, results };
    }
    case 'search_semantic': {
      if (!args.query || args.query.length < 2)
        return res.status(400).json({ error: 'query must be at least 2 characters' });
      const qdrant = require('./qdrant-sync');
      const cliFilter = args.cli ? args.cli.split(',').map(c => c.trim()) : ['claude', 'gemini', 'codex'];
      const collections = cliFilter.map(c => c + '_sessions');
      return await qdrant.search(args.query, collections, args.limit || 10);
    }
    default:
      return res.status(400).json({ error: `invalid action: ${args.action}` });
  }
}

// ── blueprint_tasks ──────────────────────────────────────────────────────────

async function handleTasks(args, res) {
  switch (args.action) {
    case 'get': {
      if (args.folder_path) {
        return { tasks: db.getTasksByFolder(args.folder_path) };
      }
      return { tasks: db.getAllTasks(args.filter || 'todo') };
    }
    case 'add': {
      if (!args.title || args.title.length > 500)
        return res.status(400).json({ error: 'title required (max 500 chars)' });
      const folderPath = args.folder_path || '/';
      return db.addTask(folderPath, args.title, args.description || '', null, 'agent');
    }
    case 'complete': {
      if (!validateTaskId(args.task_id))
        return res.status(400).json({ error: 'valid numeric task_id required' });
      db.updateTaskStatus(Number(args.task_id), 'done');
      return { completed: true };
    }
    case 'reopen': {
      if (!validateTaskId(args.task_id))
        return res.status(400).json({ error: 'valid numeric task_id required' });
      db.updateTaskStatus(Number(args.task_id), 'todo');
      return { reopened: true };
    }
    case 'archive': {
      if (!validateTaskId(args.task_id))
        return res.status(400).json({ error: 'valid numeric task_id required' });
      db.updateTaskStatus(Number(args.task_id), 'archived');
      return { archived: true };
    }
    case 'move': {
      if (!validateTaskId(args.task_id))
        return res.status(400).json({ error: 'valid numeric task_id required' });
      if (!args.folder_path) return res.status(400).json({ error: 'folder_path required' });
      db.moveTask(Number(args.task_id), args.folder_path);
      return { moved: true };
    }
    case 'update': {
      if (!validateTaskId(args.task_id))
        return res.status(400).json({ error: 'valid numeric task_id required' });
      const taskId = Number(args.task_id);
      if (args.title) db.updateTaskTitle(taskId, args.title);
      if (args.description !== undefined) db.updateTaskDescription(taskId, args.description);
      return db.getTask(taskId) || { updated: true };
    }
    default:
      return res.status(400).json({ error: `invalid action: ${args.action}` });
  }
}

// ── Route registration ───────────────────────────────────────────────────────

function registerMcpRoutes(app) {
  app.get('/api/mcp/tools', (req, res) => {
    res.json({
      tools: [
        { name: 'blueprint_files', description: 'Workspace file operations — read, write, list, delete, grep, and semantic search.' },
        { name: 'blueprint_sessions', description: 'Session operations across all CLIs — list, lookup, config, search, summarize.' },
        { name: 'blueprint_tasks', description: 'Task management — create, complete, reopen, archive, move, update.' },
      ],
    });
  });

  app.post('/api/mcp/call', async (req, res) => {
    const { tool, args } = req.body;
    if (!args || !args.action) return res.status(400).json({ error: 'action required' });

    try {
      let result;
      switch (tool) {
        case 'blueprint_files':
          result = await handleFiles(args, res);
          break;
        case 'blueprint_sessions':
          result = await handleSessions(args, res);
          break;
        case 'blueprint_tasks':
          result = await handleTasks(args, res);
          break;
        default:
          return res.status(404).json({ error: `Unknown tool: ${tool}` });
      }
      // If handler already sent response (via res.status().json()), don't send again
      if (!res.headersSent) res.json({ result });
    } catch (err) {
      if (res.headersSent) return;
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: `Resource not found: ${err.message}` });
      }
      if (err instanceof SyntaxError) {
        return res.status(400).json({ error: `Invalid input: ${err.message}` });
      }
      if (err.message && err.message.includes('traversal')) {
        return res.status(403).json({ error: err.message });
      }
      logger.error('MCP tool call error', { module: 'mcp-tools', tool, action: args.action, err: err.message });
      res.status(500).json({ error: err.message });
    }
  });
}

async function listSessions(project) {
  const projectPath = join(WORKSPACE, project);
  const sDir = sessionUtils.sessionsDir(projectPath);
  const sessions = [];
  try {
    const files = await readdir(sDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = basename(file, '.jsonl');
      const meta = await sessionUtils.parseSessionFile(join(sDir, file));
      if (meta) {
        sessions.push({
          session_id: sessionId,
          name: meta.name || 'Untitled',
          timestamp: meta.timestamp,
          message_count: meta.messageCount,
        });
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error('Error listing sessions', { module: 'mcp-tools', project, err: err.message });
    }
  }
  return sessions.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

module.exports = { registerMcpRoutes };
