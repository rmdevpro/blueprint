/**
 * Command execution and path utilities.
 *
 * Uses execFileSync with argument arrays to avoid shell interpolation.
 * Minimal path validation — Blueprint is a single-user local tool.
 */

const { execFileSync } = require('child_process');
const { resolve, join, sep } = require('path');

const WORKSPACE = process.env.WORKSPACE || '/workspace';
const CLAUDE_HOME = process.env.CLAUDE_HOME || '/home/hopper/.claude';
const HOME = process.env.HOME || '/home/hopper';

/**
 * Resolve a project path. Simple resolution — no traversal blocking.
 * Blueprint is single-user; the user owns everything.
 */
function resolveProjectPath(project) {
  return resolve(WORKSPACE, project);
}

/**
 * Sanitize a tmux session name (alphanumeric, underscores, hyphens only).
 */
function sanitizeTmuxName(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

/**
 * Run Claude CLI with arguments (no shell interpolation).
 * Synchronous — use claudeExecAsync in request handlers.
 */
function claudeExec(args, options = {}) {
  return execFileSync('claude', [...args], {
    encoding: 'utf-8',
    timeout: options.timeout || 120000,
    cwd: options.cwd || WORKSPACE,
    stdio: options.stdio || 'pipe',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

/**
 * Async version of claudeExec — does NOT block the event loop.
 */
function claudeExecAsync(args, options = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile('claude', [...args], {
      encoding: 'utf-8',
      timeout: options.timeout || 120000,
      cwd: options.cwd || WORKSPACE,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, TERM: 'xterm-256color' },
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Run tmux command.
 */
function tmuxExec(args, options = {}) {
  return execFileSync('tmux', args, {
    stdio: options.stdio || 'ignore',
    timeout: options.timeout || 10000,
    env: process.env,
  });
}

/**
 * Check if a tmux session exists.
 */
function tmuxExists(name) {
  const safe = sanitizeTmuxName(name);
  try {
    tmuxExec(['has-session', '-t', safe]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shell-escape a string for tmux commands.
 */
function shellEscape(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Create a tmux session running Claude CLI.
 */
function tmuxCreateClaude(sessionName, cwd, claudeArgs = []) {
  const safeName = sanitizeTmuxName(sessionName);
  const allArgs = ['--dangerously-skip-permissions', ...claudeArgs];
  const escapedCwd = shellEscape(cwd);
  const escapedArgs = allArgs.map(a => shellEscape(a)).join(' ');

  // Export CLAUDE_HOME and CLAUDE_CONFIG_DIR so the CLI finds credentials and handles refresh itself.
  // Do NOT inject CLAUDE_CODE_OAUTH_TOKEN — it overrides the CLI's refresh flow with a potentially stale token.
  const envExports = `export CLAUDE_HOME=${shellEscape(CLAUDE_HOME)} && export CLAUDE_CONFIG_DIR=${shellEscape(CLAUDE_HOME)} && export HOME=${shellEscape(HOME)} && export DISABLE_AUTO_COMPACT=1`;

  const cmd = `cd ${escapedCwd} && ${envExports} && exec claude ${escapedArgs}`;
  tmuxExec(['new-session', '-d', '-s', safeName, '-x', '200', '-y', '50', cmd], { timeout: 30000 });

  // Mouse off so xterm.js handles text selection and copy/paste natively
  // Scroll is handled client-side by converting wheel events to key sequences
  tmuxExec(['set-option', '-t', safeName, 'mouse', 'off']);
  tmuxExec(['set-option', '-t', safeName, 'history-limit', '10000']);
}

/**
 * Create a tmux session running plain bash (no Claude CLI).
 */
function tmuxCreateBash(sessionName, cwd) {
  const safeName = sanitizeTmuxName(sessionName);
  const escapedCwd = shellEscape(cwd);
  const envExports = `export CLAUDE_HOME=${shellEscape(CLAUDE_HOME)} && export CLAUDE_CONFIG_DIR=${shellEscape(CLAUDE_HOME)} && export HOME=${shellEscape(HOME)}`;
  const cmd = `cd ${escapedCwd} && ${envExports} && exec bash`;
  tmuxExec(['new-session', '-d', '-s', safeName, '-x', '200', '-y', '50', cmd], { timeout: 30000 });
  tmuxExec(['set-option', '-t', safeName, 'mouse', 'off']);
  tmuxExec(['set-option', '-t', safeName, 'history-limit', '10000']);
}

/**
 * Kill a tmux session.
 */
function tmuxKill(sessionName) {
  const safe = sanitizeTmuxName(sessionName);
  try { tmuxExec(['kill-session', '-t', safe]); } catch {}
}

/**
 * Send text to a tmux session via paste buffer.
 * Always uses load-buffer + paste-buffer — reliable for any length or content.
 */
function tmuxSendKeys(sessionName, text) {
  const safe = sanitizeTmuxName(sessionName);
  const { writeFileSync, unlinkSync } = require('fs');
  const { join } = require('path');
  const tmpFile = join(require('os').tmpdir(), `tmux_paste_${Date.now()}.txt`);
  // Trailing newline submits the message
  writeFileSync(tmpFile, text);
  try {
    tmuxExec(['load-buffer', tmpFile]);
    tmuxExec(['paste-buffer', '-t', safe]);
    tmuxExec(['send-keys', '-t', safe, 'Enter']);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Send a named key (e.g. 'BTab' for Shift+Tab) to a tmux session.
 * Unlike tmuxSendKeys, this does NOT use the -l literal flag — the argument
 * is a tmux key name, not text.
 */
function tmuxSendKey(sessionName, keyName) {
  const safe = sanitizeTmuxName(sessionName);
  tmuxExec(['send-keys', '-t', safe, keyName]);
}

/**
 * Run git clone.
 */
function gitClone(url, targetPath) {
  if (!url.match(/^https?:\/\//) && !url.match(/^git@/)) {
    throw new Error('Invalid git URL');
  }
  return execFileSync('git', ['clone', url, targetPath], {
    encoding: 'utf-8',
    timeout: 120000,
    stdio: 'pipe',
  });
}

/**
 * Run grep for file search.
 */
function grepSearch(pattern, cwd, glob) {
  const args = ['-rn'];
  if (glob) args.push('--include=' + glob);
  args.push('--', pattern, '.');
  try {
    return execFileSync('grep', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    }).split('\n').slice(0, 50).join('\n') || 'No matches found';
  } catch {
    return 'No matches found';
  }
}

/**
 * Fetch URL via curl.
 */
function curlFetch(url) {
  try {
    return execFileSync('curl', ['-sL', '--max-time', '10', url], {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }).substring(0, 20000);
  } catch {
    return `Error: failed to fetch ${url}`;
  }
}

/**
 * Find the Claude CLI session directory for a project path.
 * The CLI encodes the project path by replacing / with -.
 */
function findSessionsDir(projectPath) {
  const encoded = projectPath.replace(/\//g, '-');
  return join(CLAUDE_HOME, 'projects', encoded);
}

module.exports = {
  WORKSPACE,
  CLAUDE_HOME,
  HOME,
  resolveProjectPath,
  sanitizeTmuxName,
  claudeExec,
  claudeExecAsync,
  tmuxExec,
  tmuxExists,
  tmuxCreateClaude,
  tmuxCreateBash,
  tmuxKill,
  tmuxSendKeys,
  tmuxSendKey,
  gitClone,
  grepSearch,
  curlFetch,
  shellEscape,
  findSessionsDir,
};
