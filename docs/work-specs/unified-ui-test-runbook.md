# Unified UI Test Runbook

**Target:** https://aristotle9-blueprint.hf.space (HF public Space with password auth)
**Fallback Target:** http://192.168.1.120:7869 (M5 test container — NOT a substitute for HF testing)
**Branch:** huggingface-space
**Tool:** Playwright MCP (local, NOT Malory)
**Total:** 147 test blocks (79 from refactor + 38 NF + 14 settings/vector + 16 multi-CLI/lifecycle)

## CRITICAL: Test on HF Spaces, NOT just M5

M5 containers use `Dockerfile` with different paths, ports, and user setup than HF Spaces (`Dockerfile.huggingface`). Testing on M5 does NOT verify the app works on HF. All UI testing MUST be done against the actual HF Space.

### HF Public Space with Password Auth

To test the full app on the public Space (which normally shows a gate/block page):

1. Set `BLUEPRINT_USER` and `BLUEPRINT_PASS` as Space secrets via HF API:
```bash
curl -X POST "https://huggingface.co/api/spaces/aristotle9/blueprint/secrets" \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"BLUEPRINT_USER","value":"testuser"}'
curl -X POST "https://huggingface.co/api/spaces/aristotle9/blueprint/secrets" \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"BLUEPRINT_PASS","value":"testpass123"}'
```

2. The gate page will show a login form instead of the "Duplicate this Space" template.

3. Use Playwright to navigate to the Space URL, fill in the login form, and submit.

4. After login, the full app is accessible — run all UI tests.

### Why not the private Space?

Private Spaces require HF account authentication at the proxy level. Playwright cannot authenticate to HF's proxy (it's not a simple cookie — HF uses server-side session validation). The public Space with password auth bypasses this by handling auth at the app level.

## CRITICAL: What "test" means

Every test MUST involve actual browser interaction via Playwright:
- **Click buttons** — not just check they exist
- **Fill forms** — type values, select options, click save
- **Verify results** — check what changed after the action
- **Take screenshots** — visual proof at key moments
- **Wait for state** — reload and verify persistence

Checking `!!document.querySelector('.button')` is NOT a test. Clicking the button, verifying the modal opens, filling the form, clicking save, and verifying the data persisted — THAT is a test.

**Every test MUST take screenshots** throughout execution — before actions, after clicks, when modals open, after state changes. All screenshots are kept as a record of the test progression.

## Test Results Directory

All test results — server-side, UI, coverage — go to `/storage/test-results/blueprint/`. Each run gets a timestamped directory:

```
/storage/test-results/blueprint/
  YYYY-MM-DDTHH-MM-SS/                ← run folder
    server/
      results.txt                     ← npm test output
      coverage.txt                    ← c8 coverage report
    ui/
      SMOKE-01/                       ← one folder per UI test
        01-page-load.png
        02-sidebar-check.png
      CORE-01/
        01-before-create.png
        02-session-created.png
      NF-04/
        01-click-pencil.png
        02-modal-open.png
        03-fill-notes.png
        04-after-save.png
      ...
    summary.md                        ← overall pass/fail/skip counts
```

- Each UI test gets its own subfolder named by test ID
- All screenshots from that test live in its folder, numbered sequentially
- No single "final" screenshot — keep every screenshot taken during the test
- Server test output and coverage reports go in `server/`
- `summary.md` at the run root records pass/fail/skip per phase

---

## Deployment Prerequisite: OAuth Authentication (Hymie)

This MUST run before any test phase. On a clean container, there are no Claude credentials — the CLI cannot function and all CLI/terminal tests will fail.

**Tool:** Hymie desktop automation (192.168.1.130) — `mcp__hymie__desktop_*` tools. Playwright cannot handle this because the OAuth flow involves cross-origin navigation to Claude's login page with popups.

**Alternative:** Inject credentials via `docker cp` from a container that already has them. This bypasses the OAuth flow for speed but does not test the real auth path.

### OAUTH-01: Initial Authentication on Clean Container
**Precondition:** Fresh container with no `.credentials.json`.
1. Hymie opens `http://192.168.1.120:7869` in a desktop browser
2. Create a project and session via the UI
3. Open the session — Claude CLI starts in tmux
4. CLI prints an OAuth URL to the terminal
5. Blueprint's `checkForAuthIssue()` detects the URL → auth modal appears
6. Click the OAuth link — Claude's login page opens
7. Complete login on Claude's domain
8. Copy the auth code
9. Paste into Blueprint's `#auth-code-input`, click submit
10. Verify: auth modal closes, CLI session becomes functional
11. Verify: `/api/auth/status` returns `{valid: true}`
12. Verify: `.credentials.json` exists with `claudeAiOauth` key

### OAUTH-02: Token Refresh After Expiry
**Precondition:** Container with expired token.
1. Open a session — CLI should fail, auth modal should reappear
2. Complete the flow again
3. Verify: new token works, sessions resume

### OAUTH-03: Credential Injection (Shortcut for Test Speed)
**When:** You don't need to test the OAuth UI and just want tests to run.
```bash
cat /path/to/.credentials.json | ssh aristotle9@192.168.1.120 \
  "docker exec -i CONTAINER sh -c 'mkdir -p /mnt/workspace/blueprint/.claude && cat > /mnt/workspace/blueprint/.claude/.credentials.json'"
```
Verify: `/api/auth/status` returns `{valid: true}`.

**After OAuth is complete (or credentials injected), proceed to Phase 1.**

---

## Progress Tracker

| Phase | Total | Pass | Fail | Skip |
|-------|-------|------|------|------|
| 0. OAuth (Hymie) | 3 | | | |
| 1. Smoke | 3 | | | |
| 2. Core Workflows | 11 | | | |
| 3. Features | 21 | | | |
| 4. Edge Cases | 24 | | | |
| 5. CLI & Terminal | 11+batch | | | |
| 6. End-to-End | 1 | | | |
| 7. User Stories | 7 | | | |
| 8. New Features | 38 | | | |
| 9. Deferred | -- | -- | -- | skip |
| **Totals** | **120** | | | |

---

## Phase 1-7: Refactor Team Tests (79 blocks)

Source: `/storage/quorum/manual/blueprint-test-04-09-26/ui-test-runbook.md`

Execute every test block from their runbook EXCEPT:
- Change target from `http://192.168.1.120:7867` to `http://192.168.1.120:7869`
- **SKIP** Phase 8 (smart compaction stress tests — feature removed)
- **SKIP** EDGE-07 (compaction trigger — feature removed)
- **ADAPT** FEAT-06: Settings modal now has "API Keys" section instead of "Quorum" section
- **ADAPT** FEAT-16: Add Project dialog now has a "+ Folder" button
- **ADAPT** FEAT-02: File browser now has "+ Folder" and "Upload" buttons
- **ADAPT** EDGE-16: Sidebar collapse now persists to localStorage across reload

For each test:
1. Follow the Steps exactly using Playwright
2. Take a screenshot at verification points
3. Record PASS/FAIL/SKIP
4. On FAIL: note what went wrong, file GitHub issue

---

## Phase 8: New Feature Tests (38 blocks)

### NF-01: Sidebar Collapse Persistence
**Action:** Click a project header to collapse it. Reload the page.
**Verify:** The project group is still collapsed after reload.
**How:** Click header → verify `.collapsed` class → `page.reload()` → wait → verify still `.collapsed`

### NF-02: Sidebar Expand Persistence
**Action:** Expand a collapsed project. Reload.
**Verify:** Still expanded after reload.

### NF-03: Sidebar localStorage Written
**Action:** Toggle a project collapse.
**Verify:** `localStorage.getItem('expandedProjects')` is updated.

### NF-04: Project Config Modal Opens
**Action:** Click the pencil button on a project header.
**Verify:** Modal appears with name, state, and notes fields populated correctly.

### NF-05: Project Config Save Name
**Action:** Open project config, change the name, click Save.
**Verify:** Modal closes. API returns new name. Sidebar shows new name after loadState.

### NF-06: Project Config Save State
**Action:** Open project config, change state to "archived", click Save.
**Verify:** Modal closes. Project disappears from sidebar (active filter). Switch to "Archived" filter — project appears.

### NF-07: Project Config Save Notes
**Action:** Open project config, type notes, click Save.
**Verify:** Modal closes. Reopen modal — notes are still there. API confirms.

### NF-08: Project State Filtering
**Action:** Archive a project via config modal. Click "Active" filter.
**Verify:** Archived project is not visible. Click "All" — it reappears. Click "Archived" — only it shows.

### NF-09: Session Restart Button Exists
**Action:** Open a session tab.
**Verify:** Restart button (↻) is visible in the session actions row.

### NF-10: Session Restart Click
**Action:** Click the restart button. Accept the confirm dialog.
**Verify:** Session still exists in sidebar. Session is marked active (green dot). Terminal reconnects.

### NF-11: File Browser Panel Opens
**Action:** Click the "Files" tab in the right panel.
**Verify:** Panel shows mount headers for /mnt/storage and /mnt/workspace.

### NF-12: File Browser Mount Expand
**Action:** Click the /mnt/workspace mount header.
**Verify:** Directory tree expands showing workspace contents.

### NF-13: File Browser New Folder Click
**Action:** Expand a directory. Click "+ Folder". Type a name in the prompt dialog.
**Verify:** Folder appears in the directory tree. Verify via API that the directory exists on disk.

### NF-14: File Browser Upload Click
**Action:** Expand a directory. Use the Upload button (programmatically set file input since headless can't use file picker).
**Verify:** File appears in directory. Verify content via API.

### NF-15: Add Project Dialog Opens
**Action:** Click the "+" button in the sidebar header.
**Verify:** Directory picker modal appears with file tree and Add button.

### NF-16: Add Project New Folder
**Action:** In the Add Project dialog, click "+ Folder". Type a name.
**Verify:** Folder created. Picker path auto-populated with the new folder.

### NF-17: Add Project Select and Add
**Action:** Click a directory in the picker. Click "Add".
**Verify:** Dialog closes. Project appears in sidebar. API confirms project exists.

### NF-18: Settings Modal Opens
**Action:** Click the Settings link/button.
**Verify:** Settings modal is visible.

### NF-19: Settings Shows API Keys Section
**Action:** Open settings.
**Verify:** "API Keys" heading exists. Gemini, Codex, and Deepgram fields are present.

### NF-20: Settings Old Quorum Fields Gone
**Action:** Open settings.
**Verify:** No elements with id `setting-quorum-lead`, `setting-quorum-fixed`, or `setting-quorum-additional`.

### NF-21: Settings Save Gemini Key
**Action:** Open settings. Type a value in the Gemini API Key field. Trigger save (onchange).
**Verify:** Reload page, reopen settings — key is still populated. API confirms value saved.

### NF-22: Settings Save Codex Key
**Action:** Same as NF-21 for Codex field.

### NF-23: Settings Save Deepgram Key
**Action:** Same as NF-21 for Deepgram field.

### NF-24: Settings Keys Load on Open
**Action:** Save all three keys via API. Open settings modal.
**Verify:** All three fields are pre-populated with saved values.

### NF-25: Mic Button in Status Bar
**Action:** Open a session tab (so status bar is active).
**Verify:** Mic button (🎤) is visible in the status bar.

### NF-26: Voice WebSocket Connects
**Action:** Open a WebSocket to `ws://host/ws/voice`.
**Verify:** Connection opens (or returns a "no key" error if no Deepgram key — both prove the endpoint works).

### NF-27: Session Endpoint Info
**Action:** POST to `/api/sessions/test/session` with `{mode: "info"}`.
**Verify:** Returns sessionId and sessionFile path.

### NF-28: Session Endpoint Transition
**Action:** POST to `/api/sessions/test/session` with `{mode: "transition"}`.
**Verify:** Returns a prompt containing "checklist".

### NF-29: Session Endpoint Resume
**Action:** POST to `/api/sessions/test/session` with `{mode: "resume"}`.
**Verify:** Returns a prompt containing "resuming after compaction".

### NF-30: Smart Compaction Endpoint Gone
**Action:** POST to `/api/sessions/test/smart-compact`.
**Verify:** Returns 404.

### NF-31 to NF-37: REMOVED
Ask CLI, Quorum, Guides, Skills, and Prompts tests removed — features were deleted or replaced by consolidated MCP tools.

### NF-38: Workspace Path
**Action:** Fetch `/api/state`.
**Verify:** workspace = `/home/blueprint/workspace`. No references to hopper or /mnt/workspace.

---

## Phase 9: Settings Reorganization + Vector Search (14 blocks)

### NF-39: Settings Has Four Tabs
**Action:** Open settings modal. Count tab buttons.
**Verify:** Four tabs visible: General, Claude Code, Vector Search, System Prompts.

### NF-40: General Tab Shows Appearance and API Keys
**Action:** Click General tab.
**Verify:** Appearance section (theme, font size, font family) and API Keys section (Gemini, OpenAI/Codex, Deepgram) visible. NO Claude Code / Keepalive sections. NO Features section.

### NF-41: Claude Code Tab Shows Model and Keepalive
**Action:** Click Claude Code tab.
**Verify:** Default Model dropdown, Thinking Level dropdown, Keepalive Mode dropdown, Idle timeout input all visible. General tab content hidden.

### NF-42: Claude Code Settings Persist
**Action:** On Claude Code tab, change thinking level to "high". Close and reopen settings.
**Verify:** Thinking level still shows "high". Server `/api/settings` returns `thinking_level: "high"`.

### NF-43: Vector Search Tab Shows Status
**Action:** Click Vector Search tab.
**Verify:** Qdrant status indicator visible (green circle + "Connected" or red circle + "Not available"). Provider dropdown visible.

### NF-44: Vector Search Provider Dropdown
**Action:** On Vector Search tab, verify provider dropdown options.
**Verify:** Options include: Hugging Face Free, Gemini, OpenAI, Custom. Gemini/OpenAI may be grayed out if no keys set.

### NF-45: Vector Search Custom Provider Fields
**Action:** Select "Custom" from provider dropdown.
**Verify:** Endpoint URL and API Key fields appear. Select "Hugging Face Free" — custom fields hidden.

### NF-46: Vector Search Collections Visible
**Action:** On Vector Search tab, scroll to Collections section.
**Verify:** 5 collection cards: Documents (checked), Code (unchecked), Claude Sessions (checked), Gemini Sessions (checked), Codex Sessions (checked). Each has dims input and Re-index button. Documents and Code have patterns textarea.

### NF-47: Vector Search Collection Dims Configurable
**Action:** Change Documents dims from 384 to 768. Close and reopen settings, go to Vector Search tab.
**Verify:** Documents dims shows 768. Server `/api/settings` returns `vector_collection_docs.dims: 768`.

### NF-48: Vector Search Collection Patterns Editable
**Action:** Add "*.rst" to Documents patterns textarea. Save (onchange).
**Verify:** Server `/api/settings` returns `vector_collection_docs.patterns` includes "*.rst".

### NF-49: Vector Search Ignore Patterns
**Action:** Verify ignore patterns textarea visible with default content.
**Verify:** Contains "node_modules/**", ".git/**", "*.lock" etc.

### NF-50: Vector Search Additional Paths
**Action:** Type "/storage/test" in additional path input, click Add.
**Verify:** Path appears in list with remove button. Server `/api/settings` returns `vector_additional_paths: ["/storage/test"]`.

### NF-51: Vector Search Re-index Button
**Action:** Click Re-index on Documents collection.
**Verify:** Button text changes to "Indexing...", then reverts to "Re-index".

### NF-52: Qdrant Status API
**Action:** Fetch `/api/qdrant/status`.
**Verify:** Returns `available: true`, `running: true`, collections object with point counts.

---

## Phase 10: Multi-CLI Sessions, Lifecycle, MCP Management (16 blocks)

### NF-53: Filter Bar is Dropdown
**Action:** Open the sidebar. Check the session filter control.
**Verify:** Filter is a dropdown (`<select>`) with options: Active, All, Archived, Hidden. Not buttons.

### NF-54: Sort Bar is Dropdown
**Action:** Check the session sort control.
**Verify:** Sort is a dropdown with options: Date, Name, Messages. Both filter and sort are side by side.

### NF-55: Plus Button Opens CLI Dropdown
**Action:** Click the `+` button on a project header.
**Verify:** A dropdown appears with options: C Claude, G Gemini, X Codex, Terminal.

### NF-56: Create Claude Session via Dropdown
**Action:** Click `+` → Claude on a project.
**Verify:** New session created with `cli_type: claude`. Session appears in sidebar.

### NF-57: Session Shows CLI Type Indicator
**Action:** Look at the session item in the sidebar.
**Verify:** CLI type indicator (C/G/X) appears on the session's second line, colored (orange C, blue G, green X). Active sessions have bright color, inactive are dimmed.

### NF-58: Terminal Button Gone from Project Header
**Action:** Look at the project header row.
**Verify:** No `>_` terminal button. Only `✎` (config) and `+` (new session dropdown).

### NF-59: Create Session via MCP (new action)
**Action:** Call `blueprint_sessions action=new cli=claude project=<name>`.
**Verify:** Returns `session_id`, `tmux`, `cli`.

### NF-60: Connect to Session by Name (connect action)
**Action:** Call `blueprint_sessions action=connect query="<session name>"`.
**Verify:** Returns `session_id`, `tmux`, `cli`. Tmux session is running.

### NF-61: Restart Session (restart action)
**Action:** Call `blueprint_sessions action=restart session_id=<id>`.
**Verify:** Returns `restarted: true`, `tmux`. Session is relaunched.

### NF-62: MCP Register
**Action:** Call `blueprint_sessions action=mcp_register mcp_name="test-mcp" mcp_config={...}`.
**Verify:** Returns `registered: "test-mcp"`.

### NF-63: MCP List Available
**Action:** Call `blueprint_sessions action=mcp_list_available`.
**Verify:** Returns servers array including "test-mcp".

### NF-64: MCP Enable for Project
**Action:** Call `blueprint_sessions action=mcp_enable mcp_name="test-mcp" project=<name>`.
**Verify:** Returns `enabled`. `.mcp.json` written to project directory.

### NF-65: MCP List Enabled
**Action:** Call `blueprint_sessions action=mcp_list_enabled project=<name>`.
**Verify:** Returns servers array including "test-mcp".

### NF-66: MCP Disable
**Action:** Call `blueprint_sessions action=mcp_disable mcp_name="test-mcp" project=<name>`.
**Verify:** Returns `disabled`. `.mcp.json` updated.

### NF-67: Tmux Periodic Scan Running
**Action:** Check server logs for periodic scan message.
**Verify:** Log shows "Started periodic tmux scan" with interval, max sessions, idle thresholds.

### NF-68: Only 3 MCP Tools
**Action:** Fetch `/api/mcp/tools`.
**Verify:** Exactly 3 tools: `blueprint_files`, `blueprint_sessions`, `blueprint_tasks`.

---

## Issue Filing Protocol

When a test fails:
1. Take a screenshot immediately
2. Note the test ID, step that failed, expected vs actual
3. File a GitHub issue:
```bash
gh issue create \
  --repo rmdevpro/blueprint \
  --title "[UI Test] TEST-ID: Brief description" \
  --body "**Test ID:** TEST-ID
**Step:** What failed
**Expected:** What should have happened
**Actual:** What happened
**Branch:** merge/easy-fixes-into-refactor"
```

---

---

## Execution Notes

- Run Phase 1-8 tests via local Playwright MCP (NOT Malory)
- Run Phase 10 tests via Hymie desktop automation tools
- Take screenshots at minimum: page load, each modal open, each state change
- Do NOT skip tests or substitute API checks for UI clicks
- If a test requires interaction that Playwright can't do (real mic input), document it as SKIP with reason
- Phase 8 NF-27 through NF-38 can use `page.evaluate(fetch(...))` since they test API endpoints, not UI clicks
