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
    name: 'blueprint_search_sessions',
    description: 'Search across all session conversations.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, project: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'blueprint_summarize_session',
    description: 'Get an AI summary of a session.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, project: { type: 'string' } },
      required: ['session_id', 'project'],
    },
  },
  {
    name: 'blueprint_list_sessions',
    description: 'List sessions for a project.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
    },
  },
  {
    name: 'blueprint_get_tasks',
    description: 'List tasks, optionally filtered by folder path and status.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_path: { type: 'string', description: 'Filter by folder path (e.g. /src/auth)' },
        filter: { type: 'string', enum: ['all', 'todo', 'done', 'archived'], description: 'Filter by status (default: todo)' },
      },
    },
  },
  {
    name: 'blueprint_add_task',
    description: 'Add a task to a folder in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        folder_path: { type: 'string', description: 'Folder path (e.g. /src/auth). Use / for workspace root.' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['folder_path', 'title'],
    },
  },
  {
    name: 'blueprint_complete_task',
    description: 'Mark task done.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'number' } },
      required: ['task_id'],
    },
  },
  {
    name: 'blueprint_reopen_task',
    description: 'Reopen a completed task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'number' } },
      required: ['task_id'],
    },
  },
  {
    name: 'blueprint_archive_task',
    description: 'Archive a task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'number' } },
      required: ['task_id'],
    },
  },
  {
    name: 'blueprint_move_task',
    description: 'Move a task to a different folder.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        folder_path: { type: 'string' },
      },
      required: ['task_id', 'folder_path'],
    },
  },
  {
    name: 'blueprint_update_task',
    description: 'Update task title or description.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'blueprint_get_project_claude_md',
    description: 'Read CLAUDE.md.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
    },
  },
  {
    name: 'blueprint_docs',
    description: 'Manage Blueprint documentation library. Actions: list, search, read, create, update, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read', 'create', 'update', 'delete'], description: 'CRUDS operation' },
        path: { type: 'string', description: 'Path relative to /workspace/docs/ (e.g. guides/installing-aider.md)' },
        content: { type: 'string', description: 'Content for create/update actions' },
        query: { type: 'string', description: 'Search query for search action' },
      },
      required: ['action'],
    },
  },
  {
    name: 'blueprint_vector_search',
    description: 'Search across docs and session history using vector similarity. Returns semantically similar content from indexed documents and conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        collections: { type: 'string', description: 'Comma-separated collection names to search (docs, claude_sessions, gemini_sessions, codex_sessions). Default: all.' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'blueprint_vector_status',
    description: 'Get Qdrant vector index status — availability, collection stats, point counts.',
    inputSchema: {
      type: 'object',
      properties: {},
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
        serverInfo: { name: 'blueprint', version: '0.1.0' },
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
