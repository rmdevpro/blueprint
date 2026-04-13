# Blueprint Server

Modular server for managing Claude AI coding sessions via tmux, with smart compaction, terminal streaming, and project management.

## Architecture

The monolithic `server.js` has been decomposed into focused modules using factory-based dependency injection:

| Module                | Responsibility                                                                   |
| --------------------- | -------------------------------------------------------------------------------- |
| `server.js`           | Wiring layer: constructs modules, injects deps, starts server                    |
| `routes.js`           | HTTP boundary: all 40+ route handlers with input validation                      |
| `compaction.js`       | Smart compaction pipeline with 3-phase orchestration (prep → compact → recover)  |
| `watchers.js`         | Filesystem monitoring: JSONL watchers, settings sync, compaction polling         |
| `tmux-lifecycle.js`   | tmux session creation, cleanup, limit enforcement                                |
| `ws-terminal.js`      | WebSocket ↔ PTY terminal bridge with backpressure handling                       |
| `session-resolver.js` | Async temp→real session ID resolution                                            |
| `shared-state.js`     | Shared runtime state (WebSocket client map, browser count)                       |
| `db.js`               | SQLite-backed persistent storage with WAL mode                                   |
| `config.js`           | Externalized configuration with in-memory cache and hot-reload via file watchers |
| `logger.js`           | Structured JSON logging (stdout/stderr)                                          |
| `keepalive.js`        | OAuth token refresh with configurable timing (fully async)                       |

Supporting modules: `mcp-server.js`, `mcp-tools.js`, `mcp-external.js`, `openai-compat.js`, `quorum.js`, `webhooks.js`, `safe-exec.js`, `session-utils.js`.

### Dependency Graph

Factory-constructed modules receive all cross-module dependencies via injection through `server.js`. Foundational leaf modules (`db`, `logger`, `safe-exec`, `config`) are imported directly by modules that need them:

```
logger.js, shared-state.js          (leaf — no deps)
config.js                           (leaf — reads config files, caches in memory, hot-reloads via watchers)
db.js                               (leaf — SQLite)
safe-exec.js                        (leaf — child process wrappers, async tmux operations)
session-utils.js                    (imports: safe, db, config, logger)
keepalive.js                        (factory — deps: safe, config, logger; fully async token reads)
tmux-lifecycle.js                   (factory — deps: safe, logger)
session-resolver.js                 (factory — deps: tmux fns, db, safe, config, logger)
compaction.js                       (factory — deps: tmux fns, db, safe, config, session-utils, logger)
watchers.js                         (factory — deps: shared-state, db, safe, config, session-utils, logger)
                                    (receives checkCompactionNeeds via injection)
ws-terminal.js                      (factory — deps: shared-state, safe, keepalive, config, logger)
                                    (receives tmux fns and watcher fns via injection)
routes.js                           (deps: db, safe, config, session-utils, keepalive, logger)
                                    (receives tmux, resolver, compaction fns via injection)
server.js                           (wiring — constructs all, injects deps, calls config.init(), starts server)
```

## Quick Start

1. Copy `.env.example` to `.env` and configure paths:

   ```bash
   cp .env.example .env
   ```

2. Build and run:

   ```bash
   docker build -t blueprint-server .
   docker run -p 3000:3000 --env-file .env \
     -v /path/to/workspace:/workspace \
     blueprint-server
   ```

3. Open `http://localhost:3000` in your browser.

## Configuration

All tunables are externalized in `.env` (see `.env.example` for complete list) and `config/defaults.json`:

- **Server**: `PORT`, `WORKSPACE`, `CLAUDE_HOME`, `BLUEPRINT_DATA`
- **Resources**: `MAX_TMUX_SESSIONS`, `TMUX_CLEANUP_MINUTES`
- **Logging**: `LOG_LEVEL` (DEBUG, INFO, WARN, ERROR)
- **Compaction**: Poll intervals, capture lines, thresholds, `compaction.checkerModel` (default: `claude-haiku`), timeouts, `planModeTimeoutMs`, `waitForPromptTimeoutMs`, `planExitSleepMs`, `progressLogIntervalMs`
- **Keepalive**: `KEEPALIVE_MODE`, `KEEPALIVE_IDLE_MINUTES`, timing thresholds via config, `keepalive.queryTimeoutMs`, prompts externalized to `config/prompts/keepalive-*.md`
- **API**: File size limits, bridge timeouts (`bridge.cleanupSentMs`, `bridge.cleanupUnsentMs`), login timeouts
- **WebSocket**: Buffer watermarks, `ws.pingIntervalMs`
- **Claude**: `claude.defaultTimeoutMs` (default 120000) — used across all Claude CLI invocations
- **Session**: `session.summaryModel`, `session.summaryMaxTranscriptChars`, `session.summaryMaxMessageChars`, `session.promptInjectionDelayMs`
- **Validation**: Max lengths for project names (255), session names (255), prompts (50000), messages (100000), search queries (200), task text (1000), notes (100000)

### Config Hot-Reload

`config.js` loads `defaults.json` synchronously at startup (fail-fast on corrupt JSON per ERQ-001 §6.4) and caches in memory. A `fs.watchFile` listener asynchronously updates the cache on file changes. Prompt templates are similarly cached and watched. `config.get()` and `config.getPrompt()` never perform blocking I/O during request processing.

## Input Validation

All API endpoints validate inputs:

- Project names: max 255 characters
- Session names: max 255 characters
- Prompt text: max 50,000 characters
- Message content: max 100,000 characters
- Task text: max 1,000 characters
- Notes: max 100,000 characters
- OpenAI compat prompt: max 100KB
- Model parameter: validated against `/^[a-zA-Z0-9._:-]+$/`
- Session IDs: validated against `/^[a-zA-Z0-9_-]{1,64}$/` (plus `new_*` and `t_*` prefixes)
- Session state: validated against `['active', 'archived', 'hidden']`
- Search queries: max 200 characters
- Keepalive idle minutes: 1–1440
- MCP tool inputs: task_id numeric validation, session_id format validation, content length limits

## Smart Compaction Pipeline

The compaction system monitors token usage and orchestrates context compaction:

1. **Monitoring**: `watchers.js` polls JSONL files; `compaction.js` checks token usage against configurable thresholds (advisory 65%, warning 75%, urgent 85%, auto 90%).
2. **Phase 1 (PREP)**: Enters plan mode, coordinates with checker model to prepare for compaction. Logs start/complete with duration at INFO.
3. **Phase 2 (COMPACT)**: Sends `/compact` command, waits for prompt to return. Logs start/complete with duration at INFO. Periodic progress logs every 60 seconds during long waits.
4. **Phase 3 (RECOVERY)**: Provides conversation tail to checker for context restoration. Logs start/complete with duration, `resumeComplete`, and `turnsUsed` at INFO.

### Verbose Pipeline Logging

Set `compaction.verbose: true` in `config/defaults.json` to enable detailed per-stage logging including checker model interactions, blueprint evaluations, and intermediate outputs. Stage start/complete with duration is always logged at INFO level regardless of verbose setting.

### Auto-Compaction Timers

Auto-compaction timers use `.unref()` so they don't prevent process exit during shutdown.

## MCP Server Registration

On startup, `watchers.js` registers a Blueprint MCP server in Claude's `settings.json`. Registration checks both presence and correctness of the `args` path — if the server has moved, the registration is updated. The MCP server (`mcp-server.js`) runs as a standalone subprocess spawned by Claude, providing tools via JSON-RPC over stdio.

## Health Endpoint

`GET /health` returns 200 when healthy, 503 when degraded, with per-dependency status:

```json
{ "status": "ok", "dependencies": { "db": "healthy", "workspace": "healthy", "auth": "healthy" } }
```

Auth status is informational only — it does not affect the overall healthy/degraded determination. Only `db` and `workspace` affect the HTTP status code.

## Filesystem Access

Blueprint is a single-user, Docker-containerized IDE. Per AD-001, it intentionally provides full filesystem access to the user through `/api/browse`, `/api/file`, and the jqueryfiletree connector. No path containment checks are applied to these endpoints to support external file mounts (NFS, bind mounts) that may reside outside the workspace directory.

Plan file operations (`blueprint_read_plan`, `blueprint_update_plan`) do enforce path containment within `BLUEPRINT_DATA/plans` using symlink-aware async validation, as these are internal data structures.

## Compliance

- **ERQ-001**: Structured JSON logging, async I/O in all async paths (keepalive fully async, quorum fully async, tmux send operations async via `tmuxSendKeysAsync`/`tmuxSendKeyAsync`, git clone async, config reads from in-memory cache), specific exception handling with context, health endpoint with dependency status, graceful degradation, externalized config (including keepalive timing/prompts, Claude timeouts, summary model, bridge cleanup timeouts, WS ping interval), pipeline verbose mode with progress logging, fail-fast on corrupt defaults.json, idempotent session resolution and MCP registration, input validation with length limits, format checks, and enum validation.
- **WPR-104**: Complete runnable artifact with no stubs. All functionality fully implemented.
- **Security**: Input length limits, model parameter sanitization, state enum validation, settings key validation, no hardcoded credentials. Full filesystem access per AD-001 design intent.

## Known Limitations

- `node-pty.spawn()` is synchronous by design (native C++ addon). This is standard across all Node.js terminal emulators including VS Code. Documented with ERQ-001 §4.1 TODO. PTY spawn is injectable via `spawnPty` parameter for testability.
- `tmuxCreateClaude` and `tmuxCreateBash` use synchronous tmux commands internally for atomic session setup (new-session + set-option). These are sub-millisecond operations.
- `resolveCheckerSessionId` uses a mtime-based heuristic that may select the wrong JSONL under concurrent Claude processes. Impact is limited to checker session continuity loss (it restarts cleanly).

See `Issue_Log.md` for full compliance audit trail.
