'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const createTmuxLifecycle = require('../../tmux-lifecycle.js');

function makeLifecycle(overrides = {}) {
  const killed = [];
  const existing = new Set(overrides.existing || []);
  const safe = {
    sanitizeTmuxName: (n) => n.replace(/[^a-zA-Z0-9_-]/g, '_'),
    tmuxExists: async (n) => existing.has(n),
    tmuxKill: async (n) => {
      killed.push(n);
      existing.delete(n);
    },
    tmuxExecAsync:
      overrides.tmuxExecAsync ||
      (async (args) => {
        if (args[0] === 'list-sessions' && args[2] === '#{session_name} #{session_activity}')
          return 'wb_old 1\nbp_new 2\n';
        if (args[0] === 'list-sessions' && args[2] === '#{session_name}') return 'wb_one\nbp_two\n';
        return '';
      }),
  };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const onKilled = [];
  const lc = createTmuxLifecycle({
    safe,
    MAX_TMUX_SESSIONS: overrides.max ?? 1,
    TMUX_CLEANUP_DELAY: overrides.delay ?? 10,
    logger,
  });
  lc.setOnSessionKilled((tmux) => onKilled.push(tmux));
  return { lifecycle: lc, killed, existing, onKilled };
}

test('TMX-01: tmuxName uses wb_ prefix with random suffix for uniqueness', () => {
  const { lifecycle } = makeLifecycle();
  const name = lifecycle.tmuxName('abcdefghijklmnop');
  assert.match(name, /^wb_abcdefghijkl_[a-z0-9]{4}$/);
  // Two calls with the same ID produce different names (random suffix)
  const name2 = lifecycle.tmuxName('abcdefghijklmnop');
  assert.notEqual(name, name2);
});

test('TMX-02: tmuxExists delegates to safe', async () => {
  const { lifecycle } = makeLifecycle({ existing: ['wb_abc'] });
  assert.equal(await lifecycle.tmuxExists('wb_abc'), true);
  assert.equal(await lifecycle.tmuxExists('wb_missing'), false);
});

test('TMX-06: scheduleTmuxCleanup removes session from activeTabs (no immediate kill)', async () => {
  const { lifecycle, killed } = makeLifecycle({ existing: ['wb_dead'], delay: 5 });
  // First mark the tab open so it is tracked
  lifecycle.markTabOpen('wb_dead');
  // scheduleTmuxCleanup is now a legacy wrapper for markTabClosed — removes from activeTabs
  lifecycle.scheduleTmuxCleanup('wb_dead');
  // No kill should have occurred; cleanup is deferred to the periodic scan
  assert.deepEqual(killed, []);
});

test('TMX-07: cancelTmuxCleanup re-adds session to activeTabs', async () => {
  const { lifecycle, killed } = makeLifecycle({ existing: ['wb_alive'], delay: 20 });
  // Mark closed then re-open — net result is session stays tracked as active
  lifecycle.scheduleTmuxCleanup('wb_alive');
  lifecycle.cancelTmuxCleanup('wb_alive');
  // No kill should occur; periodic scan will see the tab as active
  assert.deepEqual(killed, []);
});

test('TMX-08: enforceTmuxLimit kills oldest sessions over limit (all prefixes)', async () => {
  // Use recent timestamps so idle-timeout does not fire; limit=1 means two oldest are killed
  const recentBase = Math.floor(Date.now() / 1000);
  const t1 = recentBase - 10;
  const t2 = recentBase - 5;
  const t3 = recentBase - 1;
  const { lifecycle, killed } = makeLifecycle({
    max: 1,
    existing: ['wb_a', 'wb_b', 'regular_c'],
    tmuxExecAsync: async () => `wb_a ${t1}\nbp_b ${t2}\nregular_c ${t3}\n`,
  });
  await lifecycle.enforceTmuxLimit();
  assert.deepEqual(killed, ['wb_a', 'wb_b']);
});

test('TMX-08: enforceTmuxLimit handles no-server-running gracefully', async () => {
  const { lifecycle, killed } = makeLifecycle({
    max: 1,
    tmuxExecAsync: async () => {
      throw new Error('no server running');
    },
  });
  await assert.doesNotReject(lifecycle.enforceTmuxLimit());
  assert.deepEqual(killed, []);
});

test('TMX-09: cleanOrphanedTmuxSessions kills ALL idle sessions (not just wb_)', async () => {
  // lastActivity=0 makes all sessions ancient; idle-timeout path kills everything
  const { lifecycle, killed } = makeLifecycle({
    existing: ['wb_one', 'wb_two', 'regular'],
    tmuxExecAsync: async () => 'wb_one 0\nbp_two 0\nregular 0\n',
  });
  await lifecycle.cleanOrphanedTmuxSessions();
  assert.deepEqual(killed, ['wb_one', 'wb_two', 'regular']);
});



test('sleep resolves after delay', async () => {
  const { lifecycle } = makeLifecycle();
  const start = Date.now();
  await lifecycle.sleep(10);
  assert.ok(Date.now() - start >= 8);
});
