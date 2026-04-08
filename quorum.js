/**
 * Blueprint Ask Quorum
 *
 * Lead: Claude CLI (configured model)
 * Fixed Junior: configurable (default Sonnet via API)
 * Additional Juniors: configurable list of API models
 *
 * Each junior runs as a ReAct agent with:
 *   - read_file, list_files, search_files (CWD read-only)
 *   - web_search, web_fetch
 *   - write_response (temp dir)
 */

const { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } = require('fs');
const { join, relative } = require('path');
const { randomUUID } = require('crypto');
const http = require('http');
const https = require('https');
const db = require('./db');
const safe = require('./safe-exec');
const QUORUM_DIR = join(db.DATA_DIR, 'quorum');

// ── Tool definitions for junior agents ─────────────────────────────────────

const JUNIOR_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the project directory. Returns file content.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path from project root' } },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories at a path. Returns names with type indicators.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path (empty string for root)' } },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in project files using grep. Returns matching lines with file paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex)' },
        glob: { type: 'string', description: 'Optional file glob filter (e.g. "*.py")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for information. Returns search result snippets.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a URL. Returns the text content of the page.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────────────

function executeTool(toolName, input, cwd, tempDir) {
  switch (toolName) {
    case 'read_file': {
      const { sep } = require('path');
      const fullPath = join(cwd, input.path);
      // Prevent path traversal — check with separator to avoid prefix-match bypass
      if (!fullPath.startsWith(cwd + sep) && fullPath !== cwd) return 'Error: path outside project directory';
      try {
        const content = readFileSync(fullPath, 'utf-8');
        return content.length > 10000 ? content.substring(0, 10000) + '\n...[truncated]' : content;
      } catch { return `Error: file not found: ${input.path}`; }
    }
    case 'list_files': {
      const { sep } = require('path');
      const fullPath = join(cwd, input.path || '');
      if (!fullPath.startsWith(cwd + sep) && fullPath !== cwd) return 'Error: path outside project directory';
      try {
        const entries = readdirSync(fullPath, { withFileTypes: true });
        return entries.slice(0, 100).map(e =>
          `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`
        ).join('\n');
      } catch { return `Error: cannot list: ${input.path}`; }
    }
    case 'search_files': {
      return safe.grepSearch(input.pattern, cwd, input.glob);
    }
    case 'web_search': {
      try {
        const { execFileSync } = require('child_process');
        const result = execFileSync('curl', [
          '-s', `https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_html=1`
        ], { encoding: 'utf-8', timeout: 10000 });
        const data = JSON.parse(result);
        const results = [];
        if (data.AbstractText) results.push(`Summary: ${data.AbstractText}`);
        if (data.RelatedTopics) {
          for (const t of data.RelatedTopics.slice(0, 5)) {
            if (t.Text) results.push(`- ${t.Text}`);
          }
        }
        return results.length > 0 ? results.join('\n') : 'No results found.';
      } catch { return 'Web search failed'; }
    }
    case 'web_fetch': {
      return safe.curlFetch(input.url).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 10000);
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── API-based ReAct agent ──────────────────────────────────────────────────

async function runJuniorAgent(modelConfig, question, cwd, tempDir) {
  const systemPrompt = `You are a junior member of a technical quorum. You have been given a question to answer independently.

You have access to tools to examine the project codebase and search the web. Use them as needed to give a thorough, well-informed answer.

When you have your answer ready, state it clearly. Be thorough but concise.`;

  // String config (e.g. "sonnet") = Claude CLI model
  if (typeof modelConfig === 'string') {
    return await runClaudeCliJunior(modelConfig, systemPrompt, question, cwd);
  }

  const provider = modelConfig.provider || 'anthropic';

  // Anthropic provider or missing = Claude CLI
  if (provider === 'anthropic' || provider === 'anthropic-cli') {
    const model = modelConfig.model || 'sonnet';
    return await runClaudeCliJunior(model, systemPrompt, question, cwd);
  }

  // Everything else = OpenAI-compatible API
  return await runOpenAICompatAgent(modelConfig, systemPrompt, question, cwd, tempDir);
}

async function runClaudeCliJunior(model, systemPrompt, question, cwd) {
  const prompt = `${systemPrompt}\n\n## Question\n\n${question}`;
  const args = [
    '--print',
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Grep,Glob,WebSearch,WebFetch',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
    '--model', model,
    '--no-session-persistence',
    prompt,
  ];
  try {
    return (await safe.claudeExecAsync(args, { cwd, timeout: 120000 })).trim();
  } catch (err) {
    return `CLI Error: ${err.message?.substring(0, 500)}`;
  }
}

async function runOpenAICompatAgent(config, systemPrompt, question, cwd, tempDir) {
  const apiKey = config.api_key || process.env[config.api_key_env || 'OPENAI_API_KEY'] || '';
  if (!apiKey) return `Error: no API key configured for ${config.provider}`;

  const model = config.model;
  const baseUrl = config.base_url || 'https://api.openai.com';
  const maxTurns = 10;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: question },
  ];

  // Convert tool format for OpenAI
  const tools = JUNIOR_TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await fetchJSON(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, tools }),
    });

    if (response.error) return `API Error: ${JSON.stringify(response.error)}`;

    const choice = response.choices?.[0];
    if (!choice) return 'No response';

    messages.push(choice.message);

    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls) {
      return choice.message.content || 'No response generated';
    }

    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = executeTool(tc.function.name, args, cwd, tempDir);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  return 'Max tool turns reached';
}

// ── HTTP helper ────────────────────────────────────────────────────────────

function fetchJSON(url, opts) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ error: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Quorum orchestration ───────────────────────────────────────────────────

function getQuorumSettings() {
  let lead, fixedJunior, additionalJuniors;
  try { lead = JSON.parse(db.getSetting('quorum_lead_model', '"opus"')); } catch { lead = 'opus'; }
  try { fixedJunior = JSON.parse(db.getSetting('quorum_fixed_junior', '"sonnet"')); }
  catch { fixedJunior = 'sonnet'; }
  try { additionalJuniors = JSON.parse(db.getSetting('quorum_additional_juniors', '[]')); }
  catch { additionalJuniors = []; }

  return { lead, fixedJunior, additionalJuniors };
}

const leadSessionCache = new Map();

async function askQuorum(question, project, callingSessionId, mode) {
  const settings = getQuorumSettings();
  const cwd = safe.resolveProjectPath(project);

  const roundId = randomUUID().substring(0, 8);
  const roundDir = join(QUORUM_DIR, roundId);
  mkdirSync(roundDir, { recursive: true });

  const allJuniors = [settings.fixedJunior, ...settings.additionalJuniors];
  console.log(`[quorum] Round ${roundId} — lead: ${settings.lead}, ${allJuniors.length} juniors, mode: ${mode}`);

  // Step 1: Run all junior agents
  const juniorFiles = [];
  for (let i = 0; i < allJuniors.length; i++) {
    const config = allJuniors[i];
    const label = typeof config === 'string' ? config : (config.label || config.model || `junior_${i + 1}`);
    const provider = typeof config === 'string' ? 'cli' : (config.provider || 'anthropic');
    console.log(`[quorum] Running junior ${i + 1}: ${label} (${provider})...`);

    const response = await runJuniorAgent(config, question, cwd, roundDir);
    const filename = `junior_${i + 1}_${label.replace(/[^a-zA-Z0-9]/g, '_')}.md`;
    const filepath = join(roundDir, filename);
    writeFileSync(filepath, `# Response from ${label}\n\n${response}\n`);
    juniorFiles.push(filepath);
    console.log(`[quorum] Junior ${i + 1} complete — ${response.length} chars`);
  }

  // Step 2: Lead synthesis via Claude CLI
  const juniorContents = juniorFiles.map((f, i) => {
    const content = readFileSync(f, 'utf-8');
    return `## Junior ${i + 1} Response\n\n${content}`;
  }).join('\n\n---\n\n');

  const leadPrompt = `You are the lead on a quorum review. You have a question and ${allJuniors.length} independent responses from different models.

## Question
${question}

## Independent Responses
${juniorContents}

## Your Task
Synthesize a response that is holistically superior to any individual response. Select the best insights, identify agreements (high confidence) and disagreements (needs investigation), resolve conflicts, and produce a comprehensive answer.`;

  let leadSessionId = null;
  if (mode === 'resume' && callingSessionId && leadSessionCache.has(callingSessionId)) {
    leadSessionId = leadSessionCache.get(callingSessionId);
  }

  console.log(`[quorum] Running lead synthesis (${settings.lead})...`);
  const leadArgs = ['--print', '--dangerously-skip-permissions', '--model', settings.lead];
  if (leadSessionId) {
    leadArgs.push('--resume', leadSessionId);
  } else {
    leadArgs.push('--no-session-persistence');
  }

  let leadResponse;
  try {
    leadArgs.push(leadPrompt);
    leadResponse = (await safe.claudeExecAsync(leadArgs, { cwd, timeout: 120000 })).trim();
  } catch (err) {
    leadResponse = `Lead synthesis failed: ${err.message?.substring(0, 200)}`;
  }

  const leadFile = join(roundDir, 'lead_synthesis.md');
  writeFileSync(leadFile, `# Lead Synthesis\n\n${leadResponse}\n`);

  const allFiles = [...juniorFiles, leadFile];
  console.log(`[quorum] Round ${roundId} complete — ${allFiles.length} files`);

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
      console.error('[quorum] Error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { askQuorum, registerQuorumRoutes, executeTool, getQuorumSettings };
