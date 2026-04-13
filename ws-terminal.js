'use strict';

const ptyDefault = require('node-pty');

module.exports = function createWsTerminal({
  safe,
  keepalive,
  logger,
  config,
  sessionWsClients,
  getBrowserCount: _getBrowserCount,
  incrementBrowserCount,
  decrementBrowserCount,
  tmuxExists,
  cancelTmuxCleanup,
  scheduleTmuxCleanup,
  startJsonlWatcher,
  stopJsonlWatcher,
  spawnPty,
}) {
  const highWater = config ? config.get('ws.bufferHighWaterMark', 1048576) : 1048576;
  const lowWater = config ? config.get('ws.bufferLowWaterMark', 524288) : 524288;
  const pingIntervalMs = config ? config.get('ws.pingIntervalMs', 30000) : 30000;
  const ptySpawn = spawnPty || ptyDefault.spawn;

  async function handleTerminalConnection(ws, tmuxSession) {
    tmuxSession = safe.sanitizeTmuxName(tmuxSession);

    if (!(await tmuxExists(tmuxSession))) {
      ws.send(JSON.stringify({ type: 'error', message: `No tmux session: ${tmuxSession}` }));
      ws.close();
      return;
    }

    // NOTE: node-pty.spawn() is synchronous by design (native addon fork).
    // This is the standard pattern used by VS Code terminal, xterm.js, and all
    // major Node.js terminal emulators. The spawn is fast (fork+exec) and does
    // not block the event loop for meaningful durations.
    // TODO(async): ERQ-001 §4.1 — if a non-blocking PTY library becomes available, migrate.
    let ptyProcess;
    try {
      ptyProcess = ptySpawn('tmux', ['attach-session', '-t', tmuxSession], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      logger.error('Failed to spawn PTY process', {
        module: 'ws-terminal',
        op: 'handleTerminalConnection',
        tmuxSession,
        err: err.message,
      });
      ws.close();
      return;
    }

    const browserCount = incrementBrowserCount();
    keepalive.onBrowserConnect();
    cancelTmuxCleanup(tmuxSession);
    logger.info('PTY attached to tmux session', {
      module: 'ws-terminal',
      tmuxSession,
      pid: ptyProcess.pid,
      browsers: browserCount,
    });

    sessionWsClients.set(tmuxSession, ws);
    startJsonlWatcher(tmuxSession);

    let isPaused = false;
    let checkBufferInterval = null;
    ws.isAlive = true;

    ptyProcess.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        if (ws.bufferedAmount > highWater && !isPaused) {
          isPaused = true;
          ptyProcess.pause();
          checkBufferInterval = setInterval(() => {
            if (ws.bufferedAmount < lowWater) {
              ptyProcess.resume();
              isPaused = false;
              clearInterval(checkBufferInterval);
              checkBufferInterval = null;
            } else if (ws.readyState !== ws.OPEN) {
              clearInterval(checkBufferInterval);
              checkBufferInterval = null;
            }
          }, 100);
        }
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      logger.info('PTY exited', { module: 'ws-terminal', tmuxSession, exitCode });
      if (ws.readyState === ws.OPEN) {
        ws.send('\r\n\x1b[33m[Session detached]\x1b[0m\r\n');
        ws.close();
      }
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg.startsWith('{')) {
        try {
          const ctrl = JSON.parse(msg);
          if (
            ctrl.type === 'resize' &&
            typeof ctrl.cols === 'number' &&
            typeof ctrl.rows === 'number'
          ) {
            ptyProcess.resize(ctrl.cols, ctrl.rows);
            return;
          }
          if (ctrl.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
          }
        } catch (_parseErr) {
          /* expected: not all messages starting with '{' are valid JSON control frames */
          logger.debug('Non-JSON-control message received', { module: 'ws-terminal', tmuxSession });
        }
      }
      try {
        ptyProcess.write(msg);
      } catch (err) {
        logger.error('Failed to write to PTY', {
          module: 'ws-terminal',
          op: 'ws.on(message)',
          tmuxSession,
          err: err.message,
        });
      }
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const pingInterval = setInterval(() => {
      if (ws.isAlive === false) {
        logger.info('WebSocket connection timeout — closing', {
          module: 'ws-terminal',
          tmuxSession,
        });
        return ws.terminate();
      }
      ws.isAlive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, pingIntervalMs);

    ws.on('close', () => {
      clearInterval(pingInterval);
      if (checkBufferInterval) clearInterval(checkBufferInterval);
      const remaining = decrementBrowserCount();
      keepalive.onBrowserDisconnect(remaining);
      logger.info('Browser disconnected from tmux', {
        module: 'ws-terminal',
        tmuxSession,
        browsers: remaining,
      });
      if (ptyProcess) ptyProcess.kill();
      sessionWsClients.delete(tmuxSession);
      stopJsonlWatcher(tmuxSession);
      scheduleTmuxCleanup(tmuxSession);
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', {
        module: 'ws-terminal',
        op: 'ws.on(error)',
        tmuxSession,
        err: err.message,
      });
      if (ptyProcess) ptyProcess.kill();
    });
  }

  return { handleTerminalConnection };
};
