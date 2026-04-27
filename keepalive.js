'use strict';

const { readFile } = require('fs/promises');
const { join } = require('path');

module.exports = function createKeepalive({ safe, config, logger }) {
  const WORKSPACE = safe.WORKSPACE;
  const CLAUDE_HOME = safe.CLAUDE_HOME;

  const _REFRESH_THRESHOLD = config ? config.get('keepalive.refreshThreshold', 0.85) : 0.85;
  const CHECK_RANGE_LOW = config ? config.get('keepalive.checkRangeLow', 0.65) : 0.65;
  const CHECK_RANGE_HIGH = config ? config.get('keepalive.checkRangeHigh', 0.85) : 0.85;
  const FALLBACK_INTERVAL_MS = config
    ? config.get('keepalive.fallbackIntervalMs', 30 * 60 * 1000)
    : 30 * 60 * 1000;

  let mode = process.env.KEEPALIVE_MODE || 'browser';
  let idleTimeoutMs = parseInt(process.env.KEEPALIVE_IDLE_MINUTES || '30', 10) * 60 * 1000;
  let idleTimer = null;
  let running = false;
  let timer = null;
  let turn = 'a';

  async function getTokenExpiryAsync() {
    try {
      const raw = await readFile(join(CLAUDE_HOME, '.credentials.json'), 'utf-8');
      const creds = JSON.parse(raw);
      return creds.claudeAiOauth?.expiresAt || 0;
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: credentials file may not exist yet */
      } else if (err instanceof SyntaxError) {
        logger.warn('Credentials file contains invalid JSON', { module: 'keepalive' });
      } else {
        logger.error('Failed to read credentials file', { module: 'keepalive', err: err.message });
      }
      return 0;
    }
  }

  async function msUntilExpiryAsync() {
    const expiresAt = await getTokenExpiryAsync();
    if (!expiresAt) return 0;
    return expiresAt - Date.now();
  }

  async function claudeQuery(message) {
    const queryTimeout = config ? config.get('keepalive.queryTimeoutMs', 30000) : 30000;
    try {
      const result = await safe.claudeExecAsync(
        ['--print', '--no-session-persistence', '--model', 'haiku', message],
        { cwd: WORKSPACE, timeout: queryTimeout },
      );
      return result.trim();
    } catch (err) {
      logger.error('Keepalive Claude query failed', {
        module: 'keepalive',
        err: err.message?.substring(0, 1000),
        stderr: err.stderr?.toString().substring(0, 1000),
      });
      return null;
    }
  }

  async function doRefresh() {
    try {
      const promptA = config ? config.getPrompt('keepalive-question', {}) : '';
      const promptB = config ? config.getPrompt('keepalive-fact', {}) : '';

      if (turn === 'a') {
        const q = await claudeQuery(
          promptA || 'Ask a short interesting question. Just the question.',
        );
        if (q) {
          const a = await claudeQuery(q);
          if (a)
            logger.info('Keepalive refreshed', {
              module: 'keepalive',
              q: q.substring(0, 40),
              a: a.substring(0, 40),
            });
        }
        turn = 'b';
      } else {
        const q = await claudeQuery(promptB || 'Tell me a one-sentence fun fact.');
        if (q)
          logger.info('Keepalive refreshed', { module: 'keepalive', fact: q.substring(0, 60) });
        turn = 'a';
      }
    } catch (err) {
      logger.error('Keepalive refresh error', { module: 'keepalive', err: err.message });
    }
  }

  function scheduleFromRemaining(remaining) {
    if (!running) return;
    if (remaining <= 0) {
      logger.info('Token expired or unreadable — refreshing now', { module: 'keepalive' });
      doRefresh().then(async () => {
        const newRemaining = await msUntilExpiryAsync();
        if (newRemaining > 0) {
          scheduleFromRemaining(newRemaining);
        } else {
          logger.info('Fallback keepalive interval', {
            module: 'keepalive',
            intervalMin: FALLBACK_INTERVAL_MS / 60000,
          });
          timer = setTimeout(check, FALLBACK_INTERVAL_MS);
        }
      });
      return;
    }
    const fraction = CHECK_RANGE_LOW + Math.random() * (CHECK_RANGE_HIGH - CHECK_RANGE_LOW);
    const sleepMs = Math.max(60000, remaining * fraction);
    logger.info('Keepalive next check scheduled', {
      module: 'keepalive',
      remainingMin: Math.round(remaining / 60000),
      sleepMin: Math.round(sleepMs / 60000),
    });
    timer = setTimeout(check, sleepMs);
  }

  function check() {
    if (!running) return;
    msUntilExpiryAsync().then((remaining) => {
      logger.info('Keepalive check — refreshing', {
        module: 'keepalive',
        remainingMin: Math.round(remaining / 60000),
      });
      doRefresh().then(() => {
        msUntilExpiryAsync().then((newRemaining) => {
          scheduleFromRemaining(newRemaining);
        });
      });
    });
  }

  const instance = {
    start() {
      if (running) return;
      running = true;
      msUntilExpiryAsync().then((remaining) => {
        logger.info('Keepalive started', {
          module: 'keepalive',
          mode,
          tokenExpiresMin: remaining > 0 ? Math.round(remaining / 60000) : 0,
        });
        scheduleFromRemaining(remaining);
      });
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      logger.info('Keepalive stopped', { module: 'keepalive' });
    },
    isRunning() {
      return running;
    },
    getMode() {
      return mode;
    },
    async getStatus() {
      const remaining = await msUntilExpiryAsync();
      const expiresAt = await getTokenExpiryAsync();
      return {
        running,
        mode,
        token_expires_in_minutes: remaining > 0 ? Math.round(remaining / 60000) : 0,
        token_expires_at: new Date(expiresAt).toISOString(),
      };
    },
    setMode(newMode, idleMinutes) {
      mode = newMode;
      if (idleMinutes) idleTimeoutMs = idleMinutes * 60 * 1000;
      logger.info('Keepalive mode set', {
        module: 'keepalive',
        mode,
        idleMinutes: idleMinutes || idleTimeoutMs / 60000,
      });
    },
    onBrowserConnect() {
      if (mode === 'browser' && !running) instance.start();
      if (mode === 'idle') {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (!running) instance.start();
      }
    },
    onBrowserDisconnect(remainingBrowsers) {
      if (mode === 'browser' && remainingBrowsers === 0) instance.stop();
      if (mode === 'idle' && remainingBrowsers === 0) {
        logger.info('No browsers — idle timeout starting', {
          module: 'keepalive',
          timeoutMin: idleTimeoutMs / 60000,
        });
        idleTimer = setTimeout(() => {
          logger.info('Keepalive idle timeout reached', { module: 'keepalive' });
          instance.stop();
        }, idleTimeoutMs);
      }
    },
  };

  return instance;
};
