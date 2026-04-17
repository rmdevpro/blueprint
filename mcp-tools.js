'use strict';

const { readFile, readdir } = require('fs/promises');
const { join, basename } = require('path');
const safe = require('./safe-exec');
const sessionUtils = require('./session-utils');
const logger = require('./logger');

const _CLAUDE_HOME = safe.CLAUDE_HOME;
const WORKSPACE = safe.WORKSPACE;

const db = require('./db');

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function validateMcpSessionId(sessionId) {
  if (!sessionId) return false;
  if (sessionId.startsWith('new_') || sessionId.startsWith('t_')) return true;
  return SESSION_ID_PATTERN.test(sessionId);
}

function validateTaskId(taskId) {
  return taskId != null && Number.isFinite(Number(taskId));
}

function registerMcpRoutes(app) {
  app.get('/api/mcp/tools', (req, res) => {
    res.json({
      tools: [
        {
          name: 'blueprint_search_sessions',
          description: 'Search across all session conversations for a keyword or phrase.',
        },
        {
          name: 'blueprint_summarize_session',
          description: 'Get an AI-generated summary of a session.',
        },
        {
          name: 'blueprint_list_sessions',
          description:
            'List all sessions for a project with names, timestamps, and message counts.',
        },
        { name: 'blueprint_get_tasks', description: 'List tasks by folder path or status filter.' },
        { name: 'blueprint_add_task', description: 'Add a task to a workspace folder.' },
        { name: 'blueprint_complete_task', description: 'Mark a task as done.' },
        { name: 'blueprint_reopen_task', description: 'Reopen a completed task.' },
        { name: 'blueprint_archive_task', description: 'Archive a task.' },
        { name: 'blueprint_move_task', description: 'Move a task to a different folder.' },
        { name: 'blueprint_update_task', description: 'Update task title or description.' },
        {
          name: 'blueprint_get_project_claude_md',
          description: "Read a project's CLAUDE.md file.",
        },
        { name: 'blueprint_session', description: 'Session management — info, transition, or resume.' },
        { name: 'blueprint_docs', description: 'Manage documentation library (list, search, read, create, update, delete).' },
        { name: 'blueprint_set_session_config', description: 'Set session configuration.' },
        { name: 'blueprint_get_token_usage', description: 'Get token usage for a session.' },
        { name: 'blueprint_vector_search', description: 'Search across docs and session history using vector similarity.' },
        { name: 'blueprint_vector_status', description: 'Get Qdrant vector index status and collection stats.' },
      ],
    });
  });

  app.post('/api/mcp/call', async (req, res) => {
    const { tool, args } = req.body;
    try {
      let result;
      switch (tool) {
        case 'blueprint_search_sessions': {
          if (!args.query || args.query.length < 2)
            return res.status(400).json({ error: 'query must be at least 2 characters' });
          if (args.query.length > 200)
            return res.status(400).json({ error: 'query too long (max 200)' });
          result = await sessionUtils.searchSessions(args.query, args.project);
          break;
        }
        case 'blueprint_summarize_session': {
          if (!validateMcpSessionId(args.session_id))
            return res.status(400).json({ error: 'invalid session_id format' });
          result = await sessionUtils.summarizeSession(args.session_id, args.project);
          break;
        }
        case 'blueprint_list_sessions':
          result = await listSessions(args.project);
          break;
        case 'blueprint_get_tasks': {
          if (args.folder_path) {
            result = { tasks: db.getTasksByFolder(args.folder_path) };
          } else {
            result = { tasks: db.getAllTasks(args.filter || 'todo') };
          }
          break;
        }
        case 'blueprint_add_task': {
          if (!args.title || args.title.length > 500)
            return res.status(400).json({ error: 'title required (max 500 chars)' });
          const folderPath = args.folder_path || '/';
          result = db.addTask(folderPath, args.title, args.description || '', null, 'agent');
          break;
        }
        case 'blueprint_complete_task': {
          if (!validateTaskId(args.task_id))
            return res.status(400).json({ error: 'valid numeric task_id required' });
          db.updateTaskStatus(Number(args.task_id), 'done');
          result = { completed: true };
          break;
        }
        case 'blueprint_reopen_task': {
          if (!validateTaskId(args.task_id))
            return res.status(400).json({ error: 'valid numeric task_id required' });
          db.updateTaskStatus(Number(args.task_id), 'todo');
          result = { reopened: true };
          break;
        }
        case 'blueprint_archive_task': {
          if (!validateTaskId(args.task_id))
            return res.status(400).json({ error: 'valid numeric task_id required' });
          db.updateTaskStatus(Number(args.task_id), 'archived');
          result = { archived: true };
          break;
        }
        case 'blueprint_move_task': {
          if (!validateTaskId(args.task_id))
            return res.status(400).json({ error: 'valid numeric task_id required' });
          if (!args.folder_path) return res.status(400).json({ error: 'folder_path required' });
          db.moveTask(Number(args.task_id), args.folder_path);
          result = { moved: true };
          break;
        }
        case 'blueprint_update_task': {
          if (!validateTaskId(args.task_id))
            return res.status(400).json({ error: 'valid numeric task_id required' });
          const taskId = Number(args.task_id);
          if (args.title) db.updateTaskTitle(taskId, args.title);
          if (args.description !== undefined) db.updateTaskDescription(taskId, args.description);
          result = db.getTask(taskId) || { updated: true };
          break;
        }
        case 'blueprint_get_project_claude_md': {
          const claudeMdPath = join(safe.resolveProjectPath(args.project), 'CLAUDE.md');
          try {
            result = { content: await readFile(claudeMdPath, 'utf-8') };
          } catch (err) {
            if (err.code === 'ENOENT') {
              result = { content: '' };
            } else throw err;
          }
          break;
        }
        case 'blueprint_get_token_usage': {
          if (!validateMcpSessionId(args.session_id))
            return res.status(400).json({ error: 'invalid session_id format' });
          result = await sessionUtils.getTokenUsage(args.session_id, args.project);
          break;
        }
        case 'blueprint_set_session_config': {
          if (!validateMcpSessionId(args.session_id))
            return res.status(400).json({ error: 'invalid session_id format' });
          if (args.name !== undefined) db.renameSession(args.session_id, args.name);
          if (args.state !== undefined) db.setSessionState(args.session_id, args.state);
          if (args.notes !== undefined) db.setSessionNotes(args.session_id, args.notes);
          result = { saved: true };
          break;
        }
        case 'blueprint_docs': {
          const DOCS_DIR = join(safe.WORKSPACE, 'docs');
          const docPath = args.path ? join(DOCS_DIR, args.path) : DOCS_DIR;

          // Prevent path traversal
          if (args.path && !docPath.startsWith(DOCS_DIR)) {
            return res.status(403).json({ error: 'path traversal blocked' });
          }

          switch (args.action) {
            case 'list': {
              const { readdirSync, statSync } = require('fs');
              const target = args.path ? docPath : DOCS_DIR;
              try {
                const entries = readdirSync(target).map(name => {
                  const full = join(target, name);
                  const isDir = statSync(full).isDirectory();
                  return { name, type: isDir ? 'directory' : 'file' };
                });
                result = { path: args.path || '/', entries };
              } catch (e) {
                result = { path: args.path || '/', entries: [], error: e.code === 'ENOENT' ? 'directory not found' : e.message };
              }
              break;
            }
            case 'search': {
              if (!args.query) return res.status(400).json({ error: 'query required' });
              const { execSync } = require('child_process');
              try {
                const out = execSync(`grep -rl --include='*.md' ${safe.shellEscape(args.query)} ${safe.shellEscape(DOCS_DIR)}`, { encoding: 'utf-8', timeout: 5000 }).trim();
                const matches = out ? out.split('\n').map(f => f.replace(DOCS_DIR + '/', '')) : [];
                result = { query: args.query, matches };
              } catch {
                result = { query: args.query, matches: [] };
              }
              break;
            }
            case 'read': {
              if (!args.path) return res.status(400).json({ error: 'path required' });
              try {
                const content = require('fs').readFileSync(docPath, 'utf-8');
                result = { path: args.path, content };
              } catch (e) {
                result = { error: e.code === 'ENOENT' ? 'doc not found' : e.message };
              }
              break;
            }
            case 'create': {
              if (!args.path || !args.content) return res.status(400).json({ error: 'path and content required' });
              const dir = require('path').dirname(docPath);
              require('fs').mkdirSync(dir, { recursive: true });
              if (require('fs').existsSync(docPath)) return res.status(409).json({ error: 'doc already exists, use update' });
              require('fs').writeFileSync(docPath, args.content);
              result = { created: args.path };
              break;
            }
            case 'update': {
              if (!args.path || !args.content) return res.status(400).json({ error: 'path and content required' });
              if (!require('fs').existsSync(docPath)) return res.status(404).json({ error: 'doc not found, use create' });
              require('fs').writeFileSync(docPath, args.content);
              result = { updated: args.path };
              break;
            }
            case 'delete': {
              if (!args.path) return res.status(400).json({ error: 'path required' });
              try {
                require('fs').unlinkSync(docPath);
                result = { deleted: args.path };
              } catch (e) {
                result = { error: e.code === 'ENOENT' ? 'doc not found' : e.message };
              }
              break;
            }
            default:
              return res.status(400).json({ error: 'invalid action' });
          }
          break;
        }
        case 'blueprint_session': {
          const r = await fetch(
            `http://localhost:${process.env.BLUEPRINT_PORT || 3000}/api/sessions/${args.session_id}/session`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mode: args.mode, tailLines: args.tail_lines }),
            },
          );
          const data = await r.json();
          if (args.mode === 'info') {
            result = `Session ID: ${data.sessionId}\nSession file: ${data.sessionFile}\nExists: ${data.exists}`;
          } else {
            result = data.prompt || data.error || 'No response';
          }
          break;
        }
        case 'blueprint_vector_search': {
          if (!args.query || args.query.length < 2)
            return res.status(400).json({ error: 'query must be at least 2 characters' });
          const qdrant = require('./qdrant-sync');
          const collections = args.collections
            ? args.collections.split(',').map(c => c.trim())
            : null;
          result = await qdrant.search(args.query, collections, args.limit || 10);
          break;
        }
        case 'blueprint_vector_status': {
          const qdrant = require('./qdrant-sync');
          result = await qdrant.status();
          break;
        }
        default:
          return res.status(404).json({ error: `Unknown tool: ${tool}` });
      }
      res.json({ result });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: `Resource not found: ${err.message}` });
      }
      if (err instanceof SyntaxError) {
        return res.status(400).json({ error: `Invalid input: ${err.message}` });
      }
      if (err.message && err.message.includes('traversal')) {
        return res.status(403).json({ error: err.message });
      }
      logger.error('MCP tool call error', { module: 'mcp-tools', tool, err: err.message });
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
    /* expected for ENOENT: no sessions dir */
  }
  return sessions.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

module.exports = { registerMcpRoutes };
