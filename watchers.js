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
  tmuxName,
  tmuxExists,
  CLAUDE_HOME,
  logger,
}) {
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
            // Simple 75% nudge — replaces smart compaction
            const pct = usage.max_tokens > 0 ? (usage.input_tokens / usage.max_tokens) * 100 : 0;
            checkContextUsage(entry.sessionId, pct);
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

  // Simple context usage nudge — fires once per session at 75%
  const nudgeSent = new Set();
  function checkContextUsage(sessionId, pct) {
    if (nudgeSent.has(sessionId)) return;
    const threshold = config.get('session.nudgeThresholdPercent', 75);
    if (pct >= threshold) {
      nudgeSent.add(sessionId);
      const tmux = tmuxName(sessionId);
      tmuxExists(tmux).then(exists => {
        if (exists) {
          safe.tmuxSendKeysAsync(tmux, config.getPrompt('session-nudge', { PERCENT: pct.toFixed(0) }));
        }
      });
    }
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
    const isStale = existing && (
      !existing.command ||
      (existing.args && existing.args[0] !== expectedArgs[0]) ||
      (existing.env && 'BLUEPRINT_PORT' in existing.env)
    );

    if (!existing || isStale) {
      cfg.mcpServers.blueprint = {
        command: 'node',
        args: expectedArgs,
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

  async function registerGeminiMcp() {
    const HOME = safe.HOME;
    const geminiSettingsFile = join(HOME, '.gemini', 'settings.json');
    let cfg = {};
    try {
      cfg = JSON.parse(await fsp.readFile(geminiSettingsFile, 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) {
        logger.warn('Failed to read Gemini settings.json', { module: 'watchers', err: err.message });
      }
    }

    if (!cfg.mcpServers) cfg.mcpServers = {};
    const expectedArgs = [join(__dirname, 'mcp-server.js')];
    const existing = cfg.mcpServers.blueprint;
    const isStale = existing && (
      !existing.command ||
      (existing.args && existing.args[0] !== expectedArgs[0]) ||
      (existing.env && 'BLUEPRINT_PORT' in existing.env)
    );

    if (!existing || isStale) {
      cfg.mcpServers.blueprint = {
        command: 'node',
        args: expectedArgs,
      };
      try {
        await fsp.mkdir(join(HOME, '.gemini'), { recursive: true });
        await fsp.writeFile(geminiSettingsFile, JSON.stringify(cfg, null, 2));
        logger.info('Registered Blueprint MCP server for Gemini', { module: 'watchers' });
      } catch (err) {
        logger.error('Could not write Gemini MCP config', { module: 'watchers', err: err.message });
      }
    }
  }

  async function registerCodexMcp() {
    const HOME = safe.HOME;
    const codexConfigFile = join(HOME, '.codex', 'config.toml');
    try {
      let content = '';
      try {
        content = await fsp.readFile(codexConfigFile, 'utf-8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      // #188: previously this branch also tried to migrate an old
      // [mcp_servers.blueprint.env]/BLUEPRINT_PORT block away with a regex
      // that ate too much and corrupted the file. The migration is now dead
      // weight (any persistent-/data host has either already migrated or
      // already been corrupted), so just check-and-append.
      if (content.includes('[mcp_servers.blueprint]')) return;

      const mcpConfig = `\n[mcp_servers.blueprint]\ncommand = "node"\nargs = ["${join(__dirname, 'mcp-server.js')}"]\n`;
      await fsp.mkdir(join(HOME, '.codex'), { recursive: true });
      await fsp.appendFile(codexConfigFile, mcpConfig);
      logger.info('Registered Blueprint MCP server for Codex', { module: 'watchers' });
    } catch (err) {
      logger.error('Could not write Codex MCP config', { module: 'watchers', err: err.message });
    }
  }

  // #204: mirror of trustProjectDirs but for Codex. Codex stores trusted
  // directories in /data/.codex/config.toml as `[projects."<exact-path>"]`
  // blocks with `trust_level = "trusted"`. Trust is per-exact-path (NOT
  // recursive), so trusting /data/workspace doesn't trust subdirectories —
  // every Blueprint project needs its own block. Without this, spawning a
  // Codex session in a project that's never been opened in Codex before
  // pops up a trust dialog and blocks the test/automation.
  async function trustCodexProjectDirs() {
    const HOME = safe.HOME;
    const codexConfigFile = join(HOME, '.codex', 'config.toml');
    let content = '';
    try {
      content = await fsp.readFile(codexConfigFile, 'utf-8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Failed to read codex config.toml', { module: 'watchers', op: 'trustCodexProjectDirs', err: err.message });
        return;
      }
      /* expected: first run — file does not exist yet, will be created */
    }

    let appended = '';
    for (const project of db.getProjects()) {
      const p = project.path;
      // Match `[projects."<p>"]` literally — TOML keys are exact strings.
      const blockMarker = `[projects."${p}"]`;
      if (content.includes(blockMarker)) continue;
      appended += `\n${blockMarker}\ntrust_level = "trusted"\n`;
    }
    if (!appended) return;
    try {
      await fsp.mkdir(join(HOME, '.codex'), { recursive: true });
      await fsp.appendFile(codexConfigFile, appended);
      logger.info('Trusted Codex project directories', { module: 'watchers', count: appended.split('\n').filter(l => l.startsWith('[projects.')).length });
    } catch (err) {
      logger.error('Failed to update codex trust', { module: 'watchers', op: 'trustCodexProjectDirs', err: err.message });
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
    registerMcpServer,
    registerGeminiMcp,
    registerCodexMcp,
    trustProjectDirs,
    trustCodexProjectDirs,
    ensureSettings,
  };
};
