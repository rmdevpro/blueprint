/**
 * Shared test fixtures for Blueprint test suite.
 * All test data comes from here — no hardcoded inline data in test bodies.
 * Per test plan §2.4 and §3.4
 */
'use strict';

const path = require('path');
const os = require('os');

// ── Helpers ─────────────────────────────────────────────────────────────────

function longText(char, length) {
  return Array.from({ length }, () => char).join('');
}

function makeJsonlLine(obj) {
  return JSON.stringify(obj);
}

function makeAssistantEntry({
  text = 'assistant response',
  model = 'claude-sonnet-4-6',
  inputTokens = 1000,
  outputTokens = 200,
  cacheRead = 0,
  cacheCreate = 0,
  timestamp = '2026-04-10T00:00:00.000Z',
} = {}) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  };
}

function makeUserEntry({ text = 'user prompt', timestamp = '2026-04-10T00:00:00.000Z' } = {}) {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: text },
  };
}

function makeSummaryEntry(summary, timestamp = '2026-04-10T00:00:00.000Z') {
  return { type: 'summary', timestamp, summary };
}

// ── JSONL Fixtures ──────────────────────────────────────────────────────────

const validUserEntry = {
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: 'Hello, can you help me with a project?' },
  uuid: 'uuid-user-001',
  timestamp: '2026-04-01T10:00:00.000Z',
  permissionMode: 'bypassPermissions',
  userType: 'external',
  entrypoint: 'cli',
  sessionId: 'abc123def456',
};

const validAssistantEntry = {
  parentUuid: 'uuid-user-001',
  isSidechain: false,
  type: 'assistant',
  message: {
    model: 'claude-sonnet-4-6',
    id: 'msg_test123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Of course! I would be happy to help you with your project.' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 50000,
      output_tokens: 200,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 5000,
    },
  },
  requestId: 'req-001',
  uuid: 'uuid-assistant-001',
  timestamp: '2026-04-01T10:00:05.000Z',
};

const validAssistantEntryOpus = {
  ...validAssistantEntry,
  uuid: 'uuid-assistant-opus-001',
  message: {
    ...validAssistantEntry.message,
    model: 'claude-opus-4-6',
    usage: {
      input_tokens: 100000,
      output_tokens: 500,
      cache_read_input_tokens: 20000,
      cache_creation_input_tokens: 10000,
    },
  },
};

const validSummaryEntry = {
  type: 'summary',
  summary: 'Working on Blueprint test infrastructure',
  timestamp: '2026-04-01T12:00:00.000Z',
};

const syntheticModelEntry = {
  parentUuid: 'uuid-user-001',
  isSidechain: false,
  type: 'assistant',
  message: {
    model: 'synthetic-message',
    id: 'msg_synthetic',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'System message' }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  uuid: 'uuid-synthetic-001',
  timestamp: '2026-04-01T09:00:00.000Z',
};

const malformedJsonlLines = [
  '{"type": "user", "message": {"content": "valid line"}}',
  'this is not json at all',
  '{"type": "assistant", incomplete',
  '',
  '{"type": "assistant", "message": {"content": [{"type": "text", "text": "valid assistant"}], "model": "claude-sonnet-4-6", "usage": {"input_tokens": 100, "output_tokens": 50}}}',
];

const sessionUtilsValidLines = [
  makeJsonlLine(
    makeUserEntry({ text: 'First user message', timestamp: '2026-04-10T00:00:01.000Z' }),
  ),
  makeJsonlLine(
    makeAssistantEntry({ text: 'Assistant first', timestamp: '2026-04-10T00:00:02.000Z' }),
  ),
  makeJsonlLine(
    makeUserEntry({ text: 'Second user message', timestamp: '2026-04-10T00:00:03.000Z' }),
  ),
  makeJsonlLine(
    makeAssistantEntry({ text: 'Assistant second', timestamp: '2026-04-10T00:00:04.000Z' }),
  ),
  makeJsonlLine(
    makeUserEntry({ text: 'Third user message', timestamp: '2026-04-10T00:00:05.000Z' }),
  ),
];

const sessionUtilsMalformedLines = [
  makeJsonlLine(makeUserEntry({ text: 'Good line', timestamp: '2026-04-10T00:00:01.000Z' })),
  '{"bad-json"',
  makeJsonlLine(makeAssistantEntry({ text: 'Still good', timestamp: '2026-04-10T00:00:02.000Z' })),
];

const sessionUtilsSummaryOverrideLines = [
  makeJsonlLine(
    makeUserEntry({
      text: 'Original derived title should come from this message',
      timestamp: '2026-04-10T00:00:01.000Z',
    }),
  ),
  makeJsonlLine(makeSummaryEntry('Human curated summary title', '2026-04-10T00:00:02.000Z')),
];

const tokenUsageLines = [
  makeJsonlLine(
    makeAssistantEntry({
      text: 'synthetic ignored',
      model: 'synthetic-model',
      inputTokens: 999999,
      outputTokens: 1,
    }),
  ),
  makeJsonlLine(
    makeAssistantEntry({
      text: 'system ignored',
      model: 'system-model',
      inputTokens: 888888,
      outputTokens: 1,
    }),
  ),
  makeJsonlLine(
    makeAssistantEntry({
      text: 'real used',
      model: 'claude-sonnet-4-6',
      inputTokens: 5000,
      outputTokens: 700,
      cacheRead: 300,
      cacheCreate: 200,
    }),
  ),
];

function buildJsonlContent(entries) {
  return entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
}

function buildValidJsonl() {
  return buildJsonlContent([validUserEntry, validAssistantEntry]);
}

function buildJsonlWithSummary() {
  return buildJsonlContent([validUserEntry, validAssistantEntry, validSummaryEntry]);
}

function buildJsonlWithMultipleMessages(count = 5) {
  const entries = [];
  let prevUuid = null;
  for (let i = 0; i < count; i++) {
    const userUuid = `uuid-user-${i}`;
    const assistantUuid = `uuid-assistant-${i}`;
    entries.push({
      ...validUserEntry,
      uuid: userUuid,
      parentUuid: prevUuid,
      message: { role: 'user', content: `Message ${i + 1} from user` },
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
    });
    entries.push({
      ...validAssistantEntry,
      uuid: assistantUuid,
      parentUuid: userUuid,
      message: {
        ...validAssistantEntry.message,
        content: [{ type: 'text', text: `Response ${i + 1} from assistant` }],
        usage: {
          input_tokens: 50000 + i * 10000,
          output_tokens: 200 + i * 50,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 5000,
        },
      },
      timestamp: new Date(Date.now() - (count - i) * 60000 + 5000).toISOString(),
    });
    prevUuid = assistantUuid;
  }
  return buildJsonlContent(entries);
}

function buildJsonlForTokenPercent(targetPercent, maxTokens = 200000) {
  const targetInputTokens = Math.floor(maxTokens * (targetPercent / 100));
  const entries = [];
  entries.push(makeUserEntry({ text: 'Fill session to target capacity' }));
  entries.push(
    makeAssistantEntry({
      text: 'x'.repeat(1000),
      inputTokens: targetInputTokens,
      outputTokens: 200,
      cacheRead: 0,
      cacheCreate: 0,
    }),
  );
  return buildJsonlContent(entries);
}

// ── Config Fixtures ─────────────────────────────────────────────────────────

const validDefaultsJson = {
  compaction: {
    thresholds: { advisory: 65, warning: 75, urgent: 85, auto: 90 },
    verbose: false,
    pollIntervalMs: 3000,
    compactTimeoutMs: 300000,
    tmuxCaptureLines: 50,
    maxPrepTurns: 10,
    maxRecoveryTurns: 6,
    checkerModel: 'claude-haiku-4-5-20251001',
    contextCleanupDelayMs: 60000,
    planModeTimeoutMs: 30000,
    waitForPromptTimeoutMs: 120000,
    planExitSleepMs: 2000,
    progressLogIntervalMs: 60000,
    promptPattern: '^\\s*❯\\s*$',
    tailPercent: 20,
  },
  session: {
    nameMaxLength: 60,
    promptInjectionDelayMs: 2000,
    promptMaxLength: 4096,
    summaryModel: 'claude-haiku-4-5-20251001',
    summaryMaxTranscriptChars: 1500,
    summaryMaxMessageChars: 500,
  },
  keepalive: {
    refreshThreshold: 0.85,
    checkRangeLow: 0.65,
    checkRangeHigh: 0.85,
    fallbackIntervalMs: 1800000,
    queryTimeoutMs: 30000,
  },
  bridges: { deliveredCleanupMs: 5000, undeliveredCleanupMs: 3600000 },
  polling: { tokenUsageIntervalMs: 15000, compactionMonitorIntervalMs: 30000 },
  ws: { bufferHighWaterMark: 1048576, bufferLowWaterMark: 524288, pingIntervalMs: 30000 },
  claude: { defaultTimeoutMs: 120000 },
  resolver: { maxAttempts: 3, sleepMs: 1 },
  bridge: { cleanupSentMs: 5000, cleanupUnsentMs: 3600000 },
  tmux: { maxSessions: 50, windowWidth: 200, windowHeight: 50 },
};

const promptTemplates = {
  summarizeSession: 'Summary for transcript:\n\n{{TRANSCRIPT}}',
  compactionPrep: '{"blueprint":"ready_to_connect"}',
  compactionPrepToAgent: 'prepare now',
  compactionGitCommit: 'git commit please',
  compactionResume: 'resume from {{CONVERSATION_TAIL_FILE}}',
  compactionAuto: 'auto compact at {{PERCENT}}',
  compactionNudgeAdvisory: 'advisory {{PERCENT}}',
  compactionNudgeWarning: 'warning {{PERCENT}}',
  compactionNudgeUrgent: 'urgent {{PERCENT}} auto {{AUTO_THRESHOLD}}',
  keepaliveQuestion: 'question?',
  keepaliveFact: 'fact.',
};

const corruptJson = '{"compaction": {"thresholds": {BROKEN';

// ── Compaction Fixtures ─────────────────────────────────────────────────────

const compaction = {
  ansiString: '\x1b[31mred text\x1b[0m normal \x1b]0;title\x07',
  ansiStripped: 'red text normal ',
  blueprintJsonLines: {
    valid: 'noise\n{"blueprint":"ready_to_connect"}\nmore noise',
    malformed: 'x\n{"blueprint": invalid }\ny',
    wrongSchema: 'noise\n{"blueprint":{"nested":true}}\nmore',
    hallucinated: 'Sure, here is my answer:\n{"blueprint":"read_plan_file"}\nI hope that helps.',
    noBlueprint: 'just regular text\nno json here\nmore text',
  },
  prepResponses: {
    initReady: '{"blueprint":"ready_to_connect"}',
    askReadPlan: '{"blueprint":"read_plan_file"}',
    askExitPlan: '{"blueprint":"exit_plan_mode"}',
    readyToCompact: '{"blueprint":"ready_to_compact"}',
    resumeComplete: '{"blueprint":"resume_complete"}',
    error: '{"blueprint":"error"}',
    plainAgentMessage: 'Please update the reading list and do not exit plan mode yet.',
  },
  promptVisibleBuffer: '\nfoo\n❯ \n',
  nonPromptBuffer: '\nworking...\n',
  recentTurnsLines: [
    makeJsonlLine(makeUserEntry({ text: 'u1' })),
    makeJsonlLine(makeAssistantEntry({ text: 'a1' })),
    makeJsonlLine(makeUserEntry({ text: 'u2' })),
    makeJsonlLine(makeAssistantEntry({ text: 'a2' })),
    makeJsonlLine(makeUserEntry({ text: 'u3' })),
    makeJsonlLine(makeAssistantEntry({ text: 'a3' })),
  ],
};

// ── Auth / ANSI Fixtures ────────────────────────────────────────────────────

const validCredentials = {
  claudeAiOauth: {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600000,
  },
};

const expiredCredentials = {
  claudeAiOauth: {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() - 3600000,
  },
};

const authAnsi = {
  ansiUrl: '\u001b[31mhttps://claude.com/cai/oauth/authorize?code=abc123\u001b[0m',
  fragmentedFrames: [
    'noise \u001b[32mhttps://claude.com/cai/',
    'oauth/authorize?client=bp&',
    'code=xyz Paste code here',
  ],
  largePrefix: `${longText('x', 5000)}https://claude.com/cai/oauth/authorize?state=large Paste code here`,
};

// ── Webhook Fixtures ────────────────────────────────────────────────────────

const webhooks = {
  hooks: [
    { url: 'http://localhost:9999/a', events: ['*'], mode: 'event_only' },
    { url: 'http://localhost:9999/b', events: ['task_added'], mode: 'full_content' },
  ],
};

// ── Route Validation Fixtures ───────────────────────────────────────────────

const routes = {
  validProjectName: 'test-project',
  validProjectPath: '/workspace/test-project',
  validSessionId: 'abc123def456',
  tempSessionId: 'new_123456',
  overlongProjectName: longText('p', 256),
  overlongSessionName: longText('s', 256),
  overlongPrompt: longText('x', 50001),
  overlongTaskText: longText('t', 1001),
  overlongMessage: longText('m', 100001),
  overlongSearch: longText('q', 201),
  overlongNotes: longText('n', 100001),
  invalidSessionIds: ['../../etc/passwd', 'bad!chars', '', ' '],
  traversalContent: '../etc/passwd',
};

// ── Safe-exec Fixtures ──────────────────────────────────────────────────────

const safeExec = {
  maliciousShellInput: "'; rm -rf /; '",
  tmuxDirtyName: 'a/b;c d',
  validGitUrl: 'https://example.com/repo.git',
  invalidGitUrl: 'notaurl',
  grepOutput: 'a.js:1:needle\nb.js:2:needle\nc.js:3:needle\n',
  curlLongBody: longText('x', 25000),
  sendText: 'line 1\nline 2\nline 3',
};

// ── Logger Fixtures ─────────────────────────────────────────────────────────

const loggerFixtures = {
  reservedCollisionContext: {
    timestamp: 'fake-timestamp',
    level: 'FAKE',
    message: 'fake',
    keep: 'value',
  },
};

// ── Paths ───────────────────────────────────────────────────────────────────

const paths = {
  tmpRoot: path.join(os.tmpdir(), 'blueprint-tests'),
  workspace: path.join(os.tmpdir(), 'blueprint-tests', 'workspace'),
  claudeHome: path.join(os.tmpdir(), 'blueprint-tests', 'claude-home'),
  data: path.join(os.tmpdir(), 'blueprint-tests', 'data'),
};

module.exports = {
  longText,
  makeJsonlLine,
  makeAssistantEntry,
  makeUserEntry,
  makeSummaryEntry,
  validUserEntry,
  validAssistantEntry,
  validAssistantEntryOpus,
  validSummaryEntry,
  syntheticModelEntry,
  malformedJsonlLines,
  sessionUtilsValidLines,
  sessionUtilsMalformedLines,
  sessionUtilsSummaryOverrideLines,
  tokenUsageLines,
  buildJsonlContent,
  buildValidJsonl,
  buildJsonlWithSummary,
  buildJsonlWithMultipleMessages,
  buildJsonlForTokenPercent,
  validDefaultsJson,
  promptTemplates,
  corruptJson,
  compaction,
  validCredentials,
  expiredCredentials,
  authAnsi,
  webhooks,
  routes,
  safeExec,
  loggerFixtures,
  paths,
};
