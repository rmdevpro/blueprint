# Unified UI Test Runbook

**Target:** http://192.168.1.120:7869
**Container:** blueprint-merged on M5
**Branch:** merge/easy-fixes-into-refactor
**Tool:** Local Playwright MCP (NOT Malory)
**Total:** 117 test blocks (79 from refactor + 38 new)

## CRITICAL: What "test" means

Every test MUST involve actual browser interaction via Playwright:
- **Click buttons** — not just check they exist
- **Fill forms** — type values, select options, click save
- **Verify results** — check what changed after the action
- **Take screenshots** — visual proof at key moments
- **Wait for state** — reload and verify persistence

Checking `!!document.querySelector('.button')` is NOT a test. Clicking the button, verifying the modal opens, filling the form, clicking save, and verifying the data persisted — THAT is a test.

---

## Progress Tracker

| Phase | Total | Pass | Fail | Skip |
|-------|-------|------|------|------|
| 1. Smoke | 3 | | | |
| 2. Core Workflows | 11 | | | |
| 3. Features | 21 | | | |
| 4. Edge Cases | 24 | | | |
| 5. CLI & Terminal | 11+batch | | | |
| 6. End-to-End | 1 | | | |
| 7. User Stories | 7 | | | |
| 8. New Features | 38 | | | |
| 9. Deferred | -- | -- | -- | skip |
| **Totals** | **117** | | | |

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

### NF-31: Ask CLI Validates Input
**Action:** POST to `/api/cli/ask` with `{cli: "claude"}` (no prompt).
**Verify:** Returns `{error: "prompt required"}`.

### NF-32: Ask CLI Real Call
**Action:** POST to `/api/cli/ask` with `{cli: "claude", prompt: "Reply with only pong"}`.
**Verify:** Returns result containing "pong".

### NF-33: Quorum Validates Input
**Action:** POST to `/api/quorum/ask` with `{project: "t"}` (no question).
**Verify:** Returns `{error: "question required"}`.

### NF-34: Guides Accessible
**Action:** Fetch all three guide files via `/api/file`.
**Verify:** All return 200 with correct content.

### NF-35: Skills Installed
**Action:** Fetch session and guides SKILL.md files via `/api/file`.
**Verify:** Both return 200.

### NF-36: New Prompts Exist
**Action:** Fetch session-nudge.md, session-resume.md, session-transition.md via `/api/file`.
**Verify:** All return 200.

### NF-37: Old Prompts Gone
**Action:** Fetch compaction-auto.md, compaction-prep-to-agent.md via `/api/file`.
**Verify:** All return 404 (or non-200).

### NF-38: Workspace and Mounts
**Action:** Fetch `/api/state` and `/api/mounts`.
**Verify:** workspace = `/mnt/workspace`. Mounts include `/mnt/workspace` and `/mnt/storage`.

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

## Phase 10: Hymie-Based Tests (OAuth Flow)

These tests require Hymie (192.168.1.130) — the desktop automation workstation with `mcp__hymie__desktop_*` tools. Playwright cannot handle the OAuth flow because it involves cross-origin popups on Claude's domain.

### HYMIE-01: Full OAuth Flow — Fresh Container
**Precondition:** Container with no credentials (wipe `.credentials.json`).
**Action:**
1. Hymie opens `http://192.168.1.120:7869` in a real browser
2. Create a session — auth modal should appear automatically
3. Click the OAuth link in the auth modal
4. Claude's login page opens (popup or redirect)
5. Complete login (enter credentials on Claude's domain)
6. Copy the auth code
7. Paste auth code into Blueprint's `#auth-code-input`
8. Click submit
**Verify:** Auth modal closes. Session becomes functional. `/api/auth/status` returns `{valid: true}`. Claude CLI responds to prompts.

### HYMIE-02: OAuth Token Refresh
**Precondition:** Container with expired credentials.
**Action:** Open Blueprint. Auth modal should appear. Complete the flow.
**Verify:** New token saved. Sessions work.

### HYMIE-03: Auth Recovery After Token Expiry
**Precondition:** Container with valid auth. Manually expire the token.
**Action:** Try to use a session. Auth failure banner should appear. Complete reauth.
**Verify:** Sessions resume working.

**Note:** These tests cannot be automated via Playwright — they require Hymie's desktop_click, desktop_type, and desktop_screenshot tools to interact with Claude's OAuth pages. The rest of the runbook injects credentials via `docker cp` to bypass OAuth for testing speed.

---

## Execution Notes

- Run Phase 1-8 tests via local Playwright MCP (NOT Malory)
- Run Phase 10 tests via Hymie desktop automation tools
- Take screenshots at minimum: page load, each modal open, each state change
- Do NOT skip tests or substitute API checks for UI clicks
- If a test requires interaction that Playwright can't do (real mic input), document it as SKIP with reason
- Phase 8 NF-27 through NF-38 can use `page.evaluate(fetch(...))` since they test API endpoints, not UI clicks
