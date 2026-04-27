'use strict';

const http = require('http');
const https = require('https');
const db = require('./db');
const logger = require('./logger');

function getWebhooks() {
  const raw = db.getSetting('webhooks', '[]');
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      logger.warn('Webhooks setting contains invalid JSON', { module: 'webhooks' });
      return [];
    }
    throw err;
  }
}

function fireEvent(event, data) {
  const webhooks = getWebhooks();
  if (webhooks.length === 0) return;

  for (const hook of webhooks) {
    if (hook.events && !hook.events.includes(event) && !hook.events.includes('*')) continue;
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      ...(hook.mode === 'full_content' ? { data } : { ids: extractIds(data) }),
    };
    sendWebhook(hook.url, payload);
  }
}

function extractIds(data) {
  const ids = {};
  if (data?.session_id) ids.session_id = data.session_id;
  if (data?.project) ids.project = data.project;
  if (data?.task_id) ids.task_id = data.task_id;
  if (data?.message_id) ids.message_id = data.message_id;
  return ids;
}

function sendWebhook(url, payload) {
  try {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Workbench-Webhook/0.1',
      },
      timeout: 5000,
    });
    req.on('error', (err) => {
      logger.error('Webhook delivery failed', { module: 'webhooks', url, err: err.message });
    });
    req.write(body);
    req.end();
  } catch (err) {
    logger.error('Webhook send error', { module: 'webhooks', url, err: err.message });
  }
}

function registerWebhookRoutes(app) {
  app.get('/api/webhooks', (req, res) => {
    res.json({ webhooks: getWebhooks() });
  });

  app.put('/api/webhooks', (req, res) => {
    const { webhooks } = req.body;
    if (!Array.isArray(webhooks))
      return res.status(400).json({ error: 'webhooks must be an array' });
    db.setSetting('webhooks', JSON.stringify(webhooks));
    res.json({ saved: true });
  });

  app.post('/api/webhooks', (req, res) => {
    const { url, events, mode } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const hooks = getWebhooks();
    hooks.push({ url, events: events || ['*'], mode: mode || 'event_only' });
    db.setSetting('webhooks', JSON.stringify(hooks));
    res.json({ saved: true, count: hooks.length });
  });

  app.delete('/api/webhooks/:index', (req, res) => {
    const hooks = getWebhooks();
    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx) || idx < 0 || idx >= hooks.length)
      return res.status(404).json({ error: 'not found' });
    hooks.splice(idx, 1);
    db.setSetting('webhooks', JSON.stringify(hooks));
    res.json({ deleted: true });
  });
}

module.exports = { fireEvent, registerWebhookRoutes };
