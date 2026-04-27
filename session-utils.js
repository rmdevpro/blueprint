'use strict';

const { readdir, readFile, stat } = require('fs/promises');
const { join, basename } = require('path');
const safe = require('./safe-exec');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');

const CLAUDE_HOME = safe.CLAUDE_HOME;
const WORKSPACE = safe.WORKSPACE;

function sessionsDir(projectPath) {
  return safe.findSessionsDir(projectPath);
}

async function parseSessionFile(filepath) {
  try {
    const sessionId = basename(filepath, '.jsonl');
    const fileStat = await stat(filepath);
    const mtime = fileStat.mtimeMs;
    const size = fileStat.size;

    const cached = db.getSessionMeta(sessionId);
    if (cached && cached.file_mtime === mtime && cached.file_size === size) {
      return {
        name: cached.name || 'Untitled Session',
        timestamp: cached.timestamp || new Date().toISOString(),
        messageCount: cached.message_count || 0,
        model: cached.model || null,
      };
    }

    const content = await readFile(filepath, 'utf-8');
    const lines = content.trim().split('\n');
    let name = null;
    let timestamp = null;
    let messageCount = 0;
    let model = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!name && entry.type === 'user' && entry.message?.content) {
          const text =
            typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content[0]?.text || '';
          name = text.substring(0, 80);
          if (text.length > 80) name += '...';
        }
        if (entry.type === 'summary' && entry.summary) {
          name = entry.summary.substring(0, 80);
        }
        if (entry.type === 'user' || entry.type === 'assistant') {
          messageCount++;
        }
        if (entry.type === 'assistant' && entry.message?.model) {
          model = entry.message.model;
        }
        if (entry.timestamp) {
          timestamp = entry.timestamp;
        }
      } catch (parseErr) {
        if (!(parseErr instanceof SyntaxError)) {
          logger.debug('Unexpected error parsing JSONL line in parseSessionFile', {
            module: 'session-utils',
            err: parseErr.message,
          });
        }
        /* expected: malformed JSONL lines during active session writes */
      }
    }

    const result = {
      name: name || 'Untitled Session',
      timestamp: timestamp || new Date().toISOString(),
      messageCount,
      model: model || null,
    };

    db.upsertSessionMeta(
      sessionId,
      filepath,
      mtime,
      size,
      result.name,
      result.timestamp,
      result.messageCount,
      result.model || '',
    );
    return result;
  } catch (err) {
    if (err.code === 'ENOENT') {
      /* expected: session file may not exist yet */
      return null;
    }
    logger.error('Unexpected error in parseSessionFile', {
      module: 'session-utils',
      err: err.message,
    });
    return null;
  }
}

function extractMessageText(entry) {
  if (entry.type !== 'user' && entry.type !== 'assistant') return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  return content?.[0]?.text || '';
}

function _extractGeminiMessageText(msg) {
  if (msg.type !== 'user' && msg.type !== 'gemini') return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => typeof p === 'string' ? p : p.text || '').join(' ');
  return '';
}

function _extractCodexMessageText(entry) {
  if (entry.type !== 'response_item' || !entry.payload) return '';
  const role = entry.payload.role || '';
  if (role !== 'user' && role !== 'assistant') return '';
  const content = entry.payload.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === 'input_text' || b.type === 'text')
      .map(b => b.text || '')
      .join(' ');
  }
  return '';
}

function _searchGeminiSessions(q, results) {
  const geminiSessions = discoverGeminiSessions();
  for (const gs of geminiSessions) {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(gs.filePath, 'utf-8');
      const data = JSON.parse(content);
      const messages = data.messages || [];
      const matches = [];

      for (const msg of messages) {
        const text = _extractGeminiMessageText(msg);
        if (text && text.toLowerCase().includes(q)) {
          matches.push({ type: msg.type, text: text.substring(0, 200), timestamp: msg.timestamp });
        }
      }

      if (matches.length > 0) {
        results.push({
          session_id: gs.sessionId || gs.filePath,
          sessionId: gs.sessionId || gs.filePath,
          project: '(gemini)',
          name: gs.name || 'Untitled',
          match_count: matches.length,
          matchCount: matches.length,
          snippets: matches.slice(0, 3).map(m => m.text),
          matches: matches.slice(0, 3),
          cli_type: 'gemini',
        });
      }
    } catch { /* skip unreadable files */ }
  }
}

function _searchCodexSessions(q, results) {
  const codexSessions = discoverCodexSessions();
  for (const cs of codexSessions) {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(cs.filePath, 'utf-8');
      const lines = content.trim().split('\n');
      const matches = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const text = _extractCodexMessageText(entry);
          if (text && text.toLowerCase().includes(q)) {
            matches.push({ type: entry.payload?.role || 'unknown', text: text.substring(0, 200), timestamp: entry.timestamp });
          }
        } catch { /* skip malformed lines */ }
      }

      if (matches.length > 0) {
        results.push({
          session_id: cs.filePath,
          sessionId: cs.filePath,
          project: '(codex)',
          name: cs.name || 'Untitled',
          match_count: matches.length,
          matchCount: matches.length,
          snippets: matches.slice(0, 3).map(m => m.text),
          matches: matches.slice(0, 3),
          cli_type: 'codex',
        });
      }
    } catch { /* skip unreadable files */ }
  }
}

async function searchSessions(query, projectFilter, maxResults = 15) {
  const q = query.toLowerCase();
  const results = [];
  const dbProjects = db.getProjects();

  // Search Claude JSONL sessions
  for (const dbProj of dbProjects) {
    if (projectFilter && dbProj.name !== projectFilter) continue;
    const sDir = sessionsDir(dbProj.path);
    try {
      const files = await readdir(sDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = basename(file, '.jsonl');
        const content = await readFile(join(sDir, file), 'utf-8');
        const matches = [];
        let firstName = null;

        for (const line of content.split('\n')) {
          try {
            const e = JSON.parse(line);
            if (!firstName && e.type === 'user' && e.message?.content) {
              const t =
                typeof e.message.content === 'string'
                  ? e.message.content
                  : e.message.content[0]?.text || '';
              firstName = t.substring(0, 80);
            }
            const text = extractMessageText(e);
            if (text && text.toLowerCase().includes(q)) {
              matches.push({ type: e.type, text: text.substring(0, 200), timestamp: e.timestamp });
            }
          } catch (parseErr) {
            if (!(parseErr instanceof SyntaxError)) {
              logger.debug('Unexpected error parsing JSONL line in searchSessions', {
                module: 'session-utils',
                err: parseErr.message,
              });
            }
            /* expected: malformed JSONL line */
          }
        }

        if (matches.length > 0) {
          const cached = db.getSessionMeta(sessionId);
          const sessionName = cached?.name || firstName || 'Untitled';
          results.push({
            session_id: sessionId,
            sessionId,
            project: dbProj.name,
            name: sessionName,
            match_count: matches.length,
            matchCount: matches.length,
            snippets: matches.slice(0, 3).map((m) => m.text),
            matches: matches.slice(0, 3),
            cli_type: 'claude',
          });
        }
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        /* expected: no sessions dir for this project */
      } else {
        logger.error('Error reading sessions dir in searchSessions', {
          module: 'session-utils',
          project: dbProj.name,
          err: err.message,
        });
      }
    }
  }

  // Search Gemini and Codex sessions
  if (!projectFilter) {
    _searchGeminiSessions(q, results);
    _searchCodexSessions(q, results);
  }

  return results.sort((a, b) => b.match_count - a.match_count).slice(0, maxResults);
}

function _readGeminiTranscript(sessionId, maxTranscriptChars, maxMessageChars) {
  const messages = [];
  let charCount = 0;

  // Find by cli_session_id match or file path
  const geminiSessions = discoverGeminiSessions();
  const session = db.getSession(sessionId);
  const cliSessId = session?.cli_session_id;

  let target = null;
  if (cliSessId) {
    target = geminiSessions.find(g => g.sessionId === cliSessId);
  }
  if (!target && geminiSessions.length > 0) {
    // Fall back to most recent
    target = geminiSessions.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    })[0];
  }
  if (!target) return messages;

  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(target.filePath, 'utf-8'));
    const msgs = data.messages || [];
    // Read from end for most recent context
    for (let i = msgs.length - 1; i >= 0 && charCount < maxTranscriptChars; i--) {
      const text = _extractGeminiMessageText(msgs[i]);
      if (text) {
        const role = msgs[i].type === 'user' ? 'user' : 'assistant';
        messages.unshift({ role, text: text.substring(0, maxMessageChars) });
        charCount += text.length;
      }
    }
  } catch { /* unreadable */ }

  return messages;
}

function _readCodexTranscript(sessionId, maxTranscriptChars, maxMessageChars) {
  const messages = [];
  let charCount = 0;

  const codexSessions = discoverCodexSessions();
  const session = db.getSession(sessionId);
  const cliSessId = session?.cli_session_id;

  let target = null;
  if (cliSessId) {
    target = codexSessions.find(c => {
      const rolloutName = basename(c.filePath, '.jsonl');
      const rolloutUuid = rolloutName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      const rolloutId = rolloutUuid ? rolloutUuid[1] : rolloutName;
      return rolloutId === cliSessId;
    });
  }
  if (!target && codexSessions.length > 0) {
    target = codexSessions.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    })[0];
  }
  if (!target) return messages;

  try {
    const fs = require('fs');
    const content = fs.readFileSync(target.filePath, 'utf-8');
    const lines = content.trim().split('\n');
    for (let i = lines.length - 1; i >= 0 && charCount < maxTranscriptChars; i--) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const text = _extractCodexMessageText(entry);
        if (text) {
          const role = entry.payload?.role === 'user' ? 'user' : 'assistant';
          messages.unshift({ role, text: text.substring(0, maxMessageChars) });
          charCount += text.length;
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* unreadable */ }

  return messages;
}

async function summarizeSession(sessionId, project) {
  const dbProj = db.getProject(project);
  const projectPath = dbProj ? dbProj.path : join(WORKSPACE, project);

  // Determine CLI type from DB
  const session = db.getSession(sessionId);
  const cliType = session?.cli_type || 'claude';

  const maxTranscriptChars = config.get('session.summaryMaxTranscriptChars', 1500);
  const maxMessageChars = config.get('session.summaryMaxMessageChars', 500);
  let messages = [];

  if (cliType === 'gemini') {
    messages = _readGeminiTranscript(sessionId, maxTranscriptChars, maxMessageChars);
  } else if (cliType === 'codex') {
    messages = _readCodexTranscript(sessionId, maxTranscriptChars, maxMessageChars);
  } else {
    // Claude: read from JSONL
    const sDir = sessionsDir(projectPath);
    const jsonlFile = join(sDir, `${sessionId}.jsonl`);

    try {
      const content = await readFile(jsonlFile, 'utf-8');
      const lines = content.trim().split('\n');
      let charCount = 0;

      for (let i = lines.length - 1; i >= 0 && charCount < maxTranscriptChars; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          const text = extractMessageText(entry);
          if (text) {
            messages.unshift({ role: entry.type, text: text.substring(0, maxMessageChars) });
            charCount += text.length;
          }
        } catch (parseErr) {
          if (!(parseErr instanceof SyntaxError)) {
            logger.debug('Unexpected error parsing JSONL line in summarizeSession', {
              module: 'session-utils',
              err: parseErr.message,
            });
          }
          /* expected: malformed JSONL line */
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error('Error reading session file for summary', {
          module: 'session-utils',
          sessionId: sessionId.substring(0, 8),
          err: err.message,
        });
      }
    }
  }

  if (messages.length === 0)
    return { summary: 'Empty session.', recent_messages: [], recentMessages: [] };

  const cliLabel = cliType === 'gemini' ? 'Gemini' : cliType === 'codex' ? 'Codex' : 'Claude';
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'Human' : cliLabel}: ${m.text}`)
    .join('\n\n');

  const prompt = config.getPrompt('summarize-session', { TRANSCRIPT: transcript });
  const summaryModel = config.get('session.summaryModel', 'claude-sonnet-4-6');
  const claudeTimeout = config.get('claude.defaultTimeoutMs', 120000);

  try {
    const summary = (
      await safe.claudeExecAsync(
        ['--print', '--no-session-persistence', '--model', summaryModel, prompt],
        { cwd: projectPath, timeout: claudeTimeout },
      )
    ).trim();
    const recent = messages.slice(-3);
    return { summary, recent_messages: recent, recentMessages: recent };
  } catch (err) {
    const stderr = err.stderr?.toString().substring(0, 1000);
    logger.error('Failed to generate session summary', {
      module: 'session-utils',
      sessionId: sessionId.substring(0, 8),
      err: err.message,
      stderr,
    });
    const recent = messages.slice(-3);
    return {
      summary: 'Failed to generate summary: ' + (stderr || err.message?.substring(0, 1000) || 'unknown error'),
      recent_messages: recent,
      recentMessages: recent,
    };
  }
}

function _getGeminiTokenUsage(sessionId) {
  const geminiSessions = discoverGeminiSessions();
  const session = db.getSession(sessionId);
  const cliSessId = session?.cli_session_id;

  let target = null;
  if (cliSessId) {
    target = geminiSessions.find(g => g.sessionId === cliSessId);
  }
  if (!target) return { input_tokens: 0, model: null, max_tokens: 1000000 };

  // Gemini JSON files may include usage data in messages
  try {
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(target.filePath, 'utf-8'));
    const messages = data.messages || [];
    let inputTokens = 0;
    let model = target.model || null;

    // Look for usage info in gemini responses (from end)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'gemini' && msg.usage) {
        inputTokens = msg.usage.input_tokens || msg.usage.prompt_token_count || 0;
        if (msg.model) model = msg.model;
        break;
      }
    }

    return {
      input_tokens: inputTokens,
      model,
      max_tokens: 1000000, // Gemini models have 1M context
    };
  } catch {
    return { input_tokens: 0, model: target.model || null, max_tokens: 1000000 };
  }
}

function _getCodexTokenUsage(sessionId) {
  const codexSessions = discoverCodexSessions();
  const session = db.getSession(sessionId);
  const cliSessId = session?.cli_session_id;

  let target = null;
  if (cliSessId) {
    target = codexSessions.find(c => {
      const rolloutName = basename(c.filePath, '.jsonl');
      const rolloutUuid = rolloutName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      const rolloutId = rolloutUuid ? rolloutUuid[1] : rolloutName;
      return rolloutId === cliSessId;
    });
  }
  if (!target) return { input_tokens: 0, model: null, max_tokens: 200000 };

  // Codex JSONL may include usage in turn_context or response entries
  try {
    const fs = require('fs');
    const content = fs.readFileSync(target.filePath, 'utf-8');
    const lines = content.trim().split('\n');
    let inputTokens = 0;
    let model = target.model || null;

    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'turn_context' && entry.payload?.usage) {
          inputTokens = entry.payload.usage.input_tokens || entry.payload.usage.total_tokens || 0;
          if (entry.payload.model) model = entry.payload.model;
          break;
        }
      } catch { /* skip malformed */ }
    }

    return {
      input_tokens: inputTokens,
      model,
      max_tokens: 200000, // Codex/GPT default
    };
  } catch {
    return { input_tokens: 0, model: target.model || null, max_tokens: 200000 };
  }
}

async function getTokenUsage(sessionId, project) {
  if (sessionId.startsWith('new_')) return { input_tokens: 0, model: null, max_tokens: 200000 };

  // Check CLI type from DB
  const session = db.getSession(sessionId);
  const cliType = session?.cli_type || 'claude';

  if (cliType === 'gemini') return _getGeminiTokenUsage(sessionId);
  if (cliType === 'codex') return _getCodexTokenUsage(sessionId);

  // Claude: read from JSONL
  const dbProj = db.getProject(project);
  const projectPath = dbProj ? dbProj.path : join(WORKSPACE, project);
  const sDir = sessionsDir(projectPath);
  const jsonlFile = join(sDir, `${sessionId}.jsonl`);

  try {
    const content = await readFile(jsonlFile, 'utf-8');
    const lines = content.trim().split('\n');
    let inputTokens = 0;
    let model = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.usage) {
          const m = entry.message.model || '';
          if (m.includes('synthetic') || m.includes('system')) continue;
          const usage = entry.message.usage;
          const total =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          if (total === 0) continue;
          inputTokens = total;
          model = m || null;
          break;
        }
      } catch (parseErr) {
        if (!(parseErr instanceof SyntaxError)) {
          logger.debug('Unexpected error parsing JSONL line in getTokenUsage', {
            module: 'session-utils',
            err: parseErr.message,
          });
        }
        /* expected: malformed JSONL line */
      }
    }

    return {
      input_tokens: inputTokens,
      model,
      max_tokens: model?.includes('opus') || model?.includes('1m') ? 1000000 : 200000,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      /* expected: session file may not exist yet */
      return { input_tokens: 0, model: null, max_tokens: 200000 };
    }
    logger.error('Unexpected error in getTokenUsage', {
      module: 'session-utils',
      sessionId: sessionId.substring(0, 8),
      err: err.message,
    });
    return { input_tokens: 0, model: null, max_tokens: 200000 };
  }
}

async function getSessionSlug(sessionId, projectPath) {
  const jsonlFile = join(sessionsDir(projectPath), `${sessionId}.jsonl`);
  try {
    const content = await readFile(jsonlFile, 'utf-8');
    for (const line of content.split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (entry.slug) return entry.slug;
      } catch (parseErr) {
        if (!(parseErr instanceof SyntaxError)) {
          logger.debug('Unexpected error parsing JSONL line in getSessionSlug', {
            module: 'session-utils',
            err: parseErr.message,
          });
        }
        /* expected: malformed JSONL line */
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error('Unexpected error in getSessionSlug', {
        module: 'session-utils',
        sessionId: sessionId.substring(0, 8),
        err: err.message,
      });
    }
    /* expected for ENOENT: session file may not exist */
  }
  return null;
}

/**
 * Parse a Gemini chat JSON file for session metadata.
 * Returns { name, timestamp, messageCount, model, sessionId } or null.
 */
function parseGeminiChatFile(filePath) {
  const fs = require('fs');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);
    const messages = data.messages || [];
    let name = null;
    let timestamp = null;
    let messageCount = 0;
    let model = null;
    const sessionId = data.sessionId || null;

    for (const msg of messages) {
      if (!name && msg.type === 'user') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map(p => typeof p === 'string' ? p : p.text || '').join(' ')
            : '';
        if (text) {
          name = text.substring(0, 80);
          if (text.length > 80) name += '...';
        }
      }
      if (msg.type === 'user' || msg.type === 'gemini') messageCount++;
      if (msg.type === 'gemini' && msg.model) model = msg.model;
      if (msg.timestamp) timestamp = msg.timestamp;
    }

    return {
      name: name || 'Untitled Session',
      timestamp: timestamp || null,
      messageCount,
      model: model || null,
      sessionId,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a Codex rollout JSONL file for session metadata.
 * Returns { name, timestamp, messageCount, model } or null.
 */
function parseCodexRolloutFile(filePath) {
  const fs = require('fs');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    let name = null;
    let timestamp = null;
    let messageCount = 0;
    let model = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'response_item' && entry.payload) {
          const role = entry.payload.role || 'unknown';
          if (role === 'user' || role === 'assistant') messageCount++;
          if (!name && role === 'user') {
            let text = '';
            if (typeof entry.payload.content === 'string') {
              text = entry.payload.content;
            } else if (Array.isArray(entry.payload.content)) {
              text = entry.payload.content
                .filter(b => b.type === 'input_text' || b.type === 'text')
                .map(b => b.text || '')
                .join(' ');
            }
            if (text) {
              name = text.substring(0, 80);
              if (text.length > 80) name += '...';
            }
          }
        }
        if (entry.type === 'turn_context' && entry.payload?.model) {
          model = entry.payload.model;
        }
        if (entry.timestamp) timestamp = entry.timestamp;
      } catch { /* skip malformed lines */ }
    }

    return {
      name: name || 'Untitled Session',
      timestamp: timestamp || null,
      messageCount,
      model: model || null,
    };
  } catch {
    return null;
  }
}

/**
 * Find all Gemini chat files and return a map of sessionId → { filePath, meta }.
 */
function discoverGeminiSessions() {
  const fs = require('fs');
  const home = safe.HOME;
  const results = [];
  try {
    const geminiBase = join(home, '.gemini', 'tmp');
    const projectDirs = fs.readdirSync(geminiBase, { withFileTypes: true });
    for (const pDir of projectDirs) {
      if (!pDir.isDirectory()) continue;
      const chatsDir = join(geminiBase, pDir.name, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const filePath = join(chatsDir, file);
        const meta = parseGeminiChatFile(filePath);
        if (meta) results.push({ filePath, ...meta });
      }
    }
  } catch { /* no gemini sessions */ }
  return results;
}

/**
 * Find all Codex rollout files and return a list of { filePath, meta }.
 */
function discoverCodexSessions() {
  const fs = require('fs');
  const home = safe.HOME;
  const results = [];
  try {
    const sessBase = join(home, '.codex', 'sessions');
    if (!fs.existsSync(sessBase)) return results;
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.jsonl')) {
          const meta = parseCodexRolloutFile(full);
          if (meta) results.push({ filePath: full, ...meta });
        }
      }
    };
    walk(sessBase);
  } catch { /* no codex sessions */ }
  return results;
}

// ── #156: Unified single-session metadata read ─────────────────────────────
// Single function the status bar, sidebar, MCP tokens, and MCP config readers
// all funnel through. Returns DB row + file metadata + token usage + tmux active
// state in one shape. TTL-cached to dedupe parallel callers (sidebar polling +
// status bar polling on the same session would otherwise hit disk twice).
const _sessionInfoCache = new Map();
const SESSION_INFO_TTL_MS = 2000;

function invalidateSessionInfoCache(sessionId) {
  if (sessionId) {
    _sessionInfoCache.delete(`${sessionId}:0`);
    _sessionInfoCache.delete(`${sessionId}:1`);
  } else {
    _sessionInfoCache.clear();
  }
}

async function getSessionInfo(sessionId, opts = {}) {
  if (!sessionId) return null;
  // includeTokens: when false, skip the per-CLI token-usage read. buildSessionList
  // sets this so a sidebar refresh isn't N JSONL re-reads (only the active session
  // bar polls /api/sessions/:id/tokens, which uses includeTokens=true).
  const includeTokens = opts.includeTokens !== false;
  // Cache key includes the includeTokens flag so a no-tokens entry doesn't satisfy
  // a later tokens-required call.
  const cacheKey = `${sessionId}:${includeTokens ? 1 : 0}`;
  const cached = _sessionInfoCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SESSION_INFO_TTL_MS) return cached.value;

  const dbRow = db.getSessionFull(sessionId);
  if (!dbRow) {
    _sessionInfoCache.set(cacheKey, { ts: Date.now(), value: null });
    return null;
  }

  const cliType = dbRow.cli_type || 'claude';
  let fileMeta = null;
  let tokens = { input_tokens: 0, model: null, max_tokens: 200000 };

  if (cliType === 'claude') {
    const sDir = sessionsDir(dbRow.project_path);
    const jsonlFile = join(sDir, `${sessionId}.jsonl`);
    fileMeta = await parseSessionFile(jsonlFile);
    // getTokenUsage's second arg is the project NAME (it does db.getProject(name)
    // internally to resolve the path). dbRow.project_name is the right key.
    if (includeTokens) tokens = await getTokenUsage(sessionId, dbRow.project_name);
  } else if (cliType === 'gemini') {
    if (dbRow.cli_session_id) {
      const sessions = discoverGeminiSessions();
      const target = sessions.find(g => g.sessionId === dbRow.cli_session_id);
      if (target) {
        fileMeta = {
          name: target.name,
          timestamp: target.timestamp,
          messageCount: target.messageCount,
          model: target.model,
        };
      }
    }
    if (includeTokens) tokens = _getGeminiTokenUsage(sessionId);
  } else if (cliType === 'codex') {
    if (dbRow.cli_session_id) {
      const sessions = discoverCodexSessions();
      const target = sessions.find(c => {
        const rolloutName = basename(c.filePath, '.jsonl');
        const m = rolloutName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        return (m ? m[1] : rolloutName) === dbRow.cli_session_id;
      });
      if (target) {
        fileMeta = {
          name: target.name,
          timestamp: target.timestamp,
          messageCount: target.messageCount,
          model: target.model,
        };
      }
    }
    if (includeTokens) tokens = _getCodexTokenUsage(sessionId);
  }

  const tmux = safe.tmuxNameFor(sessionId);
  const active = await safe.tmuxExists(tmux);

  const info = {
    id: dbRow.id,
    project_id: dbRow.project_id,
    project_name: dbRow.project_name,
    project_path: dbRow.project_path,
    cli_type: cliType,
    cli_session_id: dbRow.cli_session_id || null,
    name: dbRow.name || fileMeta?.name || 'Untitled Session',
    state: dbRow.state || (dbRow.archived ? 'archived' : 'active'),
    archived: !!dbRow.archived,
    model_override: dbRow.model_override || null,
    model: dbRow.model_override || fileMeta?.model || tokens.model || null,
    input_tokens: tokens.input_tokens || 0,
    max_tokens: tokens.max_tokens || 200000,
    message_count: fileMeta?.messageCount || 0,
    timestamp: fileMeta?.timestamp || dbRow.updated_at,
    notes: dbRow.notes || '',
    created_at: dbRow.created_at,
    updated_at: dbRow.updated_at,
    tmux,
    active,
  };

  _sessionInfoCache.set(cacheKey, { ts: Date.now(), value: info });
  return info;
}

module.exports = {
  sessionsDir,
  parseSessionFile,
  parseGeminiChatFile,
  parseCodexRolloutFile,
  discoverGeminiSessions,
  discoverCodexSessions,
  extractMessageText,
  searchSessions,
  summarizeSession,
  getTokenUsage,
  getSessionInfo,
  invalidateSessionInfoCache,
  getSessionSlug,
  CLAUDE_HOME,
};
