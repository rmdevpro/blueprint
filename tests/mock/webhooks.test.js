'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fixtures = require('../fixtures/test-data');
const { freshRequire } = require('../helpers/module');
const path = require('node:path');

test('WHK-08 / WHK-09 / WHK-11: fireEvent sends filtered payloads with correct modes', (t) => {
  const db = require('../../db.js');
  t.mock.method(db, 'getSetting', () => JSON.stringify(fixtures.webhooks.hooks));
  const requests = [];
  const factory = (_o) => ({
    on() {},
    write(b) {
      this.body = b;
    },
    end() {
      requests.push(JSON.parse(this.body));
    },
    setTimeout() {},
  });
  t.mock.method(http, 'request', factory);
  t.mock.method(https, 'request', factory);
  const { fireEvent } = freshRequire(path.join(__dirname, '../../webhooks.js'));

  fireEvent('session_created', { session_id: 's1', project: 'p' });
  fireEvent('task_added', { task_id: 7, project: 'p', text: 'T' });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].event, 'session_created');
  assert.ok(requests[0].ids);
  assert.ok(!requests[0].data);
  assert.equal(requests[2].event, 'task_added');
  assert.ok(requests[2].data);
  assert.equal(requests[2].data.text, 'T');
});

test('WHK-10: delivery failure does not crash', (t) => {
  const db = require('../../db.js');
  t.mock.method(db, 'getSetting', () =>
    JSON.stringify([{ url: 'http://localhost:9999/fail', events: ['*'], mode: 'event_only' }]),
  );
  t.mock.method(http, 'request', () => {
    const r = {
      on(e, h) {
        if (e === 'error') setImmediate(() => h(new Error('refused')));
      },
      write() {},
      end() {},
      setTimeout() {},
    };
    return r;
  });
  const { fireEvent } = freshRequire(path.join(__dirname, '../../webhooks.js'));
  assert.doesNotThrow(() => fireEvent('test', {}));
});

test('WHK-11: event filtering prevents non-matching events', (t) => {
  const db = require('../../db.js');
  t.mock.method(db, 'getSetting', () =>
    JSON.stringify([{ url: 'http://localhost:9999', events: ['task_added'], mode: 'event_only' }]),
  );
  const requests = [];
  t.mock.method(http, 'request', () => ({
    on() {},
    write(b) {
      requests.push(b);
    },
    end() {},
    setTimeout() {},
  }));
  const { fireEvent } = freshRequire(path.join(__dirname, '../../webhooks.js'));
  fireEvent('session_created', { session_id: 's1' });
  assert.equal(requests.length, 0);
});
