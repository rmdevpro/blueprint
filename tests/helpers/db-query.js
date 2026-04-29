'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const CONTAINER = process.env.TEST_CONTAINER || 'workbench-test';
const DB_PATH = process.env.TEST_DB_PATH || '/data/.workbench/workbench.db';
const _IN_CONTAINER = fs.existsSync('/.dockerenv');

function _runSqlite(args, sql) {
  // When the test runner is itself inside a workbench container, talk to
  // the local sqlite3 binary directly (no docker exec wrapper). Mirrors
  // the reset-state.js helper.
  if (_IN_CONTAINER) {
    return execSync(`sqlite3 ${args} ${DB_PATH} "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      shell: '/bin/sh',
    }).trim();
  }
  return execSync(
    `docker exec -u workbench ${CONTAINER} sqlite3 ${args} ${DB_PATH} "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8', timeout: 10000 },
  ).trim();
}

function query(sql) {
  try {
    return _runSqlite('', sql);
  } catch (err) {
    throw new Error(`DB query failed: ${err.message}\nSQL: ${sql}`);
  }
}

function queryJson(sql) {
  try {
    const out = _runSqlite('-json', sql);
    return out ? JSON.parse(out) : [];
  } catch {
    return [];
  }
}

function queryCount(table, where = '1=1') {
  const r = query(`SELECT COUNT(*) FROM ${table} WHERE ${where}`);
  return parseInt(r, 10) || 0;
}

module.exports = { query, queryJson, queryCount, CONTAINER, DB_PATH };
