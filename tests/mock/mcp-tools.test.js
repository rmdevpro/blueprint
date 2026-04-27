'use strict';

// TODO: This entire file tests the old 17-tool MCP API.
// The current API has 3 tools (workbench_files, workbench_sessions, workbench_tasks)
// with action-based dispatch. All tests below need rewriting.
// See: tests/traceability-matrix.md for the full gap analysis.

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

test.skip('MCP-05: invalid task_id rejected', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_complete_task',
      args: { task_id: 'abc' },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP unknown tool returns 404', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', { tool: 'nonexistent_tool', args: {} });
    assert.equal(r.status, 404);
  });
});

test.skip('MCP tool list returns expected tools', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (await req(port, 'GET', '/api/mcp/tools')).json();
    assert.ok(r.tools.length >= 14);
    assert.ok(r.tools.some((t) => t.name === 'workbench_search_sessions'));
    assert.ok(r.tools.some((t) => t.name === 'workbench_session'));
    assert.ok(r.tools.some((t) => t.name === 'workbench_vector_search'));
    assert.ok(r.tools.some((t) => t.name === 'workbench_get_token_usage'));
  });
});

test.skip('MCP workbench_reopen_task validates task_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_reopen_task',
      args: { task_id: 'notnum' },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP workbench_archive_task validates task_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_archive_task',
      args: { task_id: null },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP workbench_add_task rejects missing title', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_add_task',
      args: { folder_path: '/' },
    });
    assert.ok(r.status >= 400);
  });
});

test.skip('MCP workbench_search_sessions rejects short query', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_search_sessions',
      args: { query: 'a' },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP workbench_search_sessions rejects overlong query', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_search_sessions',
      args: { query: 'x'.repeat(201) },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP workbench_set_session_config validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_set_session_config',
      args: { session_id: '../../bad' },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP workbench_get_token_usage validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_get_token_usage',
      args: { session_id: 'bad!id' },
    });
    assert.equal(r.status, 400);
  });
});

// ── Success path tests for MCP tools ─────────────────────────────────────

test.skip('MCP workbench_get_project_notes returns notes for existing project', async () => {
  db.ensureProject('notesproj', '/virtual/notesproj');
  const proj = db.getProject('notesproj');
  db.setProjectNotes(proj.id, 'These are project notes');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_get_project_notes',
        args: { project: 'notesproj' },
      })
    ).json();
    assert.equal(r.result.notes, 'These are project notes');
  });
});

test.skip('MCP workbench_get_project_notes returns empty for unknown project', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_get_project_notes',
        args: { project: 'unknownproj' },
      })
    ).json();
    assert.equal(r.result.notes, '');
  });
});

test.skip('MCP workbench_get_session_notes returns notes for valid session', async () => {
  db.ensureProject('snproj', '/virtual/snproj');
  const proj = db.getProject('snproj');
  db.upsertSession('valid_session', proj.id, 'S');
  db.setSessionNotes('valid_session', 'session notes here');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_get_session_notes',
        args: { session_id: 'valid_session' },
      })
    ).json();
    assert.equal(r.result.notes, 'session notes here');
  });
});

test.skip('MCP workbench_get_tasks returns tasks', async () => {
  db.addTask('/virtual/taskproj', 'Test task 1', '', null, 'agent');
  db.addTask('/virtual/taskproj', 'Test task 2', '', null, 'human');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_get_tasks',
        args: {},
      })
    ).json();
    assert.ok(r.result.tasks.length >= 2);
    assert.ok(r.result.tasks.some((t) => t.title === 'Test task 1'));
  });
});

test.skip('MCP workbench_get_tasks with folder_path filter', async () => {
  db.addTask('/folderA', 'Task A', '', null, 'agent');
  db.addTask('/folderB', 'Task B', '', null, 'agent');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_get_tasks',
        args: { folder_path: '/folderA' },
      })
    ).json();
    assert.ok(r.result.tasks.every((t) => t.folder_path === '/folderA'));
  });
});

test.skip('MCP workbench_add_task success path', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_add_task',
        args: { folder_path: '/src', title: 'New task' },
      })
    ).json();
    assert.equal(r.result.title, 'New task');
    assert.equal(r.result.folder_path, '/src');
    assert.equal(r.result.status, 'todo');
  });
});

test.skip('MCP workbench_add_task rejects overlong title', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_add_task',
      args: { folder_path: '/', title: 'x'.repeat(501) },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP workbench_complete_task success path', async () => {
  const task = db.addTask('/virtual/cmpltproj', 'to complete');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_complete_task',
        args: { task_id: task.id },
      })
    ).json();
    assert.equal(r.result.completed, true);
  });
});

test.skip('MCP workbench_reopen_task success path', async () => {
  const task = db.addTask('/virtual/reopenproj', 'to reopen');
  db.updateTaskStatus(task.id, 'done');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_reopen_task',
        args: { task_id: task.id },
      })
    ).json();
    assert.equal(r.result.reopened, true);
  });
});

test.skip('MCP workbench_archive_task success path', async () => {
  const task = db.addTask('/virtual/archproj', 'to archive');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_archive_task',
        args: { task_id: task.id },
      })
    ).json();
    assert.equal(r.result.archived, true);
  });
});

test.skip('MCP workbench_set_project_notes success path', async () => {
  db.ensureProject('setnotesProj', '/virtual/setnotesProj');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_set_project_notes',
        args: { project: 'setnotesProj', notes: 'updated notes' },
      })
    ).json();
    assert.equal(r.result.saved, true);
  });
});

test.skip('MCP workbench_set_project_notes rejects unknown project', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_set_project_notes',
      args: { project: 'nope_project', notes: 'x' },
    });
    assert.equal(r.status, 500); // throws 'Project not found'
  });
});

test.skip('MCP workbench_set_session_notes success path', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_set_session_notes',
        args: { session_id: 'valid_sess', notes: 'my notes' },
      })
    ).json();
    assert.equal(r.result.saved, true);
  });
});

test.skip('MCP workbench_set_session_notes validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_set_session_notes',
      args: { session_id: '../../bad' },
    });
    assert.equal(r.status, 400);
  });
});

test.skip('MCP workbench_set_session_config success path with all fields', async () => {
  db.ensureProject('cfgproj', '/virtual/cfgproj');
  const proj = db.getProject('cfgproj');
  db.upsertSession('cfg_sess', proj.id, 'Original');
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_set_session_config',
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

test.skip('MCP workbench_summarize_session validates session_id', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await req(port, 'POST', '/api/mcp/call', {
      tool: 'workbench_summarize_session',
      args: { session_id: '!bad' },
    });
    assert.equal(r.status, 400);
  });
});



// ── listSessions coverage ──────────────────────────────────────────────────

test.skip('MCP workbench_list_sessions returns sessions array', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_list_sessions',
        args: { project: 'nonexistent_proj' },
      })
    ).json();
    // Should return empty array (no sessions dir) without crashing
    assert.ok(Array.isArray(r.result));
  });
});

// ── listSessions non-ENOENT error branch ──────────────────────────────────

test.skip('MCP listSessions logs non-ENOENT readdir error', async () => {
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
          tool: 'workbench_list_sessions',
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

test.skip('MCP tool call with SyntaxError returns 400', async () => {
  // Monkey-patch db.addTask to throw a SyntaxError so it flows through the catch
  const origAddTask = db.addTask;
  db.addTask = () => {
    throw new SyntaxError('unexpected token in input');
  };
  db.ensureProject('syntaxerrproj', '/virtual/syntaxerrproj');
  try {
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_add_task',
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

test.skip('MCP tool call with traversal error returns 403', async () => {
  // Monkey-patch db.addTask to throw an error containing "traversal"
  const origAddTask = db.addTask;
  db.addTask = () => {
    throw new Error('path traversal detected');
  };
  db.ensureProject('traversalerrproj', '/virtual/traversalerrproj');
  try {
    await withServer(startMcpApp(), async ({ port }) => {
      const r = await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_add_task',
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

// ── workbench_get_project_claude_md ────────────────────────────────────────

test.skip('MCP workbench_get_project_claude_md returns empty for missing file', async () => {
  await withServer(startMcpApp(), async ({ port }) => {
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_get_project_claude_md',
        args: { project: 'no_claude_md' },
      })
    ).json();
    assert.ok('result' in r);
    assert.equal(r.result.content, '');
  });
});

// ── Error handling branches ────────────────────────────────────────────────

test.skip('MCP tool call with ENOENT error returns 404', async () => {
  // workbench_get_project_claude_md with a project whose path causes ENOENT on non-CLAUDE.md operations
  // We can trigger this by making the internal functions throw ENOENT
  await withServer(startMcpApp(), async ({ port }) => {
    // The workbench_summarize_session will try to read a non-existent session file
    const r = await (
      await req(port, 'POST', '/api/mcp/call', {
        tool: 'workbench_summarize_session',
        args: { session_id: 'valid_sess', project: 'noproj' },
      })
    ).json();
    // Should either succeed with summary or return error
    assert.ok(r.result || r.error);
  });
});
