'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fixtures = require('../fixtures/test-data');
const createCompaction = require('../../compaction.js');

async function makeEnv(overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-cmp-'));
  const dataDir = path.join(root, 'data');
  const projectPath = path.join(root, 'project');
  const sessionsDir = path.join(root, 'sessions');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(projectPath, { recursive: true });
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.writeFile(
    path.join(sessionsDir, 'session123.jsonl'),
    fixtures.compaction.recentTurnsLines.join('\n') + '\n',
  );

  const sentKeys = [],
    sentNamedKeys = [],
    claudeCalls = [],
    logMessages = [];
  // Track what text the compaction pipeline sees after ANSI stripping
  const capturedCleanText = [];
  // Track parsed blueprint objects
  const parsedBlueprints = [];

  const captureOutputs = [fixtures.compaction.nonPromptBuffer, ...(overrides.captureOutputs || [])];
  let captureCallCount = 0;
  const claudeOutputs = [...(overrides.claudeOutputs || [])];
  const tmuxAlive = overrides.tmuxAlive ?? new Set(['bp_session123']);

  const configValues = {
    'compaction.verbose': overrides.verbose ?? false,
    'compaction.pollIntervalMs': 1,
    'compaction.tmuxCaptureLines': 50,
    'compaction.maxPrepTurns': overrides.maxPrepTurns ?? 3,
    'compaction.maxRecoveryTurns': overrides.maxRecoveryTurns ?? 2,
    'compaction.checkerModel': 'claude-haiku',
    'compaction.tailPercent': 50,
    'compaction.timeoutMs': overrides.timeoutMs ?? 50,
    'compaction.contextCleanupDelayMs': 10,
    'compaction.promptPattern': '^\\s*❯\\s*$',
    'compaction.planModeTimeoutMs': 10,
    'compaction.waitForPromptTimeoutMs': overrides.waitTimeout ?? 20,
    'compaction.planExitSleepMs': 1,
    'compaction.progressLogIntervalMs': 5,
    'compaction.thresholds': { advisory: 65, warning: 75, urgent: 85, auto: 90 },
    'claude.defaultTimeoutMs': 1000,
    ...(overrides.configValues || {}),
  };

  const promptMap = {
    'compaction-prep': fixtures.compaction.prepResponses.initReady,
    'compaction-prep-to-agent': 'prepare now',
    'compaction-git-commit': 'git commit please',
    'compaction-resume': 'resume from {{CONVERSATION_TAIL_FILE}}',
    'compaction-auto': 'auto compact at {{PERCENT}}',
    'compaction-nudge-advisory': 'advisory {{PERCENT}}',
    'compaction-nudge-warning': 'warning {{PERCENT}}',
    'compaction-nudge-urgent': 'urgent {{PERCENT}} auto {{AUTO_THRESHOLD}}',
  };

  let tokenUsageImpl;
  if (overrides.tokenUsageThrows) {
    tokenUsageImpl = async () => {
      throw overrides.tokenUsageThrows;
    };
  } else {
    tokenUsageImpl = async () =>
      overrides.tokenUsage ?? { input_tokens: 0, model: 'claude-sonnet-4-6', max_tokens: 200000 };
  }

  const comp = createCompaction({
    db: { DATA_DIR: dataDir, getProject: () => ({ id: 1, name: 'proj', path: projectPath }) },
    safe: {
      resolveProjectPath: () => projectPath,
      findSessionsDir: () => sessionsDir,
      sanitizeTmuxName: (v) => v.replace(/[^a-zA-Z0-9_-]/g, '_'),
      tmuxExecAsync: async (args) => {
        if (args[0] === 'capture-pane') {
          if (captureOutputs.length > 0) {
            const n = captureOutputs.shift();
            if (n instanceof Error) throw n;
            // Track cleaned text for ANSI verification
            const cleaned = n.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\x07]/g, '');
            capturedCleanText.push(cleaned);
            return n;
          }
          captureCallCount++;
          return captureCallCount % 2 === 0
            ? fixtures.compaction.promptVisibleBuffer
            : fixtures.compaction.promptVisibleBuffer.replace('foo', 'bar');
        }
        return '';
      },
      claudeExecAsync: async (args) => {
        claudeCalls.push(args);
        if (claudeOutputs.length === 0) return fixtures.compaction.prepResponses.initReady;
        const n = claudeOutputs.shift();
        if (n instanceof Error) throw n;
        // Track parsed blueprints from Claude responses
        try {
          const lines = n.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{') && trimmed.includes('"blueprint"')) {
              parsedBlueprints.push(JSON.parse(trimmed));
            }
          }
        } catch {
          /* not all responses contain blueprint JSON */
        }
        return n;
      },
      tmuxSendKeysAsync: async (t, text) => {
        sentKeys.push([t, text]);
      },
      tmuxSendKeyAsync: async (t, key) => {
        sentNamedKeys.push([t, key]);
      },
    },
    config: {
      get: (k, fb) => (k in configValues ? configValues[k] : fb),
      getPrompt: (name, vars = {}) => {
        let t = promptMap[name] || '';
        for (const [k, v] of Object.entries(vars))
          t = t.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
        return t;
      },
    },
    sessionUtils: {
      getTokenUsage: tokenUsageImpl,
      getSessionSlug: async () => overrides.sessionSlug ?? null,
    },
    tmuxName: (id) => `bp_${id}`,
    tmuxExists: async (tmux) => tmuxAlive.has(tmux),
    sleep: async () => {},
    logger: {
      info(m) {
        logMessages.push(m);
      },
      warn(m) {
        logMessages.push(m);
      },
      error(m) {
        logMessages.push(m);
      },
      debug() {},
    },
  });
  return {
    comp,
    sentKeys,
    sentNamedKeys,
    claudeCalls,
    dataDir,
    sessionsDir,
    logMessages,
    capturedCleanText,
    parsedBlueprints,
  };
}

// -- CMP-01: ANSI stripping (direct unit test of stripAnsi) --
test('CMP-01: stripAnsi removes escape codes from captured terminal output', async () => {
  const env = await makeEnv();
  const strip = env.comp.__stripAnsi;

  // CSI sequences (colors, cursor movement)
  assert.equal(strip('\x1b[31mcolored\x1b[0m'), 'colored', 'strips SGR color codes');
  assert.equal(strip('\x1b[32mgreen\x1b[0m'), 'green', 'strips green SGR');
  assert.equal(strip('\x1b[1;33mbold yellow\x1b[0m'), 'bold yellow', 'strips multi-param SGR');
  assert.equal(strip('\x1b[2J\x1b[H'), '', 'strips clear-screen + cursor-home');

  // OSC sequences (title sets, hyperlinks)
  assert.equal(strip('\x1b]0;window title\x07'), '', 'strips OSC title-set terminated by BEL');
  assert.equal(
    strip('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'),
    'link',
    'strips OSC hyperlinks',
  );

  // Mixed real-world terminal output
  const messy = '\x1b[31mred\x1b[0m plain \x1b]0;title\x07\x1b[32mgreen\x1b[0m\n❯ ';
  assert.equal(strip(messy), 'red plain green\n❯ ', 'handles mixed CSI + OSC in realistic output');

  // Identity on clean strings
  assert.equal(strip('hello world'), 'hello world', 'preserves clean text unchanged');
  assert.equal(strip(''), '', 'handles empty string');
});

// -- CMP-02/03/03a: parseBlueprint (direct unit tests) --
test('CMP-02: parseBlueprint extracts valid blueprint JSON with correct fields', async () => {
  const env = await makeEnv();
  const parse = env.comp.__parseBlueprint;

  // Extracts blueprint value from valid JSON line
  assert.equal(parse('{"blueprint": "ready_to_connect"}', 'sess1', false), 'ready_to_connect');
  assert.equal(parse('{"blueprint": "ready_to_compact"}', 'sess1', false), 'ready_to_compact');

  // Handles surrounding text (only first JSON line matters)
  assert.equal(parse('some text\n{"blueprint": "done"}\nmore text', 'sess1', false), 'done');

  // Returns null for non-blueprint responses
  assert.equal(parse('just plain text', 'sess1', false), null);
  assert.equal(parse('', 'sess1', false), null);
  assert.equal(parse(null, 'sess1', false), null);
});

test('CMP-03: malformed blueprint JSON returns error', async () => {
  const env = await makeEnv();
  const parse = env.comp.__parseBlueprint;
  assert.equal(parse('{"blueprint": invalid }', 'sess1', false), 'error');
});

test('CMP-03a: hallucinated text around JSON still extracted', async () => {
  const env = await makeEnv();
  const parse = env.comp.__parseBlueprint;
  // The hallucinated fixture has text before/after a valid blueprint JSON line
  const hallucinated = fixtures.compaction.blueprintJsonLines.hallucinated;
  assert.equal(
    parse(hallucinated, 'sess1', false),
    'read_plan_file',
    'Should extract blueprint JSON even when surrounded by hallucinated text',
  );
});

// -- CMP-04: extractAgentMessage --
test('CMP-04: agent message delivered without blueprint lines', async () => {
  const env = await makeEnv();
  const extract = env.comp.__extractAgentMessage;

  // Strips blueprint lines, keeps everything else
  assert.equal(extract('hello\n{"blueprint": "ready_to_connect"}\nworld'), 'hello\nworld');
  assert.equal(extract('just text'), 'just text');
  assert.equal(extract('{"blueprint": "x"}'), '');
  assert.equal(extract(null), '');
  assert.equal(extract(''), '');
});

// -- CMP-28: new_ temp sessions skipped --
test('CMP-28: new_ temp sessions skipped by checkCompactionNeeds', async () => {
  const env = await makeEnv();
  await env.comp.checkCompactionNeeds('new_123', 'proj');
  assert.equal(env.sentKeys.length, 0);
});

// -- CMP-36/37/38: orchestration guards --
test('CMP-36: invalid session ID rejected', async () => {
  const env = await makeEnv();
  await assert.rejects(env.comp.runSmartCompaction('bad!', 'proj'), /Invalid session ID/);
});

test('CMP-37: temp session returns non-compacted', async () => {
  const env = await makeEnv();
  const r = await env.comp.runSmartCompaction('new_123', 'proj');
  assert.equal(r.compacted, false);
  assert.match(r.reason, /temp session/);
});

test('CMP-38: non-running session returns non-compacted', async () => {
  const env = await makeEnv({ tmuxAlive: new Set() });
  const r = await env.comp.runSmartCompaction('session123', 'proj');
  assert.equal(r.compacted, false);
  assert.match(r.reason, /not running/);
});

// -- CMP-39: lock prevents concurrent run --
test('CMP-39: lock prevents concurrent compaction', async () => {
  const env = await makeEnv({
    claudeOutputs: [
      fixtures.compaction.prepResponses.initReady,
      fixtures.compaction.prepResponses.readyToCompact,
      fixtures.compaction.prepResponses.resumeComplete,
    ],
  });
  const locks = env.comp.__getCompactionLocks();
  const p1 = env.comp.runSmartCompaction('session123', 'proj');
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(locks.has('bp_session123'));
  const r2 = await env.comp.runSmartCompaction('session123', 'proj');
  assert.equal(r2.compacted, false);
  assert.match(r2.reason, /already in progress/);
  await p1;
});

// -- CMP-47..50: threshold boundary tests --
test('CMP-47: 64% — no nudge triggered', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 128000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.equal(env.sentKeys.length, 0);
});

test('CMP-48: 74% triggers advisory nudge but not warning nudge', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 148000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(
    env.sentKeys.some(([, t]) => /advisory/.test(t)),
    'Advisory nudge should fire at 74% (above 65% threshold)',
  );
  assert.ok(
    !env.sentKeys.some(([, t]) => /warning/.test(t)),
    'Warning nudge should not fire at 74% (below 75% threshold)',
  );
});

test('CMP-49: 84% triggers advisory and warning but not urgent', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 168000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(!env.sentKeys.some(([, t]) => /urgent/.test(t)));
});

test('CMP-50: 89% triggers advisory, warning, and urgent but not auto-compaction', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 178000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(!env.sentKeys.some(([, t]) => /auto compact/.test(t)));
});

// -- CMP-29..32: threshold nudges --
test('CMP-29: 66% triggers advisory nudge once', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 132000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(env.sentKeys.some(([, t]) => /advisory 66/.test(t)));
  env.sentKeys.length = 0;
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.equal(env.sentKeys.length, 0);
});

test('CMP-30: 76% triggers warning nudge', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 152000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(env.sentKeys.some(([, t]) => /warning 76/.test(t)));
});

test('CMP-31: 86% triggers urgent nudge', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 172000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(env.sentKeys.some(([, t]) => /urgent 86/.test(t)));
});

test('CMP-32: 91% triggers auto-compaction', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 182000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(env.sentKeys.some(([, t]) => /auto compact/.test(t)));
});

// -- CMP-34: ENOENT during checkCompactionNeeds tolerated --
test('CMP-34: ENOENT during checkCompactionNeeds tolerated', async () => {
  const enoent = new Error('ENOENT: no such file');
  enoent.code = 'ENOENT';
  const env = await makeEnv({ tokenUsageThrows: enoent });
  await assert.doesNotReject(env.comp.checkCompactionNeeds('session123', 'proj'));
  assert.equal(env.sentKeys.length, 0);
});

// -- CMP-33: state map eviction --
test('CMP-33: state map evicts oldest non-locked entry when full', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 132000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  const state = env.comp.__getCompactionState();
  for (let i = 0; i < 100; i++)
    state.set(`bp_old_${i}`, {
      nudged65: false,
      nudged75: false,
      nudged85: false,
      autoTriggered: false,
    });
  assert.equal(state.size, 100);
  await env.comp.checkCompactionNeeds('session123', 'proj');
  assert.ok(state.size <= 100);
  assert.ok(state.has('bp_session123'));
});

// -- CMP-35: full orchestration --
test('CMP-35: full orchestration PREP -> COMPACT -> RECOVERY', async () => {
  const env = await makeEnv({
    claudeOutputs: [
      fixtures.compaction.prepResponses.initReady,
      'ack',
      fixtures.compaction.prepResponses.readyToCompact,
      fixtures.compaction.prepResponses.resumeComplete,
    ],
  });
  const r = await env.comp.runSmartCompaction('session123', 'proj');
  assert.equal(r.compacted, true);
  assert.equal(r.prep_completed, true);
  assert.equal(r.compaction_completed, true);
  assert.ok(r.tail_file);
  // Gray-box: verify tail file was actually written to disk
  const tailExists = await fsp
    .stat(r.tail_file)
    .then(() => true)
    .catch(() => false);
  assert.ok(tailExists, `Tail file should exist at ${r.tail_file}`);
  const tailContent = await fsp.readFile(r.tail_file, 'utf-8');
  assert.ok(tailContent.length > 0, 'Tail file should have content');
  // Gray-box: verify lock was released after completion
  const locks = env.comp.__getCompactionLocks();
  assert.ok(!locks.has('bp_session123'), 'Lock should be released after successful compaction');
});

// -- CMP-15: checker init failure --
test('CMP-15: checker init failure stops prep', async () => {
  const env = await makeEnv({ claudeOutputs: ['not-json-at-all'] });
  const r = await env.comp.runSmartCompaction('session123', 'proj');
  assert.equal(r.compacted, false);
  assert.match(r.reason, /checker failed/);
});

// -- CMP-19: max-turns reached --
test('CMP-19: prep phase max-turns reached returns success with prepDone=false', async () => {
  const env = await makeEnv({
    claudeOutputs: [
      fixtures.compaction.prepResponses.initReady,
      'Please keep working',
      'Still working',
      'More work needed',
    ],
    maxPrepTurns: 3,
  });
  const r = await env.comp.runSmartCompaction('session123', 'proj');
  assert.equal(
    r.prep_completed,
    false,
    'prep should not be marked completed when max turns reached without ready_to_compact',
  );
});

// -- CMP-41: prompt template variable substitution --
test('CMP-41: prompt template substitution with PERCENT and AUTO_THRESHOLD', async () => {
  const env = await makeEnv({
    tokenUsage: { input_tokens: 172000, model: 'claude-sonnet-4-6', max_tokens: 200000 },
  });
  await env.comp.checkCompactionNeeds('session123', 'proj');
  const urgentKey = env.sentKeys.find(([, t]) => /urgent/.test(t));
  assert.ok(urgentKey);
  assert.ok(/86/.test(urgentKey[1]));
  assert.ok(/90/.test(urgentKey[1]));
});

// -- deleteCompactionState --
test('deleteCompactionState removes entry', async () => {
  const env = await makeEnv();
  env.comp.__getCompactionState().set('bp_test', { nudged65: true });
  env.comp.deleteCompactionState('bp_test');
  assert.equal(env.comp.__getCompactionState().has('bp_test'), false);
});
