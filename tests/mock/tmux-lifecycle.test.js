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
          return 'bp_old 1\nbp_new 2\n';
        if (args[0] === 'list-sessions' && args[2] === '#{session_name}') return 'bp_one\nbp_two\n';
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

test('TMX-01: tmuxName uses bp_ prefix and truncates to 12 chars of ID', () => {
  const { lifecycle } = makeLifecycle();
  const name = lifecycle.tmuxName('abcdefghijklmnop');
  assert.match(name, /^bp_/);
  assert.equal(name, 'bp_abcdefghijkl');
});

test('TMX-02: tmuxExists delegates to safe', async () => {
  const { lifecycle } = makeLifecycle({ existing: ['bp_abc'] });
  assert.equal(await lifecycle.tmuxExists('bp_abc'), true);
  assert.equal(await lifecycle.tmuxExists('bp_missing'), false);
});

test('TMX-06: scheduleTmuxCleanup kills idle session after delay', async () => {
  const { lifecycle, killed, onKilled } = makeLifecycle({ existing: ['bp_dead'], delay: 5 });
  lifecycle.scheduleTmuxCleanup('bp_dead');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(killed, ['bp_dead']);
  assert.deepEqual(onKilled, ['bp_dead']);
});

test('TMX-07: cancelTmuxCleanup prevents kill', async () => {
  const { lifecycle, killed } = makeLifecycle({ existing: ['bp_alive'], delay: 20 });
  lifecycle.scheduleTmuxCleanup('bp_alive');
  lifecycle.cancelTmuxCleanup('bp_alive');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(killed, []);
});

test('TMX-08: enforceTmuxLimit kills oldest bp_ sessions over limit', async () => {
  const { lifecycle, killed } = makeLifecycle({
    max: 1,
    tmuxExecAsync: async () => 'bp_a 10\nbp_b 20\nbp_c 30\n',
  });
  await lifecycle.enforceTmuxLimit();
  assert.deepEqual(killed, ['bp_a', 'bp_b']);
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

test('TMX-09: cleanOrphanedTmuxSessions kills all bp_ sessions', async () => {
  const { lifecycle, killed } = makeLifecycle({
    tmuxExecAsync: async () => 'bp_one\nbp_two\nregular\n',
  });
  await lifecycle.cleanOrphanedTmuxSessions();
  assert.deepEqual(killed, ['bp_one', 'bp_two']);
});



test('sleep resolves after delay', async () => {
  const { lifecycle } = makeLifecycle();
  const start = Date.now();
  await lifecycle.sleep(10);
  assert.ok(Date.now() - start >= 8);
});
