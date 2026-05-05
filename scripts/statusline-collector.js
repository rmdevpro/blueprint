#!/usr/bin/env node
'use strict';
// Workbench statusLine collector for Claude Code (#286).
// Claude pipes a JSON payload to this script's stdin after each assistant
// turn / permission change / vim-mode toggle. The payload's
// context_window.context_window_size is the *plan-effective* context cap
// (the value Claude shows in /context), unlike the model API's theoretical
// max. We persist the relevant fields to a per-session JSON file the
// workbench backend reads to drive its status bar; stdout is consumed by
// Claude as the visible status line.
//
// Docs: https://code.claude.com/docs/en/statusline

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.WORKBENCH_STATUSLINE_DIR || '/data/.claude';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data = null;
  try {
    data = JSON.parse(input);
  } catch (err) {
    process.stderr.write(`statusline-collector: parse failed: ${err.message}\n`);
    process.stdout.write('Workbench\n');
    return;
  }

  // Persist relevant fields by session id for the workbench backend.
  const sessionId = data && data.session_id;
  if (sessionId) {
    const statePath = path.join(STATE_DIR, `statusline-state-${sessionId}.json`);
    const state = {
      session_id: sessionId,
      model: data.model || null,
      context_window: data.context_window || null,
      rate_limits: data.rate_limits || null,
      ts: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      // Atomic write — workbench reader can't observe a partial file
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, statePath);
    } catch (err) {
      process.stderr.write(`statusline-collector: write failed: ${err.message}\n`);
    }
  }

  // Render the visible status line for Claude itself.
  const cw = (data && data.context_window) || {};
  const modelName = (data && data.model && data.model.display_name) || '?';
  const max = cw.context_window_size != null
    ? (cw.context_window_size >= 1000 ? `${Math.round(cw.context_window_size / 1000)}k` : cw.context_window_size)
    : '?';
  const pct = cw.used_percentage != null ? Math.floor(cw.used_percentage) : null;
  if (pct == null) {
    process.stdout.write(`${modelName} · ${max}\n`);
  } else {
    process.stdout.write(`${modelName} · ${pct}% of ${max}\n`);
  }
});
