'use strict';

const { readdir, stat, unlink } = require('fs/promises');
const { join } = require('path');

module.exports = function createTmuxLifecycle({
  safe,
  MAX_TMUX_SESSIONS,
  TMUX_CLEANUP_DELAY,
  logger,
}) {
  const tmuxCleanupTimers = new Map();
  let _onSessionKilled = null;

  function tmuxName(sessionId) {
    return safe.sanitizeTmuxName(`bp_${sessionId.substring(0, 12)}`);
  }

  async function tmuxExists(name) {
    return await safe.tmuxExists(name);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function scheduleTmuxCleanup(tmuxSession) {
    if (tmuxCleanupTimers.has(tmuxSession)) clearTimeout(tmuxCleanupTimers.get(tmuxSession));
    const timer = setTimeout(async () => {
      tmuxCleanupTimers.delete(tmuxSession);
      if (await safe.tmuxExists(tmuxSession)) {
        await safe.tmuxKill(tmuxSession);
        if (typeof _onSessionKilled === 'function') _onSessionKilled(tmuxSession);
        logger.info('Killed idle tmux session', {
          module: 'tmux-lifecycle',
          op: 'scheduleTmuxCleanup',
          tmuxSession,
        });
      }
    }, TMUX_CLEANUP_DELAY);
    tmuxCleanupTimers.set(tmuxSession, timer);
  }

  function cancelTmuxCleanup(tmuxSession) {
    if (tmuxCleanupTimers.has(tmuxSession)) {
      clearTimeout(tmuxCleanupTimers.get(tmuxSession));
      tmuxCleanupTimers.delete(tmuxSession);
    }
  }

  async function enforceTmuxLimit() {
    try {
      const stdout = await safe.tmuxExecAsync([
        'list-sessions',
        '-F',
        '#{session_name} #{session_activity}',
      ]);
      const sessions = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(' ');
          return { name: parts[0], lastActivity: parseInt(parts[1], 10) || 0 };
        })
        .filter((s) => s.name.startsWith('bp_'))
        .sort((a, b) => a.lastActivity - b.lastActivity);

      while (sessions.length > MAX_TMUX_SESSIONS) {
        const oldest = sessions.shift();
        await safe.tmuxKill(oldest.name);
        logger.info('Killed oldest tmux session (limit enforcement)', {
          module: 'tmux-lifecycle',
          tmuxSession: oldest.name,
        });
      }
    } catch (err) {
      if (
        err.message &&
        (err.message.includes('no server running') || err.message.includes('error connecting to'))
      ) {
        /* expected: no tmux server running means zero sessions — nothing to enforce */
        logger.debug('enforceTmuxLimit: tmux server not running', { module: 'tmux-lifecycle' });
      } else {
        logger.warn('enforceTmuxLimit: error enforcing limits', {
          module: 'tmux-lifecycle',
          err: err.message,
        });
      }
    }
  }

  async function cleanOrphanedTmuxSessions() {
    try {
      const stdout = await safe.tmuxExecAsync(['list-sessions', '-F', '#{session_name}']);
      const sessions = stdout.trim().split('\n').filter(Boolean);
      let cleaned = 0;
      for (const session of sessions) {
        if (session.startsWith('bp_')) {
          await safe.tmuxKill(session);
          cleaned++;
        }
      }
      if (cleaned > 0)
        logger.info('Cleaned up orphaned tmux sessions on startup', {
          module: 'tmux-lifecycle',
          count: cleaned,
        });
    } catch (err) {
      if (
        err.message &&
        (err.message.includes('no server running') || err.message.includes('error connecting to'))
      ) {
        /* expected: no tmux server means no orphans */
      } else {
        logger.warn('cleanOrphanedTmuxSessions error', {
          module: 'tmux-lifecycle',
          err: err.message,
        });
      }
    }
  }

  async function cleanBridgeFiles(bridgeDir) {
    try {
      const files = await readdir(bridgeDir);
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      let cleaned = 0;
      for (const file of files) {
        const fullPath = join(bridgeDir, file);
        try {
          const mtime = (await stat(fullPath)).mtimeMs;
          if (mtime < twoHoursAgo) {
            await unlink(fullPath);
            cleaned++;
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.debug('cleanBridgeFiles: could not stat/unlink file', {
              module: 'tmux-lifecycle',
              file,
              err: err.message,
            });
          }
          /* expected: file removed between readdir and stat */
        }
      }
      if (cleaned > 0)
        logger.info('Cleaned up old bridge files on startup', {
          module: 'tmux-lifecycle',
          count: cleaned,
        });
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: bridge directory does not exist yet on first run */
      } else {
        logger.error('cleanBridgeFiles: bridge dir read error', {
          module: 'tmux-lifecycle',
          err: err.message,
        });
      }
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
    cleanBridgeFiles,
    setOnSessionKilled,
  };
};
