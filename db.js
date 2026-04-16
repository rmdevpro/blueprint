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
  db.exec("ALTER TABLE projects ADD COLUMN state TEXT DEFAULT 'active'");
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
    state TEXT DEFAULT 'active',
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

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_path TEXT NOT NULL DEFAULT '/',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'todo',
    sort_order INTEGER DEFAULT 0,
    created_by TEXT DEFAULT 'human',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_folder ON tasks(folder_path);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

  CREATE TABLE IF NOT EXISTS task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id);
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
  setProjectState: db.prepare('UPDATE projects SET state = ? WHERE id = ?'),
  renameProject: db.prepare('UPDATE projects SET name = ? WHERE id = ?'),

  getAllTasks: db.prepare('SELECT * FROM tasks ORDER BY folder_path, sort_order ASC, id ASC'),
  getTasksByStatus: db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY folder_path, sort_order ASC, id ASC'),
  getTasksByFolder: db.prepare('SELECT * FROM tasks WHERE folder_path = ? ORDER BY sort_order ASC, id ASC'),
  getTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  addTask: db.prepare('INSERT INTO tasks (folder_path, title, description, sort_order, created_by) VALUES (?, ?, ?, ?, ?)'),
  updateTaskTitle: db.prepare("UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ?"),
  updateTaskDescription: db.prepare("UPDATE tasks SET description = ?, updated_at = datetime('now') WHERE id = ?"),
  updateTaskStatusDone: db.prepare("UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"),
  updateTaskStatusOther: db.prepare("UPDATE tasks SET status = ?, completed_at = NULL, updated_at = datetime('now') WHERE id = ?"),
  moveTask: db.prepare("UPDATE tasks SET folder_path = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?"),
  reorderTask: db.prepare("UPDATE tasks SET sort_order = ?, updated_at = datetime('now') WHERE id = ?"),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  addTaskHistory: db.prepare('INSERT INTO task_history (task_id, event_type, old_value, new_value) VALUES (?, ?, ?, ?)'),
  getTaskHistory: db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at DESC'),
  maxSortOrder: db.prepare('SELECT MAX(sort_order) as max_sort FROM tasks WHERE folder_path = ?'),

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
  setProjectState(projectId, state) {
    stmts.setProjectState.run(state, projectId);
  },
  renameProject(projectId, name) {
    stmts.renameProject.run(name, projectId);
  },
  getSessionNotes(sessionId) {
    const row = stmts.getSessionNotes.get(sessionId);
    return row?.notes || '';
  },
  setSessionNotes(sessionId, notes) {
    stmts.setSessionNotes.run(notes, sessionId);
  },

  // ── Tasks ────────────────────────────────────────────────────────────────
  getAllTasks(filter) {
    if (!filter || filter === 'all') return stmts.getAllTasks.all();
    return stmts.getTasksByStatus.all(filter);
  },
  getTasksByFolder(folderPath) {
    return stmts.getTasksByFolder.all(folderPath);
  },
  getTask(id) {
    return stmts.getTask.get(id);
  },
  addTask(folderPath, title, description = '', sortOrder, createdBy = 'human') {
    if (sortOrder == null) {
      const row = stmts.maxSortOrder.get(folderPath);
      sortOrder = (row?.max_sort ?? -1) + 1;
    }
    const info = stmts.addTask.run(folderPath, title, description, sortOrder, createdBy);
    const id = info.lastInsertRowid;
    stmts.addTaskHistory.run(id, 'created', null, title);
    return { id, folder_path: folderPath, title, description, status: 'todo', sort_order: sortOrder, created_by: createdBy };
  },
  updateTaskTitle(id, title) {
    const old = stmts.getTask.get(id);
    if (!old) return;
    stmts.updateTaskTitle.run(title, id);
    stmts.addTaskHistory.run(id, 'renamed', old.title, title);
  },
  updateTaskDescription(id, description) {
    const old = stmts.getTask.get(id);
    if (!old) return;
    stmts.updateTaskDescription.run(description, id);
    stmts.addTaskHistory.run(id, 'description_changed', null, null);
  },
  updateTaskStatus(id, status) {
    const old = stmts.getTask.get(id);
    if (!old) return;
    if (status === 'done') {
      stmts.updateTaskStatusDone.run(id);
      stmts.addTaskHistory.run(id, 'completed', old.status, 'done');
    } else {
      stmts.updateTaskStatusOther.run(status, id);
      const event = status === 'archived' ? 'archived' : 'reopened';
      stmts.addTaskHistory.run(id, event, old.status, status);
    }
  },
  moveTask(id, newFolderPath, sortOrder) {
    const old = stmts.getTask.get(id);
    if (!old) return;
    if (sortOrder == null) {
      const row = stmts.maxSortOrder.get(newFolderPath);
      sortOrder = (row?.max_sort ?? -1) + 1;
    }
    stmts.moveTask.run(newFolderPath, sortOrder, id);
    stmts.addTaskHistory.run(id, 'moved', old.folder_path, newFolderPath);
  },
  reorderTasks(orders) {
    const run = db.transaction(() => {
      for (const { id, sort_order } of orders) {
        stmts.reorderTask.run(sort_order, id);
      }
    });
    run();
  },
  deleteTask(id) {
    stmts.deleteTask.run(id);
  },
  getTaskHistory(taskId) {
    return stmts.getTaskHistory.all(taskId);
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
