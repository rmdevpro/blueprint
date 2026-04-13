'use strict';

const { randomUUID } = require('crypto');
const { readdir } = require('fs/promises');
const safe = require('./safe-exec');
const config = require('./config');
const logger = require('./logger');

const MODEL_PATTERN = /^[a-zA-Z0-9._:-]+$/;

function registerOpenAIRoutes(app) {
  app.get('/v1/models', (req, res) => {
    res.json({
      object: 'list',
      data: [
        { id: 'claude-opus-4-6', object: 'model', owned_by: 'anthropic' },
        { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic' },
        { id: 'claude-haiku-4-5-20251001', object: 'model', owned_by: 'anthropic' },
      ],
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const { model, messages, stream } = req.body;
      const sessionHeader = req.headers['x-blueprint-session'];

      let sessionId = null;
      let actualModel = model || 'claude-sonnet-4-6';
      let project = req.body.project || req.headers['x-blueprint-project'];

      if (model && model.startsWith('bp:')) {
        sessionId = model.substring(3);
        actualModel = null;
      } else if (sessionHeader) {
        sessionId = sessionHeader;
      }

      if (actualModel && !MODEL_PATTERN.test(actualModel)) {
        return res
          .status(400)
          .json({ error: { message: 'invalid model name', type: 'invalid_request_error' } });
      }

      if (!messages || !messages.length) {
        return res
          .status(400)
          .json({ error: { message: 'messages required', type: 'invalid_request_error' } });
      }

      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUserMsg) {
        return res
          .status(400)
          .json({ error: { message: 'no user message found', type: 'invalid_request_error' } });
      }

      if (!project) {
        try {
          const dirs = await readdir(safe.WORKSPACE, { withFileTypes: true });
          const filtered = dirs.filter((d) => d.isDirectory() && !d.name.startsWith('.'));
          project = filtered[0]?.name || 'workspace';
        } catch (err) {
          if (err.code !== 'ENOENT')
            logger.debug('Error reading workspace for project inference', {
              module: 'openai-compat',
              err: err.message,
            });
          project = 'workspace';
        }
      }
      const cwd = safe.resolveProjectPath(project);

      const claudeArgs = ['--print'];
      if (sessionId) {
        claudeArgs.push('--resume', sessionId);
      } else {
        claudeArgs.push('--no-session-persistence');
      }
      if (actualModel) claudeArgs.push('--model', actualModel);
      claudeArgs.push('--dangerously-skip-permissions');

      const userContent = Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : lastUserMsg.content;

      if (userContent && userContent.length > 100000) {
        return res.status(400).json({
          error: { message: 'prompt too large (max 100KB)', type: 'invalid_request_error' },
        });
      }

      claudeArgs.push(userContent);

      const startTime = Date.now();
      const claudeTimeout = config.get('claude.defaultTimeoutMs', 120000);
      let responseText;
      try {
        responseText = (
          await safe.claudeExecAsync(claudeArgs, { cwd, timeout: claudeTimeout })
        ).trim();
      } catch (err) {
        return res.status(500).json({
          error: {
            message: `Claude CLI error: ${err.message?.substring(0, 200)}`,
            type: 'server_error',
          },
        });
      }

      const completionId = `chatcmpl-${randomUUID().substring(0, 12)}`;

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(startTime / 1000),
          model: actualModel || 'claude-sonnet-4-6',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: responseText },
              finish_reason: 'stop',
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.json({
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(startTime / 1000),
          model: actualModel || 'claude-sonnet-4-6',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: responseText },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    } catch (err) {
      logger.error('OpenAI compat error', { module: 'openai-compat', err: err.message });
      res.status(500).json({ error: { message: err.message, type: 'server_error' } });
    }
  });
}

module.exports = { registerOpenAIRoutes };
