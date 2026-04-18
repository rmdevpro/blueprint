#!/usr/bin/env node
'use strict';

const http = require('http');
const readline = require('readline');

const BLUEPRINT_PORT = process.env.BLUEPRINT_PORT || 3000;
const BASE_URL = `http://localhost:${BLUEPRINT_PORT}`;

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

const TOOLS = [
  {
    name: 'blueprint_files',
    description: 'Workspace file operations — read, write, list, delete, grep, and semantic search across documents and code.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'create', 'update', 'delete', 'grep', 'search_documents', 'search_code'],
          description: 'Operation to perform',
        },
        path: { type: 'string', description: 'File or directory path relative to workspace' },
        content: { type: 'string', description: 'File content for create/update actions' },
        query: { type: 'string', description: 'Search query for semantic search actions' },
        pattern: { type: 'string', description: 'Regex pattern for grep action' },
        file_type: { type: 'string', description: 'File extension filter for grep (e.g. "js", "py", "md")' },
        context_lines: { type: 'number', description: 'Lines of context around grep matches (default 2)' },
        limit: { type: 'number', description: 'Max results for search actions (default 10)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'blueprint_sessions',
    description: 'Session operations across all CLIs (Claude, Gemini, Codex) — list, lookup by name, config, search, summarize, and session lifecycle.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['new', 'connect', 'restart', 'list', 'config', 'tokens', 'summarize', 'transition', 'resume', 'grep', 'search_semantic', 'mcp_list_available', 'mcp_register', 'mcp_unregister', 'mcp_enable', 'mcp_disable', 'mcp_list_enabled'],
          description: 'Operation to perform',
        },
        session_id: { type: 'string', description: 'Session ID for actions that target a specific session' },
        project: { type: 'string', description: 'Project name' },
        query: { type: 'string', description: 'Search query — for connect, searches by session name; for grep/search_semantic, searches content' },
        pattern: { type: 'string', description: 'Regex pattern for grep action' },
        cli: { type: 'string', description: 'CLI type: claude, gemini, codex. For new: which CLI to launch. For grep/search: filter (comma-separated). Default: all.' },
        prompt: { type: 'string', description: 'Initial prompt for new session' },
        name: { type: 'string', description: 'New session name for config action' },
        state: { type: 'string', enum: ['active', 'archived', 'hidden'], description: 'New session state for config action' },
        notes: { type: 'string', description: 'Session notes for config action' },
        limit: { type: 'number', description: 'Max results for search actions (default 10)' },
        tail_lines: { type: 'number', description: 'Lines of session tail for resume action (default 60)' },
        mcp_name: { type: 'string', description: 'MCP server name for mcp_* actions' },
        mcp_config: { type: 'object', description: 'MCP server config (command/args for stdio, url for http)' },
        mcp_transport: { type: 'string', enum: ['stdio', 'http', 'sse'], description: 'MCP transport type (default: stdio)' },
        mcp_description: { type: 'string', description: 'Human-readable description of the MCP server' },
      },
      required: ['action'],
    },
  },
  {
    name: 'blueprint_tasks',
    description: 'Task management — create, complete, reopen, archive, move, and update tasks organized by workspace folder.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'add', 'complete', 'reopen', 'archive', 'move', 'update'],
          description: 'Operation to perform',
        },
        task_id: { type: 'number', description: 'Task ID for actions that target a specific task' },
        folder_path: { type: 'string', description: 'Folder path (e.g. /src/auth). Use / for workspace root.' },
        title: { type: 'string', description: 'Task title for add/update actions' },
        description: { type: 'string', description: 'Task description for add/update actions' },
        filter: { type: 'string', enum: ['all', 'todo', 'done', 'archived'], description: 'Status filter for get action (default: todo)' },
      },
      required: ['action'],
    },
  },
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
        serverInfo: { name: 'blueprint', version: '0.2.0' },
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
      process.stderr.write(`[blueprint-mcp] Unexpected parse error: ${parseErr.message}\n`);
    }
  }
});

process.stderr.write('[blueprint-mcp] MCP server started (stdio)\n');
