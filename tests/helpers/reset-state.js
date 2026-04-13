'use strict';

const { execSync } = require('child_process');

const CONTAINER = process.env.TEST_CONTAINER || 'blueprint-test-blueprint-1';
const BASE_URL = process.env.TEST_URL || 'http://localhost:7867';

function dockerExec(cmd) {
  try {
    return execSync(`docker exec ${CONTAINER} ${cmd}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch {
    return '';
  }
}

async function resetBaseline(page = null) {
  try {
    execSync(
      `docker exec ${CONTAINER} sqlite3 /storage/blueprint.db "DELETE FROM sessions WHERE id LIKE 'test_%'; DELETE FROM tasks; DELETE FROM messages;"`,
      { stdio: 'ignore', timeout: 10000 },
    );
    execSync(
      `docker exec ${CONTAINER} sh -c "rm -f /storage/bridges/* && tmux ls -F '#{session_name}' 2>/dev/null | grep '^bp_' | xargs -I {} tmux kill-session -t {} 2>/dev/null || true"`,
      { stdio: 'ignore', timeout: 10000 },
    );
  } catch {
    /* best effort */
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
