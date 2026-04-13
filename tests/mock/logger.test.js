'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { freshRequire } = require('../helpers/module');
const fixtures = require('../fixtures/test-data');

const LOGGER_PATH = path.join(__dirname, '..', '..', 'logger.js');

function withLoggerEnv(level, fn) {
  const prev = process.env.LOG_LEVEL;
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  }
}

test('LOG-01 / ENG-08: info logs JSON with timestamp, level, message, and context', () => {
  let stdout = '';
  return withLoggerEnv('INFO', () => {
    const restore = process.stdout.write;
    process.stdout.write = (chunk) => {
      stdout += String(chunk);
      return true;
    };
    try {
      const logger = freshRequire(LOGGER_PATH);
      logger.info('hello', { module: 'test', key: 'value' });
    } finally {
      process.stdout.write = restore;
    }
    const parsed = JSON.parse(stdout.trim());
    assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(parsed.level, 'INFO');
    assert.equal(parsed.message, 'hello');
    assert.equal(parsed.key, 'value');
    assert.equal(parsed.module, 'test');
  });
});

test('LOG-02: error logs write to stderr', () => {
  let stderr = '';
  return withLoggerEnv('INFO', () => {
    const restore = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderr += String(chunk);
      return true;
    };
    try {
      const logger = freshRequire(LOGGER_PATH);
      logger.error('boom');
    } finally {
      process.stderr.write = restore;
    }
    const parsed = JSON.parse(stderr.trim());
    assert.equal(parsed.level, 'ERROR');
    assert.equal(parsed.message, 'boom');
  });
});

test('LOG-03: LOG_LEVEL filters lower-severity logs', () => {
  let stdout = '',
    stderr = '';
  return withLoggerEnv('ERROR', () => {
    const rOut = process.stdout.write;
    const rErr = process.stderr.write;
    process.stdout.write = (c) => {
      stdout += String(c);
      return true;
    };
    process.stderr.write = (c) => {
      stderr += String(c);
      return true;
    };
    try {
      const logger = freshRequire(LOGGER_PATH);
      logger.info('hidden');
      logger.warn('hidden too');
      logger.error('shown');
    } finally {
      process.stdout.write = rOut;
      process.stderr.write = rErr;
    }
    assert.equal(stdout, '');
    assert.equal(JSON.parse(stderr.trim()).message, 'shown');
  });
});

test('LOG-04: reserved fields are not overwritten by context', () => {
  let stdout = '';
  return withLoggerEnv('DEBUG', () => {
    const restore = process.stdout.write;
    process.stdout.write = (c) => {
      stdout += String(c);
      return true;
    };
    try {
      const logger = freshRequire(LOGGER_PATH);
      logger.debug('real-message', fixtures.loggerFixtures.reservedCollisionContext);
    } finally {
      process.stdout.write = restore;
    }
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.message, 'real-message');
    assert.equal(parsed.level, 'DEBUG');
    assert.notEqual(parsed.timestamp, 'fake-timestamp');
    assert.equal(parsed.keep, 'value');
  });
});
