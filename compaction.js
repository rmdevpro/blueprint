'use strict';

const { readdir, readFile, writeFile, stat, unlink, mkdir, copyFile } = require('fs/promises');
const { join } = require('path');
const { performance } = require('perf_hooks');

module.exports = function createCompaction({ db, safe, config, sessionUtils, tmuxName, tmuxExists, sleep, logger }) {
  const MAX_COMPACTION_ENTRIES = 100;
  const compactionState = new Map();
  const compactionLocks = new Set();

  // ── Pure helpers ──────────────────────────────────────────────────────────────

  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  }

  function parseBlueprint(response, sessionId, verbose) {
    if (!response) return null;
    for (const line of response.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{"blueprint"')) {
        try {
          const payload = JSON.parse(trimmed).blueprint || null;
          if (verbose) logger.info('Blueprint evaluated', { module: 'compaction', payload, sessionId: sessionId.substring(0, 8) });
          return payload;
        } catch (err) {
          if (err instanceof SyntaxError) {
            logger.debug('Malformed blueprint JSON line', { module: 'compaction', sessionId: sessionId.substring(0, 8), err: err.message });
          } else {
            logger.error('Unexpected error parsing blueprint', { module: 'compaction', sessionId: sessionId.substring(0, 8), err: err.message });
          }
          return 'error';
        }
      }
    }
    return null;
  }

  function extractAgentMessage(response) {
    if (!response) return '';
    return response.split('\n').filter(l => !l.trim().startsWith('{"blueprint"')).join('\n').trim();
  }

  // ── Async helpers (each is a focused function) ────────────────────────────────

  async function capturePaneAsync(tmuxSession, captureLines) {
    return await safe.tmuxExecAsync(['capture-pane', '-t', safe.sanitizeTmuxName(tmuxSession), '-p', '-S', `-${captureLines}`]);
  }

  async function waitForPrompt({ tmuxSession, pollInterval, timeoutMs, captureLines, promptPattern, sessionId }) {
    const deadline = Date.now() + timeoutMs;
    let lastOutput = '';
    while (Date.now() < deadline) {
      await sleep(pollInterval);
      try {
        const output = stripAnsi(await capturePaneAsync(tmuxSession, captureLines));
        const lines = output.split('\n').filter(l => l.trim());
        if (lines.slice(-4).some(l => promptPattern.test(l)) && output !== lastOutput && lastOutput !== '') {
          return output;
        }
        lastOutput = output;
      } catch (err) {
        logger.debug('Capture pane error during waitForPrompt', { module: 'compaction', sessionId: sessionId.substring(0, 8), err: err.message });
        if (!(await tmuxExists(tmuxSession))) return null;
        logger.error('Capture pane loop error', { module: 'compaction', op: 'waitForPrompt', sessionId: sessionId.substring(0, 8), err: err.message });
        throw err;
      }
    }
    try {
      return stripAnsi(await capturePaneAsync(tmuxSession, captureLines));
    } catch (err) {
      logger.warn('Final capture after timeout failed', { module: 'compaction', op: 'waitForPrompt', sessionId: sessionId.substring(0, 8), err: err.message });
      return '';
    }
  }

  async function sendToChecker({ message, checkerState, projectPath, checkerModel, verbose, sessionId }) {
    const start = performance.now();
    const claudeTimeout = config.get('claude.defaultTimeoutMs', 120000);
    const args = ['--print', '--dangerously-skip-permissions', '--model', checkerModel];
    if (checkerState.sessionId) args.push('--resume', checkerState.sessionId);
    args.push(message);
    try {
      const response = (await safe.claudeExecAsync(args, { cwd: projectPath, timeout: claudeTimeout })).trim();
      if (verbose) {
        logger.info('Checker completed execution', { module: 'compaction', durationMs: Math.round(performance.now() - start), model: checkerModel, sessionId: sessionId.substring(0, 8) });
      }
      if (!checkerState.sessionId) {
        await resolveCheckerSessionId(checkerState, projectPath, sessionId);
      }
      return response;
    } catch (err) {
      logger.error('Checker error', { module: 'compaction', op: 'sendToChecker', sessionId: sessionId.substring(0, 8), err: err.message });
      return null;
    }
  }

  /**
   * Resolves the checker's Claude session ID by finding the newest JSONL file.
   *
   * NOTE: This heuristic finds the most recently modified JSONL in the sessions
   * directory. Under concurrent Claude processes (main agent + checker), it may
   * incorrectly pick the agent's JSONL instead of the checker's. This causes
   * the checker to lose session continuity and restart fresh on the next
   * compaction. The impact is limited: the checker restarts cleanly and the
   * compaction still completes successfully, just without multi-turn context.
   */
  async function resolveCheckerSessionId(checkerState, projectPath, sessionId) {
    const sessDir = safe.findSessionsDir(projectPath);
    try {
      const files = await readdir(sessDir);
      const jsonls = files.filter(f => f.endsWith('.jsonl'));
      let newest = null;
      let newestMtime = 0;
      for (const f of jsonls) {
        try {
          const s = await stat(join(sessDir, f));
          if (s.mtimeMs > newestMtime) { newestMtime = s.mtimeMs; newest = f; }
        } catch (statErr) {
          if (statErr.code !== 'ENOENT') logger.debug('Stat skipped in checker session scan', { module: 'compaction', err: statErr.message });
          /* expected: file removed between readdir and stat */
        }
      }
      if (newest) checkerState.sessionId = newest.replace('.jsonl', '');
    } catch (err) {
      if (err.code !== 'ENOENT') logger.debug('Failed to resolve checker session ID', { module: 'compaction', err: err.message });
      /* expected: sessions dir may not exist yet */
    }
  }

  async function readLatestAssistantText(agentJsonlFile, sessionId) {
    try {
      const raw = await readFile(agentJsonlFile, 'utf-8');
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.content) {
            const blocks = Array.isArray(entry.message.content) ? entry.message.content : [entry.message.content];
            const text = blocks
              .filter(b => b && (b.type === 'text' || typeof b === 'string'))
              .map(b => (typeof b === 'string' ? b : b.text))
              .join('\n')
              .trim();
            if (text) return text;
          }
        } catch (parseErr) {
          if (!(parseErr instanceof SyntaxError)) {
            logger.debug('Non-syntax error parsing JSONL entry', { module: 'compaction', err: parseErr.message });
          }
          /* expected: malformed JSONL lines during active session writes */
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') logger.debug('readLatestAssistantText read failed', { module: 'compaction', sessionId: sessionId.substring(0, 8), err: err.message });
      /* expected: JSONL file not yet created */
    }
    return null;
  }

  async function setupContext({ agentJsonlFile, tailPercent, verbose, sessionId }) {
    const contextStart = performance.now();
    const contextDir = join(db.DATA_DIR, 'compaction');
    await mkdir(contextDir, { recursive: true });
    const recentTurnsFile = join(contextDir, `recent_turns_${sessionId.substring(0, 8)}.md`);
    try {
      const jsonlContent = await readFile(agentJsonlFile, 'utf-8');
      const exchanges = [];
      for (const line of jsonlContent.trim().split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message?.content) {
            const text = typeof entry.message.content === 'string' ? entry.message.content : JSON.stringify(entry.message.content);
            exchanges.push(`Human: ${text}`);
          } else if (entry.type === 'assistant' && entry.message?.content) {
            const blocks = Array.isArray(entry.message.content) ? entry.message.content : [entry.message.content];
            const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
            if (text) exchanges.push(`Assistant: ${text}`);
          }
        } catch (parseErr) {
          if (!(parseErr instanceof SyntaxError)) logger.debug('Non-syntax error during context parse', { module: 'compaction', err: parseErr.message });
          /* expected: malformed JSONL lines */
        }
      }
      const tailCount = Math.max(1, Math.floor(exchanges.length * tailPercent / 100));
      await writeFile(recentTurnsFile, exchanges.slice(-tailCount).join('\n\n---\n\n') + '\n');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Error reading history for compaction tailing', { module: 'compaction', op: 'setupContext', sessionId: sessionId.substring(0, 8), err: err.message });
      }
      /* expected for ENOENT: no conversation history file yet */
      await writeFile(recentTurnsFile, '(No conversation history available)\n');
    }
    const durationMs = Math.round(performance.now() - contextStart);
    logger.info('Pipeline context built', { module: 'compaction', durationMs, sessionId: sessionId.substring(0, 8) });
    return recentTurnsFile;
  }

  async function runPrepPhase({ tmuxSession, planCopyPath, maxPrepTurns, pollInterval, captureLines, promptPattern, checkerState, projectPath, checkerModel, verbose, sessionId, agentJsonlFile }) {
    logger.info('Compaction PHASE 1 (PREP) starting', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
    const phaseStart = performance.now();
    const waitForPromptTimeoutMs = config.get('compaction.waitForPromptTimeoutMs', 120000);

    const sendCtx = { checkerState, projectPath, checkerModel, verbose, sessionId };
    const waitCtx = { tmuxSession, pollInterval, captureLines, promptPattern, sessionId };

    const prepPrompt = config.getPrompt('compaction-prep', {});
    if (!prepPrompt) {
      logger.warn('Required prompt template missing: compaction-prep', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
    }

    let checkerResponse = await sendToChecker({ message: prepPrompt, ...sendCtx });

    if (checkerResponse === null) {
      logger.warn('Checker unavailable during init — proceeding without checker', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
    } else {
      const command = parseBlueprint(checkerResponse, sessionId, verbose);
      if (command !== 'ready_to_connect') {
        logger.info('Compaction PHASE 1 (PREP) complete', { module: 'compaction', durationMs: Math.round(performance.now() - phaseStart), sessionId: sessionId.substring(0, 8), result: 'checker_init_failed' });
        return { success: false, reason: 'checker failed to initialize' };
      }
    }

    const prepToAgentPrompt = config.getPrompt('compaction-prep-to-agent', {}).trim();
    await safe.tmuxSendKeysAsync(tmuxSession, prepToAgentPrompt);
    if (checkerResponse !== null) {
      await sendToChecker({ message: 'This is Blueprint. You are now connected to the agent.', ...sendCtx });
    }

    let prepDone = false;
    for (let turn = 1; turn <= maxPrepTurns; turn++) {
      const agentOutput = await waitForPrompt({ ...waitCtx, timeoutMs: waitForPromptTimeoutMs });
      if (agentOutput === null) {
        logger.info('Compaction PHASE 1 (PREP) complete', { module: 'compaction', durationMs: Math.round(performance.now() - phaseStart), sessionId: sessionId.substring(0, 8), result: 'tmux_died' });
        return { success: false, reason: 'tmux session died during prep' };
      }

      const latestText = (await readLatestAssistantText(agentJsonlFile, sessionId)) ?? agentOutput;
      checkerResponse = await sendToChecker({ message: latestText, ...sendCtx });
      if (checkerResponse === null) break;

      let command = parseBlueprint(checkerResponse, sessionId, verbose);
      if (command === 'error') {
        logger.info('Compaction PHASE 1 (PREP) complete', { module: 'compaction', durationMs: Math.round(performance.now() - phaseStart), sessionId: sessionId.substring(0, 8), result: 'checker_error' });
        return { success: false, reason: 'checker signaled error' };
      }

      if (command === 'read_plan_file') {
        checkerResponse = await sendToChecker({
          message: planCopyPath
            ? `Blueprint: The plan file has been copied to ${planCopyPath}. Please Read that file.`
            : 'Blueprint: The plan file does not exist yet. Wait until exit_plan_mode.',
          ...sendCtx,
        });
        if (checkerResponse !== null) {
          command = parseBlueprint(checkerResponse, sessionId, verbose);
        } else {
          continue;
        }
      }

      if (command === 'exit_plan_mode') {
        await safe.tmuxSendKeyAsync(tmuxSession, 'BTab');
        const planExitSleepMs = config.get('compaction.planExitSleepMs', 2000);
        await sleep(planExitSleepMs);
        await waitForPrompt({ ...waitCtx, timeoutMs: 30000 });
        const gitCommitPrompt = config.getPrompt('compaction-git-commit', {}).trim();
        await safe.tmuxSendKeysAsync(tmuxSession, gitCommitPrompt);
        const gitOutput = await waitForPrompt({ ...waitCtx, timeoutMs: waitForPromptTimeoutMs });
        if (gitOutput) {
          const gitText = (await readLatestAssistantText(agentJsonlFile, sessionId)) ?? gitOutput;
          await sendToChecker({ message: gitText, ...sendCtx });
        }
        continue;
      }

      if (command === 'ready_to_compact') { prepDone = true; break; }

      const agentMessage = extractAgentMessage(checkerResponse);
      if (agentMessage) await safe.tmuxSendKeysAsync(tmuxSession, agentMessage);
    }

    logger.info('Compaction PHASE 1 (PREP) complete', { module: 'compaction', durationMs: Math.round(performance.now() - phaseStart), sessionId: sessionId.substring(0, 8), prepDone, result: prepDone ? 'success' : 'max_turns_reached' });
    return { success: true, prepDone };
  }

  async function runCompactPhase({ tmuxSession, pollInterval, captureLines, promptPattern, compactionTimeoutMs, verbose, sessionId }) {
    logger.info('Compaction PHASE 2 (COMPACT) starting', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
    const phaseStart = performance.now();
    const progressLogIntervalMs = config.get('compaction.progressLogIntervalMs', 60000);

    try {
      await safe.tmuxSendKeysAsync(tmuxSession, '/compact');
    } catch (err) {
      logger.error('Failed to send /compact command', { module: 'compaction', op: 'runCompactPhase', sessionId: sessionId.substring(0, 8), err: err.message });
      logger.info('Compaction PHASE 2 (COMPACT) complete', { module: 'compaction', durationMs: Math.round(performance.now() - phaseStart), sessionId: sessionId.substring(0, 8), result: 'send_failed' });
      return { success: false, reason: 'failed to send /compact' };
    }

    const compactDeadline = Date.now() + compactionTimeoutMs;
    let compactionDone = false;
    let lastCompactionOutput = '';
    let lastProgressLog = performance.now();

    while (Date.now() < compactDeadline) {
      await sleep(pollInterval);

      const elapsed = performance.now() - phaseStart;
      if (elapsed - (lastProgressLog - phaseStart) >= progressLogIntervalMs) {
        logger.info('Compact phase still waiting', { module: 'compaction', sessionId: sessionId.substring(0, 8), elapsedMs: Math.round(elapsed) });
        lastProgressLog = performance.now();
      }

      try {
        const output = stripAnsi(await capturePaneAsync(tmuxSession, captureLines));
        const lines = output.split('\n').filter(l => l.trim());
        if (lines.slice(-4).some(l => promptPattern.test(l)) && output !== lastCompactionOutput && lastCompactionOutput !== '') {
          compactionDone = true;
          break;
        }
        lastCompactionOutput = output;
      } catch (err) {
        if (err.code === 'ENOENT') break; /* expected: capture target gone */
        if (!(await tmuxExists(tmuxSession))) break;
        logger.error('Capture error during compact phase', { module: 'compaction', op: 'runCompactPhase', sessionId: sessionId.substring(0, 8), err: err.message });
      }
    }

    const alive = await tmuxExists(tmuxSession);
    logger.info('Compaction PHASE 2 (COMPACT) complete', { module: 'compaction', durationMs: Math.round(performance.now() - phaseStart), sessionId: sessionId.substring(0, 8), compactionDone, sessionAlive: alive });
    return { success: alive, compactionDone };
  }

  async function runRecoveryPhase({ tmuxSession, recentTurnsFile, maxRecoveryTurns, pollInterval, captureLines, promptPattern, checkerState, projectPath, checkerModel, verbose, sessionId, agentJsonlFile }) {
    logger.info('Compaction PHASE 3 (RECOVERY) starting', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
    const phaseStart = performance.now();
    const waitForPromptTimeoutMs = config.get('compaction.waitForPromptTimeoutMs', 120000);

    const sendCtx = { checkerState, projectPath, checkerModel, verbose, sessionId };
    const waitCtx = { tmuxSession, pollInterval, captureLines, promptPattern, sessionId };

    await sendToChecker({ message: `This is Blueprint. Compaction is complete. The conversation tail file is at ${recentTurnsFile}.`, ...sendCtx });

    const resumePrompt = config.getPrompt('compaction-resume', { CONVERSATION_TAIL_FILE: recentTurnsFile }).trim();
    if (!resumePrompt) {
      logger.warn('Required prompt template missing: compaction-resume', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
    }
    await safe.tmuxSendKeysAsync(tmuxSession, resumePrompt);

    let resumeComplete = false;
    let turnsUsed = 0;

    for (let turn = 1; turn <= maxRecoveryTurns; turn++) {
      turnsUsed = turn;
      const agentOutput = await waitForPrompt({ ...waitCtx, timeoutMs: waitForPromptTimeoutMs });
      if (agentOutput === null) break;
      const latestText = (await readLatestAssistantText(agentJsonlFile, sessionId)) ?? agentOutput;
      const checkerResponse = await sendToChecker({ message: latestText, ...sendCtx });
      if (checkerResponse === null) break;
      if (parseBlueprint(checkerResponse, sessionId, verbose) === 'resume_complete') {
        resumeComplete = true;
        break;
      }
      const agentMessage = extractAgentMessage(checkerResponse);
      if (agentMessage) await safe.tmuxSendKeysAsync(tmuxSession, agentMessage);
    }

    logger.info('Compaction PHASE 3 (RECOVERY) complete', { module: 'compaction', durationMs: Math.round(performance.now() - phaseStart), sessionId: sessionId.substring(0, 8), resumeComplete, turnsUsed });
  }

  // ── Orchestration sub-functions ───────────────────────────────────────────────

  async function enterPlanMode({ tmuxSession, pollInterval, captureLines, verbose, sessionId }) {
    let baselineOutput = '';
    try {
      baselineOutput = stripAnsi(await capturePaneAsync(tmuxSession, captureLines));
    } catch (err) {
      logger.debug('Initial capture error', { module: 'compaction', op: 'enterPlanMode', err: err.message });
    }

    await safe.tmuxSendKeysAsync(tmuxSession, '/plan');
    const planModeTimeoutMs = config.get('compaction.planModeTimeoutMs', 30000);
    const planModeDeadline = Date.now() + planModeTimeoutMs;
    let planModeActive = false;
    while (Date.now() < planModeDeadline) {
      await sleep(pollInterval);
      try {
        if (stripAnsi(await capturePaneAsync(tmuxSession, captureLines)) !== baselineOutput) {
          planModeActive = true;
          break;
        }
      } catch (err) {
        logger.debug('Polling capture error', { module: 'compaction', op: 'enterPlanMode', err: err.message });
      }
    }

    if (verbose) logger.info('Plan Mode Invocation outcome', { module: 'compaction', planModeActive, sessionId: sessionId.substring(0, 8) });
    return planModeActive;
  }

  async function copyPlanFile({ sessionId, projectPath, verbose }) {
    let planCopyPath = null;
    try {
      const slug = await sessionUtils.getSessionSlug(sessionId, projectPath);
      if (slug) {
        planCopyPath = join(db.DATA_DIR, 'compaction', `plan_${sessionId.substring(0, 8)}.md`);
        await copyFile(join(sessionUtils.CLAUDE_HOME, 'plans', `${slug}.md`), planCopyPath);
        if (verbose) logger.info('Plan file localized', { module: 'compaction', planCopyPath, sessionId: sessionId.substring(0, 8) });
      }
    } catch (err) {
      planCopyPath = null;
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to copy plan file', { module: 'compaction', op: 'copyPlanFile', sessionId: sessionId.substring(0, 8), err: err.message });
      }
      /* expected for ENOENT: plan file does not exist */
    }
    return planCopyPath;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function deleteCompactionState(tmuxSession) {
    compactionState.delete(tmuxSession);
  }

  async function runSmartCompaction(sessionId, project) {
    const tmuxSession = tmuxName(sessionId);
    if (compactionLocks.has(tmuxSession)) {
      logger.info('Session already compacting — skipping', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
      return { compacted: false, reason: 'compaction already in progress' };
    }
    compactionLocks.add(tmuxSession);
    try {
      return await orchestrateCompaction(sessionId, project);
    } finally {
      compactionLocks.delete(tmuxSession);
    }
  }

  async function checkCompactionNeeds(sessionId, project) {
    if (sessionId.startsWith('new_')) return;
    try {
      const dbProj = db.getProject(project);
      const projectPath = dbProj ? dbProj.path : safe.resolveProjectPath(project);
      const usage = await sessionUtils.getTokenUsage(sessionId, projectPath);
      const pct = usage.max_tokens > 0 ? (usage.input_tokens / usage.max_tokens) * 100 : 0;
      const tmuxSession = tmuxName(sessionId);

      if (!compactionState.has(tmuxSession)) {
        if (compactionState.size >= MAX_COMPACTION_ENTRIES) {
          let evicted = false;
          for (const key of compactionState.keys()) {
            if (!compactionLocks.has(key)) {
              compactionState.delete(key);
              evicted = true;
              break;
            }
          }
          if (!evicted) {
            logger.warn('Compaction state full and all locked, skipping monitor', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
            return;
          }
        }
        compactionState.set(tmuxSession, { nudged65: false, nudged75: false, nudged85: false, autoTriggered: false });
      }
      const state = compactionState.get(tmuxSession);

      if (!(await tmuxExists(tmuxSession))) return;

      const thresholds = config.get('compaction.thresholds', { advisory: 65, warning: 75, urgent: 85, auto: 90 });

      if (pct >= thresholds.auto && !state.autoTriggered) {
        state.autoTriggered = true;
        logger.info('AUTO COMPACTING session', { module: 'compaction', sessionId: sessionId.substring(0, 8), pct: pct.toFixed(0) });

        try {
          await safe.tmuxSendKeysAsync(tmuxSession, config.getPrompt('compaction-auto', { PERCENT: pct.toFixed(0) }));
        } catch (err) {
          logger.warn('Failed to send auto nudge keys', { module: 'compaction', op: 'checkCompactionNeeds', sessionId: sessionId.substring(0, 8), err: err.message });
        }

        const autoCompactionTimer = setTimeout(() => {
          if (!db.getProject(project)) {
            logger.info('Project deleted before auto-compaction ran', { module: 'compaction' });
            return;
          }
          runSmartCompaction(sessionId, project).catch(err => {
            logger.error('Auto-compaction failed', { module: 'compaction', op: 'checkCompactionNeeds', sessionId: sessionId.substring(0, 8), err: err.message });
          });
        }, config.get('compaction.pollIntervalMs', 3000));
        autoCompactionTimer.unref();
      } else if (pct >= thresholds.urgent && !state.nudged85) {
        state.nudged85 = true;
        await safe.tmuxSendKeysAsync(tmuxSession, config.getPrompt('compaction-nudge-urgent', { PERCENT: pct.toFixed(0), AUTO_THRESHOLD: thresholds.auto }));
      } else if (pct >= thresholds.warning && !state.nudged75) {
        state.nudged75 = true;
        await safe.tmuxSendKeysAsync(tmuxSession, config.getPrompt('compaction-nudge-warning', { PERCENT: pct.toFixed(0) }));
      } else if (pct >= thresholds.advisory && !state.nudged65) {
        state.nudged65 = true;
        await safe.tmuxSendKeysAsync(tmuxSession, config.getPrompt('compaction-nudge-advisory', { PERCENT: pct.toFixed(0) }));
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.debug('Session JSONL not found yet', { module: 'compaction', sessionId: sessionId.substring(0, 8) });
        /* expected: JSONL not created yet for new sessions */
        return;
      }
      logger.error('checkCompactionNeeds failed', { module: 'compaction', op: 'checkCompactionNeeds', sessionId: sessionId.substring(0, 8), err: err.message });
    }
  }

  // ── Orchestration ─────────────────────────────────────────────────────────────

  async function orchestrateCompaction(sessionId, project) {
    const dbProj = db.getProject(project);
    const projectPath = dbProj ? dbProj.path : safe.resolveProjectPath(project);
    if (sessionId.startsWith('new_')) return { compacted: false, reason: 'temp session not yet resolved' };
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(sessionId)) throw new Error('Invalid session ID format');

    const tmuxSession = tmuxName(sessionId);
    if (!(await tmuxExists(tmuxSession))) return { compacted: false, reason: 'session not running' };

    const verbose = config.get('compaction.verbose', false);
    logger.info('Starting smart compaction', { module: 'compaction', sessionId: sessionId.substring(0, 8), project });
    const pipelineStart = performance.now();

    const pollInterval = config.get('compaction.pollIntervalMs', 3000);
    const captureLines = config.get('compaction.tmuxCaptureLines', 50);
    const maxPrepTurns = config.get('compaction.maxPrepTurns', 10);
    const maxRecoveryTurns = config.get('compaction.maxRecoveryTurns', 6);
    const checkerModel = config.get('compaction.checkerModel', 'claude-haiku');
    const tailPercent = config.get('compaction.tailPercent', 20);
    const compactionTimeoutMs = config.get('compaction.timeoutMs', 300000);
    const contextCleanupDelayMs = config.get('compaction.contextCleanupDelayMs', 60000);
    const promptPattern = new RegExp(config.get('compaction.promptPattern', '^\\s*❯\\s*$'));
    const agentJsonlFile = join(safe.findSessionsDir(projectPath), `${sessionId}.jsonl`);
    const checkerState = { sessionId: null };

    const planModeActive = await enterPlanMode({ tmuxSession, pollInterval, captureLines, verbose, sessionId });
    if (!planModeActive) return { compacted: false, reason: 'failed to enter plan mode' };

    const planCopyPath = await copyPlanFile({ sessionId, projectPath, verbose });

    const recentTurnsFile = await setupContext({ agentJsonlFile, tailPercent, verbose, sessionId });

    const sharedCtx = { tmuxSession, pollInterval, captureLines, promptPattern, checkerState, projectPath, checkerModel, verbose, sessionId, agentJsonlFile };

    const prepResult = await runPrepPhase({ ...sharedCtx, planCopyPath, maxPrepTurns });
    if (!prepResult.success) return { compacted: false, reason: prepResult.reason };

    const compactResult = await runCompactPhase({ tmuxSession, pollInterval, captureLines, promptPattern, compactionTimeoutMs, verbose, sessionId });
    if (!compactResult.success) return { compacted: false, reason: 'session died during compaction' };

    await runRecoveryPhase({ ...sharedCtx, recentTurnsFile, maxRecoveryTurns });

    const cleanupTimer = setTimeout(() => {
      unlink(recentTurnsFile).catch(err => {
        if (err.code !== 'ENOENT') logger.warn('Could not remove recent_turns file', { module: 'compaction', sessionId: sessionId.substring(0, 8), err: err.message });
        /* expected for ENOENT: file already cleaned up */
      });
    }, contextCleanupDelayMs);
    cleanupTimer.unref();

    logger.info('Smart compaction complete', { module: 'compaction', sessionId: sessionId.substring(0, 8), totalDurationMs: Math.round(performance.now() - pipelineStart) });
    return {
      compacted: true,
      prep_completed: prepResult.prepDone,
      compaction_completed: compactResult.compactionDone,
      tail_file: recentTurnsFile,
    };
  }

  return {
    runSmartCompaction,
    checkCompactionNeeds,
    deleteCompactionState,
    __getCompactionState: () => compactionState,
    __getCompactionLocks: () => compactionLocks,
    __stripAnsi: stripAnsi,
    __parseBlueprint: parseBlueprint,
    __extractAgentMessage: extractAgentMessage,
  };
};
