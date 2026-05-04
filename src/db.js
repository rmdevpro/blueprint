'use strict';

const Database = require('better-sqlite3');
const { join } = require('path');
const { mkdirSync } = require('fs');

const DATA_DIR = process.env.WORKBENCH_DATA || join(process.env.HOME || '/data', '.workbench');
mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, 'workbench.db'));
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
try {
  db.exec("ALTER TABLE sessions ADD COLUMN cli_type TEXT DEFAULT 'claude'");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE session_meta ADD COLUMN model TEXT DEFAULT ''");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN cli_session_id TEXT DEFAULT NULL");
} catch (_e) {
  /* column exists */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN folder_path TEXT NOT NULL DEFAULT '/'");
} catch (_e) {
  /* column exists or table doesn't exist yet */
}
try {
  db.exec('ALTER TABLE tasks ADD COLUMN sort_order INTEGER DEFAULT 0');
} catch (_e) {
  /* column exists or table doesn't exist yet */
}
try {
  db.exec("ALTER TABLE tasks ADD COLUMN created_by TEXT DEFAULT 'human'");
} catch (_e) {
  /* column exists or table doesn't exist yet */
}
try {
  db.exec("ALTER TABLE task_history ADD COLUMN created_by TEXT DEFAULT 'human'");
} catch (_e) {
  /* column exists or table doesn't exist yet */
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
    cli_type TEXT DEFAULT 'claude',
    cli_session_id TEXT DEFAULT NULL,
    user_renamed INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_meta (
    session_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_mtime REAL NOT NULL,
    file_size INTEGER NOT NULL,
    name TEXT,
    timestamp TEXT,
    message_count INTEGER DEFAULT 0,
    model TEXT DEFAULT ''
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
    created_by TEXT DEFAULT 'human',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_task_history_task ON task_history(task_id);

  CREATE TABLE IF NOT EXISTS task_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    archived_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_task_folders_status ON task_folders(status);

  CREATE TABLE IF NOT EXISTS mcp_registry (
    name TEXT PRIMARY KEY,
    transport TEXT NOT NULL DEFAULT 'stdio',
    config TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mcp_project_enabled (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mcp_name TEXT NOT NULL REFERENCES mcp_registry(name) ON DELETE CASCADE,
    PRIMARY KEY (project_id, mcp_name)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    module TEXT,
    message TEXT NOT NULL,
    context TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_logs_ts        ON logs(ts);
  CREATE INDEX IF NOT EXISTS idx_logs_level_ts  ON logs(level, ts);
  CREATE INDEX IF NOT EXISTS idx_logs_module_ts ON logs(module, ts);
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
    INSERT INTO sessions (id, project_id, name, cli_type, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(sessions.name, excluded.name),
      cli_type = COALESCE(excluded.cli_type, sessions.cli_type),
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
    'SELECT s.*, p.name as project_name, p.path as project_path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = ?',
  ),
  searchSessionsByName: db.prepare(
    'SELECT s.*, p.name as project_name, p.path as project_path FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.name LIKE ? ORDER BY s.updated_at DESC LIMIT 20',
  ),
  setCliSessionId: db.prepare("UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?"),
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
  addTaskHistory: db.prepare('INSERT INTO task_history (task_id, event_type, old_value, new_value, created_by) VALUES (?, ?, ?, ?, ?)'),
  getTaskHistory: db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at DESC, id DESC'),
  maxSortOrder: db.prepare('SELECT MAX(sort_order) as max_sort FROM tasks WHERE folder_path = ?'),

  getAllTaskFolders: db.prepare('SELECT * FROM task_folders ORDER BY path ASC'),
  getTaskFoldersByStatus: db.prepare('SELECT * FROM task_folders WHERE status = ? ORDER BY path ASC'),
  getTaskFolder: db.prepare('SELECT * FROM task_folders WHERE id = ?'),
  getTaskFolderByPath: db.prepare('SELECT * FROM task_folders WHERE path = ?'),
  addTaskFolder: db.prepare('INSERT INTO task_folders (path, name, description) VALUES (?, ?, ?)'),
  updateTaskFolder: db.prepare("UPDATE task_folders SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?"),
  setTaskFolderStatus: db.prepare("UPDATE task_folders SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?"),
  deleteTaskFolder: db.prepare('DELETE FROM task_folders WHERE id = ?'),
  reparentTasks: db.prepare("UPDATE tasks SET folder_path = ?, updated_at = datetime('now') WHERE folder_path = ?"),
  reparentTasksUnderPrefix: db.prepare(
    "UPDATE tasks SET folder_path = ? || substr(folder_path, length(?) + 1), updated_at = datetime('now') WHERE folder_path = ? OR folder_path LIKE ? || '/%'"
  ),
  reparentFoldersUnderPrefix: db.prepare(
    "UPDATE task_folders SET path = ? || substr(path, length(?) + 1), updated_at = datetime('now') WHERE path LIKE ? || '/%'"
  ),

  getSessionMeta: db.prepare('SELECT * FROM session_meta WHERE session_id = ?'),
  getSessionMetaByPath: db.prepare('SELECT * FROM session_meta WHERE file_path = ?'),
  upsertSessionMeta: db.prepare(`
    INSERT INTO session_meta (session_id, file_path, file_mtime, file_size, name, timestamp, message_count, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime = excluded.file_mtime,
      file_size = excluded.file_size,
      name = excluded.name,
      timestamp = excluded.timestamp,
      message_count = excluded.message_count,
      model = excluded.model
  `),
  deleteSessionMeta: db.prepare('DELETE FROM session_meta WHERE session_id = ?'),

  // MCP registry
  getMcpServers: db.prepare('SELECT * FROM mcp_registry ORDER BY name'),
  getMcpServer: db.prepare('SELECT * FROM mcp_registry WHERE name = ?'),
  registerMcp: db.prepare('INSERT OR REPLACE INTO mcp_registry (name, transport, config, description) VALUES (?, ?, ?, ?)'),
  unregisterMcp: db.prepare('DELETE FROM mcp_registry WHERE name = ?'),
  enableMcpForProject: db.prepare('INSERT OR IGNORE INTO mcp_project_enabled (project_id, mcp_name) VALUES (?, ?)'),
  disableMcpForProject: db.prepare('DELETE FROM mcp_project_enabled WHERE project_id = ? AND mcp_name = ?'),
  getEnabledMcpForProject: db.prepare('SELECT m.* FROM mcp_registry m JOIN mcp_project_enabled e ON m.name = e.mcp_name WHERE e.project_id = ?'),

  // #181: log surfacing.
  // ts is stored as JS ISO8601 with millis ('2026-04-26T12:34:56.789Z'). The retention
  // sweep MUST compare in the same format — `datetime('now', ?)` returns SQLite's
  // 'YYYY-MM-DD HH:MM:SS' which is lexicographically NOT comparable to the ISO form.
  // Use strftime to emit matching format on both sides.
  insertLog: db.prepare('INSERT INTO logs (ts, level, module, message, context) VALUES (?, ?, ?, ?, ?)'),
  errorCountSince: db.prepare("SELECT COUNT(*) AS n FROM logs WHERE level = 'ERROR' AND ts >= ?"),
  topErrorSince: db.prepare("SELECT module, message, ts FROM logs WHERE level = 'ERROR' AND ts >= ? ORDER BY ts DESC LIMIT 1"),
  cleanupOldLogs: db.prepare("DELETE FROM logs WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"),
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
  upsertSession(id, projectId, name, cliType) {
    // If no cliType provided, check existing session to preserve its type
    const existing = stmts.getSession.get(id);
    const resolvedType = cliType || existing?.cli_type || 'claude';
    stmts.upsertSession.run(id, projectId, name, resolvedType);
    return stmts.getSession.get(id);
  },
  renameSession(id, name) {
    stmts.renameSession.run(name, id);
  },
  archiveSession(id, archived) {
    const arch = archived ? 1 : 0;
    stmts.archiveSession.run(arch, arch, id);
  },
  setCliSessionId(id, cliSessionId) {
    stmts.setCliSessionId.run(cliSessionId, id);
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
    stmts.addTaskHistory.run(id, 'created', null, title, createdBy);
    return { id, folder_path: folderPath, title, description, status: 'todo', sort_order: sortOrder, created_by: createdBy };
  },
  updateTaskTitle(id, title) {
    const old = stmts.getTask.get(id);
    if (!old) return;
    stmts.updateTaskTitle.run(title, id);
    stmts.addTaskHistory.run(id, 'renamed', old.title, title, 'human');
  },
  updateTaskDescription(id, description) {
    const old = stmts.getTask.get(id);
    if (!old) return;
    stmts.updateTaskDescription.run(description, id);
    stmts.addTaskHistory.run(id, 'description_changed', null, null, 'human');
  },
  updateTaskStatus(id, status) {
    const old = stmts.getTask.get(id);
    if (!old) return;
    if (status === 'done') {
      stmts.updateTaskStatusDone.run(id);
      stmts.addTaskHistory.run(id, 'completed', old.status, 'done', 'human');
    } else {
      stmts.updateTaskStatusOther.run(status, id);
      const event = status === 'archived' ? 'archived' : 'reopened';
      stmts.addTaskHistory.run(id, event, old.status, status, 'human');
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
    stmts.addTaskHistory.run(id, 'moved', old.folder_path, newFolderPath, 'human');
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
  addTaskComment(taskId, body, createdBy = 'human') {
    const info = stmts.addTaskHistory.run(taskId, 'comment', null, body, createdBy);
    return { id: info.lastInsertRowid, task_id: taskId, event_type: 'comment', new_value: body, created_by: createdBy };
  },

  getAllTaskFolders(filter) {
    if (!filter || filter === 'all') return stmts.getAllTaskFolders.all();
    return stmts.getTaskFoldersByStatus.all(filter);
  },
  getTaskFolder(id) {
    return stmts.getTaskFolder.get(id);
  },
  getTaskFolderByPath(path) {
    return stmts.getTaskFolderByPath.get(path);
  },
  addTaskFolder(path, name, description = '') {
    const info = stmts.addTaskFolder.run(path, name, description);
    return stmts.getTaskFolder.get(info.lastInsertRowid);
  },
  updateTaskFolder(id, name, description) {
    stmts.updateTaskFolder.run(name, description, id);
    return stmts.getTaskFolder.get(id);
  },
  setTaskFolderStatus(id, status) {
    stmts.setTaskFolderStatus.run(status, status, id);
    return stmts.getTaskFolder.get(id);
  },
  deleteTaskFolder(id) {
    stmts.deleteTaskFolder.run(id);
  },
  reparentTasks(fromPath, toPath) {
    stmts.reparentTasks.run(toPath, fromPath);
  },
  // Replace a path prefix on every task and every virtual folder rooted under
  // `fromPath`. Used to "move" the entire subtree to `toPath` when a folder
  // is deleted. Atomic via transaction.
  reparentSubtree(fromPath, toPath) {
    const run = db.transaction(() => {
      stmts.reparentTasksUnderPrefix.run(toPath, fromPath, fromPath, fromPath);
      stmts.reparentFoldersUnderPrefix.run(toPath, fromPath, fromPath);
    });
    run();
  },

  getSessionFull(id) {
    return stmts.getSessionFull.get(id);
  },
  searchSessionsByName(query) {
    return stmts.searchSessionsByName.all(`%${query}%`);
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
  upsertSessionMeta(sessionId, filePath, mtime, size, name, timestamp, messageCount, model) {
    stmts.upsertSessionMeta.run(sessionId, filePath, mtime, size, name, timestamp, messageCount, model || '');
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

  // MCP registry
  getMcpServers() {
    return stmts.getMcpServers.all();
  },
  getMcpServer(name) {
    return stmts.getMcpServer.get(name);
  },
  registerMcp(name, transport, config, description = '') {
    stmts.registerMcp.run(name, transport, JSON.stringify(config), description);
  },
  unregisterMcp(name) {
    stmts.unregisterMcp.run(name);
  },
  enableMcpForProject(projectId, mcpName) {
    stmts.enableMcpForProject.run(projectId, mcpName);
  },
  disableMcpForProject(projectId, mcpName) {
    stmts.disableMcpForProject.run(projectId, mcpName);
  },

  // #181: log surfacing
  insertLog(ts, level, mod, message, context) {
    stmts.insertLog.run(ts, level, mod, message, context);
  },
  errorCountSince(sinceTs) {
    return stmts.errorCountSince.get(sinceTs).n;
  },
  topErrorSince(sinceTs) {
    return stmts.topErrorSince.get(sinceTs) || null;
  },
  queryLogs({ level, module: mod, since, limit }) {
    const where = [];
    const params = [];
    if (level) { where.push('level = ?'); params.push(level); }
    if (mod) { where.push('module = ?'); params.push(mod); }
    if (since) { where.push('ts >= ?'); params.push(since); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // Clamp to [1, 5000]. Negative limits would otherwise reach SQLite where
    // LIMIT -1 means "no limit" — would let a caller dump the whole table.
    const parsed = parseInt(limit, 10);
    const lim = Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 200, 5000));
    return db.prepare(`SELECT id, ts, level, module, message, context FROM logs ${whereSql} ORDER BY ts DESC LIMIT ${lim}`).all(...params);
  },
  cleanupOldLogs(modifier = '-7 days') {
    return stmts.cleanupOldLogs.run(modifier).changes;
  },
  getEnabledMcpForProject(projectId) {
    return stmts.getEnabledMcpForProject.all(projectId);
  },
};
