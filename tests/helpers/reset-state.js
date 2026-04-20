'use strict';

const { execSync } = require('child_process');

const CONTAINER = process.env.TEST_CONTAINER || 'blueprint-test';
const BASE_URL = process.env.TEST_URL || 'http://localhost:7867';

function dockerExec(cmd) {
  try {
    return execSync(`docker exec -u blueprint ${CONTAINER} ${cmd}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch {
    return '';
  }
}

async function resetBaseline(page = null) {
  try {
    // Clean up test data but preserve the browser seed project (name = 'bp-seed')
    execSync(
      `docker exec -u blueprint ${CONTAINER} sqlite3 /data/.blueprint/blueprint.db "DELETE FROM sessions WHERE id LIKE 'test_%' OR id LIKE 'new_%' OR project_id IN (SELECT id FROM projects WHERE (name LIKE '%_proj' OR name LIKE 'test_%') AND name != 'bp-seed'); DELETE FROM projects WHERE (name LIKE '%_proj' OR name LIKE 'test_%') AND name != 'bp-seed'; DELETE FROM tasks; DELETE FROM task_history;"`,
      { stdio: 'ignore', timeout: 10000 },
    );
    execSync(
      `docker exec -u blueprint ${CONTAINER} sh -c "tmux ls -F '#{session_name}' 2>/dev/null | grep '^bp_' | xargs -I {} tmux kill-session -t {} 2>/dev/null || true"`,
      { stdio: 'ignore', timeout: 10000 },
    );
  } catch {
    /* best effort */
  }

  // Seed a browser test project with exactly 2 sessions so browser tests have data to render.
  // Clean all bp-seed sessions first to prevent accumulation across test runs.
  try {
    execSync(`docker exec -u blueprint ${CONTAINER} mkdir -p /data/workspace/bp-seed`, {
      stdio: 'ignore',
      timeout: 5000,
    });
    // Delete all bp-seed sessions to ensure exactly 2 after re-seeding
    execSync(
      `docker exec -u blueprint ${CONTAINER} sqlite3 /data/.blueprint/blueprint.db "DELETE FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE name = 'bp-seed');"`,
      { stdio: 'ignore', timeout: 5000 },
    );
    // Ensure bp-seed project exists
    await fetch(`${BASE_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/data/workspace/bp-seed', name: 'bp-seed' }),
    }).catch(() => null);
    // Create exactly 2 seed sessions using terminals (bash), NOT Claude sessions.
    // Claude sessions die immediately without auth, crashing the tmux server. (See #87)
    await fetch(`${BASE_URL}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'bp-seed' }),
    }).catch(() => null);
    await fetch(`${BASE_URL}/api/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'bp-seed' }),
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
