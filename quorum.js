/**
 * Blueprint Ask Quorum + CLI agent
 *
 * All juniors run via CLI: claude, gemini, codex.
 * Lead always runs via Claude CLI (Opus).
 * Quorum participants = Claude (always) + any CLI with a configured API key.
 */

const { mkdirSync, writeFileSync, readFileSync } = require('fs');
const { join } = require('path');
const { randomUUID } = require('crypto');
const db = require('./db');
const safe = require('./safe-exec');
const QUORUM_DIR = join(db.DATA_DIR, 'quorum');

// ── CLI execution ─────────────────────────────────────────────────────────

async function askCli(cli, prompt, cwd, model) {
  const args = buildCliArgs(cli, prompt, model);
  try {
    if (cli === 'claude') {
      return (await safe.claudeExecAsync(args, { cwd, timeout: 120000 })).trim();
    }
    // Gemini and Codex run via execFileAsync
    const { execFile } = require('child_process');
    return await new Promise((resolve, reject) => {
      const proc = execFile(cli, args, { cwd, timeout: 120000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    });
  } catch (err) {
    return `CLI Error (${cli}): ${err.message?.substring(0, 500)}`;
  }
}

function buildCliArgs(cli, prompt, model) {
  switch (cli) {
    case 'claude':
      return [
        '--print',
        '--permission-mode', 'dontAsk',
        '--tools', 'Read,Grep,Glob,WebSearch,WebFetch',
        '--allowedTools', 'Read,Grep,Glob,WebSearch,WebFetch',
        ...(model ? ['--model', model] : []),
        '--no-session-persistence',
        prompt,
      ];
    case 'gemini':
      return [
        ...(model ? ['--model', model] : []),
        '-p', prompt,
      ];
    case 'codex':
      return ['exec', prompt];
    default:
      throw new Error(`Unknown CLI: ${cli}`);
  }
}

// ── Configured CLIs ─────────────────────────────────────────────────────────

function getConfiguredCLIs() {
  const clis = ['claude']; // always included
  const geminiKey = db.getSetting('gemini_api_key', '');
  const codexKey = db.getSetting('codex_api_key', '');
  if (geminiKey) clis.push('gemini');
  if (codexKey) clis.push('codex');
  return clis;
}

// ── Quorum orchestration ───────────────────────────────────────────────────

async function askQuorum(question, project, callingSessionId, mode) {
  const dbProj = db.getProject(project);
  const cwd = dbProj ? dbProj.path : safe.resolveProjectPath(project);
  const clis = getConfiguredCLIs();

  const roundId = randomUUID().substring(0, 8);
  const roundDir = join(QUORUM_DIR, roundId);
  mkdirSync(roundDir, { recursive: true });

  console.log(`[quorum] Round ${roundId} — ${clis.length} CLIs: ${clis.join(', ')}`);

  // Step 1: Run all juniors in parallel
  const juniorResults = await Promise.all(
    clis.map(async (cli, i) => {
      console.log(`[quorum] Running junior ${i + 1}: ${cli}...`);
      const response = await askCli(cli, question, cwd);
      const filename = `junior_${i + 1}_${cli}.md`;
      const filepath = join(roundDir, filename);
      writeFileSync(filepath, `# Response from ${cli}\n\n${response}\n`);
      console.log(`[quorum] Junior ${i + 1} (${cli}) complete — ${response.length} chars`);
      return { cli, filepath, response };
    })
  );

  // Step 2: Lead synthesis via Claude CLI (always Opus)
  const juniorContents = juniorResults.map((r, i) =>
    `## Junior ${i + 1} (${r.cli}) Response\n\n${r.response}`
  ).join('\n\n---\n\n');

  const leadPrompt = `You are the lead on a quorum review. You have a question and ${clis.length} independent responses from different AI models.

## Question
${question}

## Independent Responses
${juniorContents}

## Your Task
Synthesize a response that is holistically superior to any individual response. Select the best insights, identify agreements (high confidence) and disagreements (needs investigation), resolve conflicts, and produce a comprehensive answer.`;

  console.log('[quorum] Running lead synthesis (opus)...');
  const leadResponse = await askCli('claude', leadPrompt, cwd, 'opus');

  const leadFile = join(roundDir, 'lead_synthesis.md');
  writeFileSync(leadFile, `# Lead Synthesis\n\n${leadResponse}\n`);

  const allFiles = [...juniorResults.map(r => r.filepath), leadFile];
  console.log(`[quorum] Round ${roundId} complete — ${allFiles.length} files`);

  return {
    round_id: roundId,
    files: allFiles,
    lead_synthesis: leadFile,
    junior_count: juniorResults.length,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────

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

  // Generic CLI ask endpoint — used by blueprint_ask_cli MCP tool
  app.post('/api/cli/ask', async (req, res) => {
    try {
      const { cli, prompt, model, cwd } = req.body;
      if (!cli) return res.status(400).json({ error: 'cli required' });
      if (!prompt) return res.status(400).json({ error: 'prompt required' });
      const validClis = ['claude', 'gemini', 'codex'];
      if (!validClis.includes(cli)) return res.status(400).json({ error: `cli must be one of: ${validClis.join(', ')}` });
      const result = await askCli(cli, prompt, cwd || '/mnt/workspace', model);
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { askCli, askQuorum, registerQuorumRoutes, getConfiguredCLIs };
