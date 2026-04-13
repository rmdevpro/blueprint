/**
 * Shared helper for spinning up in-process Express servers for mock handler tests.
 * Consolidates the listen/close boilerplate used across routes.test.js, mcp-tools.test.js,
 * openai-compat.test.js, mcp-external.test.js, and quorum.test.js.
 */
'use strict';

const http = require('node:http');

/**
 * Start an Express app on an ephemeral port and run fn({ port, server }).
 * Automatically closes the server after fn completes (or throws).
 */
async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await fn({ port, server });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/**
 * Make a fetch request to a local in-process server.
 */
async function req(port, method, path, body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  return fetch(`http://127.0.0.1:${port}${path}`, opts);
}

module.exports = { withServer, req };
