'use strict';

const { execSync } = require('child_process');

const CONTAINER = process.env.TEST_CONTAINER || 'blueprint-test-blueprint-1';
const DB_PATH = '/storage/blueprint.db';

function query(sql) {
  try {
    return execSync(`docker exec ${CONTAINER} sqlite3 ${DB_PATH} "${sql.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (err) {
    throw new Error(`DB query failed: ${err.message}\nSQL: ${sql}`);
  }
}

function queryJson(sql) {
  try {
    const out = execSync(
      `docker exec ${CONTAINER} sqlite3 -json ${DB_PATH} "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
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
