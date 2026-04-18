'use strict';

const { readdir, stat, unlink } = require('fs/promises');
const { join } = require('path');

module.exports = function createTmuxLifecycle({
  safe,
  MAX_TMUX_SESSIONS,
  TMUX_CLEANUP_DELAY,
  logger,
}) {
  // Track which sessions have an active browser tab (WebSocket connection)
  const activeTabs = new Set();
  let _onSessionKilled = null;
  let _scanInterval = null;

  const IDLE_WITH_TAB_MS = 8 * 60 * 60 * 1000;     // 8 hours if tab open
  const IDLE_WITHOUT_TAB_MS = 2 * 60 * 60 * 1000;   // 2 hours if tab closed
  const SCAN_INTERVAL_MS = 60 * 1000;                // check every 60 seconds

  function tmuxName(sessionId) {
    return safe.sanitizeTmuxName(`bp_${sessionId.substring(0, 12)}`);
  }

  async function tmuxExists(name) {
    return await safe.tmuxExists(name);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Track browser tab connections
  function markTabOpen(tmuxSession) {
    activeTabs.add(tmuxSession);
  }

  function markTabClosed(tmuxSession) {
    activeTabs.delete(tmuxSession);
  }

  /**
   * Periodic scan: discover all tmux sessions, enforce idle timeouts and session limit.
   */
  async function periodicScan() {
    try {
      const stdout = await safe.tmuxExecAsync([
        'list-sessions',
        '-F',
        '#{session_name} #{session_activity}',
      ]);
      const now = Math.floor(Date.now() / 1000);
      const sessions = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(' ');
          return { name: parts[0], lastActivity: parseInt(parts[1], 10) || 0 };
        });

      // Enforce idle timeouts
      for (const s of sessions) {
        const idleSeconds = now - s.lastActivity;
        const idleMs = idleSeconds * 1000;
        const hasTab = activeTabs.has(s.name);
        const threshold = hasTab ? IDLE_WITH_TAB_MS : IDLE_WITHOUT_TAB_MS;

        if (idleMs > threshold) {
          await safe.tmuxKill(s.name);
          if (typeof _onSessionKilled === 'function') _onSessionKilled(s.name);
          logger.info('Killed idle tmux session', {
            module: 'tmux-lifecycle',
            tmuxSession: s.name,
            idleHours: (idleMs / 3600000).toFixed(1),
            hadTab: hasTab,
          });
          activeTabs.delete(s.name);
        }
      }

      // Enforce session limit (kill oldest first)
      const remaining = [];
      for (const s of sessions) {
        if (await safe.tmuxExists(s.name)) remaining.push(s);
      }
      remaining.sort((a, b) => a.lastActivity - b.lastActivity);

      while (remaining.length > MAX_TMUX_SESSIONS) {
        const oldest = remaining.shift();
        await safe.tmuxKill(oldest.name);
        if (typeof _onSessionKilled === 'function') _onSessionKilled(oldest.name);
        logger.info('Killed oldest tmux session (limit enforcement)', {
          module: 'tmux-lifecycle',
          tmuxSession: oldest.name,
          totalSessions: remaining.length + 1,
          limit: MAX_TMUX_SESSIONS,
        });
        activeTabs.delete(oldest.name);
      }
    } catch (err) {
      if (
        err.message &&
        (err.message.includes('no server running') || err.message.includes('error connecting to'))
      ) {
        /* expected: no tmux server running */
      } else {
        logger.warn('periodicScan error', { module: 'tmux-lifecycle', err: err.message });
      }
    }
  }

  // Legacy: still called from ws-terminal on disconnect, but real cleanup is periodic now
  function scheduleTmuxCleanup(tmuxSession) {
    markTabClosed(tmuxSession);
  }

  function cancelTmuxCleanup(tmuxSession) {
    markTabOpen(tmuxSession);
  }

  async function enforceTmuxLimit() {
    await periodicScan();
  }

  async function cleanOrphanedTmuxSessions() {
    // On startup, don't kill everything — just run a scan
    await periodicScan();
  }

  function startPeriodicScan() {
    if (_scanInterval) return;
    _scanInterval = setInterval(() => {
      periodicScan().catch((err) =>
        logger.error('Periodic scan failed', { module: 'tmux-lifecycle', err: err.message }),
      );
    }, SCAN_INTERVAL_MS);
    _scanInterval.unref();
    logger.info('Started periodic tmux scan', {
      module: 'tmux-lifecycle',
      intervalSec: SCAN_INTERVAL_MS / 1000,
      maxSessions: MAX_TMUX_SESSIONS,
      idleWithTabHours: IDLE_WITH_TAB_MS / 3600000,
      idleWithoutTabHours: IDLE_WITHOUT_TAB_MS / 3600000,
    });
  }

  function stopPeriodicScan() {
    if (_scanInterval) {
      clearInterval(_scanInterval);
      _scanInterval = null;
    }
  }

  function setOnSessionKilled(callback) {
    _onSessionKilled = callback;
  }

  return {
    tmuxName,
    tmuxExists,
    sleep,
    scheduleTmuxCleanup,
    cancelTmuxCleanup,
    enforceTmuxLimit,
    cleanOrphanedTmuxSessions,
    startPeriodicScan,
    stopPeriodicScan,
    markTabOpen,
    markTabClosed,
    setOnSessionKilled,
  };
};
