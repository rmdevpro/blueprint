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
    name: 'blueprint_get_project_notes',
    description: 'Read project notes.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
    },
  },
  {
    name: 'blueprint_get_session_notes',
    description: 'Read session notes.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'blueprint_get_tasks',
    description: 'List tasks.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
    },
  },
  {
    name: 'blueprint_add_task',
    description: 'Add a task.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, text: { type: 'string' } },
      required: ['project', 'text'],
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
    name: 'blueprint_get_project_claude_md',
    description: 'Read CLAUDE.md.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
    },
  },
  {
    name: 'blueprint_read_plan',
    description: 'Read session plan file.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, project: { type: 'string' } },
      required: ['session_id', 'project'],
    },
  },
  {
    name: 'blueprint_update_plan',
    description: 'Write session plan file.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        project: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['session_id', 'project', 'content'],
    },
  },
  {
    name: 'blueprint_smart_compaction',
    description: 'Run smart compaction.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, project: { type: 'string' } },
      required: ['project'],
    },
  },
  {
    name: 'blueprint_ask_quorum',
    description: 'Ask the quorum.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        project: { type: 'string' },
        mode: { type: 'string' },
      },
      required: ['question', 'project'],
    },
  },
  {
    name: 'blueprint_send_message',
    description: 'Send inter-session message.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        to_session: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['project', 'to_session', 'content'],
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
