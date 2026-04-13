'use strict';

const WebSocket = require('ws');

const WS_URL = process.env.TEST_WS_URL || 'ws://localhost:7867';

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
