/**
 * Blueprint MCP tools — exposed via the Blueprint HTTP API.
 * Claude CLI connects to these via the project's .mcp.json or global MCP config.
 *
 * Tools:
 *   blueprint_search_sessions — search across session content
 *   blueprint_summarize_session — get an AI summary of a session
 *   blueprint_list_sessions — list all sessions for a project
 */

const { readFile, readdir } = require('fs/promises');
const { join, basename } = require('path');
const safe = require('./safe-exec');
const sessionUtils = require('./session-utils');

const CLAUDE_HOME = safe.CLAUDE_HOME;
const WORKSPACE = safe.WORKSPACE;

const db = require('./db');

function registerMcpRoutes(app) {

  // MCP tool discovery endpoint
  app.get('/api/mcp/tools', (req, res) => {
    res.json({
      tools: [
        {
          name: 'blueprint_search_sessions',
          description: 'Search across all session conversations for a keyword or phrase. Returns matching sessions with context snippets.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              project: { type: 'string', description: 'Optional: limit search to a specific project name' },
            },
            required: ['query'],
          },
        },
        {
          name: 'blueprint_summarize_session',
          description: 'Get an AI-generated summary of a session including what was discussed, accomplished, and current state. Also returns the last few messages.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'The session UUID to summarize' },
              project: { type: 'string', description: 'The project name the session belongs to' },
            },
            required: ['session_id', 'project'],
          },
        },
        {
          name: 'blueprint_list_sessions',
          description: 'List all sessions for a project with names, timestamps, and message counts.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Project name' },
            },
            required: ['project'],
          },
        },
        {
          name: 'blueprint_session',
          description: 'Session management. Mode "info" returns session ID and file path. Mode "resume" returns a prompt with recent conversation tail. Mode "transition" returns the end-of-session checklist prompt.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'The current session ID' },
              mode: { type: 'string', enum: ['info', 'transition', 'resume'], description: 'What to do' },
              tail_lines: { type: 'number', description: 'Number of JSONL lines to include in resume tail (default 60)' },
            },
            required: ['session_id', 'mode'],
          },
        },
        {
          name: 'blueprint_ask_cli',
          description: 'Ask any installed CLI a question. Use for second opinions from different models.',
          inputSchema: {
            type: 'object',
            properties: {
              cli: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'Which CLI to ask' },
              prompt: { type: 'string', description: 'The question or instruction' },
              model: { type: 'string', description: 'Optional model override — uses CLI default if omitted' },
              cwd: { type: 'string', description: 'Optional working directory' },
            },
            required: ['cli', 'prompt'],
          },
        },
        {
          name: 'blueprint_ask_quorum',
          description: 'Ask a question to the quorum (multi-model consensus). Participants = all CLIs with configured API keys.',
          inputSchema: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question to ask' },
              project: { type: 'string', description: 'Project context' },
            },
            required: ['question', 'project'],
          },
        },
        {
          name: 'blueprint_send_message',
          description: 'Send a message to another session. Content is delivered via bridge file.',
          inputSchema: {
            type: 'object',
            properties: {
              to_session: { type: 'string', description: 'Target session UUID' },
              project: { type: 'string', description: 'Project name' },
              content: { type: 'string', description: 'Message content' },
            },
            required: ['to_session', 'project', 'content'],
          },
        },
        {
          name: 'blueprint_get_token_usage',
          description: 'Get token usage for a session — input tokens, model, max context, percentage used.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session UUID' },
              project: { type: 'string', description: 'Project name' },
            },
            required: ['session_id', 'project'],
          },
        },
        {
          name: 'blueprint_set_session_config',
          description: 'Set session configuration — name, state (active/archived/hidden), notes.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session UUID' },
              name: { type: 'string', description: 'New session name' },
              state: { type: 'string', description: 'Session state: active, archived, hidden' },
              notes: { type: 'string', description: 'Session notes' },
            },
            required: ['session_id'],
          },
        },
        {
          name: 'blueprint_reopen_task',
          description: 'Reopen a completed task.',
          inputSchema: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: 'Task ID to reopen' },
            },
            required: ['task_id'],
          },
        },
        {
          name: 'blueprint_delete_task',
          description: 'Delete a task.',
          inputSchema: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: 'Task ID to delete' },
            },
            required: ['task_id'],
          },
        },
        {
          name: 'blueprint_set_project_notes',
          description: 'Set notes for a project.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Project name' },
              notes: { type: 'string', description: 'Notes content' },
            },
            required: ['project', 'notes'],
          },
        },
        {
          name: 'blueprint_set_session_notes',
          description: 'Set notes for a session.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session UUID' },
              notes: { type: 'string', description: 'Notes content' },
            },
            required: ['session_id', 'notes'],
          },
        },
        {
          name: 'blueprint_get_project_notes',
          description: 'Get notes for a project.',
          inputSchema: {
            type: 'object',
            properties: { project: { type: 'string', description: 'Project name' } },
            required: ['project'],
          },
        },
        {
          name: 'blueprint_get_session_notes',
          description: 'Get notes for a session.',
          inputSchema: {
            type: 'object',
            properties: { session_id: { type: 'string', description: 'Session UUID' } },
            required: ['session_id'],
          },
        },
        {
          name: 'blueprint_get_tasks',
          description: 'Get all tasks for a project.',
          inputSchema: {
            type: 'object',
            properties: { project: { type: 'string', description: 'Project name' } },
            required: ['project'],
          },
        },
        {
          name: 'blueprint_add_task',
          description: 'Add a new task to a project.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', description: 'Project name' },
              text: { type: 'string', description: 'Task description' },
            },
            required: ['project', 'text'],
          },
        },
        {
          name: 'blueprint_complete_task',
          description: 'Mark a task as completed.',
          inputSchema: {
            type: 'object',
            properties: { task_id: { type: 'string', description: 'Task ID' } },
            required: ['task_id'],
          },
        },
        {
          name: 'blueprint_read_plan',
          description: 'Read a session plan file.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session UUID' },
              project: { type: 'string', description: 'Project name' },
            },
            required: ['session_id', 'project'],
          },
        },
        {
          name: 'blueprint_update_plan',
          description: 'Write/update a session plan file.',
          inputSchema: {
            type: 'object',
            properties: {
              session_id: { type: 'string', description: 'Session UUID' },
              project: { type: 'string', description: 'Project name' },
              content: { type: 'string', description: 'Plan file content (markdown)' },
            },
            required: ['session_id', 'project', 'content'],
          },
        },
        {
          name: 'blueprint_get_project_claude_md',
          description: 'Read the CLAUDE.md file for a project.',
          inputSchema: {
            type: 'object',
            properties: { project: { type: 'string', description: 'Project name' } },
            required: ['project'],
          },
        },
      ],
    });
  });

  // MCP tool execution endpoint
  app.post('/api/mcp/call', async (req, res) => {
    const { tool, args } = req.body;

    try {
      let result;
      switch (tool) {
        case 'blueprint_search_sessions':
          result = await sessionUtils.searchSessions(args.query, args.project);
          break;
        case 'blueprint_summarize_session':
          result = await sessionUtils.summarizeSession(args.session_id, args.project);
          break;
        case 'blueprint_list_sessions':
          result = await listSessions(args.project);
          break;
        case 'blueprint_get_project_notes': {
          const project = db.getProject(args.project);
          result = project ? { notes: db.getProjectNotes(project.id) } : { notes: '' };
          break;
        }
        case 'blueprint_get_session_notes':
          result = { notes: db.getSessionNotes(args.session_id) };
          break;
        case 'blueprint_get_tasks': {
          const project = db.getProject(args.project);
          result = project ? { tasks: db.getTasks(project.id) } : { tasks: [] };
          break;
        }
        case 'blueprint_add_task': {
          const project = db.getProject(args.project);
          if (!project) throw new Error('Project not found');
          result = db.addTask(project.id, args.text, 'agent');
          break;
        }
        case 'blueprint_complete_task':
          db.completeTask(args.task_id);
          result = { completed: true };
          break;
        case 'blueprint_get_project_claude_md': {
          const claudeMdPath = join(safe.resolveProjectPath(args.project), 'CLAUDE.md');
          try {
            result = { content: await readFile(claudeMdPath, 'utf-8') };
          } catch {
            result = { content: '' };
          }
          break;
        }
        case 'blueprint_read_plan': {
          const { resolve, sep } = require('path');
          const planBase = join(db.DATA_DIR, 'plans');
          const planFile = resolve(planBase, args.project, `${args.session_id}.md`);
          if (!planFile.startsWith(planBase + sep)) throw new Error('Path traversal blocked');
          try {
            result = { content: await readFile(planFile, 'utf-8') };
          } catch {
            result = { content: '', exists: false };
          }
          break;
        }
        case 'blueprint_update_plan': {
          const { resolve, sep } = require('path');
          const planBase = join(db.DATA_DIR, 'plans');
          const planDir = resolve(planBase, args.project);
          const planFile = resolve(planDir, `${args.session_id}.md`);
          if (!planFile.startsWith(planBase + sep)) throw new Error('Path traversal blocked');
          const { mkdirSync, writeFileSync } = require('fs');
          mkdirSync(planDir, { recursive: true });
          writeFileSync(planFile, args.content);
          result = { saved: true, path: planFile };
          break;
        }
        case 'blueprint_get_token_usage': {
          result = await sessionUtils.getTokenUsage(args.session_id, args.project);
          break;
        }
        case 'blueprint_set_session_config': {
          if (args.name !== undefined) db.renameSession(args.session_id, args.name);
          if (args.state !== undefined) db.setSessionState(args.session_id, args.state);
          if (args.notes !== undefined) db.setSessionNotes(args.session_id, args.notes);
          result = { saved: true };
          break;
        }
        case 'blueprint_reopen_task':
          db.reopenTask(args.task_id);
          result = { reopened: true };
          break;
        case 'blueprint_delete_task':
          db.deleteTask(args.task_id);
          result = { deleted: true };
          break;
        case 'blueprint_set_project_notes': {
          const project = db.getProject(args.project);
          if (!project) throw new Error('Project not found');
          db.setProjectNotes(project.id, args.notes);
          result = { saved: true };
          break;
        }
        case 'blueprint_set_session_notes':
          db.setSessionNotes(args.session_id, args.notes);
          result = { saved: true };
          break;
        case 'blueprint_session': {
          const r = await fetch(`http://localhost:${process.env.BLUEPRINT_PORT || 3000}/api/sessions/${args.session_id}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: args.mode, tailLines: args.tail_lines }),
          });
          const data = await r.json();
          if (args.mode === 'info') {
            result = `Session ID: ${data.sessionId}\nSession file: ${data.sessionFile}\nExists: ${data.exists}`;
          } else {
            result = data.prompt || data.error || 'No response';
          }
          break;
        }
        case 'blueprint_ask_cli': {
          const r = await fetch(`http://localhost:${process.env.BLUEPRINT_PORT || 3000}/api/cli/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cli: args.cli, prompt: args.prompt, model: args.model, cwd: args.cwd }),
          });
          const data = await r.json();
          result = data.result || data.error || 'No response';
          break;
        }
        case 'blueprint_ask_quorum': {
          const r = await fetch(`http://localhost:${process.env.BLUEPRINT_PORT || 3000}/api/quorum/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question: args.question,
              project: args.project,
            }),
          });
          result = await r.json();
          break;
        }
        case 'blueprint_send_message': {
          const project = db.getProject(args.project);
          if (!project) throw new Error('Project not found');

          const { mkdirSync, writeFileSync, unlinkSync } = require('fs');
          const { randomUUID } = require('crypto');

          // Write content to a uniquely-named bridge file
          const bridgeDir = join(WORKSPACE, '.blueprint', 'bridges');
          mkdirSync(bridgeDir, { recursive: true });
          const bridgeFile = join(bridgeDir, `msg_${randomUUID()}.md`);
          writeFileSync(bridgeFile, args.content);

          // Record in DB
          db.sendMessage(project.id, null, args.to_session, `[file: ${bridgeFile}]`);

          // Send file path to target session via claude --resume --print
          const tmuxSessName = safe.sanitizeTmuxName(`bp_${args.to_session.substring(0, 12)}`);
          let sent = false;
          try {
            if (!safe.tmuxExists(tmuxSessName)) throw new Error('not running');
            await safe.claudeExecAsync(
              ['--resume', args.to_session, '--dangerously-skip-permissions', '--no-session-persistence', '--print', bridgeFile],
              { cwd: safe.resolveProjectPath(args.project), timeout: 30000 }
            );
            sent = true;
          } catch {
            // Session not running — file stays for manual pickup
          }

          // Clean up bridge file after delivery (target CLI already read it)
          if (sent) {
            setTimeout(() => {
              try { unlinkSync(bridgeFile); } catch {}
            }, 5000); // 5s grace period for CLI to finish reading
          } else {
            // Clean up undelivered files after 1 hour
            setTimeout(() => {
              try { unlinkSync(bridgeFile); } catch {}
            }, 3600000);
          }

          result = sent
            ? { sent: true, delivered: true }
            : { sent: false, note: 'Target session not running. Message saved in DB.' };
          break;
        }
        default:
          return res.status(404).json({ error: `Unknown tool: ${tool}` });
      }
      res.json({ result });
    } catch (err) {
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
  } catch {
    // No sessions dir for this project
  }

  return sessions.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

module.exports = { registerMcpRoutes };
