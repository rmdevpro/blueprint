'use strict';

const { mkdir, writeFile, readFile, readdir } = require('fs/promises');
const { join, sep } = require('path');
const { randomUUID } = require('crypto');
const http = require('http');
const https = require('https');
const db = require('./db');
const safe = require('./safe-exec');
const config = require('./config');
const logger = require('./logger');

const QUORUM_DIR = join(db.DATA_DIR, 'quorum');

const JUNIOR_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the project directory.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'list_files',
    description: 'List files and directories at a path.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in project files using grep.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for information.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
];

async function executeTool(toolName, input, cwd, _tempDir) {
  switch (toolName) {
    case 'read_file': {
      const fullPath = join(cwd, input.path);
      if (!fullPath.startsWith(cwd + sep) && fullPath !== cwd)
        return 'Error: path outside project directory';
      try {
        const content = await readFile(fullPath, 'utf-8');
        return content.length > 10000 ? content.substring(0, 10000) + '\n...[truncated]' : content;
      } catch (err) {
        if (err.code === 'ENOENT') return `Error: file not found: ${input.path}`;
        return `Error: cannot read file: ${err.message}`;
      }
    }
    case 'list_files': {
      const fullPath = join(cwd, input.path || '');
      if (!fullPath.startsWith(cwd + sep) && fullPath !== cwd)
        return 'Error: path outside project directory';
      try {
        const entries = await readdir(fullPath, { withFileTypes: true });
        return entries
          .slice(0, 100)
          .map((e) => `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`)
          .join('\n');
      } catch (err) {
        if (err.code === 'ENOENT') return `Error: directory not found: ${input.path}`;
        return `Error: cannot list: ${err.message}`;
      }
    }
    case 'search_files':
      return await safe.grepSearchAsync(input.pattern, cwd, input.glob);
    case 'web_search': {
      try {
        const result = await safe.curlFetchAsync(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_html=1`,
        );
        const data = JSON.parse(result);
        const results = [];
        if (data.AbstractText) results.push(`Summary: ${data.AbstractText}`);
        if (data.RelatedTopics)
          for (const t of data.RelatedTopics.slice(0, 5)) {
            if (t.Text) results.push(`- ${t.Text}`);
          }
        return results.length > 0 ? results.join('\n') : 'No results found.';
      } catch (err) {
        if (err instanceof SyntaxError) return 'Web search returned invalid JSON';
        return `Web search failed: ${err.message}`;
      }
    }
    case 'web_fetch': {
      const raw = await safe.curlFetchAsync(input.url);
      return raw
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .substring(0, 10000);
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

function getQuorumSettings() {
  let lead, fixedJunior, additionalJuniors;
  try {
    lead = JSON.parse(db.getSetting('quorum_lead_model', '"opus"'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      lead = 'opus';
    } else throw err;
  }
  try {
    fixedJunior = JSON.parse(db.getSetting('quorum_fixed_junior', '"sonnet"'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      fixedJunior = 'sonnet';
    } else throw err;
  }
  try {
    additionalJuniors = JSON.parse(db.getSetting('quorum_additional_juniors', '[]'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      additionalJuniors = [];
    } else throw err;
  }
  return { lead, fixedJunior, additionalJuniors };
}

async function runJuniorAgent(modelConfig, question, cwd, tempDir) {
  const systemPrompt = `You are a junior member of a technical quorum. Answer the question thoroughly and concisely.`;
  if (typeof modelConfig === 'string')
    return await runClaudeCliJunior(modelConfig, systemPrompt, question, cwd);
  const provider = modelConfig.provider || 'anthropic';
  if (provider === 'anthropic' || provider === 'anthropic-cli')
    return await runClaudeCliJunior(modelConfig.model || 'sonnet', systemPrompt, question, cwd);
  return await runOpenAICompatAgent(modelConfig, systemPrompt, question, cwd, tempDir);
}

async function runClaudeCliJunior(model, systemPrompt, question, cwd) {
  const prompt = `${systemPrompt}\n\n## Question\n\n${question}`;
  const claudeTimeout = config.get('claude.defaultTimeoutMs', 120000);
  try {
    return (
      await safe.claudeExecAsync(
        [
          '--print',
          '--permission-mode',
          'dontAsk',
          '--model',
          model,
          '--no-session-persistence',
          prompt,
        ],
        { cwd, timeout: claudeTimeout },
      )
    ).trim();
  } catch (err) {
    return `CLI Error: ${err.message?.substring(0, 500)}`;
  }
}

async function runOpenAICompatAgent(agentConfig, systemPrompt, question, cwd, tempDir) {
  const apiKey =
    agentConfig.api_key || process.env[agentConfig.api_key_env || 'OPENAI_API_KEY'] || '';
  if (!apiKey) return `Error: no API key configured for ${agentConfig.provider}`;
  const model = agentConfig.model;
  const baseUrl = agentConfig.base_url || 'https://api.openai.com';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ];
  const tools = JUNIOR_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  try {
    for (let turn = 0; turn < 10; turn++) {
      let response;
      try {
        response = await fetchJSON(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools }),
        });
      } catch (fetchErr) {
        return `API Network Error: ${fetchErr.message?.substring(0, 200)}`;
      }
      if (response.error) return `API Error: ${JSON.stringify(response.error)}`;
      const choice = response.choices?.[0];
      if (!choice) return 'No response';
      messages.push(choice.message);
      if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls)
        return choice.message.content || 'No response generated';
      for (const tc of choice.message.tool_calls) {
        let args;
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch (parseErr) {
          if (parseErr instanceof SyntaxError) {
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: malformed tool arguments: ${tc.function.arguments}`,
            });
            continue;
          }
          throw parseErr;
        }
        const result = await executeTool(tc.function.name, args, cwd, tempDir);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
    return 'Max tool turns reached';
  } catch (err) {
    return `Agent Error: ${err.message?.substring(0, 500)}`;
  }
}

function fetchJSON(url, opts) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        timeout: 120000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError)
              resolve({ error: `Invalid JSON response: ${data.substring(0, 200)}` });
            else reject(parseErr);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const leadSessionCache = new Map();

async function askQuorum(question, project, callingSessionId, mode) {
  const settings = getQuorumSettings();
  const dbProj = db.getProject(project);
  const cwd = dbProj ? dbProj.path : safe.resolveProjectPath(project);

  const roundId = randomUUID().substring(0, 8);
  const roundDir = join(QUORUM_DIR, roundId);
  await mkdir(roundDir, { recursive: true });

  const allJuniors = [settings.fixedJunior, ...settings.additionalJuniors];
  logger.info('Quorum round starting', {
    module: 'quorum',
    roundId,
    lead: settings.lead,
    juniorCount: allJuniors.length,
    mode,
  });

  const juniorFiles = [];
  for (let i = 0; i < allJuniors.length; i++) {
    const juniorConfig = allJuniors[i];
    const label =
      typeof juniorConfig === 'string'
        ? juniorConfig
        : juniorConfig.label || juniorConfig.model || `junior_${i + 1}`;
    logger.info('Running junior agent', { module: 'quorum', junior: i + 1, label });
    const response = await runJuniorAgent(juniorConfig, question, cwd, roundDir);
    const filename = `junior_${i + 1}_${label.replace(/[^a-zA-Z0-9]/g, '_')}.md`;
    const filepath = join(roundDir, filename);
    await writeFile(filepath, `# Response from ${label}\n\n${response}\n`);
    juniorFiles.push(filepath);
  }

  const juniorContents = [];
  for (let i = 0; i < juniorFiles.length; i++) {
    const content = await readFile(juniorFiles[i], 'utf-8');
    juniorContents.push(`## Junior ${i + 1} Response\n\n${content}`);
  }
  const juniorText = juniorContents.join('\n\n---\n\n');

  const leadPrompt = `You are the lead on a quorum review.\n\n## Question\n${question}\n\n## Independent Responses\n${juniorText}\n\n## Your Task\nSynthesize a holistic response.`;

  let leadSessionId = null;
  if (mode === 'resume' && callingSessionId && leadSessionCache.has(callingSessionId)) {
    leadSessionId = leadSessionCache.get(callingSessionId);
  }

  const claudeTimeout = config.get('claude.defaultTimeoutMs', 120000);
  const leadArgs = ['--print', '--dangerously-skip-permissions', '--model', settings.lead];
  if (leadSessionId) leadArgs.push('--resume', leadSessionId);
  else leadArgs.push('--no-session-persistence');

  let leadResponse;
  try {
    leadArgs.push(leadPrompt);
    leadResponse = (await safe.claudeExecAsync(leadArgs, { cwd, timeout: claudeTimeout })).trim();
  } catch (err) {
    leadResponse = `Lead synthesis failed: ${err.message?.substring(0, 200)}`;
  }

  const leadFile = join(roundDir, 'lead_synthesis.md');
  await writeFile(leadFile, `# Lead Synthesis\n\n${leadResponse}\n`);

  const allFiles = [...juniorFiles, leadFile];
  logger.info('Quorum round complete', { module: 'quorum', roundId, fileCount: allFiles.length });
  return {
    round_id: roundId,
    files: allFiles,
    lead_synthesis: leadFile,
    junior_count: juniorFiles.length,
  };
}

function registerQuorumRoutes(app) {
  app.post('/api/quorum/ask', async (req, res) => {
    try {
      const { question, project, session_id, mode } = req.body;
      if (!question) return res.status(400).json({ error: 'question required' });
      if (!project) return res.status(400).json({ error: 'project required' });
      const result = await askQuorum(question, project, session_id, mode || 'new');
      res.json(result);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: `Resource not found: ${err.message}` });
      }
      logger.error('Quorum error', { module: 'quorum', err: err.message });
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { askQuorum, registerQuorumRoutes, executeTool, getQuorumSettings };
