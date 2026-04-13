'use strict';

const Database = require('better-sqlite3');
const { join } = require('path');
const { mkdirSync } = require('fs');

const DATA_DIR =
  process.env.BLUEPRINT_DATA || join(process.env.HOME || '/home/hopper', '.blueprint');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'blueprint.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema Migrations (idempotent) ─────────────────────────────────────────
try {
  db.exec("ALTER TABLE projects ADD COLUMN notes TEXT DEFAULT ''");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN notes TEXT DEFAULT ''");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN state TEXT DEFAULT 'active'");
} catch (_e) {
  /* column exists */
}
try {
  db.exec('ALTER TABLE sessions ADD COLUMN model_override TEXT');
} catch (_e) {
  /* column exists */
}
try {
  db.exec('ALTER TABLE sessions ADD COLUMN user_renamed INTEGER DEFAULT 0');
} catch (_e) {
  /* column exists */
}
try {
  db.exec(
    "UPDATE sessions SET state = 'archived' WHERE archived = 1 AND (state IS NULL OR state = 'active')",
  );
} catch (_e) {
  /* already migrated */
}

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL UNIQUE,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT,
    archived INTEGER DEFAULT 0,
    state TEXT DEFAULT 'active',
    model_override TEXT,
    user_renamed INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    status TEXT DEFAULT 'todo',
    created_by TEXT DEFAULT 'human',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_session TEXT,
    to_session TEXT,
    content TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_meta (
    session_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_mtime REAL NOT NULL,
    file_size INTEGER NOT NULL,
    name TEXT,
    timestamp TEXT,
    message_count INTEGER DEFAULT 0
  );
`);

// ── Prepared Statements ────────────────────────────────────────────────────
const stmts = {
  getProjects: db.prepare('SELECT * FROM projects ORDER BY name'),
  getProject: db.prepare('SELECT * FROM projects WHERE name = ?'),
  getProjectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
  insertProject: db.prepare('INSERT OR IGNORE INTO projects (name, path) VALUES (?, ?)'),

  getSessions: db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  getSessionByPrefix: db.prepare(
    'SELECT s.*, p.name as project_name, p.path as project_path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id LIKE ? LIMIT 1',
  ),
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, project_id, name, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(sessions.name, excluded.name),
      updated_at = excluded.updated_at
  `),
  renameSession: db.prepare(
    "UPDATE sessions SET name = ?, user_renamed = 1, updated_at = datetime('now') WHERE id = ?",
  ),
  archiveSession: db.prepare(
    "UPDATE sessions SET archived = ?, state = CASE WHEN ? = 1 THEN 'archived' ELSE 'active' END, updated_at = datetime('now') WHERE id = ?",
  ),
  setSessionStateStmt: db.prepare(
    "UPDATE sessions SET archived = ?, state = ?, updated_at = datetime('now') WHERE id = ?",
  ),
  getSessionFull: db.prepare(
    'SELECT s.*, p.name as project_name FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?',
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  getSessionNotes: db.prepare('SELECT notes FROM sessions WHERE id = ?'),
  setSessionNotes: db.prepare('UPDATE sessions SET notes = ? WHERE id = ?'),

  getProjectNotes: db.prepare('SELECT notes FROM projects WHERE id = ?'),
  setProjectNotes: db.prepare('UPDATE projects SET notes = ? WHERE id = ?'),

  getTasks: db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC'),
  addTask: db.prepare('INSERT INTO tasks (project_id, text, created_by) VALUES (?, ?, ?)'),
  completeTask: db.prepare(
    "UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE id = ?",
  ),
  reopenTask: db.prepare("UPDATE tasks SET status = 'todo', completed_at = NULL WHERE id = ?"),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),

  getSessionMeta: db.prepare('SELECT * FROM session_meta WHERE session_id = ?'),
  getSessionMetaByPath: db.prepare('SELECT * FROM session_meta WHERE file_path = ?'),
  upsertSessionMeta: db.prepare(`
    INSERT INTO session_meta (session_id, file_path, file_mtime, file_size, name, timestamp, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime = excluded.file_mtime,
      file_size = excluded.file_size,
      name = excluded.name,
      timestamp = excluded.timestamp,
      message_count = excluded.message_count
  `),
  deleteSessionMeta: db.prepare('DELETE FROM session_meta WHERE session_id = ?'),

  getMessages: db.prepare(
    'SELECT * FROM messages WHERE project_id = ? AND to_session = ? AND read = 0 ORDER BY created_at ASC',
  ),
  getAllMessages: db.prepare(
    'SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 50',
  ),
  sendMessage: db.prepare(
    'INSERT INTO messages (project_id, from_session, to_session, content) VALUES (?, ?, ?, ?)',
  ),
  markRead: db.prepare('UPDATE messages SET read = 1 WHERE id = ?'),
};

module.exports = {
  db,
  DATA_DIR,

  getProjects() {
    return stmts.getProjects.all();
  },
  getProject(name) {
    return stmts.getProject.get(name);
  },
  getProjectById(id) {
    return stmts.getProjectById.get(id);
  },
  ensureProject(name, path) {
    stmts.insertProject.run(name, path);
    return stmts.getProject.get(name);
  },
  deleteProject(id) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  },

  getSessionsForProject(projectId) {
    return stmts.getSessions.all(projectId);
  },
  getSession(id) {
    return stmts.getSession.get(id);
  },
  getSessionByPrefix(prefix) {
    return stmts.getSessionByPrefix.get(prefix + '%');
  },
  upsertSession(id, projectId, name) {
    stmts.upsertSession.run(id, projectId, name);
    return stmts.getSession.get(id);
  },
  renameSession(id, name) {
    stmts.renameSession.run(name, id);
  },
  archiveSession(id, archived) {
    const arch = archived ? 1 : 0;
    stmts.archiveSession.run(arch, arch, id);
  },
  deleteSession(id) {
    stmts.deleteSession.run(id);
  },

  getProjectNotes(projectId) {
    const row = stmts.getProjectNotes.get(projectId);
    return row?.notes || '';
  },
  setProjectNotes(projectId, notes) {
    stmts.setProjectNotes.run(notes, projectId);
  },
  getSessionNotes(sessionId) {
    const row = stmts.getSessionNotes.get(sessionId);
    return row?.notes || '';
  },
  setSessionNotes(sessionId, notes) {
    stmts.setSessionNotes.run(notes, sessionId);
  },

  getTasks(projectId) {
    return stmts.getTasks.all(projectId);
  },
  addTask(projectId, text, createdBy = 'human') {
    const info = stmts.addTask.run(projectId, text, createdBy);
    return { id: info.lastInsertRowid, text, status: 'todo', created_by: createdBy };
  },
  completeTask(id) {
    stmts.completeTask.run(id);
  },
  reopenTask(id) {
    stmts.reopenTask.run(id);
  },
  deleteTask(id) {
    stmts.deleteTask.run(id);
  },

  getUnreadMessages(projectId, toSession) {
    return stmts.getMessages.all(projectId, toSession);
  },
  getRecentMessages(projectId) {
    return stmts.getAllMessages.all(projectId);
  },
  sendMessage(projectId, fromSession, toSession, content) {
    const info = stmts.sendMessage.run(projectId, fromSession, toSession, content);
    return { id: info.lastInsertRowid };
  },
  markMessageRead(id) {
    stmts.markRead.run(id);
  },

  getSessionFull(id) {
    return stmts.getSessionFull.get(id);
  },
  setSessionState(id, state) {
    const archived = state === 'archived' ? 1 : 0;
    stmts.setSessionStateStmt.run(archived, state, id);
  },

  getSessionMeta(sessionId) {
    return stmts.getSessionMeta.get(sessionId);
  },
  getSessionMetaByPath(filePath) {
    return stmts.getSessionMetaByPath.get(filePath);
  },
  upsertSessionMeta(sessionId, filePath, mtime, size, name, timestamp, messageCount) {
    stmts.upsertSessionMeta.run(sessionId, filePath, mtime, size, name, timestamp, messageCount);
  },
  deleteSessionMeta(sessionId) {
    stmts.deleteSessionMeta.run(sessionId);
  },
  cleanStaleMeta(validSessionIds) {
    const all = db.prepare('SELECT session_id FROM session_meta').all();
    for (const row of all) {
      if (!validSessionIds.has(row.session_id)) {
        stmts.deleteSessionMeta.run(row.session_id);
      }
    }
  },

  getSetting(key, defaultValue = null) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  },
  setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  },
  getAllSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch (err) {
        if (err instanceof SyntaxError) {
          settings[row.key] = row.value;
        } else {
          throw err;
        }
      }
    }
    return settings;
  },
};
