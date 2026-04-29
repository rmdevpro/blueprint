'use strict';

const WebSocket = require('ws');

// Derive the WS URL from TEST_URL when set (so a single env var works for both
// http+ws). Falls back to TEST_WS_URL or the legacy default.
const WS_URL = process.env.TEST_WS_URL
  || (process.env.TEST_URL ? process.env.TEST_URL.replace(/^http(s?):/, 'ws$1:') : 'ws://localhost:7867');

function connectWs(wsPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}${wsPath}`);
    const msgs = [];
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), timeoutMs);
    ws.on('message', (m) => msgs.push(m.toString()));
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ ws, msgs, close: () => ws.close(), send: (d) => ws.send(d) });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { connectWs, WS_URL };
