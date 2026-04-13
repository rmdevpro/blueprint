'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { post } = require('../helpers/http-client');

test('CMP: smart-compact API rejects invalid session with 400', async () => {
  const r = await post('/api/sessions/nonexistent_session/smart-compact', { project: 'test' });
  // A nonexistent session must be rejected. Accepting 200 OR 400 masks bugs where
  // the server silently accepts invalid input or crashes with 500.
  // The correct behavior is either:
  //   - 400 if the route validates session existence before processing
  //   - 200 with compacted:false if the compaction logic handles missing sessions gracefully
  // We assert the specific expected behavior:
  if (r.status === 200) {
    // If 200, the response MUST indicate compaction did NOT happen
    assert.equal(
      r.data.compacted,
      false,
      'Smart-compact for nonexistent session must return compacted:false',
    );
    assert.ok(
      r.data.reason,
      'Response must include a reason explaining why compaction was skipped',
    );
  } else {
    assert.equal(
      r.status,
      400,
      `Expected 400 for nonexistent session, got ${r.status}. A 500 would indicate an unhandled crash.`,
    );
  }
});

test('CMP: smart-compact requires project parameter', async () => {
  const r = await post('/api/sessions/test_session/smart-compact', {});
  assert.equal(r.status, 400, 'Missing project parameter must return 400');
  // Verify the error message mentions the missing parameter
  const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  assert.ok(
    body.toLowerCase().includes('project'),
    `Error response must mention 'project' parameter, got: ${body.substring(0, 200)}`,
  );
});
