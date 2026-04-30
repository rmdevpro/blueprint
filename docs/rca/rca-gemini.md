# Root Cause Analysis: Live Integration Test Failures in Full Suite

## Executive Summary
Three live integration tests (`SES-03`, `WS-02/03`, `FRS-07`) fail when executed as a full suite but pass individually. The root cause is **concurrency conflict in a shared-state environment**. Multiple test files running in parallel compete for a limited number of tmux slots and perform destructive global cleanups on the same Docker container.

## Technical Findings

### 1. Parallel Test Execution
The `test:live` script in `package.json` uses `node --test tests/live/*.test.js`. By default, the Node.js test runner executes separate files in parallel. With approximately 18 test files in `tests/live/`, many are running simultaneously.

### 2. Resource Contention (`MAX_TMUX_SESSIONS`)
The `test:live` script sets `MAX_TMUX_SESSIONS=20`. 
- Each test file typically calls `resetBaseline()`, which seeds the environment with 2 terminal sessions.
- 18 files × 2 sessions = 36 sessions, which exceeds the limit of 20.
- When the limit is exceeded, `tmux-lifecycle.js:enforceTmuxLimit` automatically kills the "oldest" sessions. In a parallel burst, "oldest" can be a session just created by another test file a few seconds prior.

### 3. Aggressive Global Cleanup
Multiple tests (`SES-03`, `WS-02/03`, `FRS-07`) and the `reset-state.js` helper execute a global cleanup command:
`tmux ls -F '#{session_name}' | grep '^bp_' | xargs -I {} tmux kill-session -t {}`
When Test A and Test B run in parallel, Test A's cleanup kills the sessions Test B just created, leading to:
- **SES-03 / WS-02/03 failures:** The newly created session is killed before the test can verify its existence or connect to it.
- **"Failed to send initial prompt" errors:** `POST /api/sessions` schedules a prompt injection after 2 seconds. If the session is killed by a concurrent test's cleanup within that window, the injection fails with `cant find pane`.

### 4. Tmux Server Flapping
The error `no server running on /tmp/tmux-1001/default` occurs because the tmux server exits automatically when its last session is closed. Rapidly killing all sessions and then immediately attempting to create or list sessions across multiple parallel processes causes race conditions where the server is either shutting down or not yet fully restarted.

### 5. FRS-07 Orphan Detection
`FRS-07` in `fresh-container.test.js` kills all `bp_` sessions and waits 1.5 seconds to verify the count is 0. If any other test file creates a session during this 1.5-second window, `FRS-07` fails because it finds an "orphan."

## Recommendations

1. **Sequential Execution:** Modify the `test:live` script to run tests sequentially by adding `--test-concurrency=1`. This is the most robust fix for tests sharing a single container.
   ```json
   "test:live": "MAX_TMUX_SESSIONS=20 node --test --test-concurrency=1 tests/live/*.test.js"
   ```
2. **Increase Session Limit for Tests:** Increase `MAX_TMUX_SESSIONS` during test runs to provide more headroom, though this does not solve the global cleanup interference.
3. **Scoped Cleanup:** Modify tests to only kill the specific sessions they created, rather than using a global `grep '^bp_'` pattern, although `resetBaseline` should remain thorough for sequential runs.
