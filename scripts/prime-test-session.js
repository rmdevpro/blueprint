#!/usr/bin/env node
/**
 * Prime a Blueprint test session with conversation from a Claude CLI JSONL file.
 *
 * Usage: node prime-test-session.js <jsonl-path> <blueprint-url> <project> [target-chars]
 *
 * Reads user/assistant messages from the JSONL, creates a session in Blueprint,
 * and writes a synthetic JSONL to disk so the session appears to have conversation history.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const [, , jsonlPath, blueprintUrl, project, targetCharsStr] = process.argv;
const targetChars = parseInt(targetCharsStr) || 680000; // ~170K tokens at 4 chars/token

if (!jsonlPath || !blueprintUrl || !project) {
  console.error(
    'Usage: node prime-test-session.js <jsonl-path> <blueprint-url> <project> [target-chars]',
  );
  process.exit(1);
}

function fetchJSON(url, opts) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  console.log(`Reading JSONL: ${jsonlPath}`);
  console.log(`Target: ~${Math.round(targetChars / 4000)}K tokens (${targetChars} chars)`);

  // Parse JSONL for user/assistant message pairs
  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.trim().split('\n');

  const messages = [];
  let totalChars = 0;

  for (const line of lines) {
    if (totalChars >= targetChars) break;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : JSON.stringify(entry.message.content);
        messages.push({ role: 'user', content: text });
        totalChars += text.length;
      } else if (entry.type === 'assistant' && entry.message?.content) {
        // Extract text from content blocks
        const blocks = Array.isArray(entry.message.content)
          ? entry.message.content
          : [entry.message.content];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (text) {
          messages.push({
            role: 'assistant',
            content: text,
            model: entry.message.model,
            usage: entry.message.usage,
          });
          totalChars += text.length;
        }
      }
    } catch {}
  }

  console.log(
    `Parsed ${messages.length} messages, ${totalChars} chars (~${Math.round(totalChars / 4)}  tokens)`,
  );

  // Create a session in Blueprint
  console.log(`Creating session in ${project}...`);
  const session = await fetchJSON(`${blueprintUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, prompt: 'Compaction stress test session' }),
  });
  console.log(`Session created: ${session.id}`);

  // Wait for session to resolve
  console.log('Waiting 15s for session to resolve...');
  await new Promise((r) => setTimeout(r, 15000));

  // Get the real session ID
  const state = await fetchJSON(`${blueprintUrl}/api/state`, { method: 'GET' });
  const proj = state.projects?.find((p) => p.name === project);
  const sess = proj?.sessions?.find((s) => s.name?.includes('Compaction stress'));
  const realId = sess?.id || session.id;
  console.log(`Resolved session ID: ${realId}`);

  // Find the JSONL path for this session
  // We need to write directly to the JSONL file in the container
  // The session dir is at ~/.claude/projects/<encoded-cwd>/

  // Build synthetic JSONL entries
  const { randomUUID } = require('crypto');
  let prevUuid = null;
  const jsonlLines = [];

  for (const msg of messages) {
    const uuid = randomUUID();
    if (msg.role === 'user') {
      jsonlLines.push(
        JSON.stringify({
          parentUuid: prevUuid,
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: msg.content },
          uuid,
          timestamp: new Date().toISOString(),
          permissionMode: 'bypassPermissions',
          userType: 'external',
          entrypoint: 'cli',
          sessionId: realId,
        }),
      );
    } else {
      jsonlLines.push(
        JSON.stringify({
          parentUuid: prevUuid,
          isSidechain: false,
          message: {
            model: msg.model || 'claude-sonnet-4-6',
            id: `msg_${randomUUID().substring(0, 20)}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: msg.content }],
            stop_reason: 'end_turn',
            usage: msg.usage || {
              input_tokens: Math.round(msg.content.length / 4),
              output_tokens: Math.round(msg.content.length / 4),
            },
          },
          requestId: randomUUID(),
          type: 'assistant',
          uuid,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    prevUuid = uuid;
  }

  // Write to a temp file that can be copied into the container
  const outFile = path.join(__dirname, `prime_${realId.substring(0, 8)}.jsonl`);
  fs.writeFileSync(outFile, jsonlLines.join('\n') + '\n');
  console.log(`\nWrote ${jsonlLines.length} entries to: ${outFile}`);
  console.log(`Total size: ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\nTo inject into container:`);
  console.log(`  docker cp ${outFile} blueprint:/tmp/prime.jsonl`);
  console.log(
    `  docker exec -u hopper blueprint bash -c 'cat /tmp/prime.jsonl >> <session-jsonl-path>'`,
  );
  console.log(`\nOr use SSH:`);
  console.log(`  scp ${outFile} aristotle9@192.168.1.110:/tmp/`);
  console.log(
    `  ssh aristotle9@192.168.1.110 "docker cp /tmp/prime_${realId.substring(0, 8)}.jsonl blueprint:/tmp/prime.jsonl && docker exec -u hopper blueprint bash -c 'cat /tmp/prime.jsonl >> <session-jsonl-path>'"`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
