'use strict';

const { readFile } = require('fs');
const { watchFile } = require('fs');
const { join } = require('path');
const { promisify } = require('util');
const readFileAsync = promisify(readFile);

const CONFIG_DIR = join(__dirname, 'config');
const PROMPTS_DIR = join(CONFIG_DIR, 'prompts');

let _defaultsCache = {};
let _promptsCache = new Map();
let _initialized = false;

/**
 * Synchronous initial load for fail-fast on corrupt JSON at startup (ERQ-001 §6.4).
 * Called once during module load to populate the cache.
 */
function loadDefaultsSync() {
  try {
    const raw = require('fs').readFileSync(join(CONFIG_DIR, 'defaults.json'), 'utf-8');
    _defaultsCache = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      _defaultsCache = {};
      return;
    }
    if (err instanceof SyntaxError) {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'ERROR',
          message: 'defaults.json contains invalid JSON — cannot start safely',
          module: 'config',
          err: err.message,
        }) + '\n',
      );
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Async initialization: sets up file watchers for hot-reload.
 * Must be called during server startup before handling requests.
 */
async function init() {
  if (_initialized) return;

  loadDefaultsSync();

  watchFile(join(CONFIG_DIR, 'defaults.json'), { persistent: false, interval: 5000 }, async () => {
    try {
      const raw = await readFileAsync(join(CONFIG_DIR, 'defaults.json'), 'utf-8');
      _defaultsCache = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') {
        _defaultsCache = {};
      } else if (err instanceof SyntaxError) {
        process.stderr.write(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'defaults.json hot-reload failed: invalid JSON — retaining previous config',
            module: 'config',
            err: err.message,
          }) + '\n',
        );
      }
      /* retain previous cache on other errors */
    }
  });

  _initialized = true;
}

/**
 * Get a specific config value by dot-path (e.g., 'compaction.thresholds.advisory').
 * Reads from in-memory cache. Falls back to provided default if not found.
 */
function get(path, fallback) {
  const parts = path.split('.');
  let value = _defaultsCache;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return fallback;
    value = value[part];
  }
  return value !== undefined ? value : fallback;
}

/**
 * Read a prompt template file. Replaces {{KEY}} placeholders with values from the vars object.
 * Uses in-memory cache with file watcher for hot-reload.
 */
function getPrompt(name, vars = {}) {
  const cacheKey = name;
  if (!_promptsCache.has(cacheKey)) {
    try {
      const content = require('fs').readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8');
      _promptsCache.set(cacheKey, content);

      watchFile(join(PROMPTS_DIR, `${name}.md`), { persistent: false, interval: 5000 }, () => {
        try {
          const updated = require('fs').readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8');
          _promptsCache.set(cacheKey, updated);
        } catch (reloadErr) {
          if (reloadErr.code === 'ENOENT') {
            _promptsCache.delete(cacheKey);
          }
          /* retain previous cache on other errors */
        }
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        process.stdout.write(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'WARN',
            message: `Prompt template not found: ${name}.md — returning empty string`,
            module: 'config',
          }) + '\n',
        );
        return '';
      }
      throw err;
    }
  }

  let content = _promptsCache.get(cacheKey) || '';
  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
  }
  return content;
}

/* Perform initial synchronous load so config is available immediately on require() */
loadDefaultsSync();

module.exports = { init, get, getPrompt };
