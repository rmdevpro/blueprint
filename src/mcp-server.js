#!/usr/bin/env node
'use strict';

const http = require('http');
const readline = require('readline');

const PORT = process.env.PORT || 7860;
const BASE_URL = `http://localhost:${PORT}`;

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) resolve({ raw: data });
          else reject(parseErr);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Schema fragments ──────────────────────────────────────────────────────────
// Common parameter definitions reused across multiple tool schemas.

const P = {
  session_id: { type: 'string', description: 'Workbench session ID (the UUID-prefixed id from session_list).' },
  project: { type: 'string', description: 'Project name as listed by project_list.' },
  cli: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'CLI type.' },
  cli_or_csv: { type: 'string', description: 'CLI filter — single name or comma-separated list (claude,gemini,codex). Default: all three.' },
  pattern: { type: 'string', description: 'Regex pattern to match.' },
  query: { type: 'string', description: 'Search query (semantic, ≥ 2 chars).' },
  limit: { type: 'number', description: 'Max results (default 10).' },
  task_id: { type: 'number', description: 'Task ID (numeric).' },
  folder_path: { type: 'string', description: 'Folder path under workspace root, e.g. /src/auth or / for root.' },
};

const T = (name, description, properties, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required },
});

// ── Tool catalog (45 flat tools under server `workbench`) ─────────────────────

const TOOLS = [
  // file_*
  T('file_list', 'List entries in a workspace directory.', {
    path: { type: 'string', description: 'Workspace-relative directory path. Default: workspace root.' },
  }),
  T('file_read', 'Read a workspace file as UTF-8 text.', {
    path: { type: 'string', description: 'Workspace-relative file path.' },
  }, ['path']),
  T('file_create', 'Create a new workspace file. Fails if it already exists (use file_update to overwrite).', {
    path: { type: 'string' }, content: { type: 'string' },
  }, ['path', 'content']),
  T('file_update', 'Overwrite an existing workspace file. Fails if it does not exist (use file_create first).', {
    path: { type: 'string' }, content: { type: 'string' },
  }, ['path', 'content']),
  T('file_delete', 'Delete a workspace file.', {
    path: { type: 'string' },
  }, ['path']),
  T('file_find', 'Recursive regex search across workspace files (replaces the old file_grep). Returns up to 200 matching lines.', {
    pattern: P.pattern,
    file_type: { type: 'string', description: 'Restrict to files with this extension (e.g. js, py, md).' },
    context_lines: { type: 'number', description: 'Lines of context around each match (default 2).' },
  }, ['pattern']),
  T('file_search_documents', 'Semantic search across documentation files (markdown / text). Requires a vector embedding provider configured in Settings.', {
    query: P.query, limit: P.limit,
  }, ['query']),
  T('file_search_code', 'Semantic search across source code files. Requires a vector embedding provider configured in Settings.', {
    query: P.query, limit: P.limit,
  }, ['query']),

  // session_* — lifecycle
  T('session_new', 'Create a new CLI session in a project. Defaults to hidden so MCP-spawned sub-sessions do not clutter the sidebar.', {
    project: P.project,
    cli: { type: 'string', enum: ['claude', 'gemini', 'codex', 'bash'], description: 'CLI to launch (default claude). Use bash for utility shell sessions.' },
    name: { type: 'string', description: 'Session name shown in the sidebar. Required.' },
    hidden: { type: 'boolean', description: 'Whether to hide from sidebar (default true). Set false for visible sessions.' },
  }, ['project', 'name']),
  T('session_connect', 'Look up a session and ensure its tmux pane is running. Returns the tmux name. Pass session_id (preferred) or query (fuzzy name match).', {
    session_id: P.session_id,
    query: { type: 'string', description: 'Fuzzy name match against the sidebar session list (best match wins).' },
  }),
  T('session_restart', 'Kill the session’s tmux pane and respawn the CLI with --resume. JSONL must still exist on disk.', {
    session_id: P.session_id,
  }, ['session_id']),
  T('session_kill', 'Kill the session’s tmux pane without respawning. Use when you are done driving the session.', {
    session_id: P.session_id,
  }, ['session_id']),
  T('session_list', 'List sessions in a project, sorted newest first.', {
    project: P.project,
  }, ['project']),
  T('session_config', 'Update session metadata (name / state / notes).', {
    session_id: P.session_id,
    name: { type: 'string' },
    state: { type: 'string', enum: ['active', 'archived', 'hidden'] },
    notes: { type: 'string' },
  }, ['session_id']),
  T('session_summarize', 'Return a structured summary of a session (recent transcript + token counts).', {
    session_id: P.session_id, project: P.project,
  }, ['session_id']),
  T('session_prepare_pre_compact', 'Return the pre-compact checklist prompt — call before /compact in a long session.', {}),
  T('session_resume_post_compact', 'Return the resume prompt for after a /compact, with the last N JSONL lines injected as context. Output is hard-capped at max_chars (default 16384) to stay readable in a single tool result; if the requested tail exceeds the cap, only the most recent lines that fit are kept.', {
    session_id: P.session_id,
    tail_lines: { type: 'number', description: 'Lines of session tail to consider (default 15). Each Claude JSONL line can be 1-3 KiB after stripping; large defaults blow past the Read cap. Use a small number for long sessions.' },
    max_chars: { type: 'number', description: 'Hard cap on injected-tail char count (default 16384). The tail is trimmed line-by-line from the start to fit; the cap takes precedence over tail_lines.' },
  }, ['session_id']),
  T('session_export', 'Export a session — raw JSONL for Claude, structured summary for Gemini/Codex.', {
    session_id: P.session_id, project: P.project,
  }, ['session_id']),
  T('session_info', 'Unified session info: model, tokens, message count, timestamp, cli_type, active (tmux alive).', {
    session_id: P.session_id,
  }, ['session_id']),

  // session_* — search
  T('session_find', 'Regex search across session JSONLs (replaces session_grep). Filter by CLI with the cli arg.', {
    pattern: P.pattern, cli: P.cli_or_csv,
  }, ['pattern']),
  T('session_search', 'Semantic search across session content. Filter by CLI with the cli arg. Requires a vector embedding provider.', {
    query: P.query, cli: P.cli_or_csv, limit: P.limit,
  }, ['query']),

  // session_* — tmux interaction
  T('session_send_text', 'Paste text into a session via tmux load-buffer + paste-buffer (no Enter). Use this for prompts and long input — handles special characters safely. Follow with session_send_key {key:"Enter"} to submit. SIZE LIMIT: 32 KiB (32768 chars). For larger input, write to a file and reference it (e.g. "Read /tmp/briefing.md") instead.', {
    session_id: P.session_id, text: { type: 'string', maxLength: 32768, description: 'Text to paste. No trailing Enter is appended. Hard cap 32768 chars — for larger input, write to a file and reference it.' },
  }, ['session_id', 'text']),
  T('session_send_keys', 'Send raw text via tmux send-keys. Short commands only — special characters get shell-interpreted. For prompts, prefer session_send_text.', {
    session_id: P.session_id, text: { type: 'string' },
  }, ['session_id', 'text']),
  T('session_send_key', 'Send a single named key (Enter, Escape, Tab, Up, etc.) or single ASCII char. Used to submit input or dismiss menus.', {
    session_id: P.session_id, key: { type: 'string', description: 'Key name (Enter, Escape, Tab, Up, Down, F1..F12, etc.) or a single printable ASCII character.' },
  }, ['session_id', 'key']),
  T('session_read_screen', 'Capture the visible tmux pane content (capture-pane). Useful for checking startup prompts, verifying submission, watching for "Thinking…".', {
    session_id: P.session_id, lines: { type: 'number', description: 'Lines of scrollback to include (default 200, max 1000).' },
  }, ['session_id']),
  T('session_read_output', 'Read structured session content (parsed transcript with token counts). Higher-fidelity than session_read_screen — not limited to visible pane.', {
    session_id: P.session_id, project: P.project,
  }, ['session_id']),
  T('session_wait', 'Pause for N seconds (≤ 60). Use between session_send_text and session_read_screen so the CLI has time to respond.', {
    seconds: { type: 'number', description: 'Seconds to wait (positive, ≤ 60).' },
  }, ['seconds']),

  // project_*
  T('project_find', 'List all projects, optionally filtered by case-insensitive regex over name + notes (replaces project_list and project_grep).', {
    pattern: { type: 'string', description: 'Optional regex; if absent, returns every project.' },
  }),
  T('project_get', 'Get a single project by name.', { project: P.project }, ['project']),
  T('project_update', 'Update project metadata (name / notes / state).', {
    project: P.project,
    name: { type: 'string', description: 'New project name.' },
    notes: { type: 'string' },
    state: { type: 'string', enum: ['active', 'archived', 'hidden'] },
  }, ['project']),
  T('project_sys_prompt_get', 'Read a CLI’s system-prompt file from the project (CLAUDE.md / GEMINI.md / AGENTS.md).', {
    project: P.project, cli: P.cli,
  }, ['project', 'cli']),
  T('project_sys_prompt_update', 'Write a CLI’s system-prompt file in the project (CLAUDE.md / GEMINI.md / AGENTS.md).', {
    project: P.project, cli: P.cli, content: { type: 'string' },
  }, ['project', 'cli', 'content']),
  T('project_mcp_list', 'List MCP servers registered in the workbench (available to enable per project).', {}),
  T('project_mcp_register', 'Register an MCP server in the workbench so it can be enabled per project.', {
    mcp_name: { type: 'string', description: 'Server name as written into .mcp.json.' },
    mcp_config: { type: 'object', description: 'Server config (command/args for stdio, url for http).' },
    mcp_transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
    mcp_description: { type: 'string' },
  }, ['mcp_name', 'mcp_config']),
  T('project_mcp_unregister', 'Unregister a workbench-level MCP server.', {
    mcp_name: { type: 'string' },
  }, ['mcp_name']),
  T('project_mcp_enable', 'Enable an MCP server for a project. Updates that project’s .mcp.json. If session_id is provided, restarts that session so the new server is picked up.', {
    project: P.project, mcp_name: { type: 'string' }, session_id: P.session_id,
  }, ['project', 'mcp_name']),
  T('project_mcp_disable', 'Disable an MCP server for a project. Updates .mcp.json. If session_id is provided, restarts that session.', {
    project: P.project, mcp_name: { type: 'string' }, session_id: P.session_id,
  }, ['project', 'mcp_name']),
  T('project_mcp_list_enabled', 'List MCP servers enabled for a project.', {
    project: P.project,
  }, ['project']),

  // task_*
  T('task_find', 'Find tasks. Optional filters: folder_path, status (todo / done / archived / all), pattern (regex over title + description). Replaces task_list and task_grep.', {
    folder_path: P.folder_path,
    filter: { type: 'string', enum: ['all', 'todo', 'done', 'archived'], description: 'Status filter (default todo).' },
    pattern: { type: 'string', description: 'Optional case-insensitive regex over title + description.' },
  }),
  T('task_get', 'Get a single task by ID.', { task_id: P.task_id }, ['task_id']),
  T('task_add', 'Create a new task.', {
    title: { type: 'string', description: 'Task title (≤ 500 chars).' },
    description: { type: 'string' },
    folder_path: P.folder_path,
  }, ['title']),
  T('task_move', 'Move a task to a different folder.', {
    task_id: P.task_id, folder_path: P.folder_path,
  }, ['task_id', 'folder_path']),
  T('task_update', 'Update task fields (title, description, status, folder_path).', {
    task_id: P.task_id,
    title: { type: 'string' },
    description: { type: 'string' },
    status: { type: 'string', enum: ['todo', 'done', 'archived'] },
    folder_path: P.folder_path,
  }, ['task_id']),

  // log_*
  T('log_find', 'Query the workbench audit-log table. Optional filters: level (DEBUG/INFO/WARN/ERROR), module (e.g. qdrant-sync), since (1h / 30m / 24h / iso8601), pattern (regex over message + context), limit (default 200, max 5000). Returns rows newest-first.', {
    level: { type: 'string', enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'] },
    module: { type: 'string', description: 'Source module name, e.g. qdrant-sync, ws-terminal.' },
    since: { type: 'string', description: 'Lower bound. Relative (1h / 30m / 24h) or ISO 8601 timestamp.' },
    pattern: { type: 'string', description: 'Optional case-insensitive regex over message + context.' },
    limit: { type: 'number', description: 'Max rows (default 200, hard cap 5000).' },
  }),
];

async function executeTool(name, args) {
  const result = await apiCall('POST', '/api/mcp/call', { tool: name, args });
  if (result.error) throw new Error(result.error);
  return result.result;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workbench', version: '0.3.0' },
      });
      break;
    case 'notifications/initialized':
      break;
    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const { name, arguments: callArgs } = params;
      try {
        const result = await executeTool(name, callArgs || {});
        sendResponse(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
      break;
    }
    default:
      if (id) sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    handleMessage(msg).catch((err) => {
      if (msg.id) sendError(msg.id, -32603, err.message);
    });
  } catch (parseErr) {
    if (parseErr instanceof SyntaxError) {
      /* expected: non-JSON lines on stdin */
    } else {
      process.stderr.write(`[workbench-mcp] Unexpected parse error: ${parseErr.message}\n`);
    }
  }
});

process.stderr.write(`[workbench-mcp] MCP server started (stdio) — ${TOOLS.length} tools\n`);
