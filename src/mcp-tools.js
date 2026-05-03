'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { readdir } = require('fs/promises');
const { join, basename, resolve, dirname } = require('path');
const { execSync } = require('child_process');
const safe = require('./safe-exec');
const sessionUtils = require('./session-utils');
const logger = require('./logger');
const db = require('./db');

const WORKSPACE = safe.WORKSPACE;
const CLAUDE_HOME = safe.CLAUDE_HOME;
const HOME = safe.HOME;

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_CLI_TYPES = ['claude', 'gemini', 'codex'];
const VALID_CLI_TYPES_FOR_NEW = ['claude', 'gemini', 'codex', 'bash'];
const VALID_KEY_NAMES = new Set([
  'Enter', 'Escape', 'Tab', 'Space', 'BSpace',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

class ToolError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function require_(args, ...keys) {
  for (const k of keys) {
    if (args[k] === undefined || args[k] === null || args[k] === '')
      throw new ToolError(`${k} required`);
  }
}

function validateSessionId(sessionId) {
  if (!sessionId) return false;
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) return true;
  return SESSION_ID_PATTERN.test(sessionId);
}

function requireSessionId(args) {
  if (!validateSessionId(args.session_id))
    throw new ToolError('valid session_id required');
}

function requireTaskId(args) {
  if (args.task_id == null || !Number.isFinite(Number(args.task_id)))
    throw new ToolError('valid numeric task_id required');
  return Number(args.task_id);
}

function resolveWorkspacePath(relPath) {
  const full = relPath ? resolve(WORKSPACE, relPath) : WORKSPACE;
  if (!full.startsWith(WORKSPACE)) throw new ToolError('path traversal blocked', 403);
  return full;
}

async function _semanticSearch(collections, query, limit) {
  const qdrant = require('./qdrant-sync');
  if (qdrant.getEmbeddingProvider() === 'none') {
    return {
      configured: false,
      message: 'Vector search is disabled. Open Workbench Settings → Vector Search and pick an embedding provider (Gemini, OpenAI, HuggingFace, or Custom) — a matching API key in Settings → API Keys is required.',
      results: [],
    };
  }
  try {
    return await qdrant.search(query, collections, limit);
  } catch (err) {
    if (err.code === 'EMBEDDINGS_DISABLED') {
      return { configured: false, message: err.message, results: [] };
    }
    throw err;
  }
}

async function ensureSessionTmux(session, projectPath) {
  const tmux = safe.tmuxNameFor(session.id);
  if (!(await safe.tmuxExists(tmux))) {
    const cliType = session.cli_type || 'claude';
    const { args: resumeArgs, missing, expectedPath } = safe.buildResumeArgs(session, projectPath);
    if (missing) {
      throw new ToolError(`Cannot reattach session ${session.id} — JSONL missing at ${expectedPath}`, 410);
    }
    safe.tmuxCreateCLI(tmux, projectPath, cliType, resumeArgs);
    await new Promise(r => setTimeout(r, 1000));
  }
  return tmux;
}

const SYS_PROMPT_FILES = { claude: 'CLAUDE.md', gemini: 'GEMINI.md', codex: 'AGENTS.md' };

const handlers = {};

// ── file_* ───────────────────────────────────────────────────────────────────

handlers.file_list = async (args) => {
  const target = resolveWorkspacePath(args.path || '');
  try {
    const entries = fs.readdirSync(target).map(name => {
      const isDir = fs.statSync(join(target, name)).isDirectory();
      return { name, type: isDir ? 'directory' : 'file' };
    });
    return { path: args.path || '/', entries };
  } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError('directory not found', 404);
    throw e;
  }
};

handlers.file_read = async (args) => {
  require_(args, 'path');
  const filePath = resolveWorkspacePath(args.path);
  try {
    return { path: args.path, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError('file not found', 404);
    throw e;
  }
};

handlers.file_create = async (args) => {
  require_(args, 'path', 'content');
  const filePath = resolveWorkspacePath(args.path);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) throw new ToolError('file already exists, use file_update', 409);
  fs.writeFileSync(filePath, args.content);
  return { created: args.path };
};

handlers.file_update = async (args) => {
  require_(args, 'path', 'content');
  const filePath = resolveWorkspacePath(args.path);
  if (!fs.existsSync(filePath)) throw new ToolError('file not found, use file_create', 404);
  fs.writeFileSync(filePath, args.content);
  return { updated: args.path };
};

handlers.file_delete = async (args) => {
  require_(args, 'path');
  const filePath = resolveWorkspacePath(args.path);
  try {
    fs.unlinkSync(filePath);
    return { deleted: args.path };
  } catch (e) {
    if (e.code === 'ENOENT') throw new ToolError('file not found', 404);
    throw e;
  }
};

handlers.file_find = async (args) => {
  require_(args, 'pattern');
  const ctx = args.context_lines || 2;
  // -m 50: cap matches per file. Without this a common pattern like
  // "deployment" overflows execSync's maxBuffer in seconds on a busy
  // workspace. We post-slice to 200 lines anyway, so matches beyond
  // that aren't useful.
  const grepArgs = ['-rn', '--color=never', `-C${ctx}`, '-m', '50'];
  if (args.file_type) grepArgs.push(`--include=*.${args.file_type}`);
  grepArgs.push('--', safe.shellEscape(args.pattern), safe.shellEscape(WORKSPACE));
  try {
    const out = execSync(`grep ${grepArgs.join(' ')}`, {
      encoding: 'utf-8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    }).trim();
    const lines = out.split('\n').slice(0, 200);
    return { pattern: args.pattern, matches: lines.map(l => l.replace(WORKSPACE + '/', '')) };
  } catch (e) {
    if (e.status === 1) return { pattern: args.pattern, matches: [] };
    if (e.code === 'ENOBUFS') {
      throw new ToolError('find output exceeded 16 MB — narrow your pattern or use file_type filter', 413);
    }
    throw e;
  }
};

handlers.file_search_documents = async (args) => {
  require_(args, 'query');
  if (args.query.length < 2) throw new ToolError('query must be at least 2 characters');
  return await _semanticSearch(['documents'], args.query, args.limit || 10);
};

handlers.file_search_code = async (args) => {
  require_(args, 'query');
  if (args.query.length < 2) throw new ToolError('query must be at least 2 characters');
  return await _semanticSearch(['code'], args.query, args.limit || 10);
};

// ── session_* ────────────────────────────────────────────────────────────────

handlers.session_new = async (args) => {
  require_(args, 'project');
  const cliType = args.cli || 'claude';
  if (!VALID_CLI_TYPES_FOR_NEW.includes(cliType))
    throw new ToolError(`invalid cli: ${cliType}. Must be one of: ${VALID_CLI_TYPES_FOR_NEW.join(', ')}`);
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  if (cliType === 'bash') {
    const tmpId = crypto.randomUUID();
    const tmux = safe.tmuxNameFor(tmpId);
    safe.tmuxCreateBash(tmux, proj.path);
    return { session_id: tmpId, tmux, project: args.project, cli: 'bash' };
  }
  const tmpId = cliType === 'claude'
    ? `new_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
    : crypto.randomUUID();
  const tmux = safe.tmuxNameFor(tmpId);
  safe.tmuxCreateCLI(tmux, proj.path, cliType);
  db.upsertSession(tmpId, proj.id, args.name || 'New Session', cliType);
  // MCP-spawned sessions default to hidden — agents creating sub-sessions
  // shouldn't clutter the human's sidebar. Pass hidden:false to override.
  if (args.hidden !== false) db.setSessionState(tmpId, 'hidden');
  return { session_id: tmpId, tmux, project: args.project, cli: cliType };
};

handlers.session_connect = async (args) => {
  let session;
  if (args.session_id) {
    requireSessionId(args);
    session = db.getSessionFull(args.session_id);
  } else if (args.query) {
    const matches = db.searchSessionsByName(args.query);
    if (matches.length === 0) throw new ToolError('no session found matching query', 404);
    session = matches[0];
  } else {
    throw new ToolError('session_id or query required');
  }
  if (!session) throw new ToolError('session not found', 404);
  const projectPath = session.project_path || safe.resolveProjectPath(session.project_name);
  const tmux = await ensureSessionTmux(session, projectPath);
  return {
    session_id: session.id,
    name: session.name,
    project: session.project_name,
    cli: session.cli_type || 'claude',
    tmux,
  };
};

handlers.session_restart = async (args) => {
  requireSessionId(args);
  const session = db.getSessionFull(args.session_id);
  if (!session) throw new ToolError('session not found', 404);
  const tmux = safe.tmuxNameFor(args.session_id);
  await safe.tmuxKill(tmux);
  const projectPath = session.project_path || safe.resolveProjectPath(session.project_name);
  const newTmux = await ensureSessionTmux(session, projectPath);
  return { session_id: session.id, tmux: newTmux, cli: session.cli_type || 'claude', restarted: true };
};

handlers.session_kill = async (args) => {
  requireSessionId(args);
  const tmux = safe.tmuxNameFor(args.session_id);
  await safe.tmuxKill(tmux);
  return { session_id: args.session_id, killed: true };
};

handlers.session_list = async (args) => {
  require_(args, 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  const sDir = sessionUtils.sessionsDir(proj.path);
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
      logger.error('Error listing sessions', { module: 'mcp-tools', project: args.project, err: err.message });
    }
  }
  return { sessions: sessions.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)) };
};

handlers.session_config = async (args) => {
  requireSessionId(args);
  if (args.name !== undefined) db.renameSession(args.session_id, args.name);
  if (args.state !== undefined) db.setSessionState(args.session_id, args.state);
  if (args.notes !== undefined) db.setSessionNotes(args.session_id, args.notes);
  return { saved: true };
};

handlers.session_summarize = async (args) => {
  requireSessionId(args);
  return await sessionUtils.summarizeSession(args.session_id, args.project);
};

handlers.session_prepare_pre_compact = async () => {
  const config = require('./config');
  return config.getPrompt('session-transition', {});
};

handlers.session_resume_post_compact = async (args) => {
  requireSessionId(args);
  const config = require('./config');
  const session = db.getSessionFull(args.session_id);
  const projectPath = session?.project_path || '';
  const sessDir = sessionUtils.sessionsDir(projectPath);
  const sessionFile = join(sessDir, `${args.session_id}.jsonl`);
  // #252: tail_lines default lowered from 60 → 15 because each Claude JSONL
  // line can be 1-3 KiB after stripping (thinking signatures, cache stats,
  // tool_use payloads). 60 lines blew past the Read tool's max-tokens cap and
  // forced multi-call file reconstruction. max_chars is the authoritative
  // size guard — if even 15 lines exceed it, we trim from the start one line
  // at a time until the tail fits, preserving the most recent context.
  const tailLines = Math.max(1, Number.isFinite(args.tail_lines) ? args.tail_lines : 15);
  const maxChars = Math.max(512, Number.isFinite(args.max_chars) ? args.max_chars : 16384);
  let tail = '';
  try {
    const content = fs.readFileSync(sessionFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    let kept = lines.slice(-tailLines);
    let joined = kept.join('\n');
    while (joined.length > maxChars && kept.length > 1) {
      kept = kept.slice(1);
      joined = kept.join('\n');
    }
    if (joined.length > maxChars) {
      // even the single most-recent line exceeds the cap — truncate mid-line.
      joined = joined.slice(-maxChars);
    }
    tail = joined;
  } catch {
    tail = '(could not read session file)';
  }
  return config.getPrompt('session-resume', { SESSION_TAIL: tail });
};

handlers.session_export = async (args) => {
  requireSessionId(args);
  const session = db.getSessionFull(args.session_id);
  if (!session) throw new ToolError('session not found', 404);
  const projectPath = session.project_path || '';
  const cliType = session.cli_type || 'claude';
  if (cliType === 'claude') {
    const sessDir = sessionUtils.sessionsDir(projectPath);
    const path = join(sessDir, `${args.session_id}.jsonl`);
    try { return { format: 'jsonl', path, content: fs.readFileSync(path, 'utf-8') }; }
    catch (e) { throw new ToolError(`session file not found: ${path}`, 404); }
  }
  // Gemini/Codex — return parsed transcript via summarizer's tail mechanism
  return await sessionUtils.summarizeSession(args.session_id, args.project);
};

handlers.session_info = async (args) => {
  requireSessionId(args);
  const info = await sessionUtils.getSessionInfo(args.session_id);
  if (!info) throw new ToolError('session not found', 404);
  return info;
};

handlers.session_find = async (args) => {
  require_(args, 'pattern');
  const cliFilter = args.cli ? args.cli.split(',').map(c => c.trim()) : VALID_CLI_TYPES;
  const results = {};
  for (const cli of cliFilter) {
    let searchDirs = [];
    switch (cli) {
      case 'claude': searchDirs = [join(CLAUDE_HOME, 'projects')]; break;
      case 'gemini': searchDirs = [join(HOME, '.gemini', 'tmp')]; break;
      case 'codex':  searchDirs = [process.env.CODEX_HOME || join(HOME, '.codex', 'sessions')]; break;
    }
    const matches = [];
    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const out = execSync(
          `grep -rn --color=never --include='*.jsonl' --include='*.json' -- ${safe.shellEscape(args.pattern)} ${safe.shellEscape(dir)}`,
          { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 },
        ).trim();
        if (out) matches.push(...out.split('\n').slice(0, 50).map(l => l.replace(dir + '/', '')));
      } catch (e) {
        if (e.status !== 1) logger.error('Session grep error', { module: 'mcp-tools', cli, err: e.message });
      }
    }
    if (matches.length > 0) results[cli] = matches;
  }
  return { pattern: args.pattern, results };
};

handlers.session_search = async (args) => {
  require_(args, 'query');
  if (args.query.length < 2) throw new ToolError('query must be at least 2 characters');
  const cliFilter = args.cli ? args.cli.split(',').map(c => c.trim()) : VALID_CLI_TYPES;
  const collections = cliFilter.map(c => c + '_sessions');
  return await _semanticSearch(collections, args.query, args.limit || 10);
};

handlers.session_send_text = async (args) => {
  requireSessionId(args);
  require_(args, 'text');
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  await safe.tmuxSendTextAsync(tmux, args.text);
  return { sent: true, tmux };
};

handlers.session_send_keys = async (args) => {
  requireSessionId(args);
  require_(args, 'text');
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  await safe.tmuxExecAsync(['send-keys', '-t', tmux, args.text]);
  return { sent: true, tmux };
};

handlers.session_send_key = async (args) => {
  requireSessionId(args);
  require_(args, 'key');
  // Allow named keys from the whitelist OR a single printable ASCII char.
  const isNamed = VALID_KEY_NAMES.has(args.key);
  const isSingle = typeof args.key === 'string' && args.key.length === 1 && /^[\x20-\x7E]$/.test(args.key);
  if (!isNamed && !isSingle) throw new ToolError(`invalid key: ${args.key}`);
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  await safe.tmuxSendKeyAsync(tmux, args.key);
  return { sent: true, key: args.key, tmux };
};

handlers.session_read_screen = async (args) => {
  requireSessionId(args);
  const tmux = safe.tmuxNameFor(args.session_id);
  if (!(await safe.tmuxExists(tmux))) throw new ToolError(`tmux session not running: ${tmux}`, 410);
  const lines = Math.max(1, Math.min(args.lines || 200, 1000));
  const { stdout } = await safe.tmuxExecAsync(['capture-pane', '-p', '-S', `-${lines}`, '-t', tmux]);
  return { tmux, lines, screen: stdout };
};

handlers.session_read_output = async (args) => {
  requireSessionId(args);
  const result = await sessionUtils.summarizeSession(args.session_id, args.project);
  return result;
};

handlers.session_wait = async (args) => {
  const seconds = Math.max(0, Math.min(Number(args.seconds) || 0, 60));
  if (!Number.isFinite(seconds) || seconds <= 0) throw new ToolError('seconds must be a positive number ≤ 60');
  await new Promise(r => setTimeout(r, seconds * 1000));
  return { waited_seconds: seconds };
};

// ── project_* ────────────────────────────────────────────────────────────────

function _projectShape(p) {
  return { id: p.id, name: p.name, path: p.path, notes: p.notes || '', state: p.state || 'active' };
}

handlers.project_find = async (args = {}) => {
  let projects = db.getProjects();
  if (args.pattern) {
    let re;
    try { re = new RegExp(args.pattern, 'i'); }
    catch (e) { throw new ToolError(`invalid regex: ${e.message}`); }
    projects = projects.filter(p => re.test(p.name) || re.test(p.notes || ''));
  }
  return { projects: projects.map(_projectShape) };
};

handlers.project_get = async (args) => {
  require_(args, 'project');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  return _projectShape(p);
};

handlers.project_update = async (args) => {
  require_(args, 'project');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  if (args.name !== undefined) db.renameProject(p.id, args.name);
  if (args.notes !== undefined) db.setProjectNotes(p.id, args.notes);
  if (args.state !== undefined) db.setProjectState(p.id, args.state);
  return _projectShape(db.getProjectById(p.id));
};

handlers.project_sys_prompt_get = async (args) => {
  require_(args, 'project', 'cli');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  const filename = SYS_PROMPT_FILES[args.cli];
  if (!filename) throw new ToolError(`invalid cli: ${args.cli}. Must be claude, gemini, or codex`);
  const path = join(p.path, filename);
  let content = '';
  try { content = fs.readFileSync(path, 'utf-8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { project: args.project, cli: args.cli, file: filename, content };
};

handlers.project_sys_prompt_update = async (args) => {
  require_(args, 'project', 'cli', 'content');
  const p = db.getProject(args.project);
  if (!p) throw new ToolError('project not found', 404);
  const filename = SYS_PROMPT_FILES[args.cli];
  if (!filename) throw new ToolError(`invalid cli: ${args.cli}. Must be claude, gemini, or codex`);
  fs.writeFileSync(join(p.path, filename), args.content);
  return { project: args.project, cli: args.cli, file: filename, updated: true };
};

handlers.project_mcp_list = async () => {
  return { servers: db.getMcpServers() };
};

handlers.project_mcp_register = async (args) => {
  require_(args, 'mcp_name', 'mcp_config');
  const transport = args.mcp_transport || 'stdio';
  const cfgStr = typeof args.mcp_config === 'string' ? args.mcp_config : JSON.stringify(args.mcp_config);
  db.registerMcp(args.mcp_name, transport, cfgStr, args.mcp_description || '');
  return { registered: args.mcp_name };
};

handlers.project_mcp_unregister = async (args) => {
  require_(args, 'mcp_name');
  db.unregisterMcp(args.mcp_name);
  return { unregistered: args.mcp_name };
};

function _writeProjectMcpJson(proj) {
  const enabled = db.getEnabledMcpForProject(proj.id);
  const mcpJson = {};
  for (const s of enabled) {
    try { mcpJson[s.name] = JSON.parse(s.config); } catch { mcpJson[s.name] = s.config; }
  }
  fs.writeFileSync(join(proj.path, '.mcp.json'), JSON.stringify({ mcpServers: mcpJson }, null, 2));
}

async function _restartCallingSession(args, projectPath) {
  if (!args.session_id) return;
  const session = db.getSessionFull(args.session_id);
  if (!session) return;
  const tmux = safe.tmuxNameFor(args.session_id);
  await safe.tmuxKill(tmux);
  await ensureSessionTmux(session, session.project_path || projectPath);
}

handlers.project_mcp_enable = async (args) => {
  require_(args, 'mcp_name', 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  if (!db.getMcpServer(args.mcp_name)) throw new ToolError('MCP server not registered', 404);
  db.enableMcpForProject(proj.id, args.mcp_name);
  _writeProjectMcpJson(proj);
  await _restartCallingSession(args, proj.path);
  return { enabled: args.mcp_name, project: args.project };
};

handlers.project_mcp_disable = async (args) => {
  require_(args, 'mcp_name', 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  db.disableMcpForProject(proj.id, args.mcp_name);
  _writeProjectMcpJson(proj);
  await _restartCallingSession(args, proj.path);
  return { disabled: args.mcp_name, project: args.project };
};

handlers.project_mcp_list_enabled = async (args) => {
  require_(args, 'project');
  const proj = db.getProject(args.project);
  if (!proj) throw new ToolError('project not found', 404);
  return { servers: db.getEnabledMcpForProject(proj.id) };
};

// ── task_* ───────────────────────────────────────────────────────────────────

handlers.task_find = async (args = {}) => {
  let tasks = args.folder_path
    ? db.getTasksByFolder(args.folder_path)
    : db.getAllTasks(args.filter || 'todo');
  if (args.pattern) {
    let re;
    try { re = new RegExp(args.pattern, 'i'); }
    catch (e) { throw new ToolError(`invalid regex: ${e.message}`); }
    tasks = tasks.filter(t => re.test(t.title || '') || re.test(t.description || ''));
  }
  return { tasks };
};

handlers.task_get = async (args) => {
  const id = requireTaskId(args);
  const task = db.getTask(id);
  if (!task) throw new ToolError('task not found', 404);
  return task;
};

handlers.task_add = async (args) => {
  require_(args, 'title');
  if (args.title.length > 500) throw new ToolError('title max 500 chars');
  const folderPath = args.folder_path || '/';
  return db.addTask(folderPath, args.title, args.description || '', null, 'agent');
};

handlers.task_move = async (args) => {
  const id = requireTaskId(args);
  require_(args, 'folder_path');
  db.moveTask(id, args.folder_path);
  return { moved: true, task_id: id, folder_path: args.folder_path };
};

handlers.task_update = async (args) => {
  const id = requireTaskId(args);
  if (args.title !== undefined) db.updateTaskTitle(id, args.title);
  if (args.description !== undefined) db.updateTaskDescription(id, args.description);
  if (args.status !== undefined) {
    if (!['todo', 'done', 'archived'].includes(args.status))
      throw new ToolError(`invalid status: ${args.status}. Must be todo, done, or archived`);
    db.updateTaskStatus(id, args.status);
  }
  if (args.folder_path !== undefined) db.moveTask(id, args.folder_path);
  return db.getTask(id) || { updated: true };
};

// ── log_* ────────────────────────────────────────────────────────────────────

const SINCE_RE = /^(\d+)\s*([smhd])$/;

function _resolveSince(sinceArg) {
  if (!sinceArg) return null;
  const m = SINCE_RE.exec(String(sinceArg).trim());
  if (!m) {
    // Treat as ISO timestamp if not a relative form.
    const d = new Date(sinceArg);
    if (Number.isNaN(d.getTime())) throw new ToolError(`invalid since: ${sinceArg}. Use 1h / 30m / 24h / iso8601`);
    return d.toISOString();
  }
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === 's' ? n * 1000
    : unit === 'm' ? n * 60_000
    : unit === 'h' ? n * 3_600_000
    : n * 86_400_000;
  return new Date(Date.now() - ms).toISOString();
}

handlers.log_find = async (args = {}) => {
  if (args.level && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(args.level)) {
    throw new ToolError(`invalid level: ${args.level}. Must be DEBUG / INFO / WARN / ERROR`);
  }
  const sinceTs = _resolveSince(args.since);
  let rows = db.queryLogs({ level: args.level, module: args.module, since: sinceTs, limit: args.limit });
  if (args.pattern) {
    let re;
    try { re = new RegExp(args.pattern, 'i'); }
    catch (e) { throw new ToolError(`invalid regex: ${e.message}`); }
    rows = rows.filter(r => re.test(r.message || '') || re.test(r.context || ''));
  }
  return { count: rows.length, logs: rows };
};

// ── Dispatch + HTTP ──────────────────────────────────────────────────────────

const TOOL_NAMES = Object.keys(handlers);

async function dispatch(toolName, args) {
  const handler = handlers[toolName];
  if (!handler) throw new ToolError(`Unknown tool: ${toolName}`, 404);
  return await handler(args || {});
}

function registerMcpRoutes(app) {
  app.get('/api/mcp/tools', (req, res) => {
    res.json({ tools: TOOL_NAMES });
  });

  app.post('/api/mcp/call', async (req, res) => {
    const { tool, args } = req.body || {};
    try {
      const result = await dispatch(tool, args);
      res.json({ result });
    } catch (err) {
      const status = err.status
        || (err.code === 'ENOENT' ? 404
            : err instanceof SyntaxError ? 400
            : err.message?.includes('traversal') ? 403
            : 500);
      if (status === 500) {
        logger.error('MCP tool call error', { module: 'mcp-tools', tool, err: err.message });
      }
      res.status(status).json({ error: err.message });
    }
  });
}

module.exports = { registerMcpRoutes, handlers, dispatch, TOOL_NAMES, ToolError };
