'use strict';

const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { join } = require('path');

const logger = require('./logger');
const sharedState = require('./shared-state');
const db = require('./db');
const safe = require('./safe-exec');
const config = require('./config');
const sessionUtils = require('./session-utils');
const { fireEvent } = require('./webhooks');

const createKeepalive = require('./keepalive');
const createTmuxLifecycle = require('./tmux-lifecycle');
const createSessionResolver = require('./session-resolver');
const createWatchers = require('./watchers');
const createWsTerminal = require('./ws-terminal');
const registerCoreRoutes = require('./routes');
const { handleVoiceConnection } = require('./voice');

// ── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;
const CLAUDE_HOME = safe.CLAUDE_HOME;
const WORKSPACE = safe.WORKSPACE;
const MAX_TMUX_SESSIONS = parseInt(process.env.MAX_TMUX_SESSIONS || '5', 10);
const TMUX_CLEANUP_DELAY = parseInt(process.env.TMUX_CLEANUP_MINUTES || '30', 10) * 60 * 1000;

// ── Global error handlers ───────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting', {
    module: 'server',
    err: err.message,
    stack: err.stack ? err.stack.substring(0, 500) : undefined,
  });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    module: 'server',
    err: reason instanceof Error ? reason.message : String(reason),
  });
});

// ── Construct modules with explicit deps ────────────────────────────────────

const keepalive = createKeepalive({ safe, config, logger });

const tmux = createTmuxLifecycle({ safe, MAX_TMUX_SESSIONS, TMUX_CLEANUP_DELAY, logger });

const resolver = createSessionResolver({
  db,
  safe,
  config,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  sleep: tmux.sleep,
  logger,
});

const watchers = createWatchers({
  db,
  safe,
  config,
  sessionUtils,
  sessionWsClients: sharedState.sessionWsClients,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  CLAUDE_HOME,
  logger,
});

const terminal = createWsTerminal({
  safe,
  keepalive,
  logger,
  config,
  sessionWsClients: sharedState.sessionWsClients,
  getBrowserCount: sharedState.getBrowserCount,
  incrementBrowserCount: sharedState.incrementBrowserCount,
  decrementBrowserCount: sharedState.decrementBrowserCount,
  tmuxExists: tmux.tmuxExists,
  cancelTmuxCleanup: tmux.cancelTmuxCleanup,
  scheduleTmuxCleanup: tmux.scheduleTmuxCleanup,
  startJsonlWatcher: watchers.startJsonlWatcher,
  stopJsonlWatcher: watchers.stopJsonlWatcher,
});

// Smart compaction removed — no kill callback needed

// ── Express setup ───────────────────────────────────────────────────────────

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const voiceWss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(join(__dirname, 'public')));
app.use('/lib/xterm', express.static(join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/lib/xterm-fit', express.static(join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use(
  '/lib/xterm-web-links',
  express.static(join(__dirname, 'node_modules/@xterm/addon-web-links')),
);
app.use('/lib/jqueryfiletree', express.static(join(__dirname, 'node_modules/jqueryfiletree/dist')));
app.use('/lib/jquery', express.static(join(__dirname, 'node_modules/jquery/dist')));

// ── Route registration ──────────────────────────────────────────────────────

const { checkAuthStatus } = registerCoreRoutes(app, {
  db,
  safe,
  config,
  sessionUtils,
  keepalive,
  fireEvent,
  logger,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  enforceTmuxLimit: tmux.enforceTmuxLimit,
  resolveSessionId: resolver.resolveSessionId,
  getBrowserCount: sharedState.getBrowserCount,
  CLAUDE_HOME,
  WORKSPACE,
  ensureSettings: watchers.ensureSettings,
  sleep: tmux.sleep,
});

// ── WebSocket upgrade handler ───────────────────────────────────────────────

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/ws/voice') {
    voiceWss.handleUpgrade(req, socket, head, (ws) => {
      handleVoiceConnection(ws);
    });
    return;
  }

  const match = url.pathname.match(/^\/ws\/(.+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => terminal.handleTerminalConnection(ws, match[1]));
}

server.on('upgrade', handleUpgrade);

// ── Exports for testing ─────────────────────────────────────────────────────

module.exports = {
  parseSessionFile: sessionUtils.parseSessionFile,
  checkAuthStatus,
  tmuxName: tmux.tmuxName,
  tmuxExists: tmux.tmuxExists,
  sleep: tmux.sleep,
};

// ── Startup sequence ────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    try {
      await config.init();
      await watchers.ensureSettings();

      await tmux.cleanOrphanedTmuxSessions();
      // Bridge file cleanup removed — messaging replaced by tmux (#51)

      resolver.resolveStaleNewSessions().catch((err) =>
        logger.error('Startup stale-session resolution error', {
          module: 'server',
          err: err.message,
        }),
      );

      server.listen(PORT, '0.0.0.0', () => {
        logger.info('Blueprint running', { module: 'server', port: PORT });
        keepalive.start();
        watchers.startSettingsWatcher();

        watchers.registerMcpServer().catch((err) =>
          logger.error('Post-startup MCP registration failed', {
            module: 'server',
            err: err.message,
          }),
        );
        watchers.trustProjectDirs().catch((err) =>
          logger.error('Post-startup trust project dirs failed', {
            module: 'server',
            err: err.message,
          }),
        );
      });
    } catch (err) {
      logger.error('Fatal startup error', {
        module: 'server',
        err: err.message,
        stack: err.stack ? err.stack.substring(0, 500) : undefined,
      });
      process.exit(1);
    }
  })();
}
