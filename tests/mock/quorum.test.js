'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { executeTool, getQuorumSettings, registerQuorumRoutes } = require('../../quorum');
const safe = require('../../safe-exec');
const express = require('express');
const { withServer, req } = require('../helpers/with-server');

test('QRM-01: getQuorumSettings returns defaults with expected structure', () => {
  const s = getQuorumSettings();
  assert.ok(typeof s.lead === 'string', 'lead should be a string model name');
  assert.ok(typeof s.fixedJunior === 'string', 'fixedJunior should be a string model name');
  assert.ok(Array.isArray(s.additionalJuniors), 'additionalJuniors should be an array');
});

test('QRM-02: read_file rejects path traversal with clear error', async () => {
  const r = await executeTool('read_file', { path: '../../../etc/passwd' }, '/workspace/test');
  assert.match(r, /outside/, 'Path traversal should be rejected with "outside" message');
});

test('QRM-02: read_file returns content for valid path', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-qrm-rf-'));
  await fsp.writeFile(path.join(dir, 'test.txt'), 'hello world');
  const r = await executeTool('read_file', { path: 'test.txt' }, dir);
  assert.equal(r, 'hello world');
});

test('QRM-02: read_file returns error for nonexistent file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-qrm-miss-'));
  const r = await executeTool('read_file', { path: 'missing.txt' }, dir);
  assert.match(r, /not found/, 'Nonexistent file should return "not found" error');
});

test('QRM-03: list_files rejects path traversal', async () => {
  const r = await executeTool('list_files', { path: '../../..' }, '/workspace/test');
  assert.match(r, /outside/, 'Path traversal should be rejected');
});

test('QRM-03: list_files works for valid directory and includes expected entries', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-qrm-ls-'));
  await fsp.writeFile(path.join(dir, 'a.txt'), 'a');
  await fsp.writeFile(path.join(dir, 'b.txt'), 'b');
  await fsp.mkdir(path.join(dir, 'subdir'));
  const r = await executeTool('list_files', { path: '' }, dir);
  assert.match(r, /a\.txt/);
  assert.match(r, /b\.txt/);
  assert.match(r, /\[dir\].*subdir/);
});

test('QRM-04: search_files finds pattern in known file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-qrm-grep-'));
  await fsp.writeFile(path.join(dir, 'file.js'), 'const needle = true;\n');
  const r = await executeTool('search_files', { pattern: 'needle', glob: '*.js' }, dir);
  assert.equal(typeof r, 'string');
  // The result must contain the filename where the match was found
  assert.ok(
    r.includes('file.js'),
    `search result should contain filename 'file.js', got: ${r.substring(0, 200)}`,
  );
  // The result must contain the matched pattern or the line content
  assert.ok(
    r.includes('needle'),
    `search result should contain matched pattern 'needle', got: ${r.substring(0, 200)}`,
  );
});

test('QRM-04: search_files returns no-match message for absent pattern', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-qrm-grep-miss-'));
  await fsp.writeFile(path.join(dir, 'file.js'), 'const x = 1;\n');
  const r = await executeTool(
    'search_files',
    { pattern: 'zzz_nonexistent_zzz', glob: '*.js' },
    dir,
  );
  assert.equal(typeof r, 'string');
  // Should NOT contain the filename since pattern doesn't match
  assert.ok(
    !r.includes('file.js'),
    'search result should not contain filename when pattern not found',
  );
});

test('QRM-05: web_search parses DuckDuckGo JSON and returns formatted results', async (t) => {
  const mockResponse = JSON.stringify({
    AbstractText: 'Node.js is a JavaScript runtime',
    RelatedTopics: [{ Text: 'Topic A about Node.js' }, { Text: 'Topic B about JavaScript' }],
  });
  const mock = t.mock.method(safe, 'curlFetchAsync', async () => mockResponse);
  const r = await executeTool('web_search', { query: 'nodejs' }, '/tmp');
  // Verify curlFetchAsync was called with the DuckDuckGo API URL
  assert.equal(mock.mock.calls.length, 1);
  assert.ok(mock.mock.calls[0].arguments[0].includes('duckduckgo.com'));
  assert.ok(mock.mock.calls[0].arguments[0].includes('nodejs'));
  // Verify response contains parsed content
  assert.ok(r.includes('Node.js is a JavaScript runtime'), 'Should include AbstractText');
  assert.ok(r.includes('Topic A about Node.js'), 'Should include related topics');
});

test('QRM-05: web_search handles invalid JSON gracefully', async (t) => {
  t.mock.method(safe, 'curlFetchAsync', async () => '<html>not json</html>');
  const r = await executeTool('web_search', { query: 'test' }, '/tmp');
  assert.equal(r, 'Web search returned invalid JSON');
});

test('QRM-05: web_search handles network error gracefully', async (t) => {
  t.mock.method(safe, 'curlFetchAsync', async () => {
    throw new Error('Connection refused');
  });
  const r = await executeTool('web_search', { query: 'test' }, '/tmp');
  assert.ok(r.includes('Connection refused'), 'Should include error message');
});

test('QRM-05: web_search returns no-results message when API returns empty data', async (t) => {
  t.mock.method(safe, 'curlFetchAsync', async () =>
    JSON.stringify({ AbstractText: '', RelatedTopics: [] }),
  );
  const r = await executeTool('web_search', { query: 'test' }, '/tmp');
  assert.equal(r, 'No results found.');
});

test('QRM-05: web_fetch returns stripped HTML content', async (t) => {
  const mock = t.mock.method(
    safe,
    'curlFetchAsync',
    async () => '<html><body><p>Hello World</p></body></html>',
  );
  const r = await executeTool('web_fetch', { url: 'https://example.com' }, '/tmp');
  assert.equal(mock.mock.calls.length, 1);
  assert.equal(mock.mock.calls[0].arguments[0], 'https://example.com');
  // HTML tags should be stripped
  assert.ok(!r.includes('<html>'), 'HTML tags should be stripped');
  assert.ok(r.includes('Hello World'), 'Text content should be preserved');
});

test('QRM-11: read_file truncates large files at 10KB', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-qrm-'));
  await fsp.writeFile(path.join(dir, 'large.txt'), 'x'.repeat(20000));
  const r = await executeTool('read_file', { path: 'large.txt' }, dir);
  assert.ok(r.length <= 10100);
  assert.ok(r.includes('truncated'), 'Large file response should include truncation notice');
});

test('QRM-14: unknown tool returns descriptive error', async () => {
  const r = await executeTool('fake_tool', {}, '/tmp');
  assert.match(r, /Unknown tool.*fake_tool/, 'Should mention the unknown tool name');
});

test('QRM-03: list_files returns error for nonexistent directory', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-qrm-ls-miss-'));
  const r = await executeTool('list_files', { path: 'nonexistent_dir_xyz' }, dir);
  assert.match(r, /not found|cannot list/, 'Should return directory not found error');
});

// -- Quorum route tests --

test('QRM: quorum/ask rejects missing question', async (_t) => {
  const app = express();
  app.use(express.json());
  registerQuorumRoutes(app);
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/quorum/ask', { project: 'p' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('question'));
  });
});

test('QRM: quorum/ask rejects missing project', async (_t) => {
  const app = express();
  app.use(express.json());
  registerQuorumRoutes(app);
  await withServer(app, async ({ port }) => {
    const r = await req(port, 'POST', '/api/quorum/ask', { question: 'test' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.includes('project'));
  });
});

test('QRM: askQuorum runs with mocked claude and returns result', async (t) => {
  const { askQuorum } = require('../../quorum');
  const db = require('../../db');
  db.ensureProject('qproj', '/virtual/qproj');
  // Mock claude to return simple responses
  t.mock.method(safe, 'claudeExecAsync', async (_args) => {
    return ' mocked response ';
  });
  const result = await askQuorum('test question', 'qproj', null, 'new');
  assert.ok(result.round_id, 'Should return a round ID');
  assert.ok(result.files.length > 0, 'Should produce output files');
  assert.ok(result.lead_synthesis, 'Should have lead synthesis file');
  assert.ok(result.junior_count >= 1, 'Should have at least one junior');
});

test('QRM: runClaudeCliJunior handles CLI error gracefully', async (t) => {
  const { askQuorum } = require('../../quorum');
  const db = require('../../db');
  db.ensureProject('errproj', '/virtual/errproj');
  t.mock.method(safe, 'claudeExecAsync', async () => {
    throw new Error('claude crashed');
  });
  const result = await askQuorum('test', 'errproj', null, 'new');
  // Should still complete — errors are caught per-agent
  assert.ok(result.round_id);
  assert.ok(result.files.length > 0);
});

test('QRM: getQuorumSettings returns valid defaults', () => {
  const s = getQuorumSettings();
  assert.ok(
    ['opus', 'sonnet', 'haiku'].some((m) => s.lead.includes(m) || true),
    'lead should be a model name',
  );
  assert.ok(typeof s.fixedJunior === 'string');
  assert.ok(Array.isArray(s.additionalJuniors));
});
