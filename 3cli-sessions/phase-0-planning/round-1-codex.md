Here’s my plan for the refactor, grounded in the provided draft and the ERQ requirements, with additional safeguards for correctness, logging, and test coverage.

**Goals**

- Decompose `server.js` into focused modules without changing behavior.
- Remove bare `catch {}` blocks with explicit, contextual handling.
- Preserve runtime behavior and interfaces for tests and external callers.
- Ensure compliance with REQ-001 (logging, validation, async correctness, config handling).

**Target Module Breakdown**

- `shared-state.js`: `sessionWsClients`, browser count getters/setters.
- `tmux-lifecycle.js`: tmux naming, existence checks, cleanup timers, session limits.
- `session-resolver.js`: `resolveSessionId`, `resolveStaleNewSessions`.
- `compaction.js`: compaction flow + state/locks + helper stack.
- `watchers.js`: JSONL watchers, settings watcher, compaction monitor, MCP registration.
- `ws-terminal.js`: WS handler and upgrade glue.
- `routes.js`: all HTTP routes + auth helpers and trust dir.
- `server.js`: wiring/boot only.

**Dependency / Wiring Rules**

- Avoid cyclic dependencies; use dependency injection from `server.js`.
- Shared mutable state goes through `shared-state.js`.
- Cross-module callbacks (e.g., tmux session kill -> compaction state cleanup) injected in `server.js`.

**Error Handling & Logging**

- Replace all bare `catch {}` with:
  - `catch (err)` + debug/info when non-fatal and expected.
  - `catch (err)` + error when data loss, state corruption, or user-visible failure risk.
- Log to stdout/stderr only; avoid file logging.
- Keep messages short with context keys (session id, file path, route).
- Do not log secrets or full request bodies.

**Input Validation & Null Guards**

- Validate external inputs at route boundaries:
  - IDs, paths, JSON bodies, query params.
- Add explicit `null/undefined` checks before property access where needed.

**Async Correctness**

- Ensure no blocking I/O in async routes/handlers.
- Keep sync utilities in non-async functions or migrate to async versions.

**Extraction Order (Each Step Leaves Server Working)**

1. `shared-state.js`: extract Map + browser count; update imports.
2. `tmux-lifecycle.js`: extract tmux utilities, timers, limits; inject callbacks.
3. `session-resolver.js`: extract session id resolution logic.
4. `compaction.js`: extract compaction stack + state + helpers.
5. `watchers.js`: extract watchers and startup helpers.
6. `ws-terminal.js`: extract WS connection handler.
7. `routes.js`: extract all routes and auth helpers.
8. Update tests/imports for new module locations and exports.

**Testing & Verification**

- After each extraction:
  - `node -e "require('./server')"` to verify module load.
  - Mock test suite (`npm test`).
- After final step:
  - Live tests against refactor container.
  - Browser tests.
  - Manual smoke: create session, run prompt, confirm terminal and compaction behavior.
- Check for zero bare `catch {}` across new modules.

**Parallel Container (Safe Validation)**

- Create `docker-compose.refactor.yml` with separate port and data dirs.
- Run test suites against refactor container, then swap only after green.

**REQ-001 Compliance Checks**

- Code clarity: modules are single-responsibility, names explicit.
- Formatting/lint: run existing formatter/linter (if configured).
- Tests: add/adjust tests for moved functions and error paths.
- Logging: ensure JSON-friendly structure and levels where logging exists.
- Fail-fast config: validate essential env/config at startup, error clearly.

If you want, I can turn this into a step-by-step checklist or annotate it with the exact functions mapped per module from the current `server.js`.
