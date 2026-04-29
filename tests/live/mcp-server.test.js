'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');

const _IN_CONTAINER = fs.existsSync('/.dockerenv');
const CONTAINER = process.env.TEST_CONTAINER || 'workbench-test';

test('MCS-01: initialize returns protocol version', async () => {
  return new Promise((resolve, reject) => {
    // Inside the container: spawn node directly. Outside: docker exec wrapper.
    const cp = _IN_CONTAINER
      ? spawn('node', ['/app/mcp-server.js'])
      : spawn('docker', ['exec', '-i', CONTAINER, 'node', '/app/mcp-server.js']);
    let out = '';
    const timer = setTimeout(() => {
      cp.kill();
      reject(new Error('timeout'));
    }, 10000);
    cp.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('protocolVersion')) {
        clearTimeout(timer);
        const line = out.split('\n').find((l) => l.startsWith('{'));
        if (line) {
          const r = JSON.parse(line);
          assert.equal(r.result.protocolVersion, '2024-11-05');
          assert.ok(r.result.capabilities);
          assert.ok(r.result.serverInfo);
        }
        cp.kill();
        resolve();
      }
    });
    cp.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    );
  });
});
