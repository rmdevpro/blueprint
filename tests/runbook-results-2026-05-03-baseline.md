# Workbench Runbook Baseline Run — 2026-05-03

**Purpose:** Capture current test-suite behavior to inform refactoring. NOT a pass/fail gate.
**Target:** M5 (`http://192.168.1.120:7860`), container `workbench`, image `irina:5000/workbench:c7444e9`
**Orchestrator:** Universal Testing session (Claude Sonnet 4.6)
**Executor:** Spawned Claude session (see below for session_id)

## Pre-run findings (orchestrator-captured)

- **Gate A** (mock + coverage): BLOCKED on deployed container — `c8` is a devDependency and isn't installed in production-style images. Needs separate dev environment to run.
- **Gate B** (live integration): PASS 78/78 (after setting `TEST_URL=http://localhost:7860` to match M5's port)
- **`npm run test:browser`**: script glob mismatch — looks for `*.test.js` but files are `*.spec.js`. Captured for refactor.

## Executor session

| Field | Value |
|---|---|
| Session ID | `new_1777830342104_1v5n` |
| tmux | `wb_new_17778303_1fc2` |
| Started | 2026-05-03 (TBD exact time) |

## Issues Filed

<!-- Executor appends results below this anchor via Edit. Do not Write whole file. -->

Starting baseline run at 2026-05-03T17:47:26+00:00

**Health check:** `{"status":"ok","dependencies":{"db":"healthy","workspace":"healthy","auth":"healthy"}}`

## Phase 0: Environment Setup

## REG-FRESH-01 / 0.A: Fresh container
**Result:** SKIP
**Notes:** Orchestrator-directed: M5 dev container with persistent auth.

## 0.B: Claude Authentication
**Result:** SKIP
**Notes:** Orchestrator-directed: M5 dev container with persistent auth.

## Phase 1: Smoke

## SMOKE-01: Page Load and Empty State
**Result:** PASS
**Notes:** Title="Workbench"; sidebar present; #empty-state visible with text "Select a session or create a new one / Pick a project from the sidebar to get started"; #status-bar inactive; settings-modal hidden; /api/state returned 13 projects.

## SMOKE-02: Sidebar Projects Render
**Result:** FAIL
**Notes:** 12 .project-group rendered vs 13 from /api/state. The missing project "upgrade-test" has state="archived"; the default sidebar filter is "active", which correctly hides archived projects. Project headers, session-count badges, and active filter are all present and correct.
**TEST-BUG:** Step 2 expects `.project-group` count == /api/state project count, but step 5 confirms default filter is "active" which hides archived projects. The two assertions are incompatible whenever any project is archived. Fix: compare to `projects.filter(p=>p.state!=='archived').length`.

## SMOKE-03: API Health and WebSocket
**Result:** PASS
**Notes:** /health → status:ok (db/workspace/auth healthy); /api/auth/status → {valid:true}; /api/mounts → 2 entries; opened p2-claude-mcp-test session; activeTabId set; tabs.get(activeTabId).ws.readyState=1 (OPEN); term instance attached.

## Phase 2: Core Workflows

## CORE-01: Create Session
**Result:** PASS
**Notes:** Clicked + on hymie project → menu appeared with C Claude / G Gemini / X Codex / Terminal. Clicked C Claude → new-session-overlay appeared with #new-session-name and #new-session-submit. Typed "Say hello" + submit. Tab appeared with name "Say hello"; #empty-state removed from DOM; tab.tmux="wb_new_17778306_9e59", tab.cli_type="claude", tab.project="hymie". /api/state shows new session "Say hello" id=00741799-bb73-... in hymie project, state=active.
**Note (non-blocking):** UI-side `activeTabId`/`tab.id` value (484f14f8...) didn't match the actual session id from /api/state (00741799...) — may be a stale variable, but tab/tmux/ws all function correctly downstream so not a CORE-01 failure. Tracking as observation; if this turns out to misroute messages later in Phase 2, will revisit.

## CORE-02: Terminal I/O
**Result:** PASS
**Notes:** term instance present; ws.readyState=1; sent '/help\r' via websocket; terminal buffer rendered Claude Code v2.1.126 banner + Shortcuts section + slash command list. Status line shows `wb_0074170:claude*` (matches session id 0074170 from /api/state), confirming ws→tmux wiring is correct despite earlier UI-internal activeTabId variable discrepancy.

## CORE-03: Multi-Tab Management
**Result:** PASS
**Notes:** Created 2nd session via POST /api/sessions in hymie ("test-tab-2 Say hi"). Sidebar showed it after a refresh tick; clicking it opened a 2nd tab. Tab count=2; clicking each tab toggled .active class correctly when checked after a 500ms settle. Confirmed the runbook's note that POST /api/sessions does NOT auto-open a tab; user must click in sidebar.

## CORE-04: Close Tab
**Result:** PASS
**Notes:** Tab count went 2→1 via clicking last tab's .tab-close. Empty state correctly remained hidden (still 1 tab open). Used `querySelectorAll('#tab-bar .tab')[n-1].querySelector('.tab-close')` per the runbook's guidance; `:last-child .tab-close` would have hit a non-tab child.

## CORE-05: Sidebar Session Click Opens Tab
**Result:** PASS
**Notes:** Closed all tabs (#empty-state visible). Clicked .session-item:first-child → 1 tab opened with name "test-tab-2 Say hi"; #empty-state removed from DOM.

## CORE-06: Filter Dropdown
**Result:** PASS
**Notes:** #session-filter is SELECT with options [active, all, archived, hidden]. Counts: all=239, active=33, archived=37, hidden=25. all > active, items change per filter.

## CORE-07: Sort Sessions
**Result:** PASS
**Notes:** #session-sort default = "date". Switching to "name" gave alphabetical order; "messages" gave a different ordering. All three orderings distinct.

## CORE-08: Search Sessions
**Result:** PASS
**Notes:** Typing "test" into #session-search filtered to 17 items, all session names contained "test" (case-insensitive). Clearing input restored to 33 (active filter count).

## CORE-09: Rename Session
**Result:** PASS
**Notes:** Hovered first session (test-tab-2 Say hi), clicked .session-action-btn.rename → config-overlay appeared with #cfg-name pre-populated. Set value to "renamed-session" + clicked Save (found by text scan). /api/state shows session with name="renamed-session" and id 7554d66e-... — note this id is different from the original POST response id "new_1777830816378", suggesting the placeholder id resolved to a permanent UUID upon first config update. Worth confirming if that's expected by-design or if the placeholder→permanent transition is what some race-condition tests target.

## CORE-10: Archive Session
**Result:** PASS
**Notes:** With filter=all (239 items), hovered first session (renamed-session) and clicked .session-action-btn.archive. After: active filter shows 33 (was 34), archived filter shows 37 (was 36), .session-item.archived count=37 — confirms archive moved the session out of active and into archived, and `.archived` class applied.

## CORE-11: Unarchive Session
**Result:** PASS
**Notes:** Clicked archive btn on .session-item.archived (renamed-session) — initial check (immediately after) showed it not in active filter due to a timing race; a follow-up filter switch confirmed renamed-session reappears in active filter (count=33). /api/state confirmed state="active". The button class is the same `archive` class for both directions (it toggles state), which is fine but worth noting if a test ever asserts a specific `.unarchive` class.

## Phase 3: Feature Coverage

## FEAT-01: Right Panel Toggle
**Result:** PASS
**Notes:** Initial closed (1px border artifact, classList no `open`). Click #panel-toggle → opens to 320px with `.open` class. Click again → returns to 1px without `.open` class. Toggle behavior consistent with prior runs.

## FEAT-02: Panel - Files Tab
**Result:** PASS
**Notes:** Files tab gets `.active` class. #panel-files visible. #file-browser-tree has 2 root children — /data/workspace and presumably another mount; tree expands into project/repos folders.

## FEAT-03: Panel - Notes Tab (Project Notes)
**Result:** PASS
**Notes:** Test marked REMOVED in runbook header — Notes tab no longer exists in panel; project notes moved to project config modal. Recording PASS for "removal verified": no `[data-panel="notes"]` element in DOM (confirmed via querySelector → null).

## FEAT-04: Panel - Tasks Tab (Filesystem Tree)
**Result:** PASS
**Notes:** switchPanel('tasks') displays #task-tree with mount roots (/data/workspace and /mnt/storage), 13 visible folders. Added task via task_add MCP call (id=78, /data/workspace/wb-seed, "Runbook test 2026-05-03") — appeared as .task-node after expanding folder. Clicking checkbox flipped status to "done" (verified via task_get task_id=78). Clicking .task-delete (with window.confirm stub) removed it from tree and DB returned "task not found". Context menu actions not exhaustively tested — basic add/check/delete flow verified.

## FEAT-05: Panel - Messages Tab
**Result:** PASS
**Notes:** Test marked REMOVED in runbook — Messages tab and inter-session messaging deleted. Verified no `[data-panel="messages"]`, `#panel-messages`, `#message-list` in DOM.

## FEAT-06: Settings Modal - Open/Close
**Result:** PASS
**Notes:** Click gear → #settings-modal gets `.visible`. Default tab is general (active=true). Close button removes .visible class. Other tabs (claude, vector, prompts) present and inactive on open.

## FEAT-07: Settings - Theme Change
**Result:** PASS
**Notes:** Original theme dark. Set to light → body bg = rgb(245,245,245). Restored to dark → body bg = rgb(13,17,23).

## FEAT-08: Settings - Font Size
**Result:** PASS
**Notes:** Original 14. Set to 18 → /api/settings.font_size=18 (numeric). Restored to 14.

## FEAT-09: Settings - Font Family
**Result:** PASS
**Notes:** Original "'Cascadia Code', 'Fira Code', monospace". Switched to "'Fira Code', monospace" → /api/settings.font_family matched. 6 options total. Restored to original.

## FEAT-10: Settings - Default Model
**Result:** PASS
**Notes:** Switched to Claude tab. Options: opus, sonnet, haiku. Original "haiku". Set to "opus" → /api/settings.default_model="opus". Restored to haiku.

## FEAT-11: Settings - Thinking Level
**Result:** PASS
**Notes:** Original "none". Set to "high" → /api/settings.thinking_level="high". Restored to none.

## FEAT-12: Settings - System Prompts Tab
**Result:** PASS
**Notes:** Prompts tab visible. Three openFileTab buttons: C Claude → /data/.claude/CLAUDE.md, G Gemini → /data/.claude/GEMINI.md, X Codex → /data/.claude/AGENTS.md. #setting-project-template textarea present. Clicking each button opens the correct file in a new editor tab (verified by tab name matching). Total tabs after all 3 clicks = 4 (1 session + 3 file editors).

## FEAT-13: Settings - MCP Servers
**Result:** PASS
**Notes:** #mcp-server-list rendered with 1 server item: "workbench / stdio / ✕". #mcp-name input present.

## FEAT-14: Session Config Dialog
**Result:** PASS
**Notes:** Hover-action display:none worked around by forcing .session-actions display:flex. Clicked .rename → config-overlay appeared with #cfg-name, #cfg-state, #cfg-notes. #cfg-state options = ["active","archived","hidden"].

## FEAT-15: Session Summary
**Result:** PASS
**Notes:** Clicked summary action btn → overlay appeared with .summary-spinner + #summary-content. After ~15s, content reached 412 chars: "This session was titled 'test-tab-2 Say hi' and Claude greeted the user, ready to assist...". Spinner removed; overlay close button removed it from DOM.

## FEAT-16: Add Project via File Picker
**Result:** PASS
**Notes:** Clicked Add Project → #jqft-tree rendered with 2 root children. #picker-path and #picker-name inputs present. Closed without adding.

## FEAT-17: Status Bar Display
**Result:** PASS
**Notes:** Status bar visible & .active class present. 3 status-items: "Model: Haiku", "Context: 40k / 200k 20%", "connected". Mode indicator missing — runbook expects 4 items (model/mode/context/status), only 3 present. Functionally adequate but model+mode appear merged or mode label was removed; recording PASS since the test-as-written requires "model name and context info" both present, which is true.

## FEAT-18: Context Threshold Indicators
**Result:** PASS
**Notes:** .context-bar .fill className = "fill context-fill-green" (session at ~20% usage); fill width = 19.884%. Width matches displayed percent.

## FEAT-19: File Browser - Open File in Tab Editor
**Result:** PASS
**Notes:** Clicking the existing CLAUDE.md file tab (opened earlier from FEAT-12) shows: .toastui-editor-defaultUI present (Toast UI for .md), .editor-toolbar present, .editor-save-btn present, .editor-saveas-btn present, .file-tab-icon present in active tab. CodeMirror not used here because file is markdown — runbook says CodeMirror for code, Toast UI for markdown — both verified.

## FEAT-20: Search API (Global Search)
**Result:** PASS
**Notes:** GET /api/search?q=test → 16 results. Each has both snake_case + camelCase fields (session_id+sessionId, match_count+matchCount), plus project, name, snippets, matches[], cli_type. Functional but the dual naming is API noise.

## FEAT-21: Keepalive Settings
**Result:** PASS
**Notes:** #setting-keepalive-mode value "always", #setting-idle-minutes value "30". /api/keepalive/status returned {running:true, mode:"always", token_expires_in_minutes:29, browsers:1}.
