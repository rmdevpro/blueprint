'use strict';

const db = require('./db');
const { writeFile } = require('fs/promises');
const { join } = require('path');
const safe = require('./safe-exec');
const logger = require('./logger');

const MODEL_PATTERN = /^[a-zA-Z0-9._:-]+$/;
const VALID_STATES = ['active', 'archived', 'hidden'];
const PROJECT_NAME_MAX_LEN = 255;
const SETTINGS_KEY_PATTERN = /^[a-zA-Z0-9_.-]{1,100}$/;

const ADMIN_TOOLS = [
  { name: 'blueprint_create_session', description: 'Create a new CLI session for a project.' },
  {
    name: 'blueprint_set_session_state',
    description: 'Change session state: active, archived, or hidden.',
  },
  { name: 'blueprint_get_token_usage', description: 'Get context token usage for a session.' },
  { name: 'blueprint_set_project_notes', description: 'Write shared project notes.' },
  { name: 'blueprint_set_project_claude_md', description: "Write a project's CLAUDE.md file." },
  { name: 'blueprint_list_projects', description: 'List all projects with session counts.' },
  { name: 'blueprint_update_settings', description: 'Update a Blueprint setting.' },
];

function registerExternalMcpRoutes(app) {
  app.get('/api/mcp/external/tools', async (req, res) => {
    try {
      const internalRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/mcp/tools`);
      if (!internalRes.ok) {
        logger.warn('Internal MCP tools endpoint returned error', {
          module: 'mcp-external',
          status: internalRes.status,
        });
        return res.json({ tools: ADMIN_TOOLS });
      }
      const internal = await internalRes.json();
      res.json({ tools: [...(internal.tools || []), ...ADMIN_TOOLS] });
    } catch (err) {
      logger.error('Failed to fetch internal MCP tools', {
        module: 'mcp-external',
        err: err.message,
      });
      res.json({ tools: ADMIN_TOOLS });
    }
  });

  app.post('/api/mcp/external/call', async (req, res) => {
    const { tool, args } = req.body;

    const internalTools = [
      'blueprint_search_sessions',
      'blueprint_summarize_session',
      'blueprint_list_sessions',
      'blueprint_get_project_notes',
      'blueprint_get_session_notes',
      'blueprint_get_tasks',
      'blueprint_add_task',
      'blueprint_complete_task',
      'blueprint_get_project_claude_md',
      'blueprint_send_message',
    ];

    if (internalTools.includes(tool)) {
      try {
        const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/mcp/call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool, args }),
        });
        const body = await r.json();
        return res.json(body);
      } catch (err) {
        if (err instanceof SyntaxError) {
          logger.error('Internal MCP call returned non-JSON', { module: 'mcp-external', tool });
          return res.status(502).json({ error: 'Internal MCP endpoint returned invalid response' });
        }
        logger.error('Internal MCP call network error', {
          module: 'mcp-external',
          tool,
          err: err.message,
        });
        return res.status(500).json({ error: err.message });
      }
    }

    try {
      let result;
      switch (tool) {
        case 'blueprint_create_session': {
          if (!args.project) throw new Error('project required');
          if (args.project.length > PROJECT_NAME_MAX_LEN)
            return res
              .status(400)
              .json({ error: `project name too long (max ${PROJECT_NAME_MAX_LEN})` });
          if (args.model && !MODEL_PATTERN.test(args.model))
            return res.status(400).json({ error: 'invalid model name' });
          const projectPath = safe.resolveProjectPath(args.project);
          const id = `new_${Date.now()}`;
          const tmux = `bp_${id}`;
          const claudeArgs = args.model ? ['--model', args.model] : [];
          safe.tmuxCreateClaude(tmux, projectPath, claudeArgs);
          result = { session_id: id, tmux, project: args.project };
          break;
        }
        case 'blueprint_set_session_state':
          if (!args.session_id || !args.state) throw new Error('session_id and state required');
          if (!VALID_STATES.includes(args.state))
            return res
              .status(400)
              .json({ error: `state must be one of: ${VALID_STATES.join(', ')}` });
          db.setSessionState(args.session_id, args.state);
          result = { session_id: args.session_id, state: args.state };
          break;
        case 'blueprint_get_token_usage': {
          if (!args.session_id || !args.project) throw new Error('session_id and project required');
          const r = await fetch(
            `http://localhost:${process.env.PORT || 3000}/api/sessions/${args.session_id}/tokens?project=${args.project}`,
          );
          result = await r.json();
          break;
        }
        case 'blueprint_set_project_notes': {
          const project = db.getProject(args.project);
          if (!project) throw new Error('Project not found');
          db.setProjectNotes(project.id, args.notes);
          result = { saved: true };
          break;
        }
        case 'blueprint_set_project_claude_md': {
          if (!args.project || !args.content) throw new Error('project and content required');
          if (args.content.length > 100000)
            return res.status(400).json({ error: 'content too long (max 100000)' });
          const filePath = join(safe.resolveProjectPath(args.project), 'CLAUDE.md');
          await writeFile(filePath, args.content);
          result = { saved: true };
          break;
        }
        case 'blueprint_list_projects':
          result = { projects: db.getProjects() };
          break;
        case 'blueprint_update_settings':
          if (!args.key) throw new Error('key required');
          if (!SETTINGS_KEY_PATTERN.test(args.key))
            return res.status(400).json({ error: 'invalid settings key format' });
          db.setSetting(args.key, args.value);
          result = { saved: true };
          break;
        default:
          return res.status(404).json({ error: `Unknown tool: ${tool}` });
      }
      res.json({ result });
    } catch (err) {
      logger.error('MCP external tool call error', {
        module: 'mcp-external',
        tool,
        err: err.message,
      });
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerExternalMcpRoutes, ADMIN_TOOLS };
