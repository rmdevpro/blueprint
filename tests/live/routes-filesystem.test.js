'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { get } = require('../helpers/http-client');

test('FS-01: /api/mounts returns array', async () => {
  const r = await get('/api/mounts');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data));
});

test('FS-02: /api/browse returns listing and hides dot dirs', async () => {
  const r = await get('/api/browse?path=/workspace');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.entries));
  for (const entry of r.data.entries) {
    assert.ok(!entry.name.startsWith('.'), `Dot directory ${entry.name} should be hidden`);
  }
});

test('FS-03: /api/file reads file content for accessible path', async () => {
  // /etc/hostname is a standard file in Docker containers.
  // The correct behavior is 200 with content. If the route restricts access,
  // it should return 403 (forbidden), not 400 (bad request).
  // We no longer accept [200, 400] — that masks regressions.
  const r = await get('/api/file?path=/etc/hostname');
  if (r.status === 200) {
    // Success: verify content is a non-empty hostname string
    const content = typeof r.data === 'string' ? r.data : r.data.content || '';
    assert.ok(content.trim().length > 0, 'File content for /etc/hostname must be non-empty');
  } else if (r.status === 403) {
    // Acceptable: route restricts file access outside workspace
    assert.ok(true, 'Route restricts access to files outside workspace');
  } else {
    assert.fail(
      `Expected 200 (readable) or 403 (restricted), got ${r.status}. ` +
        `400 would indicate a route bug, 500 would indicate an unhandled crash.`,
    );
  }
});

test('FS-04: /api/file rejects path traversal', async () => {
  const r = await get('/api/file?path=../../../etc/shadow');
  assert.ok(
    r.status === 400 || r.status === 403,
    `Path traversal must be rejected with 400 or 403, got ${r.status}`,
  );
});
