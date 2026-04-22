'use strict';

const childProcess = require('child_process');
const { execFileSync } = childProcess;
const { writeFile: writeFileAsync, unlink: unlinkAsync } = require('fs/promises');
const { resolve, join } = require('path');
const os = require('os');
const logger = require('./logger');

function execFileAsync(cmd, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    childProcess.execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) rejectPromise(err);
      else resolvePromise({ stdout, stderr });
    });
  });
}

const HOME = process.env.HOME || '/data';
const CLAUDE_HOME = process.env.CLAUDE_HOME || join(HOME, '.claude');
const WORKSPACE = process.env.WORKSPACE || join(HOME, 'workspace');

function resolveProjectPath(project) {
  return resolve(WORKSPACE, project);
}

function sanitizeTmuxName(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function shellEscape(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Synchronous tmux exec — used internally only by functions that compose
 * multiple fast tmux commands atomically (tmuxCreateClaude, tmuxCreateBash).
 * These are sub-millisecond operations for atomic session setup.
 */
function tmuxExecSync(args, options = {}) {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 10000,
    env: process.env,
  });
}

/**
 * Async tmux exec — used by all callers in async contexts.
 */
async function tmuxExecAsync(args, options = {}) {
  const { stdout } = await execFileAsync('tmux', args, {
    encoding: 'utf-8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeout || 10000,
    env: process.env,
  });
  return stdout;
}

function claudeExecAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'claude',
      [...args],
      {
        encoding: 'utf-8',
        timeout: options.timeout || 120000,
        cwd: options.cwd || WORKSPACE,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, TERM: 'xterm-256color' },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

async function tmuxExists(name) {
  const safeName = sanitizeTmuxName(name);
  try {
    await tmuxExecAsync(['has-session', '-t', safeName]);
    return true;
  } catch (_err) {
    /* any tmux error (session not found, server not running) means session doesn't exist */
    return false;
  }
}

function tmuxCreateCLI(sessionName, cwd, cliType, args = []) {
  const safeName = sanitizeTmuxName(sessionName);
  const escapedCwd = shellEscape(cwd);

  let binary;
  let cliArgs = [...args];
  let envParts = [`export HOME=${shellEscape(HOME)}`];

  switch (cliType) {
    case 'claude':
      binary = 'claude';
      cliArgs = ['--dangerously-skip-permissions', ...cliArgs];
      envParts.push(`export CLAUDE_HOME=${shellEscape(CLAUDE_HOME)}`);
      envParts.push(`export CLAUDE_CONFIG_DIR=${shellEscape(CLAUDE_HOME)}`);
      break;
    case 'gemini':
      binary = 'gemini';
      if (process.env.GEMINI_API_KEY) envParts.push(`export GEMINI_API_KEY=${shellEscape(process.env.GEMINI_API_KEY)}`);
      break;
    case 'codex':
      binary = 'codex';
      if (process.env.OPENAI_API_KEY) envParts.push(`export OPENAI_API_KEY=${shellEscape(process.env.OPENAI_API_KEY)}`);
      break;
    case 'bash':
      binary = 'bash';
      envParts.push(`export CLAUDE_HOME=${shellEscape(CLAUDE_HOME)}`);
      envParts.push(`export CLAUDE_CONFIG_DIR=${shellEscape(CLAUDE_HOME)}`);
      break;
    default:
      throw new Error(`Unknown CLI type: ${cliType}`);
  }

  const escapedArgs = cliArgs.map((a) => shellEscape(a)).join(' ');
  const envExports = envParts.join(' && ');
  const cmd = `cd ${escapedCwd} && ${envExports} && exec ${binary}${escapedArgs ? ' ' + escapedArgs : ''}`;
  tmuxExecSync(['new-session', '-d', '-s', safeName, '-x', '200', '-y', '50', cmd], {
    timeout: 30000,
  });
  tmuxExecSync(['set-option', '-t', safeName, 'mouse', 'off']);
  tmuxExecSync(['set-option', '-t', safeName, 'history-limit', '10000']);
}

// Backward-compatible wrappers
function tmuxCreateClaude(sessionName, cwd, claudeArgs = []) {
  tmuxCreateCLI(sessionName, cwd, 'claude', claudeArgs);
}
function tmuxCreateGemini(sessionName, cwd, geminiArgs = []) {
  tmuxCreateCLI(sessionName, cwd, 'gemini', geminiArgs);
}
function tmuxCreateCodex(sessionName, cwd, codexArgs = []) {
  tmuxCreateCLI(sessionName, cwd, 'codex', codexArgs);
}
function tmuxCreateBash(sessionName, cwd) {
  tmuxCreateCLI(sessionName, cwd, 'bash');
}

async function tmuxKill(sessionName) {
  const safeName = sanitizeTmuxName(sessionName);
  try {
    await tmuxExecAsync(['kill-session', '-t', safeName]);
  } catch (err) {
    if (
      err.message &&
      (err.message.includes('session not found') ||
        err.message.includes('no server running') ||
        err.message.includes('error connecting to'))
    ) {
      /* expected: session already gone or tmux server not running */
    } else {
      logger.debug('tmuxKill unexpected error', {
        module: 'safe-exec',
        tmuxSession: safeName,
        err: err.message,
      });
    }
  }
}

/**
 * Async version of tmuxSendKeys — writes text to a temp file, loads it into
 * tmux paste buffer, pastes into session, and sends Enter.
 * Uses async fs and tmux operations to avoid blocking the event loop.
 */
async function tmuxSendKeysAsync(sessionName, text) {
  const safeName = sanitizeTmuxName(sessionName);
  const tmpFile = join(
    os.tmpdir(),
    `tmux_paste_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.txt`,
  );
  await writeFileAsync(tmpFile, text);
  try {
    await tmuxExecAsync(['load-buffer', tmpFile]);
    await tmuxExecAsync(['paste-buffer', '-t', safeName]);
    await tmuxExecAsync(['send-keys', '-t', safeName, 'Enter']);
  } finally {
    try {
      await unlinkAsync(tmpFile);
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        logger.debug('tmuxSendKeysAsync cleanup failed', {
          module: 'safe-exec',
          err: cleanupErr.message,
        });
      }
    }
  }
}

/**
 * Async version of tmuxSendKey — sends a named key to a tmux session.
 */
async function tmuxSendKeyAsync(sessionName, keyName) {
  const safeName = sanitizeTmuxName(sessionName);
  await tmuxExecAsync(['send-keys', '-t', safeName, keyName]);
}

async function gitCloneAsync(url, targetPath) {
  if (!url.match(/^https?:\/\//) && !url.match(/^git@/)) {
    throw new Error('Invalid git URL');
  }
  const { stdout } = await execFileAsync('git', ['clone', url, targetPath], {
    encoding: 'utf-8',
    timeout: 120000,
  });
  return stdout;
}

function grepSearchAsync(pattern, cwd, glob) {
  return new Promise((resolve) => {
    const args = ['-rn'];
    if (glob) args.push('--include=' + glob);
    args.push('--', pattern, '.');
    childProcess.execFile(
      'grep',
      args,
      {
        cwd,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err || !stdout) resolve('No matches found');
        else resolve(stdout.split('\n').slice(0, 50).join('\n') || 'No matches found');
      },
    );
  });
}

function curlFetchAsync(url) {
  return new Promise((resolve) => {
    childProcess.execFile(
      'curl',
      ['-sL', '--max-time', '10', url],
      {
        encoding: 'utf-8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err || !stdout) resolve(`Error: failed to fetch ${url}`);
        else resolve(stdout.substring(0, 20000));
      },
    );
  });
}

function findSessionsDir(projectPath) {
  // Claude Code's projects-subdir encoding replaces BOTH '/' AND '_' with '-'.
  // Replacing only '/' produces a path that doesn't exist for any project whose
  // path contains an underscore (e.g. /data/workspace/repos/agentic_workbench
  // → -data-workspace-repos-agentic-workbench, with hyphen, not underscore).
  // Watchers / session-meta lookups would silently miss the JSONL otherwise.
  const encoded = projectPath.replace(/[\/_]/g, '-');
  return join(CLAUDE_HOME, 'projects', encoded);
}

module.exports = {
  WORKSPACE,
  CLAUDE_HOME,
  HOME,
  resolveProjectPath,
  sanitizeTmuxName,
  shellEscape,
  claudeExecAsync,
  tmuxExecAsync,
  tmuxExists,
  tmuxCreateCLI,
  tmuxCreateClaude,
  tmuxCreateGemini,
  tmuxCreateCodex,
  tmuxCreateBash,
  tmuxKill,
  tmuxSendKeysAsync,
  tmuxSendKeyAsync,
  gitCloneAsync,
  grepSearchAsync,
  curlFetchAsync,
  findSessionsDir,
};
