'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshRequire() {
  const modPath = require.resolve('../../shared-state.js');
  delete require.cache[modPath];
  return require(modPath);
}

test('shared-state: initial browser count is zero', () => {
  const ss = freshRequire();
  assert.equal(ss.getBrowserCount(), 0);
});

test('shared-state: incrementBrowserCount increases and returns new count', () => {
  const ss = freshRequire();
  assert.equal(ss.incrementBrowserCount(), 1);
  assert.equal(ss.incrementBrowserCount(), 2);
  assert.equal(ss.getBrowserCount(), 2);
});

test('shared-state: decrementBrowserCount decreases and returns new count', () => {
  const ss = freshRequire();
  ss.incrementBrowserCount();
  ss.incrementBrowserCount();
  assert.equal(ss.decrementBrowserCount(), 1);
  assert.equal(ss.decrementBrowserCount(), 0);
});

test('shared-state: decrementBrowserCount floors at zero', () => {
  const ss = freshRequire();
  assert.equal(ss.decrementBrowserCount(), 0);
  assert.equal(ss.getBrowserCount(), 0);
  // Double-decrement: must not go negative
  ss.incrementBrowserCount();
  ss.decrementBrowserCount();
  ss.decrementBrowserCount();
  assert.equal(ss.getBrowserCount(), 0);
});

test('shared-state: sessionWsClients is a Map', () => {
  const ss = freshRequire();
  assert.ok(ss.sessionWsClients instanceof Map);
  assert.equal(ss.sessionWsClients.size, 0);
  // Verify it's usable as a session → ws client registry
  ss.sessionWsClients.set('bp_test', { id: 1 });
  assert.equal(ss.sessionWsClients.get('bp_test').id, 1);
  ss.sessionWsClients.delete('bp_test');
  assert.equal(ss.sessionWsClients.size, 0);
});
