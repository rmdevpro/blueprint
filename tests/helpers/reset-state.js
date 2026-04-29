'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const CONTAINER = process.env.TEST_CONTAINER || 'workbench-test';
const BASE_URL = process.env.TEST_URL || 'http://localhost:7867';

// Detect whether we're running INSIDE a container — `docker exec` is not
// available from inside (no socket); shell out directly instead. The
// presence of /.dockerenv is the standard heuristic. Lets the live tests
// run via `docker exec workbench npm run test:live` without the harness
// needing a separate workbench-test container side-by-side.
const _IN_CONTAINER = fs.existsSync('/.dockerenv');

function dockerExec(cmd) {
  try {
    if (_IN_CONTAINER) {
      // Already inside the container — skip the docker exec wrapper. Tests
      // were authored as if running outside, so the user the command runs
      // as is whatever the container started as (workbench in deployed image).
      return execSync(cmd, { encoding: 'utf-8', timeout: 30000, shell: '/bin/sh' }).trim();
    }
    return execSync(`docker exec -u workbench ${CONTAINER} ${cmd}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch {
    return '';
  }
}

async function resetBaseline(page = null) {
  try {
    const sqlReset = `sqlite3 /data/.workbench/workbench.db "DELETE FROM sessions WHERE id LIKE 'test_%' OR id LIKE 'new_%' OR project_id IN (SELECT id FROM projects WHERE (name LIKE '%_proj' OR name LIKE 'test_%') AND name != 'wb-seed'); DELETE FROM projects WHERE (name LIKE '%_proj' OR name LIKE 'test_%') AND name != 'wb-seed'; DELETE FROM tasks; DELETE FROM task_history;"`;
    const tmuxKill = `sh -c "tmux ls -F '#{session_name}' 2>/dev/null | grep '^wb_' | xargs -I {} tmux kill-session -t {} 2>/dev/null || true"`;
    if (_IN_CONTAINER) {
      execSync(sqlReset, { stdio: 'ignore', timeout: 10000, shell: '/bin/sh' });
      execSync(tmuxKill, { stdio: 'ignore', timeout: 10000, shell: '/bin/sh' });
    } else {
      execSync(`docker exec -u workbench ${CONTAINER} ${sqlReset}`, { stdio: 'ignore', timeout: 10000 });
      execSync(`docker exec -u workbench ${CONTAINER} ${tmuxKill}`, { stdio: 'ignore', timeout: 10000 });
    }
  } catch {
    /* best effort */
  }

  // Seed a browser test project with exactly 2 sessions so browser tests have data to render.
  // Clean all wb-seed sessions first to prevent accumulation across test runs.
  try {
    const mkdirCmd = 'mkdir -p /data/workspace/wb-seed';
    const seedDeleteCmd = `sqlite3 /data/.workbench/workbench.db "DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE name = 'wb-seed');"`;
    if (_IN_CONTAINER) {
      execSync(mkdirCmd, { stdio: 'ignore', timeout: 5000, shell: '/bin/sh' });
      execSync(seedDeleteCmd, { stdio: 'ignore', timeout: 5000, shell: '/bin/sh' });
    } else {
      execSync(`docker exec -u workbench ${CONTAINER} ${mkdirCmd}`, { stdio: 'ignore', timeout: 5000 });
      execSync(`docker exec -u workbench ${CONTAINER} ${seedDeleteCmd}`, { stdio: 'ignore', timeout: 5000 });
    }
    // Ensure wb-seed project exists
    await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/data/workspace/wb-seed', name: 'wb-seed' }),
    }).catch(() => null);
    // Create exactly 2 seed sessions using terminals (bash), NOT Claude sessions.
    // Claude sessions die immediately without auth, crashing the tmux server. (See #87)
    await fetch(`${BASE_URL}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'wb-seed' }),
    }).catch(() => null);
    await fetch(`${BASE_URL}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'wb-seed' }),
    }).catch(() => null);
  } catch {
    /* seed is best-effort */
  }

  if (page) {
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        document
          .querySelectorAll(
            '[id^="new-session-overlay-"], [id^="config-overlay-"], [id^="summary-overlay-"]',
          )
          .forEach((m) => m.remove());
        const sm = document.getElementById('settings-modal');
        if (sm) sm.classList.remove('visible');
        const am = document.getElementById('auth-modal');
        if (am) am.classList.remove('visible');
      });
    } catch {
      /* page may not be ready */
    }
  }
}

module.exports = { resetBaseline, dockerExec, CONTAINER, BASE_URL };
