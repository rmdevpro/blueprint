'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fixtures = require('../fixtures/test-data');
const { freshRequire } = require('../helpers/module');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.js');

async function setupConfigFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-config-'));
  const configDir = path.join(root, 'config');
  const promptsDir = path.join(configDir, 'prompts');
  await fsp.mkdir(promptsDir, { recursive: true });
  await fsp.writeFile(
    path.join(configDir, 'defaults.json'),
    JSON.stringify(fixtures.validDefaultsJson, null, 2),
  );
  await fsp.writeFile(
    path.join(promptsDir, 'summarize-session.md'),
    fixtures.promptTemplates.summarizeSession,
  );
  await fsp.writeFile(
    path.join(promptsDir, 'compaction-auto.md'),
    fixtures.promptTemplates.compactionAuto,
  );

  const orig = { readFileSync: fs.readFileSync, readFile: fs.readFile, watchFile: fs.watchFile };
  function rewrite(p) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) return path.join(configDir, 'defaults.json');
    if (n.includes('/config/prompts/')) return path.join(promptsDir, path.basename(p));
    return p;
  }
  t.mock.method(fs, 'readFileSync', function (p, ...a) {
    return orig.readFileSync.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'readFile', function (p, ...a) {
    return orig.readFile.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    return orig.watchFile.call(this, rewrite(p), o, l);
  });
  return { root, configDir, promptsDir };
}

test('CFG-01 / SET-04 / SET-07: loads defaults and supports dot-path lookups', async (t) => {
  await setupConfigFixture(t);
  const config = freshRequire(CONFIG_PATH);
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
  assert.equal(config.get('session.nameMaxLength'), 60);
  assert.equal(config.get('does.not.exist', 'fallback'), 'fallback');
});

test('CFG-04: dot-path returns undefined for partial missing path', async (t) => {
  await setupConfigFixture(t);
  const config = freshRequire(CONFIG_PATH);
  assert.equal(config.get('compaction.thresholds.nonexistent'), undefined);
  assert.equal(config.get('compaction.nonexistent.leaf'), undefined);
});

test('CFG-05 / SET-06: prompt template variable substitution works', async (t) => {
  const { promptsDir } = await setupConfigFixture(t);
  await fsp.writeFile(
    path.join(promptsDir, 'test-template.md'),
    'Threshold {{PERCENT}} of {{AUTO_THRESHOLD}}',
  );
  const config = freshRequire(CONFIG_PATH);
  const result = config.getPrompt('test-template', { PERCENT: 85, AUTO_THRESHOLD: 90 });
  assert.equal(result, 'Threshold 85 of 90');
});

test('CFG-06: missing prompt file returns empty string and logs warning', async (t) => {
  await setupConfigFixture(t);
  let logged = '';
  t.mock.method(process.stdout, 'write', (c) => {
    logged += String(c);
    return true;
  });
  const config = freshRequire(CONFIG_PATH);
  assert.equal(config.getPrompt('nonexistent-template'), '');
  assert.match(logged, /Prompt template not found/);
});

test('CFG-09: hot-reload retains last good state on corrupt JSON', async (t) => {
  const { configDir } = await setupConfigFixture(t);
  const config = freshRequire(CONFIG_PATH);
  await config.init();
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
  t.mock.method(process.stderr, 'write', () => true);
  await fsp.writeFile(path.join(configDir, 'defaults.json'), '{"bad": }');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
});

test('ENG-17 / CFG-02 / SET-08: corrupt defaults.json exits process', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-config-corrupt-'));
  const configDir = path.join(root, 'config');
  const promptsDir = path.join(configDir, 'prompts');
  await fsp.mkdir(promptsDir, { recursive: true });
  await fsp.writeFile(path.join(configDir, 'defaults.json'), '{"oops": ]');
  const orig = { readFileSync: fs.readFileSync, readFile: fs.readFile, watchFile: fs.watchFile };
  function rewrite(p) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) return path.join(configDir, 'defaults.json');
    if (n.includes('/config/prompts/')) return path.join(promptsDir, path.basename(p));
    return p;
  }
  t.mock.method(fs, 'readFileSync', function (p, ...a) {
    return orig.readFileSync.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'readFile', function (p, ...a) {
    return orig.readFile.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    return orig.watchFile.call(this, rewrite(p), o, l);
  });
  let exited = null;
  t.mock.method(process, 'exit', (code) => {
    exited = code;
    throw new Error(`process.exit:${code}`);
  });
  t.mock.method(process.stderr, 'write', () => true);
  assert.throws(() => freshRequire(CONFIG_PATH), /process\.exit:1/);
  assert.equal(exited, 1);
});

test('CFG-03: missing defaults file yields empty cache', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bp-config-missing-'));
  const configDir = path.join(root, 'config');
  const promptsDir = path.join(configDir, 'prompts');
  await fsp.mkdir(promptsDir, { recursive: true });
  const orig = { readFileSync: fs.readFileSync, readFile: fs.readFile, watchFile: fs.watchFile };
  function rewrite(p) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) return path.join(configDir, 'defaults.json');
    if (n.includes('/config/prompts/')) return path.join(promptsDir, path.basename(p));
    return p;
  }
  t.mock.method(fs, 'readFileSync', function (p, ...a) {
    return orig.readFileSync.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'readFile', function (p, ...a) {
    return orig.readFile.call(this, rewrite(p), ...a);
  });
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    return orig.watchFile.call(this, rewrite(p), o, l);
  });
  const config = freshRequire(CONFIG_PATH);
  assert.equal(config.get('compaction.thresholds.advisory'), undefined);
  assert.equal(config.get('missing.path', 'fallback'), 'fallback');
});

test('CFG-10: loadDefaultsSync re-throws non-ENOENT, non-SyntaxError errors', async (t) => {
  const permError = Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
  const origReadFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...a) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) throw permError;
    return origReadFileSync.call(this, p, ...a);
  });
  t.mock.method(fs, 'readFile', () => {});
  t.mock.method(fs, 'watchFile', () => {});
  assert.throws(
    () => freshRequire(CONFIG_PATH),
    (err) => err === permError,
  );
});

test('CFG-11: init() watchFile callback resets cache on ENOENT', async (t) => {
  const { configDir } = await setupConfigFixture(t);
  let defaultsWatchCb = null;
  const origWatchFile = fs.watchFile.mock.original;
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) {
      defaultsWatchCb = l;
      return;
    }
    return origWatchFile.call(this, p, o, l);
  });
  const config = freshRequire(CONFIG_PATH);
  await config.init();
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
  assert.ok(defaultsWatchCb, 'watchFile callback should have been captured');
  /* Delete the file so readFileAsync throws ENOENT when callback fires */
  await fsp.unlink(path.join(configDir, 'defaults.json'));
  await defaultsWatchCb();
  assert.equal(config.get('compaction.thresholds.advisory'), undefined);
});

test('CFG-12: init() watchFile callback logs to stderr on SyntaxError and retains cache', async (t) => {
  const { configDir } = await setupConfigFixture(t);
  let defaultsWatchCb = null;
  const origWatchFile = fs.watchFile.mock.original;
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) {
      defaultsWatchCb = l;
      return;
    }
    return origWatchFile.call(this, p, o, l);
  });
  const config = freshRequire(CONFIG_PATH);
  await config.init();
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
  assert.ok(defaultsWatchCb, 'watchFile callback should have been captured');
  let stderrOutput = '';
  t.mock.method(process.stderr, 'write', (c) => {
    stderrOutput += String(c);
    return true;
  });
  /* Write invalid JSON so readFileAsync succeeds but JSON.parse throws SyntaxError */
  await fsp.writeFile(path.join(configDir, 'defaults.json'), '{"bad": }');
  await defaultsWatchCb();
  assert.match(stderrOutput, /hot-reload failed/);
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
});

test('CFG-13: init() watchFile callback retains cache on other errors', async (t) => {
  await setupConfigFixture(t);
  let defaultsWatchCb = null;
  const origWatchFile = fs.watchFile.mock.original;
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) {
      defaultsWatchCb = l;
      return;
    }
    return origWatchFile.call(this, p, o, l);
  });
  const config = freshRequire(CONFIG_PATH);
  await config.init();
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
  assert.ok(defaultsWatchCb, 'watchFile callback should have been captured');
  const ioErr = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
  /* Replace readFile (the callback-based version) with one that errors with EIO */
  const origReadFile = fs.readFile.mock.original;
  t.mock.method(fs, 'readFile', function (p, enc, cb) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('/config/defaults.json')) {
      const done = typeof enc === 'function' ? enc : cb;
      done(ioErr);
      return;
    }
    return origReadFile.call(this, p, enc, cb);
  });
  await defaultsWatchCb();
  assert.equal(config.get('compaction.thresholds.advisory'), 65);
});

test('CFG-14: getPrompt watchFile callback deletes cache entry on ENOENT', async (t) => {
  const { promptsDir } = await setupConfigFixture(t);
  await fsp.writeFile(path.join(promptsDir, 'hot-prompt.md'), 'original content');
  let promptWatchCb = null;
  const origWatchFile = fs.watchFile.mock.original;
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('hot-prompt.md')) {
      promptWatchCb = l;
      return;
    }
    return origWatchFile.call(this, p, o, l);
  });
  const config = freshRequire(CONFIG_PATH);
  assert.equal(config.getPrompt('hot-prompt'), 'original content');
  assert.ok(promptWatchCb, 'watchFile callback should have been captured');
  /* Delete the prompt file so readFileSync throws ENOENT when callback fires */
  await fsp.unlink(path.join(promptsDir, 'hot-prompt.md'));
  promptWatchCb();
  /* Cache entry deleted — next getPrompt should return '' (ENOENT path) */
  t.mock.method(process.stdout, 'write', () => true);
  assert.equal(config.getPrompt('hot-prompt'), '');
});

test('CFG-15: getPrompt watchFile callback retains cache entry on other errors', async (t) => {
  const { promptsDir } = await setupConfigFixture(t);
  await fsp.writeFile(path.join(promptsDir, 'retained-prompt.md'), 'cached content');
  let promptWatchCb = null;
  const origWatchFile = fs.watchFile.mock.original;
  t.mock.method(fs, 'watchFile', function (p, o, l) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('retained-prompt.md')) {
      promptWatchCb = l;
      return;
    }
    return origWatchFile.call(this, p, o, l);
  });
  const config = freshRequire(CONFIG_PATH);
  assert.equal(config.getPrompt('retained-prompt'), 'cached content');
  assert.ok(promptWatchCb, 'watchFile callback should have been captured');
  /* Replace readFileSync so the watcher reload throws a non-ENOENT error */
  const ioErr = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
  const origReadFileSync = fs.readFileSync.mock.original;
  t.mock.method(fs, 'readFileSync', function (p, ...a) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('retained-prompt.md')) throw ioErr;
    return origReadFileSync.call(this, p, ...a);
  });
  promptWatchCb();
  /* Cache should be retained — getPrompt reads from cache, readFileSync not needed */
  assert.equal(config.getPrompt('retained-prompt'), 'cached content');
});

test('CFG-16: getPrompt re-throws non-ENOENT errors from readFileSync', async (t) => {
  await setupConfigFixture(t);
  const permError = Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
  /* Capture the already-mocked readFileSync from setupConfigFixture as our fallback */
  const baseReadFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...a) {
    const n = String(p).replace(/\\/g, '/');
    if (n.includes('locked-prompt.md')) throw permError;
    return baseReadFileSync.call(this, p, ...a);
  });
  const config = freshRequire(CONFIG_PATH);
  assert.throws(
    () => config.getPrompt('locked-prompt'),
    (err) => err === permError,
  );
});
