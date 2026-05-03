'use strict';

const { readFile, stat } = require('fs/promises');
const { join } = require('path');

module.exports = function createKeepalive({ safe, config, logger }) {
  const WORKSPACE = safe.WORKSPACE;
  const CLAUDE_HOME = safe.CLAUDE_HOME;
  const CREDENTIALS_PATH = join(CLAUDE_HOME, '.credentials.json');

  const _REFRESH_THRESHOLD = config ? config.get('keepalive.refreshThreshold', 0.85) : 0.85;
  const CHECK_RANGE_LOW = config ? config.get('keepalive.checkRangeLow', 0.65) : 0.65;
  const CHECK_RANGE_HIGH = config ? config.get('keepalive.checkRangeHigh', 0.85) : 0.85;
  const FALLBACK_INTERVAL_MS = config
    ? config.get('keepalive.fallbackIntervalMs', 30 * 60 * 1000)
    : 30 * 60 * 1000;
  // #213: how many consecutive auth-broken failures before we suppress further
  // ERRORs and stop scheduling until creds change. 3 is enough to ride out a
  // single transient hiccup while not noise-spamming the log every 30 min.
  const AUTH_BROKEN_THRESHOLD = config ? config.get('keepalive.authBrokenThreshold', 3) : 3;
  // #213: how often to poll the credentials file mtime when in auth-broken
  // state. fs.watch would be more efficient but the credentials file lives on
  // a bind-mounted volume where inotify is unreliable.
  const CREDS_WATCH_INTERVAL_MS = config ? config.get('keepalive.credsWatchIntervalMs', 60 * 1000) : 60 * 1000;

  let mode = process.env.KEEPALIVE_MODE || 'browser';
  let idleTimeoutMs = parseInt(process.env.KEEPALIVE_IDLE_MINUTES || '30', 10) * 60 * 1000;
  let idleTimer = null;
  let running = false;
  let timer = null;
  let turn = 'a';

  // #213: auth-broken state machine. When the Claude CLI returns 401 / "Invalid
  // authentication credentials" N consecutive times, we stop spamming ERRORs
  // and stop scheduling refreshes until the user re-runs /login (which rewrites
  // ~/.claude/.credentials.json — we watch its mtime to detect that).
  let _authBrokenCount = 0;
  let _authBrokenLogged = false;
  let _authBrokenMtime = 0;
  let _credsWatchTimer = null;

  function isAuthBrokenError(err) {
    if (!err) return false;
    const haystack = `${err.message || ''}\n${err.stderr?.toString() || ''}`;
    return /\b401\b|invalid authentication|invalid_api_key|please run \/login/i.test(haystack);
  }

  async function getCredsMtimeAsync() {
    try { return (await stat(CREDENTIALS_PATH)).mtimeMs; }
    catch { return 0; }
  }

  function startCredsWatch() {
    if (_credsWatchTimer) return;
    _credsWatchTimer = setInterval(async () => {
      const mtime = await getCredsMtimeAsync();
      if (mtime && _authBrokenMtime && mtime !== _authBrokenMtime) {
        logger.info('Keepalive credentials file changed — re-enabling refresh attempts', {
          module: 'keepalive',
          oldMtime: new Date(_authBrokenMtime).toISOString(),
          newMtime: new Date(mtime).toISOString(),
        });
        _authBrokenCount = 0;
        _authBrokenLogged = false;
        _authBrokenMtime = 0;
        clearInterval(_credsWatchTimer);
        _credsWatchTimer = null;
        if (running) check();
      }
    }, CREDS_WATCH_INTERVAL_MS);
    if (typeof _credsWatchTimer.unref === 'function') _credsWatchTimer.unref();
  }

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
      // Successful query — clear any auth-broken state so we don't stay
      // suppressed after the user fixes their credentials.
      if (_authBrokenCount > 0 || _authBrokenLogged) {
        _authBrokenCount = 0;
        _authBrokenLogged = false;
        _authBrokenMtime = 0;
        if (_credsWatchTimer) { clearInterval(_credsWatchTimer); _credsWatchTimer = null; }
      }
      return result.trim();
    } catch (err) {
      // #213: distinguish auth-broken from other transient failures. After N
      // consecutive auth-broken failures, emit a single clear WARN and stop
      // logging the same ERROR every 30 minutes. The creds-watch loop will
      // re-enable us when the user re-runs /login.
      if (isAuthBrokenError(err)) {
        _authBrokenCount += 1;
        if (_authBrokenCount >= AUTH_BROKEN_THRESHOLD && !_authBrokenLogged) {
          _authBrokenLogged = true;
          _authBrokenMtime = await getCredsMtimeAsync();
          logger.warn('Keepalive disabled: OAuth credentials invalid — re-run /login. Will resume when ~/.claude/.credentials.json is updated.', {
            module: 'keepalive',
            consecutiveFailures: _authBrokenCount,
            credsMtime: _authBrokenMtime ? new Date(_authBrokenMtime).toISOString() : null,
          });
          startCredsWatch();
        } else if (!_authBrokenLogged) {
          // Below threshold — still log the ERROR so transient single hiccups
          // remain visible. Suppression only kicks in after N in a row.
          logger.error('Keepalive Claude query failed (auth)', {
            module: 'keepalive',
            consecutiveFailures: _authBrokenCount,
            err: err.message?.substring(0, 200),
          });
        }
        return null;
      }
      // Non-auth failure — keep prior logging behavior.
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
    // #213: if auth-broken state is active, stop scheduling. creds-watch will
    // call check() (which calls scheduleFromRemaining indirectly) when the
    // credentials file changes.
    if (_authBrokenLogged) return;
    if (remaining <= 0) {
      logger.info('Token expired or unreadable — refreshing now', { module: 'keepalive' });
      doRefresh().then(async () => {
        if (_authBrokenLogged) return;
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
    // #213: when auth is persistently broken, stop scheduling. The creds-watch
    // loop will call check() again once the credentials file changes.
    if (_authBrokenLogged) return;
    msUntilExpiryAsync().then((remaining) => {
      logger.info('Keepalive check — refreshing', {
        module: 'keepalive',
        remainingMin: Math.round(remaining / 60000),
      });
      doRefresh().then(() => {
        if (_authBrokenLogged) return; // entered auth-broken during the refresh
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
      if (_credsWatchTimer) {
        clearInterval(_credsWatchTimer);
        _credsWatchTimer = null;
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
