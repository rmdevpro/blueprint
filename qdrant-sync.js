'use strict';

/**
 * Qdrant vector sync — watches directories for changes, embeds content
 * via OpenAI-compatible API (Gemini), and upserts to Qdrant collections.
 *
 * Collections: docs, claude_sessions, gemini_sessions, codex_sessions
 * Embedding: 384 dims via MRL truncation (matches Qdrant default model dims)
 *
 * Zero npm dependencies — uses native fetch and fs.watch.
 */

const { watch, readFileSync, readdirSync, statSync, existsSync } = require('fs');
const { readFile, readdir, stat } = require('fs/promises');
const { join, basename, extname, relative } = require('path');
const { createHash } = require('crypto');
const logger = require('./logger');
const db = require('./db');
const safe = require('./safe-exec');

// ── Configuration ──────────────────────────────────────────────────────────

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const EMBEDDING_URL = process.env.EMBEDDING_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMS || '384', 10);
const DEBOUNCE_MS = parseInt(process.env.QDRANT_DEBOUNCE_MS || '10000', 10);
const CHUNK_WINDOW = 3; // sliding window of N conversation turns
const CHUNK_OVERLAP = 1;

const WORKSPACE = safe.WORKSPACE;
const CLAUDE_HOME = safe.CLAUDE_HOME;

const COLLECTIONS = {
  docs: 'docs',
  claude: 'claude_sessions',
  gemini: 'gemini_sessions',
  codex: 'codex_sessions',
};

// ── SQLite sync state ──────────────────────────────────────────────────────

db.db.exec(`
  CREATE TABLE IF NOT EXISTS qdrant_sync (
    file_path TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    last_offset INTEGER DEFAULT 0,
    last_mtime REAL DEFAULT 0,
    last_hash TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

const syncStmts = {
  get: db.db.prepare('SELECT * FROM qdrant_sync WHERE file_path = ?'),
  upsert: db.db.prepare(`
    INSERT INTO qdrant_sync (file_path, collection, last_offset, last_mtime, last_hash)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      last_offset = excluded.last_offset,
      last_mtime = excluded.last_mtime,
      last_hash = excluded.last_hash,
      updated_at = datetime('now')
  `),
  getByCollection: db.db.prepare('SELECT * FROM qdrant_sync WHERE collection = ?'),
  delete: db.db.prepare('DELETE FROM qdrant_sync WHERE file_path = ?'),
};

// ── Embedding API ──────────────────────────────────────────────────────────

function getApiKey() {
  // Check environment first, then Blueprint settings
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  let key = db.getSetting('gemini_api_key', '');
  // Settings are stored JSON-stringified — unwrap if needed
  if (key && key.startsWith('"')) {
    try { key = JSON.parse(key); } catch { /* use as-is */ }
  }
  return key || null;
}

async function embed(texts) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No embedding API key configured (GOOGLE_API_KEY or gemini_api_key setting)');

  // Gemini's OpenAI-compatible endpoint accepts both Bearer token and x-goog-api-key
  const response = await fetch(`${EMBEDDING_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMS,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.data.map(d => d.embedding);
}

// ── Qdrant REST API ────────────────────────────────────────────────────────

async function qdrantHealthy() {
  try {
    const r = await fetch(`${QDRANT_URL}/collections`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureCollection(name) {
  const r = await fetch(`${QDRANT_URL}/collections/${name}`);
  if (r.ok) return;

  const cr = await fetch(`${QDRANT_URL}/collections/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size: EMBEDDING_DIMS, distance: 'Cosine' } }),
  });
  if (!cr.ok) throw new Error(`Failed to create collection ${name}: ${await cr.text()}`);
  logger.info(`Created Qdrant collection: ${name}`, { module: 'qdrant-sync' });
}

async function upsertPoints(collection, points) {
  if (!points.length) return;

  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  });
  if (!r.ok) throw new Error(`Qdrant upsert failed: ${await r.text()}`);
}

async function deletePointsByFilter(collection, filter) {
  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filter }),
  });
  if (!r.ok) throw new Error(`Qdrant delete failed: ${await r.text()}`);
}

async function searchPoints(collection, vector, limit = 10, filter = null) {
  const body = { vector, limit, with_payload: true };
  if (filter) body.filter = filter;

  const r = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Qdrant search failed: ${await r.text()}`);
  const data = await r.json();
  return data.result;
}

// ── Chunking ───────────────────────────────────────────────────────────────

/**
 * Chunk a markdown/text document into sections.
 * Splits on ## headings, falls back to fixed-size chunks.
 */
function chunkDocument(text, filePath) {
  const sections = [];
  const lines = text.split('\n');
  let current = { title: basename(filePath), lines: [] };

  for (const line of lines) {
    if (/^##\s/.test(line) && current.lines.length > 0) {
      sections.push(current);
      current = { title: line.replace(/^##\s*/, ''), lines: [] };
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) sections.push(current);

  // If document is small enough, return as single chunk
  if (sections.length === 1 && text.length < 4000) {
    return [{ text, metadata: { section: sections[0].title } }];
  }

  return sections.map(s => ({
    text: s.lines.join('\n').trim(),
    metadata: { section: s.title },
  })).filter(c => c.text.length > 20);
}

/**
 * Chunk JSONL session turns using sliding window.
 * Groups user+assistant turns, slides by CHUNK_OVERLAP.
 */
function chunkSessionTurns(turns) {
  if (turns.length === 0) return [];
  if (turns.length <= CHUNK_WINDOW) {
    return [{
      text: turns.map(t => `[${t.role}] ${t.content}`).join('\n'),
      metadata: { turn_start: 0, turn_end: turns.length - 1 },
    }];
  }

  const chunks = [];
  const step = CHUNK_WINDOW - CHUNK_OVERLAP;
  for (let i = 0; i < turns.length; i += step) {
    const window = turns.slice(i, i + CHUNK_WINDOW);
    if (window.length < 2) break; // don't create tiny trailing chunks
    chunks.push({
      text: window.map(t => `[${t.role}] ${t.content}`).join('\n'),
      metadata: { turn_start: i, turn_end: i + window.length - 1 },
    });
  }
  return chunks;
}

/**
 * Parse Claude JSONL session file into conversation turns.
 * Each turn: { role, content, timestamp }
 */
function parseClaudeJsonl(content) {
  const turns = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') {
        const msg = entry.message;
        if (!msg || !msg.content) continue;
        // Content can be string or array of content blocks
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
        }
        if (text.length > 10) {
          // Truncate very long messages for embedding
          turns.push({
            role: msg.role || entry.type,
            content: text.substring(0, 2000),
            timestamp: entry.timestamp,
          });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return turns;
}

/**
 * Parse Gemini session file (JSON format) into conversation turns.
 */
function parseGeminiSession(content) {
  const turns = [];
  try {
    const data = JSON.parse(content);
    const messages = Array.isArray(data) ? data : (data.messages || data.parts || []);
    for (const msg of messages) {
      const role = msg.role || 'unknown';
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (msg.parts) {
        text = msg.parts
          .filter(p => typeof p === 'string' || p.text)
          .map(p => typeof p === 'string' ? p : p.text)
          .join('\n');
      }
      if (text.length > 10) {
        turns.push({ role, content: text.substring(0, 2000) });
      }
    }
  } catch {
    // Try JSONL fallback
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.role && (entry.content || entry.parts)) {
          const text = entry.content || (entry.parts || []).map(p => p.text || '').join('\n');
          if (text.length > 10) {
            turns.push({ role: entry.role, content: text.substring(0, 2000) });
          }
        }
      } catch { /* skip */ }
    }
  }
  return turns;
}

/**
 * Parse Codex/OpenAI session file (JSONL format) into conversation turns.
 */
function parseCodexSession(content) {
  const turns = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const role = entry.role || entry.type || 'unknown';
      let text = '';
      if (typeof entry.content === 'string') {
        text = entry.content;
      } else if (Array.isArray(entry.content)) {
        text = entry.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n');
      }
      if (text.length > 10) {
        turns.push({ role, content: text.substring(0, 2000) });
      }
    } catch { /* skip */ }
  }
  return turns;
}

// ── Point ID generation ────────────────────────────────────────────────────

function pointId(filePath, chunkIndex) {
  const hash = createHash('sha256').update(`${filePath}:${chunkIndex}`).digest('hex');
  // Qdrant accepts UUIDs or unsigned 64-bit ints; use UUID format from hash
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    hash.substring(12, 16),
    hash.substring(16, 20),
    hash.substring(20, 32),
  ].join('-');
}

// ── Sync logic ─────────────────────────────────────────────────────────────

async function syncDocFile(filePath) {
  const relPath = relative(join(WORKSPACE, 'docs'), filePath);
  const syncState = syncStmts.get.get(filePath);
  const fileStat = await stat(filePath);
  const content = await readFile(filePath, 'utf-8');
  const hash = createHash('md5').update(content).digest('hex');

  if (syncState && syncState.last_hash === hash) return 0;

  // Delete old points for this file
  await deletePointsByFilter(COLLECTIONS.docs, {
    must: [{ key: 'file_path', match: { value: relPath } }],
  });

  const chunks = chunkDocument(content, filePath);
  if (chunks.length === 0) return 0;

  const texts = chunks.map(c => c.text);
  const embeddings = await embed(texts);

  const points = chunks.map((chunk, i) => ({
    id: pointId(filePath, i),
    vector: embeddings[i],
    payload: {
      file_path: relPath,
      section: chunk.metadata.section,
      text: chunk.text.substring(0, 5000),
      type: 'doc',
      indexed_at: new Date().toISOString(),
    },
  }));

  await upsertPoints(COLLECTIONS.docs, points);
  syncStmts.upsert.run(filePath, COLLECTIONS.docs, 0, fileStat.mtimeMs, hash);
  return points.length;
}

async function syncSessionFile(filePath, collection, parser) {
  const syncState = syncStmts.get.get(filePath);
  const fileStat = await stat(filePath);

  // Check if file has changed
  if (syncState && syncState.last_mtime === fileStat.mtimeMs) return 0;

  const content = await readFile(filePath, 'utf-8');
  const turns = parser(content);

  if (turns.length === 0) return 0;

  const sessionId = basename(filePath).replace(/\.(jsonl|json)$/, '');

  // Delete old points and re-index (simpler than offset tracking for windowed chunks)
  await deletePointsByFilter(collection, {
    must: [{ key: 'session_id', match: { value: sessionId } }],
  });

  const chunks = chunkSessionTurns(turns);
  if (chunks.length === 0) return 0;

  const texts = chunks.map(c => c.text);

  // Batch embeddings in groups of 20 to avoid API limits
  const allEmbeddings = [];
  for (let i = 0; i < texts.length; i += 20) {
    const batch = texts.slice(i, i + 20);
    const batchEmbeddings = await embed(batch);
    allEmbeddings.push(...batchEmbeddings);
  }

  const points = chunks.map((chunk, i) => ({
    id: pointId(filePath, i),
    vector: allEmbeddings[i],
    payload: {
      session_id: sessionId,
      text: chunk.text.substring(0, 5000),
      turn_start: chunk.metadata.turn_start,
      turn_end: chunk.metadata.turn_end,
      type: 'session',
      indexed_at: new Date().toISOString(),
    },
  }));

  await upsertPoints(collection, points);
  syncStmts.upsert.run(filePath, collection, content.length, fileStat.mtimeMs, '');
  return points.length;
}

// ── Directory scanning ─────────────────────────────────────────────────────

async function scanDocs() {
  const docsDir = join(WORKSPACE, 'docs');
  if (!existsSync(docsDir)) return 0;

  let total = 0;
  const scan = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(full);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.txt')) {
        try {
          total += await syncDocFile(full);
        } catch (err) {
          logger.error('Doc sync error', { module: 'qdrant-sync', file: full, err: err.message });
        }
      }
    }
  };
  await scan(docsDir);
  return total;
}

async function scanClaudeSessions() {
  // Claude sessions: ~/.claude/projects/<encoded-path>/*.jsonl
  const projectsDir = join(CLAUDE_HOME, 'projects');
  if (!existsSync(projectsDir)) return 0;

  let total = 0;
  const projectDirs = await readdir(projectsDir, { withFileTypes: true });
  for (const pDir of projectDirs) {
    if (!pDir.isDirectory()) continue;
    const sessDir = join(projectsDir, pDir.name);
    const files = await readdir(sessDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        total += await syncSessionFile(
          join(sessDir, file),
          COLLECTIONS.claude,
          parseClaudeJsonl,
        );
      } catch (err) {
        logger.error('Claude session sync error', { module: 'qdrant-sync', file, err: err.message });
      }
    }
  }
  return total;
}

async function scanGeminiSessions() {
  // Gemini sessions: ~/.gemini/tmp/<hash>/chats/session-*.json
  const geminiBase = join(process.env.HOME || '/home/hopper', '.gemini', 'tmp');
  if (!existsSync(geminiBase)) return 0;

  let total = 0;
  try {
    const hashDirs = await readdir(geminiBase, { withFileTypes: true });
    for (const hDir of hashDirs) {
      if (!hDir.isDirectory()) continue;
      const chatsDir = join(geminiBase, hDir.name, 'chats');
      if (!existsSync(chatsDir)) continue;
      const files = await readdir(chatsDir);
      for (const file of files) {
        if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;
        try {
          total += await syncSessionFile(
            join(chatsDir, file),
            COLLECTIONS.gemini,
            parseGeminiSession,
          );
        } catch (err) {
          logger.error('Gemini session sync error', { module: 'qdrant-sync', file, err: err.message });
        }
      }
    }
  } catch { /* no gemini sessions */ }
  return total;
}

async function scanCodexSessions() {
  // Codex sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const codexBase = join(process.env.CODEX_HOME || join(process.env.HOME || '/home/hopper', '.codex'), 'sessions');
  if (!existsSync(codexBase)) return 0;

  let total = 0;
  const walkDir = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(full);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          total += await syncSessionFile(full, COLLECTIONS.codex, parseCodexSession);
        } catch (err) {
          logger.error('Codex session sync error', { module: 'qdrant-sync', file: full, err: err.message });
        }
      }
    }
  };
  await walkDir(codexBase);
  return total;
}

// ── File watchers ──────────────────────────────────────────────────────────

const _watchers = [];
let _debounceTimer = null;
let _pendingSyncs = new Set();

function scheduleSync(syncFn) {
  _pendingSyncs.add(syncFn);
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(async () => {
    const fns = [..._pendingSyncs];
    _pendingSyncs.clear();
    for (const fn of fns) {
      try {
        const count = await fn();
        if (count > 0) {
          logger.info(`Qdrant sync: ${count} points indexed`, { module: 'qdrant-sync' });
        }
      } catch (err) {
        logger.error('Qdrant sync error', { module: 'qdrant-sync', err: err.message });
      }
    }
  }, DEBOUNCE_MS);
}

function watchDir(dir, syncFn) {
  if (!existsSync(dir)) return;
  try {
    const watcher = watch(dir, { recursive: true }, () => scheduleSync(syncFn));
    _watchers.push(watcher);
    logger.info(`Watching ${dir} for Qdrant sync`, { module: 'qdrant-sync' });
  } catch (err) {
    logger.error(`Failed to watch ${dir}`, { module: 'qdrant-sync', err: err.message });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

let _running = false;

async function start() {
  if (_running) return;

  // Check if Qdrant is reachable
  if (!(await qdrantHealthy())) {
    logger.info('Qdrant not available — vector sync disabled', { module: 'qdrant-sync' });
    return;
  }

  _running = true;
  logger.info('Qdrant sync starting', { module: 'qdrant-sync', url: QDRANT_URL });

  // Ensure collections exist
  for (const name of Object.values(COLLECTIONS)) {
    await ensureCollection(name);
  }

  // Initial full scan
  try {
    const docCount = await scanDocs();
    const claudeCount = await scanClaudeSessions();
    const geminiCount = await scanGeminiSessions();
    const codexCount = await scanCodexSessions();
    logger.info('Qdrant initial sync complete', {
      module: 'qdrant-sync',
      docs: docCount,
      claude: claudeCount,
      gemini: geminiCount,
      codex: codexCount,
    });
  } catch (err) {
    logger.error('Qdrant initial sync error', { module: 'qdrant-sync', err: err.message });
  }

  // Set up file watchers
  watchDir(join(WORKSPACE, 'docs'), scanDocs);
  watchDir(join(CLAUDE_HOME, 'projects'), scanClaudeSessions);

  const geminiBase = join(process.env.HOME || '/home/hopper', '.gemini');
  watchDir(geminiBase, scanGeminiSessions);

  const codexBase = process.env.CODEX_HOME || join(process.env.HOME || '/home/hopper', '.codex');
  watchDir(codexBase, scanCodexSessions);
}

function stop() {
  for (const w of _watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  _watchers.length = 0;
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _running = false;
}

async function search(query, collections = null, limit = 10) {
  if (!(await qdrantHealthy())) throw new Error('Qdrant not available');

  // Embed the query
  const [queryVector] = await embed([query]);

  // Search specified collections (default: all)
  const targetCollections = collections || Object.values(COLLECTIONS);
  const results = [];

  for (const col of targetCollections) {
    try {
      const hits = await searchPoints(col, queryVector, limit);
      for (const hit of hits) {
        results.push({
          collection: col,
          score: hit.score,
          ...hit.payload,
        });
      }
    } catch (err) {
      logger.error(`Search error in ${col}`, { module: 'qdrant-sync', err: err.message });
    }
  }

  // Sort by score descending, take top N
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function status() {
  const healthy = await qdrantHealthy();
  if (!healthy) return { available: false };

  const collections = {};
  for (const [key, name] of Object.entries(COLLECTIONS)) {
    try {
      const r = await fetch(`${QDRANT_URL}/collections/${name}`);
      if (r.ok) {
        const data = await r.json();
        collections[key] = {
          points: data.result?.points_count || 0,
          status: data.result?.status || 'unknown',
        };
      }
    } catch { /* skip */ }
  }

  return { available: true, running: _running, url: QDRANT_URL, collections };
}

module.exports = { start, stop, search, status, embed, qdrantHealthy };
