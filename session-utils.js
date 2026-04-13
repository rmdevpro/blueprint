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
      };
    }

    const content = await readFile(filepath, 'utf-8');
    const lines = content.trim().split('\n');
    let name = null;
    let timestamp = null;
    let messageCount = 0;

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
    };

    db.upsertSessionMeta(
      sessionId,
      filepath,
      mtime,
      size,
      result.name,
      result.timestamp,
      result.messageCount,
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

async function searchSessions(query, projectFilter, maxResults = 15) {
  const q = query.toLowerCase();
  const results = [];
  const dbProjects = db.getProjects();

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

  return results.sort((a, b) => b.match_count - a.match_count).slice(0, maxResults);
}

async function summarizeSession(sessionId, project) {
  const dbProj = db.getProject(project);
  const projectPath = dbProj ? dbProj.path : join(WORKSPACE, project);
  const sDir = sessionsDir(projectPath);
  const jsonlFile = join(sDir, `${sessionId}.jsonl`);

  const content = await readFile(jsonlFile, 'utf-8');
  const lines = content.trim().split('\n');
  const messages = [];
  const maxTranscriptChars = config.get('session.summaryMaxTranscriptChars', 1500);
  const maxMessageChars = config.get('session.summaryMaxMessageChars', 500);
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

  if (messages.length === 0)
    return { summary: 'Empty session.', recent_messages: [], recentMessages: [] };

  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'Human' : 'Claude'}: ${m.text}`)
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
    logger.error('Failed to generate session summary', {
      module: 'session-utils',
      sessionId: sessionId.substring(0, 8),
      err: err.message,
    });
    const recent = messages.slice(-3);
    return {
      summary: 'Failed to generate summary: ' + (err.message?.substring(0, 100) || 'unknown error'),
      recent_messages: recent,
      recentMessages: recent,
    };
  }
}

async function getTokenUsage(sessionId, project) {
  if (sessionId.startsWith('new_')) return { input_tokens: 0, model: null, max_tokens: 200000 };
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

module.exports = {
  sessionsDir,
  parseSessionFile,
  extractMessageText,
  searchSessions,
  summarizeSession,
  getTokenUsage,
  getSessionSlug,
  CLAUDE_HOME,
};
