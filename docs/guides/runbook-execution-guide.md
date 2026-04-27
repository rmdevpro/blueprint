# Blueprint UI Test Runbook — Execution Guide

This guide is for the **orchestrator** who runs the master UI test runbook (`tests/blueprint-test-runbook.md`) against a Blueprint deployment. It covers spawning an executor, briefing it, monitoring it, recovering from common failure modes, and triaging the results.

The runbook itself is a test catalog — what to test. This guide is the procedure — how to drive it to completion.

## Roles

- **Orchestrator** — you. Decides target, spawns the executor, monitors, intervenes, triages results, files issues, applies fixes.
- **Executor** — a separate Claude session (typically Sonnet 4.6 in a tmux pane within Blueprint). Reads the runbook, runs each test using its tools, writes results to a separate file. Has no decision-making authority over what to skip.

Two distinct conversations. Don't conflate them. Never use a subagent (`Agent` tool) — the executor must be a real session with full Playwright + Bash + filesystem access.

## Phase 1 — Decide the target

Bind these placeholders before doing anything else:

- `${WORKBENCH_URL}` — base URL of the deployment under test
- `${WORKBENCH_CONTAINER}` — Docker container name on the host
- `${WORKBENCH_HOST}` — `user@host` reachable via ssh for `docker exec` etc.
- `${GATE_USER}` / `${GATE_PASS}` — gate credentials if the deployment is gated; empty otherwise

Pick orchestrator-directed SKIPs in advance. The executor is forbidden from choosing SKIP on its own — anything you skip must be explicit in the briefing. Common ones:

- Phase 0 (Fresh Container + Auth) — skipped when re-using an existing dev container with persistent auth
- Any specific REG-* you know is broken and have a separate ticket for

## Phase 2 — Spawn the executor

Create a new Claude session inside the Blueprint deployment. The executor session gets the same tools any Blueprint Claude session has: Playwright MCP, Bash, filesystem access. It runs in a tmux pane on the same host as Blueprint.

```bash
# From an orchestrator shell with curl access to the Blueprint API
PROMPT_JSON=$(python3 -c "import json; print(json.dumps({
  'project': '<a-project-name>',
  'cli_type': 'claude',
  'prompt': open('/tmp/executor-briefing.txt').read()
}))")
curl -X POST ${WORKBENCH_URL}/api/sessions \
  -H 'Content-Type: application/json' \
  -d "$PROMPT_JSON"
```

The response gives the new session id and the tmux pane name. Capture both.

### Briefing — what to put in `/tmp/executor-briefing.txt`

Concrete, with no decisions left to the executor. Cover at minimum:

1. **Target binding** — every placeholder from Phase 1, with concrete values
2. **Tools available** — Playwright MCP for UI, curl for API, ssh + docker exec for infra. Make it explicit: there is no test you cannot run; SKIP-on-your-own is forbidden
3. **Output file** — exact path where to write results (`tests/runbook-results-<date>.md`); format per test
4. **Edit-append, not Write-whole-file** — every test result added via the `Edit` tool against a stable anchor like `## Issues Filed`. Do NOT rewrite the entire file each time. This is the single most important durability rule
5. **Per-test commit/push cadence** — every N tests, `git add` + commit + push so partial progress survives executor failure
6. **Orchestrator-directed SKIPs** — list them by name. Executor records SKIP only for these, with the reason verbatim
7. **Issue Filing Protocol** — point at the runbook's section. Each FAIL produces a GitHub issue
8. **Pacing** — Phase 1 (Smoke) must fully pass before any other phase runs; if it fails, stop and report

### Verify the briefing landed

```bash
docker exec ${WORKBENCH_CONTAINER} tmux capture-pane -t <pane-name> -p | tail -25
```

You should see the executor reading the runbook and the results file (if a partial exists), then beginning tests. If it's stuck on the prompt without output, the briefing didn't deliver — check tmux send-keys path or paste it manually.

## Phase 3 — Inline polling

The polling loop is **synchronous in the orchestrator's own session**. Sleep, then check, then decide. Do not use background tools (`Monitor`, `run_in_background`) — events from those don't arrive reliably enough to react in real time, and the system blocks long bare sleeps anyway.

The standard pattern (5-minute cycle, single Bash call):

```bash
python3 -c "import time; time.sleep(270)" \
  && docker exec ${WORKBENCH_CONTAINER} tmux capture-pane -t <pane> -p | tail -15 \
  && wc -l tests/runbook-results-<date>.md \
  && grep -cE '^\*\*Result:\*\* (PASS|FAIL|SKIP)' tests/runbook-results-<date>.md
```

`270` (4.5 min) keeps the orchestrator within the prompt cache window; bump up only if context permits.

### What to watch for at every tick

- **Progress signals**
  - Token count increasing on the spinner line
  - Result file line count growing
  - New `**Result:** PASS|FAIL` blocks appearing
  - Recent pane output mentions test IDs you'd expect

- **Freeze signals** (act if confirmed across two ticks)
  - Token count flat
  - Same pane content captured
  - File mtime unchanged
  - Spinner still showing but no tool calls landing

- **Context-window-saturation signals** (act immediately)
  - Pane shows `Context limit reached` or `Auto-compacting conversation`
  - Pane shows `Tip: Use /clear to start fresh when switching topics and free up context`
  - Token count climbing past the model's effective working ceiling (well before the hard limit)
  - Tool calls failing with `Error writing file` or similar truncation symptoms

The context-saturation case is the silent killer. The executor will eventually hit the limit, auto-compact (losing detail), and start producing degraded output before fully crashing. Catch it early.

### Intervention patterns (least → most disruptive)

| Symptom | Intervention |
|---|---|
| Executor working but not flushing results to disk | `tmux send-keys` a clear instruction: write everything you have via `Edit` NOW, then continue per the rules. Then `Enter` |
| Queued message not being processed (executor stuck mid-turn) | `tmux send-keys Escape` to interrupt the current turn, then `Enter` to submit the queued message |
| Executor frozen — token count flat across two ticks, pane unchanged | Esc + Enter as above. If still frozen on next tick, kill the session and spawn a fresh executor (next row) |
| Context-window saturation imminent | Send `/clear`, wait for prompt to clear, then re-inject the briefing — including: prior results file path, where to resume (last completed test ID), what tests remain, and the same Edit-append rules |
| Executor hung past recovery, or fresh start makes more sense than untangling | Kill the session: `tmux send-keys "/quit" Enter`. Spawn a new executor with the partial results file as input and instructions to carry forward all prior PASSes, redo SKIPs/FAILs, run remaining tests |

The `/clear` + re-injection path matters most. When it works, the executor keeps the same session id and tmux pane (so any orchestrator-side references stay valid) but with a fresh context window. The re-brief must be self-sufficient — assume the executor has zero memory of the prior turn:

- Re-state the target binding
- Point at the partial results file
- Tell it explicitly which test ID to resume from
- Repeat the Edit-append + per-N-tests commit rules
- Repeat the orchestrator-directed SKIP list

## Phase 4 — End of run

The executor declares done. Verify before accepting:

```bash
# Coverage check
runbook_test_count=$(grep -cE '^### (REG|NF|SMOKE|CORE|FEAT|EDGE|CLI|E2E|USER|SESS|EDIT|TASK|MCP|KEEP|QDRANT|PROMPT|CONN)-' tests/blueprint-test-runbook.md)
results_count=$(grep -cE '^\*\*Result:\*\* (PASS|FAIL|SKIP)' tests/runbook-results-<date>.md)
# Counts should be roughly aligned; results may exceed runbook if carry-forwards from a partial included extra HOTFIX-style entries.

# SKIP audit — every SKIP must match an orchestrator-directed entry. Any other SKIP is a FAIL.
grep -B1 '^\*\*Result:\*\* SKIP' tests/runbook-results-<date>.md | grep '^## '
```

For every FAIL, confirm a GitHub issue exists. If the executor missed any, file them now per the runbook's Issue Filing Protocol.

Commit and push the final results file if the executor didn't.

### File issues in series, not parallel

`gh issue create` calls in parallel can race — issue numbers in the response don't always match the test you intended. File them sequentially, capture each returned URL, then build the Issues Filed table from the verified numbers.

## Phase 5 — Triage FAILs

For each FAIL, classify into one of three buckets. The classification determines what closes the issue.

| Classification | Indicator | Action |
|---|---|---|
| Real product bug | Code does the wrong thing under documented expectations | Fix the code via PROC-01 → close issue with verification |
| Test bug | Code is correct; the test is testing for old/wrong behavior | Update the runbook; close the issue with "not a bug — test updated" |
| Removed feature | Test targets something deliberately deleted from the product | Delete the test entries from the runbook (keep the corresponding `REG-VOICE-01`-style "removed" check if one exists); close the issue with "not a bug — feature removed" |
| Feature gap | Runbook expects behavior that was never implemented | Re-frame the issue as `enhancement` (not `bug`); leave open for the next implementation round |
| Test infra gap | Test cannot run on the current target without a separate environment (e.g., needs a wipeable container for fresh-install tests) | Either build the missing infra or fold the test into a phase that already provides it (e.g., Phase 0.A handles fresh-install) |

Single FAIL can map to multiple of these — handle each.

## Phase 6 — PROC-01 per real bug

For each "real product bug" FAIL:

1. **RCA** — describe the symptom in one self-contained file (`/tmp/symptom-<id>.txt`). Send to three independent CLIs (Claude via `Agent`, Gemini, Codex) and collect their root-cause diagnoses. Look for ≥2-CLI consensus.

2. **Fix** — implement; keep the diff small and targeted

3. **UI test** — if the fix touches anything visible, exercise it via Playwright (or Hymie for OAuth/Ink-input flows). Backend-only verification of a UI-touching fix is insufficient

4. **Runbook entry** — confirm the existing REG-* entry now passes, or add one if none existed. Every fix needs a permanent regression test in the runbook, not a one-shot "verify this fix" entry

5. **3-CLI code review** — diff sent to all three CLIs again. Any concern flagged by ≥2 CLIs gets addressed before merge. Single-CLI concerns are noted but not auto-actioned (unless the concern is obviously a real bug)

6. **Re-verify** after addressing review feedback

7. **Close the issue** with a verification comment that includes: the commit SHA(s), the verification evidence, and the 3-CLI review summary

## Lessons that should always make it into the briefing

These are recurring failure modes from past runs. State them explicitly in every executor briefing:

- **Edit-append, not Write-whole-file.** Holding test results in memory until the end risks losing everything to context exhaustion. Each test gets one `Edit` against a stable anchor immediately
- **No executor-chosen SKIP.** Tools are always available. "I don't have X" is wrong: you do
- **Commit + push every N tests** so partial progress survives executor failure
- **Read with offset+limit** — never load the entire runbook or the entire results file in one Read call
- **Never load huge tool outputs into context.** If a Bash command would print 1000+ lines, redirect to `/tmp/x` and `head` or `wc` it
- **Use the orchestrator-directed SKIP list verbatim.** Don't infer additional SKIPs

## Lessons for the orchestrator

- **Inline-poll only.** Background notifications drift; sync polling forces engagement. The orchestrator's own session must stay alive and attentive throughout
- **Watch for context saturation early.** By the time the executor hits the auto-compact line, you're already in recovery mode. Catch the climbing token count and `/clear` proactively if the run is long
- **File issues sequentially.** Parallel `gh issue create` calls race
- **Don't conflate the executor's machine with the test target.** The executor runs in a tmux pane on Blueprint's host; the test target may be a different deployment reached over HTTP/ssh. Routing your `tmux capture-pane` through `ssh` when the executor is local (or vice versa) wastes time and confuses the picture
- **The runbook is the regression suite, not a one-shot checklist.** Every fix lands a permanent REG-* test, not a HOTFIX-* entry that becomes dead weight
