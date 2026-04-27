# Debugging & Troubleshooting Procedure

**Purpose:** Standard process for identifying, investigating, fixing, and verifying bugs. This is the required workflow — not optional, not approximate.

**Applies to:** All CLI agents (Claude, Gemini, Codex) working in any Workbench workspace.

***

## The Loop

Every bug follows this cycle. No shortcuts, no skipping steps.

```
  Step 0: Plan — Create task list
      ↓
  Step 1: Reproduce — Confirm the issue exists  ←─┐
      ↓                                            │
  Issue confirmed?  ──── No ────→ Done             │
      ↓ Yes                                        │
  Step 2: Record — Create GitHub Issue             │
      ↓                                            │
  Step 3: Diagnose — Root cause analysis (3 CLIs)  │
      ↓                                            │
  Step 4: Fix — Apply the change                   │
      ↓                                            │
  Step 5: Peer review — Code review (3 CLIs)       │
      ↓                                            │
  Step 6: Verify — Smoke test fix + regression     │
      ↓                                            │
  Step 7: Close — Update and close GitHub Issue ───┘
```

***

## Step 0: Plan — Create Task List

**Before touching any code, create a task list for the issue you are working on.** The task list is EXACTLY these steps — one task per step:

```
Issue #XX: Step 0 — Plan: Create task list                    ✓
Issue #XX: Step 1 — Reproduce: Confirm the issue exists
Issue #XX: Step 2 — Record: Create GitHub Issue
Issue #XX: Step 3 — Diagnose: Root cause analysis (3 CLIs)
Issue #XX: Step 4 — Fix: Apply the change
Issue #XX: Step 5 — Peer review: Code review (3 CLIs)
Issue #XX: Step 6 — Verify: Smoke test fix + regression
Issue #XX: Step 7 — Close: Update and close GitHub Issue
```

Use Workbench's task system (`workbench_tasks` MCP tool or Claude Code TaskCreate) to track these. Work ONE issue at a time. Complete every step before moving to the next step. Do not skip steps. Do not jump ahead.

**If you need to pause an issue** (e.g., waiting for a long test), save the current task state as a comment in the GitHub Issue so you can return to it later. Then start Step 0 for the next issue.

**If the session ends**, save the task list in the GitHub Issue. The next session reads the issue and picks up where you left off.

This is not optional. This is how you avoid forgetting steps, skipping the CLI consultation, or deploying untested code.

***

## Step 1: Reproduce — Confirm the Issue Exists

Before investigating, confirm the bug is real and understand the failure conditions.

**What "reproduce" means:**

1. Execute the operation that is reported to fail
2. Observe the actual error (not a description of it — the actual error output)
3. Confirm the failure is consistent, not a transient network blip
4. Record the exact reproduction steps and error output

If you cannot reproduce the issue, it is not confirmed. Investigate whether the environment, data, or configuration differs from the report.

**Complex issues** may benefit from having all three CLIs attempt reproduction in parallel — each may uncover different failure conditions or edge cases that clarify the problem.

### How to test depends on the change type

| Change Type | How to Test | Rebuild Required? |
|---|---|---|
| Application code (Node.js, HTML, config) | Restart the server process or reload the page | No |
| Infrastructure (Dockerfile, entrypoint, system packages) | Rebuild and redeploy the container | Yes |
| Persistent config (MCP registrations, CLI configs) | May require restarting the CLI session | No |

***

## Step 2: Record — Create GitHub Issue

When a bug is confirmed, create a GitHub Issue immediately — before investigating the root cause.

```bash
gh issue create \
  --title "Short description" \
  --body "Description, reproduction steps, observed behavior"
```

The issue exists as a record even if you fix it in 5 minutes. This is how we track what was found, what the root cause was, and how it was fixed.

***

## Step 3: Diagnose — Root Cause Analysis with 3 CLIs

**This step is mandatory for every bug where the change has consumers.** Do not guess at root causes. Do not assume you know the answer. Consult all three CLIs independently.

### When to skip 3-CLI diagnosis

Only when the change has **no consumers** — nothing reads it, depends on it, or routes through it. In practice this means only documentation text and display strings. Everything else gets 3-CLI analysis. When in doubt, run them.

### Why Three CLIs?

Each model has different blind spots. In practice:

- Claude dismissed failures as "LLM non-determinism" — Gemini found the real bug
- Gemini found a migration used the wrong index name — Claude missed it
- Codex found a health endpoint always returned 200 — both others missed it

### How to Invoke

Send all three in parallel. Ask them to find root cause independently — do NOT tell them your theory. No leading questions. Let them find everything on their own.

**Preferred: Workbench session MCP tools.** Use `workbench_sessions` to create sessions for each CLI. This handles startup prompts and session management automatically.

**Alternative: tmux sessions.** Follow the tmux guide (`docs/guides/using-other-clis-via-tmux.md`) for interaction patterns, especially for long prompts (use load-buffer/paste-buffer) and handling startup prompts.

Session names must include the GitHub issue number to avoid collisions.
Pattern: `[cli]-[issue#]-[step]` e.g. `claude-123-rca`, `gemini-123-rca`, `codex-123-rca`.

```bash
# Create sessions for all 3 CLIs
# Via Workbench MCP tools (preferred):
workbench_sessions action:new cli:claude project:<project> prompt:"RCA for issue #123"
workbench_sessions action:new cli:gemini project:<project> prompt:"RCA for issue #123"
workbench_sessions action:new cli:codex  project:<project> prompt:"RCA for issue #123"

# Via tmux (alternative):
tmux new-session -d -s claude-123-rca -x 200 -y 50
tmux send-keys -t claude-123-rca "claude --dangerously-skip-permissions" Enter
# Wait for prompt, then send the analysis task

tmux new-session -d -s gemini-123-rca -x 200 -y 50
tmux send-keys -t gemini-123-rca "gemini" Enter
# Wait for prompt, handle startup dialogs, then send

tmux new-session -d -s codex-123-rca -x 200 -y 50
tmux send-keys -t codex-123-rca "codex --full-auto" Enter
# Wait for prompt, handle update/trust dialogs, then send
```

**All three run foreground only.** Background execution is unreliable.

**You must get output from all three CLIs.** If a CLI produces no output, refer to the CLI guides (`docs/guides/using-gemini-cli.md`, `docs/guides/using-codex-cli.md`), diagnose why it failed, and run it again. Do not proceed with fewer than 3 independent analyses.

### Processing Results

1. Wait for all three to complete
2. Compare their findings
3. If they agree → high confidence in root cause
4. If they disagree → investigate the disagreement, often the minority finding is the real bug
5. Present findings to the user before fixing, unless the user has explicitly already approved you fixing them

***

## Step 4: Fix — Apply the Change

Apply the fix. One fix per issue. Do not fix multiple issues in one change.

After fixing:
- Commit the change with a descriptive message
- Update the plan file with what was found and fixed — include the root cause, the file changed, and why the fix is correct

***

## Step 5: Peer Review — Code Review with 3 CLIs

Before testing, send the fix to all three CLIs for code review. They catch wrong selectors, logic errors, remaining fake assertions, and regressions that you will miss.

### When to skip 3-CLI review

Same rule as Step 3: only when the change has **no consumers**. If the fix changes anything that other code reads, depends on, or routes through, run the review. When in doubt, run them.

Same invocation approach as Step 3. Session names: `claude-123-review`, `gemini-123-review`, `codex-123-review`.

Do NOT lead the reviewers. Do not tell them which files to check or what problems to look for. Give them the task and let them find everything independently.

If the reviewers find issues, fix them before testing. This is cheaper than deploying a broken fix, running the full test suite, and investigating why it failed.

***

## Step 6: Verify — Smoke Test Fix + Regression Test

Two distinct checks:

**Smoke test (verify the fix):** Run the specific test or operation that reproduces the bug. Confirm the failure is gone. This proves the fix addresses the specific issue.

**Regression test (verify nothing else broke):** Run the broader test suite. Confirm that the fix didn't break existing functionality.

### Every Fix Gets a Regression Test

If the bug could recur, write a test that catches it. The test should:

- Fail without the fix applied
- Pass with the fix applied
- Run in the test suite without requiring manual intervention

### Deploy and Test

Push your changes and deploy to the test environment before production. Verify on the test environment first. Never deploy untested code to production.

***

## Step 7: Close — Update and Close GitHub Issue

```bash
# Add root cause and fix details as a comment
gh issue comment [number] \
  --body "Root cause: [explanation]. Fix: [what was changed]. Test: [test name]."
```

**Do NOT close the issue without the user's explicit permission.** Present your results and ask if the issue can be closed. Wait for a "yes."

***

## What NOT to Do

- **Do not dismiss failures as "LLM non-determinism"** — it's almost never the LLM. Every time this was claimed, the CLIs found a real code bug.
- **Do not blame the model for slowness or quality issues** — if something is slow or wrong, the problem is in the code.
- **Do not batch changes** — test each one individually.
- **Do not skip the CLI consultation** — this is not optional, not "when stuck."
- **Do not fix without recording** — the GitHub Issue is the paper trail.
- **Do not guess at root causes** — consult the CLIs.
- **Do not close issues without testing** — a fix that isn't tested is not a fix.
- **Do not close issues without the user's permission** — present results, ask, wait.
- **Do not lead the CLIs** — no leading questions, no telling them where to look.
- **Do not take action without discussing with the user first** — present findings, get agreement, then act.

***

## Severity Definitions

| Severity | Definition | Examples |
|---|---|---|
| Blocker | Prevents deployment, testing, or core functionality | Build fails, container won't start, data loss |
| Major | Significant functionality broken but system runs | Wrong query results, tool invocation fails, missing features |
| Minor | Cosmetic, low-impact, or edge case | Logging format, unused code, UI text mismatch |
| Warning | Non-fatal finding that warrants attention | Suboptimal configuration, deprecated API usage |

***

## Working During Long-Running Tests

Long-running tests (browser suites, deployments) are NOT a reason to stop working. While a test runs:

- Work the next issue on the list
- Save your current issue's task state in the GitHub Issue comment so you can return to it
- Launch the 3-CLI RCA for the next bug while waiting
- Write the fix for a different issue

The goal is zero idle time. There is always work to do.

***

**Related:** [Small Feature Procedure](./PROC-02-small-feature-guide.md) · [Tmux Guide](../../guides/using-other-clis-via-tmux.md) · [Deployment Guide](../guides/workbench-deployment.md)
