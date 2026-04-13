'use strict';

const fsp = require('fs/promises');
const fs = require('fs');
const { join, basename } = require('path');

module.exports = function createWatchers({
  db,
  safe,
  config,
  sessionUtils,
  sessionWsClients,
  checkCompactionNeeds,
  tmuxName,
  tmuxExists,
  CLAUDE_HOME,
  logger,
}) {
  const PORT = process.env.PORT || 3000;
  const jsonlWatchPaths = new Map();
  const jsonlDebounceTimers = new Map();

  function startJsonlWatcher(tmuxSession) {
    const prefix = tmuxSession.replace(/^bp_/, '');
    if (prefix.startsWith('new_') || prefix.startsWith('t_')) return;

    const session = db.getSessionByPrefix(prefix);
    if (!session) return;

    const project = db.getProjectById(session.project_id);
    if (!project) return;

    const jsonlPath = join(safe.findSessionsDir(project.path), `${session.id}.jsonl`);
    jsonlWatchPaths.set(tmuxSession, {
      jsonlPath,
      sessionId: session.id,
      projectPath: project.path,
      projectName: project.name,
    });

    fs.watchFile(jsonlPath, { persistent: false, interval: 2000 }, () => {
      const entry = jsonlWatchPaths.get(tmuxSession);
      if (!entry) return;

      if (jsonlDebounceTimers.has(tmuxSession)) clearTimeout(jsonlDebounceTimers.get(tmuxSession));
      jsonlDebounceTimers.set(
        tmuxSession,
        setTimeout(async () => {
          jsonlDebounceTimers.delete(tmuxSession);
          try {
            const usage = await sessionUtils.getTokenUsage(entry.sessionId, entry.projectPath);
            const ws = sessionWsClients.get(tmuxSession);
            if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
              ws.send(JSON.stringify({ type: 'token_update', data: usage }));
            }
            await checkCompactionNeeds(entry.sessionId, entry.projectName);
          } catch (err) {
            if (err.code === 'ENOENT') {
              logger.debug('JSONL file removed during watcher callback', {
                module: 'watchers',
                sessionId: entry.sessionId.substring(0, 8),
              });
              return;
            }
            logger.error('JSONL watcher callback error', {
              module: 'watchers',
              op: 'startJsonlWatcher',
              err: err.message,
            });
          }
        }, 500),
      );
    });
  }

  function stopJsonlWatcher(tmuxSession) {
    const entry = jsonlWatchPaths.get(tmuxSession);
    if (entry) {
      fs.unwatchFile(entry.jsonlPath);
      jsonlWatchPaths.delete(tmuxSession);
    }
    if (jsonlDebounceTimers.has(tmuxSession)) {
      clearTimeout(jsonlDebounceTimers.get(tmuxSession));
      jsonlDebounceTimers.delete(tmuxSession);
    }
  }

  let settingsWatcherActive = false;
  function startSettingsWatcher() {
    if (settingsWatcherActive) return;
    const settingsPath = join(CLAUDE_HOME, 'settings.json');
    fs.watchFile(settingsPath, { persistent: false, interval: 5000 }, async () => {
      try {
        const data = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
        const update = JSON.stringify({
          type: 'settings_update',
          model: data.model || null,
          effortLevel: data.effortLevel || null,
        });
        for (const ws of sessionWsClients.values()) {
          if (ws.readyState === 1) ws.send(update);
        }
      } catch (err) {
        if (err.code === 'ENOENT') {
          /* expected: settings file may not exist yet */
        } else if (err instanceof SyntaxError) {
          logger.warn('Settings file contains invalid JSON', {
            module: 'watchers',
            op: 'startSettingsWatcher',
          });
        } else {
          logger.error('Settings watcher error', {
            module: 'watchers',
            op: 'startSettingsWatcher',
            err: err.message,
          });
        }
      }
    });
    settingsWatcherActive = true;
  }

  let compactionMonitorInterval = null;
  function startCompactionMonitor() {
    if (compactionMonitorInterval) return;
    compactionMonitorInterval = setInterval(
      async () => {
        try {
          for (const dbProj of db.getProjects()) {
            const sessionsDir = safe.findSessionsDir(dbProj.path);
            try {
              const files = await fsp.readdir(sessionsDir);
              for (const file of files) {
                if (!file.endsWith('.jsonl')) continue;
                const sessionId = basename(file, '.jsonl');
                const tmux = tmuxName(sessionId);
                if ((await tmuxExists(tmux)) && !jsonlWatchPaths.has(tmux)) {
                  await checkCompactionNeeds(sessionId, dbProj.name);
                }
              }
            } catch (err) {
              if (err.code !== 'ENOENT') {
                logger.error('Compaction monitor error scanning sessions', {
                  module: 'watchers',
                  op: 'startCompactionMonitor',
                  err: err.message,
                });
              }
              /* expected for ENOENT: sessions dir does not exist for this project */
            }
          }
        } catch (err) {
          logger.error('Compaction monitor fatal error', {
            module: 'watchers',
            op: 'startCompactionMonitor',
            err: err.message,
          });
        }
      },
      config.get('polling.compactionMonitorIntervalMs', 300000),
    );
  }

  async function registerMcpServer() {
    const settingsFile = join(CLAUDE_HOME, 'settings.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(settingsFile, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: settings file not yet created — will be initialized */
      } else if (err instanceof SyntaxError) {
        logger.error(
          'settings.json is corrupt — cannot register MCP server without overwriting user config',
          { module: 'watchers', op: 'registerMcpServer' },
        );
        return;
      } else {
        logger.warn('Failed to read settings.json for MCP', {
          module: 'watchers',
          op: 'registerMcpServer',
          err: err.message,
        });
      }
    }

    if (!cfg.mcpServers) cfg.mcpServers = {};
    const expectedArgs = [join(__dirname, 'mcp-server.js')];
    const existing = cfg.mcpServers.blueprint;

    if (!existing || !existing.command || (existing.args && existing.args[0] !== expectedArgs[0])) {
      cfg.mcpServers.blueprint = {
        command: 'node',
        args: expectedArgs,
        env: { BLUEPRINT_PORT: String(PORT) },
      };
      try {
        await fsp.writeFile(settingsFile, JSON.stringify(cfg, null, 2));
        logger.info('Registered Blueprint MCP server', { module: 'watchers' });
      } catch (err) {
        logger.error('Could not write MCP configuration', {
          module: 'watchers',
          op: 'registerMcpServer',
          err: err.message,
        });
      }
    }
  }

  async function trustProjectDirs() {
    const configFile = join(CLAUDE_HOME, '.claude.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(configFile, 'utf-8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: first run — config file does not exist yet, will be created */
      } else if (err instanceof SyntaxError) {
        logger.error(
          '.claude.json is corrupt JSON — skipping trustProjectDirs to preserve file for inspection',
          { module: 'watchers', op: 'trustProjectDirs' },
        );
        return;
      } else {
        logger.warn('Failed to read .claude.json', {
          module: 'watchers',
          op: 'trustProjectDirs',
          err: err.message,
        });
      }
    }

    if (!cfg.projects) cfg.projects = {};
    let changed = false;
    for (const project of db.getProjects()) {
      const p = project.path;
      if (!cfg.projects[p]) cfg.projects[p] = {};
      if (!cfg.projects[p].hasTrustDialogAccepted) {
        cfg.projects[p].hasTrustDialogAccepted = true;
        cfg.projects[p].enabledMcpjsonServers = [];
        cfg.projects[p].disabledMcpjsonServers = [];
        changed = true;
      }
    }
    if (changed) {
      try {
        await fsp.writeFile(configFile, JSON.stringify(cfg, null, 2));
        logger.info('Trusted project directories', { module: 'watchers' });
      } catch (err) {
        logger.error('Failed to update trust projects', {
          module: 'watchers',
          op: 'trustProjectDirs',
          err: err.message,
        });
      }
    }
  }

  async function ensureSettings() {
    const settingsFile = join(CLAUDE_HOME, 'settings.json');
    try {
      await fsp.stat(settingsFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        try {
          await fsp.mkdir(CLAUDE_HOME, { recursive: true });
          await fsp.writeFile(
            settingsFile,
            JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2),
          );
        } catch (innerErr) {
          logger.error('Could not ensure base settings file', {
            module: 'watchers',
            op: 'ensureSettings',
            err: innerErr.message,
          });
        }
      } else {
        logger.error('Unexpected error checking settings file', {
          module: 'watchers',
          op: 'ensureSettings',
          err: err.message,
        });
      }
    }
  }

  return {
    startJsonlWatcher,
    stopJsonlWatcher,
    startSettingsWatcher,
    startCompactionMonitor,
    registerMcpServer,
    trustProjectDirs,
    ensureSettings,
  };
};
