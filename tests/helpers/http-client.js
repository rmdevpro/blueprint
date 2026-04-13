'use strict';

const BASE_URL = process.env.TEST_URL || 'http://localhost:7867';

async function api(method, path, body = null, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE_URL}${path}`, opts);
  let data;
  const text = await r.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}

async function get(path) {
  return api('GET', path);
}
async function post(path, body = {}) {
  return api('POST', path, body);
}
async function put(path, body = {}) {
  return api('PUT', path, body);
}
async function del(path) {
  return api('DELETE', path);
}

module.exports = { api, get, post, put, del, BASE_URL };
