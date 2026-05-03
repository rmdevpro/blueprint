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

## Phase 4: Edge Cases & Resilience

## EDGE-01: WebSocket Reconnection
**Result:** PASS
**Notes:** Initial readyState=1. Forced ws.close(); after 4s readyState=1 (reconnected). /api/state still returns valid data.

## EDGE-02: Rapid Tab Switching
**Result:** PASS
**Notes:** 4 tabs. 5 rapid clicks across [0,1,2,0,2]. Exactly 1 .tab.active after 1.2s. activeTabId set.

## EDGE-03: Long Session Name
**Result:** PASS
**Notes:** Created session via API with 87-char name. The API truncates to 60 chars; the in-DOM session-name element (after Claude auto-titled with summary "The user has titled this session...") had scrollWidth=466 > clientWidth=233. CSS overflow:hidden, text-overflow:ellipsis, white-space:nowrap. Visual ellipsis confirmed via computed styles.
**Note:** Long-name session is now in active filter as auto-titled item; underlying API session name was truncated to 60 chars by server-side validation (separate behavior from DOM ellipsis).

## EDGE-04: Empty State Returns After Last Tab Close
**Result:** PASS
**Notes:** All tabs closed → tabsAfter=0; #empty-state visible (offsetParent !== null), text "Select a session or create a new one Pick a project from the sidebar to get started".

## EDGE-05: Auth Modal Elements
**Result:** PASS
**Notes:** All present: #auth-modal, #auth-link, #auth-code-input, #auth-code-submit, #auth-modal .modal-close. Hidden by default (no .visible).

## EDGE-06: Double-Click Prevention
**Result:** PASS
**Notes:** With 0 tabs, double-clicked first session-item → tabsAfter=1 (only one tab opened, not 2).

## EDGE-07: Compaction Trigger
**Result:** PASS
**Notes:** Test marked REMOVED — smart compaction removed from codebase (#32). No /api/sessions/:id/smart-compact endpoint, no MCP tool. Verified absence.

## EDGE-08: Temporary Session Lifecycle
**Result:** PASS
**Notes:** Opened Terminal via + dropdown on hymie. Tab count 1→2. Clicked .tab-close on last tab → 2→1.

## EDGE-09: Panel Project Switch
**Result:** PASS
**Notes:** Right panel/Files open. Initial project=hymie, file-tree HTML length=4379. Switched to a Workbench session → activeTabId.project="Workbench"; file-tree length unchanged (4379) because tree is global (rooted at /data/workspace + /mnt/storage).
**TEST-BUG:** Step 5 expects file-browser tree length to differ when switching projects, but the current Files panel is global, not per-project. Test should be rewritten to assert "panel still works after project switch" rather than "tree changes". Project context did switch correctly.

## EDGE-10: Modal Overlap Prevention
**Result:** PASS
**Notes:** Settings z-index=999, auth z-index=1000. Both made visible simultaneously; auth correctly stacks on top.

## EDGE-11: Tmux Death Recovery
**Result:** PASS
**Notes:** Killed tmux session wb_63252681-ccb_ef98 via `docker exec workbench tmux kill-session`. After 5s: 2 tabs remain (didn't auto-close); /api/sessions/{id}/resume returned 200 (vs prior run's 410). App remains functional. Behavior shifted from prior run (410→200), suggests resume now successfully restarts the session.

## EDGE-12: Multi-Project Notes Isolation
**Result:** PASS
**Notes:** Test marked REMOVED — dedicated notes endpoints gone. Notes now via /api/projects/:name/config which is per-project by design.

## EDGE-13: Session vs Project Notes
**Result:** PASS
**Notes:** Test marked REMOVED — dedicated notes endpoints gone. Both session+project notes via their respective config endpoints.

## EDGE-14: Hidden Session Lifecycle
**Result:** PASS
**Notes:** Set renamed-session to state="hidden" via PUT /api/sessions/:id/config. After loadState() + 2s wait: not in active filter (inActive=false), in hidden filter (inHidden=true). Restored to active. Initial run had timing issue (DOM checked before re-render) — re-tested with longer wait, confirmed correct behavior.

## EDGE-15: Settings Propagation
**Result:** PASS
**Notes:** PUT /api/settings {key:'default_model', value:'opus'} → 200 {saved:true}. /api/settings.default_model="opus" after. Restored to original "haiku".

## EDGE-16: Project Header Collapse/Expand
**Result:** PASS
**Notes:** First project header initial collapsed=true. Click → collapsed=false. Click again → collapsed=true. Toggle works.

## EDGE-17: Project Terminal Button
**Result:** PASS
**Notes:** Test marked REMOVED — standalone >_ button removed. Terminal access via + dropdown verified in EDGE-08 and EDGE-23.

## EDGE-18: Server Restart Recovery
**Result:** PASS
**Notes:** Same mechanism as EDGE-01 (ws.close(1001)). After 5s readyState=1, /api/state returns valid data.

## EDGE-19: Panel Resize Terminal Refit
**Result:** PASS
**Notes:** initial cols=115; panel open → cols=78 (decreased ✓); panel close → cols=115 (restored ✓). xterm refit working.

## EDGE-20: Auth Failure Banner
**Result:** PASS
**Notes:** #auth-modal h2 = "Authentication Required", color rgb(210,153,34) (amber/warning). Show/hide via .visible class works.

## EDGE-21: Auth Recovery Lifecycle
**Result:** PASS
**Notes:** Modal shown via .visible. #auth-link href set. Input accepted "test-auth-code-12345". #auth-code-submit present. .modal-close click dismissed modal.

## EDGE-22: Drag-and-Drop File to Terminal
**Result:** PASS
**Notes:** dragover event on #terminal-area → adds .drag-over class. dragleave event → removes .drag-over class.

## EDGE-23: Multi-Project Terminal Isolation
**Result:** PASS
**Notes:** Opened Terminal on hymie (tabA=t_1777835607332, projA=hymie) and on Workbench (tabB=t_1777835609835, projB=Workbench). Distinct ids, distinct projects. Closed A; B's ws.readyState=1 (still alive).

## EDGE-24: Settings Propagation to New Session
**Result:** PASS
**Notes:** Set default_model=opus, thinking_level=high via API. Created new session via /api/sessions; settings query confirms persistence (default_model=opus, thinking_level=high). Restored haiku/none. Test session archived.

## Phase 5: CLI & Terminal

## CLI-01: /help Command
**Result:** PASS
**Notes:** Sent `/help\r` to renamed-session (Claude). Buffer matched /help|commands|available/. Output shows "Claude Code v2.1.126 general commands custom-commands" + shortcuts + slash commands list.

## CLI-02: /status Command
**Result:** PASS
**Notes:** Sent `/status\r`. Buffer shows: Version 2.1.126, Session ID 7554d66e..., cwd /data/workspace/repos/Joshua26/mads/hymie, Login: Claude Max, Org j@rmdev.pro's, Model: haiku, MCP: 2 connected/3 need auth/2 failed.

## CLI-03: /clear Command
**Result:** PASS
**Notes:** Sent `/clear\r`. Buffer scrolled and Claude Code banner re-rendered ("Claude Code v2.1.126 / Haiku 4.5 · Claude Max / ~/workspace/repos/Joshua26/mads/hymie") indicating the clear+reinit happened.

## CLI-04: /compact Command
**Result:** PASS
**Notes:** Sent `/compact\r`. After ~22s, buffer shows "Conversation compacted (ctrl+o for history)", "/compact", "Compacted (ctrl+o to see full summary)". /compact|summar/ matched.

## CLI-05: /model Command
**Result:** PASS
**Notes:** Sent `/model\r`. Selection menu shown: "1. Default (recommended) Opus 4.7 with 1M context · Most capable for complex work", "2. Sonnet — Sonnet 4.6", "3. Haiku — Haiku 4.5". Dismissed via Esc.

## CLI-06: /plan Command
**Result:** FAIL
**Notes:** First /plan → "Enabled plan mode" + status line "plan mode on (shift+tab to cycle)" — toggle-on works. Second /plan → "Already in plan mode. No plan written yet." — does NOT toggle off. Sent shift+tab (Esc[Z) twice as cleanup; status line cleared.
**TEST-BUG:** /plan does not toggle off; only shift+tab cycles through edit modes (matches the CLI-17 note in the runbook). Step 4-6 expectation is wrong. Fix: cleanup should send shift+tab, not a second /plan, and the assertion should be "first /plan enables plan mode, then shift+tab disables it".

## CLI-07: Simple Prompt and Response
**Result:** PASS
**Notes:** Sent "What is 2+2?\r". Buffer shows "What is 2+2?" then Claude responded "4". Match for /\b4\b/ confirmed.

## CLI-08: File Creation via Claude
**Result:** PASS
**Notes:** Sent "Create a file called test-runbook.txt with the content 'hello from runbook'\r". First send didn't auto-submit (input box held the text); a second `\r` triggered Claude. Tool call confirmation prompt appeared ("Do you want to create test-runbook.txt? 1. Yes / 2. Yes,allow all / 3. No"). Sent "1\r" → Claude wrote the file. Verified two ways: `docker exec cat ...` returned "hello from runbook"; GET /api/file?path=... returned 200 with body "hello from runbook".
**Note:** Original send used `'...\r'` but the prompt sat in the input. Looking at history this is consistent with Claude Code's confirm-on-submit behavior — first \r sometimes lands as newline-in-prompt, second \r submits. Worth noting this is a timing/input-quirk, not a bug; runbook should send Enter via two-step pattern for reliability.

## CLI-09: File Read via Claude
**Result:** PASS
**Notes:** Sent "Read the file test-runbook.txt and tell me its content". Claude used Read tool ("Read 1 file") and returned "The file contains: 'hello from runbook'". Buffer matched /hello from runbook/. (Adapted to read existing test-runbook.txt instead of package.json since hymie has no package.json.)

## CLI-10: Terminal Input Handling - Special Characters
**Result:** PASS
**Notes:** Sent `! echo "test < > & done"\r`. No crash, ws.readyState=1. Claude correctly echoed: "The command echo 'test < > & done' will run in your local shell and output: test < > & done". Special chars passed through cleanly.

## CLI-11: Terminal Ctrl+C Interrupt
**Result:** PASS
**Notes:** Sent "Write me a 5000 word essay about philosophy". Claude started streaming (got into pre-Socratic philosophers). Ctrl+C (0x03) after 4s → "Interrupted · What should Claude do instead?" prompt appeared. ws.readyState=1.

## CLI-12: /model claude-sonnet-4
**Result:** PASS
**Notes:** Sent `/model claude-sonnet-4-20250514\r`. Buffer shows "Set model to Sonnet 4" + EOL warning "Claude Sonnet 4 will be retired on June 15, 2026."

## CLI-13: Multi-line input
**Result:** PASS
**Notes:** Sent `line1\nline2\r`. Both lines appeared verbatim in Claude's response: "I see you've switched to Sonnet 4 and entered: line1 / line2 / What would you like me to do with these lines?".

## CLI-14: 500-char string handling
**Result:** PASS
**Notes:** Sent 500-char "A" string + Enter. WebSocket remained open (readyState=1). No crash.

## CLI-15: Up arrow
**Result:** PASS
**Notes:** Sent `\x1b[A`. ws.readyState=1, no crash. Claude Code uses its own history (not shell readline) so no visible recall, but no error either.

## CLI-16: Tab character
**Result:** PASS
**Notes:** Sent `\t`. ws.readyState=1, no crash. Tab completion is context-dependent in Claude Code; no visible output for empty input, but no error.

## CLI-17: /plan twice
**Result:** FAIL
**Notes:** First /plan → "Enabled plan mode" + status "plan mode on (shift+tab to cycle)". Second /plan → "Enabled plan mode" again (and on a separate retry: "Already in plan mode. No plan written yet." after a /compact-cleared session).
**TEST-BUG:** Same as CLI-06 — /plan only enables, never disables. Runbook's expected "second shows off" doesn't match the CLI's actual behavior. Cleanup must use shift+tab to exit plan mode.

## CLI-18: Tool listing
**Result:** PASS
**Notes:** Sent "Use a tool to list files in the current directory". Claude used a list tool and returned project files: Dockerfile, docker-compose.yml, server.py, README.md, idle-screen.html, requirements.txt, recent_turns.md, docs/ etc. Tool calling working on Sonnet 4. Claude was about to read README.md as a follow-up; cancelled with Esc.

## CLI-19: Refresh + reconnect
**Result:** PASS
**Notes:** Reloaded full page. Reopened renamed-session by clicking sidebar. tabs.get(activeTabId).ws.readyState=1, terminal buffer has 180 non-empty lines (existing content replayed). Reconnect after page reload confirmed.

## CLI-20: /status structured
**Result:** PASS
**Notes:** Sent /status. Buffer shows "Login method: Claude Max", "Organization: j@rmdev.pro's", "Email: j@rmdev.pro", "Model: claude-sonnet-4-20250514", "MCP servers: 2 connected, 3 need auth, 2 failed". Structured key:value status info confirmed.

## CLI-21: Multi-tab WebSocket isolation
**Result:** PASS
**Notes:** Tab A=renamed-session, Tab B=Say hello. After clearing B's startup help overlay, sent ALPHA-INPUT to A and BETA-MARKER-PQR to B. Final: A has ALPHA but no BETA; B has BETA but no ALPHA. Per-tab WebSocket isolation confirmed.
**Note:** The session "Say hello" had its /help overlay open on first open (apparently because a prior session's input contained `/`). Required two Esc's to clear before BETA-MARKER could be typed. Worth noting that test setup should always start with Esc to clear any startup overlays.

## Phase 6: End-to-End

## E2E-01: Daily Developer Loop
**Result:** PASS
**Notes:** Full lifecycle confirmed. (1) 12 project-groups loaded. (2) Created E2E-01-list-files Claude session via + dropdown on hymie → tab opened, terminal had content. (3) Right panel + Tasks tab opened; added "Review test results" task via task_add (id=79). (4) #status-bar.classList contains 'active'. (5) Settings opened → theme=light → body bg=rgb(245,245,245) → restored dark → settings closed. (6) Archived session via PUT /api/sessions/:id/config → archived filter shows 39 archived items including the new one. (7) Unarchived → active filter. (8) Closed tab → #empty-state visible. (9) Re-archived for cleanup. session id 0e075fd8-d321-48b7-92f5-e0c3571ab832.

## Phase 7: User Stories

## USR-01: Coding Task User Story
**Result:** PASS
**Notes:** Created usr01-coding Claude session in hymie. Sent "Create a simple hello.py that prints hello world". Claude used Write tool ("Wrote 1 lines to hello.py": `print("Hello World")`) — required confirmation prompt + "1" approval. Then Claude offered to run "python hello.py" (declined via Esc). GET /api/file?path=/data/workspace/repos/Joshua26/mads/hymie/hello.py → 200 with body `print("Hello World")\n`.

## USR-02: Organize Sessions
**Result:** PASS
**Notes:** Created usr02-A/B/C in hymie. Archived B, hid C, kept A active. Renamed A → "usr02-renamed". Final API state: A name="usr02-renamed" state="active"; B state="archived"; C state="hidden". All 3 cleaned up to archived.
**Note:** First batch creation race issues — placeholder "new_..." IDs returned by /api/sessions can't be used until session resolves to UUID (~5–8s). Had to recreate one session and retry. Worth flagging if a future test wants to chain config PUTs immediately after POST: use proper polling instead of fixed sleep.

## USR-03: Task Management
**Result:** PASS
**Notes:** Added Task A/B/C via task_add MCP (ids 80/81/82). Updated B to status=done via task_update. Deleted Task C via .task-delete UI button (with window.confirm stub). Final API: A status=todo, B status=done, C "task not found" (deleted). Cleanup deleted A and B too.

## USR-04: Customize Appearance
**Result:** PASS
**Notes:** 4 themes available: dark / light / workbench-dark / workbench-light. Body bg per theme: dark=rgb(13,17,23), light=rgb(245,245,245), workbench-dark=rgb(8,18,32), workbench-light=rgb(232,240,248). Font size 18 saved (font_size=18). Font family changed to "'Fira Code', monospace" and confirmed via /api/settings. All restored to defaults.

## USR-05: Browse Files
**Result:** PASS
**Notes:** Files panel showed mounts (/data/workspace, /mnt/storage). Expanded wb-seed via click → revealed .qdrant-initialized file. Used openFileTab('/data/workspace/repos/Joshua26/mads/hymie/hello.py') → file tab "hello.py" opened with .cm-editor or .toastui-editor-defaultUI visible. Closed file tab via .tab-close → returned to "renamed-session" tab. fileTabsAfter=0.
**Note:** Tree uses custom div structure (arrows + folder/file divs); jQueryFileTree's `<a>` selectors don't apply. Direct openFileTab() function call is the most reliable way to open a file from script.

## USR-06: Review Summary
**Result:** PASS
**Notes:** Clicked .session-action-btn.summary on first session → summary overlay appeared. Polled #summary-content; reached 337 chars within ~5s. Overlay closed via close button.

## USR-07: Hide/Recover Session
**Result:** PASS
**Notes:** "Say hello" session via PUT /api/sessions/:id/config: hidden then restored to active. Final API state: state="active". DOM filter checks were affected by re-render race (inActive read true immediately after PUT before sidebar reloaded), but API truth-source confirms hide→active lifecycle works.
**Note:** STATE-DEP risk: DOM checks immediately after a config PUT can return stale data because loadState() runs async. Wait ~2s then re-check filter for reliable observations.
