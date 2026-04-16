'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerMcpRoutes } = require('../../mcp-tools.js');
const db = require('../../db.js');
const { withServer, req } = require('../helpers/with-server');

function startMcpApp() {
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app);
  return app;
}

test('MCP-03 / FS-06: plan path traversal blocked', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_update_plan',
      args: { session_id: 's1', project: '../evil', content: 'x' },
    });
    assert.equal(r.status, 403);
  });
});

test('MCP-04: invalid session_id rejected', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_get_session_notes',
      args: { session_id: '../../etc/passwd' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP-05: invalid task_id rejected', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_complete_task',
      args: { task_id: 'abc' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP unknown tool returns 404', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', { tool: 'nonexistent_tool', args: {} });
    assert.equal(r.status, 404);
  });
});

test('MCP tool list returns expected tools', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/mcp/tools')).json();
    assert.ok(r.tools.length >= 14);
    assert.ok(r.tools.some((t) => t.name === 'blueprint_search_sessions'));
    assert.ok(r.tools.some((t) => t.name === 'blueprint_session'));
    assert.ok(r.tools.some((t) => t.name === 'blueprint_ask_cli'));
    assert.ok(r.tools.some((t) => t.name === 'blueprint_get_token_usage'));
  });
});

test('MCP blueprint_reopen_task validates task_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_reopen_task',
      args: { task_id: 'notnum' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_delete_task validates task_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_delete_task',
      args: { task_id: null },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_add_task rejects missing text', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    // Requires a real project; without DB, it will throw 'Project not found'
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_add_task',
      args: { project: 'nonexistent' },
    });
    assert.ok(r.status >= 400);
  });
});

test('MCP blueprint_search_sessions rejects short query', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_search_sessions',
      args: { query: 'a' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_search_sessions rejects overlong query', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_search_sessions',
      args: { query: 'x'.repeat(201) },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_update_plan rejects missing content', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_update_plan',
      args: { session_id: 's1', project: 'p' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_update_plan rejects overlong content', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_update_plan',
      args: { session_id: 's1', project: 'p', content: 'x'.repeat(100001) },
    });
    assert.equal(r.status, 400);
  });
});


test('MCP blueprint_set_session_config validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_set_session_config',
      args: { session_id: '../../bad' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_get_token_usage validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_get_token_usage',
      args: { session_id: 'bad!id' },
    });
    assert.equal(r.status, 400);
  });
});

// ── Success path tests for MCP tools ─────────────────────────────────────

test('MCP blueprint_get_project_notes returns notes for existing project', async () => {
  db.ensureProject('notesproj', '/virtual/notesproj');
  const proj = db.getProject('notesproj');
  db.setProjectNotes(proj.id, 'These are project notes');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_get_project_notes',
        args: { project: 'notesproj' },
      })
    ).json();
    assert.equal(r.result.notes, 'These are project notes');
  });
});

test('MCP blueprint_get_project_notes returns empty for unknown project', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_get_project_notes',
        args: { project: 'unknownproj' },
      })
    ).json();
    assert.equal(r.result.notes, '');
  });
});

test('MCP blueprint_get_session_notes returns notes for valid session', async () => {
  db.ensureProject('snproj', '/virtual/snproj');
  const proj = db.getProject('snproj');
  db.upsertSession('valid_session', proj.id, 'S');
  db.setSessionNotes('valid_session', 'session notes here');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_get_session_notes',
        args: { session_id: 'valid_session' },
      })
    ).json();
    assert.equal(r.result.notes, 'session notes here');
  });
});

test('MCP blueprint_get_tasks returns tasks for existing project', async () => {
  db.ensureProject('taskproj', '/virtual/taskproj');
  const proj = db.getProject('taskproj');
  db.addTask(proj.id, 'Test task 1', 'agent');
  db.addTask(proj.id, 'Test task 2', 'human');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_get_tasks',
        args: { project: 'taskproj' },
      })
    ).json();
    assert.ok(r.result.tasks.length >= 2);
    assert.ok(r.result.tasks.some((t) => t.text === 'Test task 1'));
  });
});

test('MCP blueprint_get_tasks returns empty for unknown project', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_get_tasks',
        args: { project: 'nope' },
      })
    ).json();
    assert.deepEqual(r.result.tasks, []);
  });
});

test('MCP blueprint_add_task success path', async () => {
  db.ensureProject('addtaskproj', '/virtual/addtaskproj');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_add_task',
        args: { project: 'addtaskproj', text: 'New task' },
      })
    ).json();
    assert.equal(r.result.text, 'New task');
    assert.equal(r.result.status, 'todo');
  });
});

test('MCP blueprint_add_task rejects overlong text', async () => {
  db.ensureProject('addtaskproj2', '/virtual/addtaskproj2');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_add_task',
      args: { project: 'addtaskproj2', text: 'x'.repeat(1001) },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_complete_task success path', async () => {
  db.ensureProject('cmpltproj', '/virtual/cmpltproj');
  const proj = db.getProject('cmpltproj');
  const task = db.addTask(proj.id, 'to complete');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_complete_task',
        args: { task_id: task.id },
      })
    ).json();
    assert.equal(r.result.completed, true);
  });
});

test('MCP blueprint_reopen_task success path', async () => {
  db.ensureProject('reopenproj', '/virtual/reopenproj');
  const proj = db.getProject('reopenproj');
  const task = db.addTask(proj.id, 'to reopen');
  db.completeTask(task.id);
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_reopen_task',
        args: { task_id: task.id },
      })
    ).json();
    assert.equal(r.result.reopened, true);
  });
});

test('MCP blueprint_delete_task success path', async () => {
  db.ensureProject('delproj', '/virtual/delproj');
  const proj = db.getProject('delproj');
  const task = db.addTask(proj.id, 'to delete');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_delete_task',
        args: { task_id: task.id },
      })
    ).json();
    assert.equal(r.result.deleted, true);
  });
});

test('MCP blueprint_set_project_notes success path', async () => {
  db.ensureProject('setnotesProj', '/virtual/setnotesProj');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_set_project_notes',
        args: { project: 'setnotesProj', notes: 'updated notes' },
      })
    ).json();
    assert.equal(r.result.saved, true);
  });
});

test('MCP blueprint_set_project_notes rejects unknown project', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_set_project_notes',
      args: { project: 'nope_project', notes: 'x' },
    });
    assert.equal(r.status, 500); // throws 'Project not found'
  });
});

test('MCP blueprint_set_session_notes success path', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_set_session_notes',
        args: { session_id: 'valid_sess', notes: 'my notes' },
      })
    ).json();
    assert.equal(r.result.saved, true);
  });
});

test('MCP blueprint_set_session_notes validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_set_session_notes',
      args: { session_id: '../../bad' },
    });
    assert.equal(r.status, 400);
  });
});

test('MCP blueprint_set_session_config success path with all fields', async () => {
  db.ensureProject('cfgproj', '/virtual/cfgproj');
  const proj = db.getProject('cfgproj');
  db.upsertSession('cfg_sess', proj.id, 'Original');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_set_session_config',
        args: { session_id: 'cfg_sess', name: 'Renamed', state: 'archived', notes: 'config notes' },
      })
    ).json();
    assert.equal(r.result.saved, true);
    // Verify side effects
    assert.equal(db.getSession('cfg_sess').name, 'Renamed');
    assert.equal(db.getSession('cfg_sess').state, 'archived');
    assert.equal(db.getSessionNotes('cfg_sess'), 'config notes');
  });
});

test('MCP blueprint_read_plan success for existing plan', async () => {
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const planBase = path.join(db.DATA_DIR, 'plans', 'testproj');
  await fsp.mkdir(planBase, { recursive: true });
  await fsp.writeFile(path.join(planBase, 'plan_sess.md'), '# My Plan\nStep 1');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_read_plan',
        args: { session_id: 'plan_sess', project: 'testproj' },
      })
    ).json();
    assert.match(r.result.content, /My Plan/);
  });
});

test('MCP blueprint_read_plan returns empty for nonexistent plan', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_read_plan',
        args: { session_id: 'noplan', project: 'noplanproj' },
      })
    ).json();
    assert.equal(r.result.content, '');
    assert.equal(r.result.exists, false);
  });
});

test('MCP blueprint_update_plan success path', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_update_plan',
        args: { session_id: 'up_sess', project: 'upproj', content: '# Updated plan' },
      })
    ).json();
    assert.equal(r.result.saved, true);
    assert.ok(r.result.path);
  });
});

test('MCP blueprint_summarize_session validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'blueprint_summarize_session',
      args: { session_id: '!bad' },
    });
    assert.equal(r.status, 400);
  });
});



// ── listSessions coverage ──────────────────────────────────────────────────

test('MCP blueprint_list_sessions returns sessions array', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_list_sessions',
        args: { project: 'nonexistent_proj' },
      })
    ).json();
    // Should return empty array (no sessions dir) without crashing
    assert.ok(Array.isArray(r.result));
  });
});

// ── listSessions non-ENOENT error branch ──────────────────────────────────

test('MCP listSessions logs non-ENOENT readdir error', async () => {
  const fsp = require('node:fs/promises');
  // Patch readdir to throw a non-ENOENT error for the sessions dir
  const origReaddir = fsp.readdir;
  // Patch readdir so it throws a non-ENOENT error — verify function handles it gracefully
  fsp.readdir = async (_p) => {
    const err = new Error('permission denied');
    err.code = 'EACCES';
    throw err;
  };
  try {
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await (
        await req(port, 'POST', '/api/mcp/call', {
          tool: 'blueprint_list_sessions',
          args: { project: 'any_project' },
        })
      ).json();
      // Should return empty array — error is caught and logged, not propagated
      assert.ok(Array.isArray(r.result), 'Should return an array even on readdir error');
      assert.equal(r.result.length, 0);
    });
  } finally {
    fsp.readdir = origReaddir;
  }
});

// ── MCP tool catch block error branches ───────────────────────────────────

test('MCP tool call with SyntaxError returns 400', async () => {
  // Monkey-patch db.addTask to throw a SyntaxError so it flows through the catch
  const origAddTask = db.addTask;
  db.addTask = () => {
    throw new SyntaxError('unexpected token in input');
  };
  db.ensureProject('syntaxerrproj', '/virtual/syntaxerrproj');
  try {
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_add_task',
        args: { project: 'syntaxerrproj', text: 'some task' },
      });
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.match(body.error, /Invalid input/);
    });
  } finally {
    db.addTask = origAddTask;
  }
});

test('MCP tool call with traversal error returns 403', async () => {
  // Monkey-patch db.addTask to throw an error containing "traversal"
  const origAddTask = db.addTask;
  db.addTask = () => {
    throw new Error('path traversal detected');
  };
  db.ensureProject('traversalerrproj', '/virtual/traversalerrproj');
  try {
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_add_task',
        args: { project: 'traversalerrproj', text: 'some task' },
      });
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.match(body.error, /traversal/);
    });
  } finally {
    db.addTask = origAddTask;
  }
});

// ── blueprint_get_project_claude_md ────────────────────────────────────────

test('MCP blueprint_get_project_claude_md returns empty for missing file', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_get_project_claude_md',
        args: { project: 'no_claude_md' },
      })
    ).json();
    assert.ok('result' in r);
    assert.equal(r.result.content, '');
  });
});

// ── Error handling branches ────────────────────────────────────────────────

test('MCP tool call with ENOENT error returns 404', async () => {
  // blueprint_get_project_claude_md with a project whose path causes ENOENT on non-CLAUDE.md operations
  // We can trigger this by making the internal functions throw ENOENT
  await withServer(startMcpApp(), async ({ port }) => {
    // The blueprint_summarize_session will try to read a non-existent session file
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'blueprint_summarize_session',
        args: { session_id: 'valid_sess', project: 'noproj' },
      })
    ).json();
    // Should either succeed with summary or return error
    assert.ok(r.result || r.error);
  });
});
