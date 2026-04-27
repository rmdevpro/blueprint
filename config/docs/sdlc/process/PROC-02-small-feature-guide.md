# Small Feature Development Procedure

**Purpose:** Standard process for designing, implementing, and verifying a single new feature. This is the atomic cycle for additive work — the counterpart to PROC-01 (debugging) which handles corrective work.

**When to use this guide:** When the feature is small enough to design, implement, and verify in a single cycle. For features requiring multiple phases or cross-cutting architectural changes, break them into multiple small features and run each through this cycle.

**Applies to:** All CLI agents (Claude, Gemini, Codex) working in any Workbench workspace.

***

## The Loop

Every small feature follows this cycle. No shortcuts, no skipping steps.

```
  Step 0: Plan — Create task list
      ↓
  Step 1: Design — Define the feature
      ↓
  Step 2: Record — Create GitHub Issue
      ↓
  Step 3: Design review — Review design (3 CLIs)
      ↓
  Step 4: Implement — Build, deploy, smoke test
      ↓
  Step 5: Peer review — Code review (3 CLIs)
      ↓
  Step 6: Regression — Test existing functionality
      ↓                     │
  Pass?  ──── No ───────────┘ (back to Step 4)
      ↓ Yes
  Step 7: Close — Update and close GitHub Issue
```

***

## Step 0: Plan — Create Task List

**Before touching any code, create a task list for the feature you are working on.** The task list is EXACTLY these steps — one task per step:

```
Issue #XX: Step 0 — Plan: Create task list                    ✓
Issue #XX: Step 1 — Design: Define the feature
Issue #XX: Step 2 — Record: Create GitHub Issue
Issue #XX: Step 3 — Design review: Review design (3 CLIs)
Issue #XX: Step 4 — Implement: Build, deploy, smoke test
Issue #XX: Step 5 — Peer review: Code review (3 CLIs)
Issue #XX: Step 6 — Regression: Test existing functionality
Issue #XX: Step 7 — Close: Update and close GitHub Issue
```

Use Workbench's task system (`workbench_tasks` MCP tool or Claude Code TaskCreate) to track these. Work ONE feature at a time. Complete every step before moving to the next step. Do not skip steps. Do not jump ahead.

**If you need to pause a feature** (e.g., waiting for a long test), save the current task state as a comment in the GitHub Issue so you can return to it later. Then start Step 0 for the next item.

**If the session ends**, save the task list in the GitHub Issue. The next session reads the issue and picks up where you left off.

***

## Step 1: Design — Define the Feature

Before writing code, define what you are building:

1. **What** — What capability does this feature add? What does it do from the user's or caller's perspective?
2. **Where** — Which files, components, or flows are affected? What existing code does this touch?
3. **How** — What is the approach? New function, new endpoint, new flow, modification to existing flow?
4. **Interface** — What does the input/output look like? What parameters, return values, or side effects?
5. **Verification** — How will you prove it works? What specific test or operation demonstrates success?

Write this down — in the GitHub Issue (Step 2) or in the plan file. The design does not need to be a formal document. It needs to be clear enough that three independent reviewers can evaluate it.

**Complex features** may benefit from having all three CLIs collaborate on the design itself — each brings different architectural perspectives and can catch constraints or integration points the others miss.

***

## Step 2: Record — Create GitHub Issue

Create a GitHub Issue for the feature immediately after designing it.

```bash
gh issue create \
  --title "Short description of feature" \
  --body "## Feature
Description of what this adds.

## Design
What, Where, How, Interface, Verification (from Step 1).

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2"
```

The issue is the record of the feature from design through completion. All decisions, reviews, and test results are recorded here.

***

## Step 3: Design Review — Review Design with 3 CLIs

**This step is mandatory for every feature where the change has consumers.** Send the design to all three CLIs for independent review before writing code.

### When to skip 3-CLI review

Only when the change has **no consumers** — nothing reads it, depends on it, or routes through it. In practice this means only documentation text and display strings. Everything else gets 3-CLI review. When in doubt, run them.

### How to Invoke

Send all three in parallel. Ask them to review the design independently. Do NOT lead them — no "focus on X" or "check Y." Let them find issues on their own.

**Preferred: Workbench session MCP tools.** Use `workbench_sessions` to create sessions for each CLI. This handles startup prompts and session management automatically.

**Alternative: tmux sessions.** Follow the tmux guide (`docs/guides/using-other-clis-via-tmux.md`) for interaction patterns, especially for long prompts (use load-buffer/paste-buffer) and handling startup prompts.

Session names must include the GitHub issue number to avoid collisions.
Pattern: `[cli]-[issue#]-[step]` e.g. `claude-42-design`, `gemini-42-design`, `codex-42-design`.

```bash
# Via Workbench MCP tools (preferred):
workbench_sessions action:new cli:claude project:<project> prompt:"Design review for #42"
workbench_sessions action:new cli:gemini project:<project> prompt:"Design review for #42"
workbench_sessions action:new cli:codex  project:<project> prompt:"Design review for #42"

# Via tmux (alternative):
tmux new-session -d -s claude-42-design -x 200 -y 50
tmux send-keys -t claude-42-design "claude --dangerously-skip-permissions" Enter
# Wait for prompt, then send the review task

tmux new-session -d -s gemini-42-design -x 200 -y 50
tmux send-keys -t gemini-42-design "gemini" Enter
# Wait for prompt, handle startup dialogs, then send

tmux new-session -d -s codex-42-design -x 200 -y 50
tmux send-keys -t codex-42-design "codex --full-auto" Enter
# Wait for prompt, handle update/trust dialogs, then send
```

### Processing Results

1. Wait for all three to complete
2. Compare their findings
3. If they identify design issues → revise the design before implementing
4. If they suggest using existing components you missed → adopt the suggestion
5. Present findings to the user before implementing, unless the user has explicitly already approved

***

## Step 4: Implement — Build, Deploy, Smoke Test

Implement the feature, deploy it, and smoke test it. This step bundles three activities because the feature is small enough to not need separate phases.

### Build

Write the code. Key principles:
- **Research existing solutions before implementing.** Check if the framework or a well-established library already provides the capability.
- **Parity from the start.** If the feature touches CLI-specific paths, implement for all three CLIs before moving on.

### Deploy

Commit and push your changes. Deploy to the test environment first:

| Change Type | How to Deploy |
|---|---|
| Application code | Push to repo, deploy to test container, restart |
| Infrastructure (Dockerfile, entrypoint) | Push to repo, rebuild container |

**Always test before production.** Deploy to the test environment, verify, then deploy to production.

### Smoke Test

Immediately after deploying, run the specific operation that exercises the new feature. Verify:

1. The feature does what it is supposed to do (the happy path works)
2. The response/output matches the expected interface from Step 1
3. No errors in container logs

This is not the full test suite — that comes in Step 6. This is the minimum viability check: does it turn on without catching fire?

***

## Step 5: Peer Review — Code Review with 3 CLIs

Before regression testing, send the implementation to all three CLIs for code review.

### When to skip 3-CLI review

Same rule as Step 3: only when the change has **no consumers**. When in doubt, run them.

Same invocation approach as Step 3. Session names: `claude-42-review`, `gemini-42-review`, `codex-42-review`.

Do NOT lead the reviewers. Do not tell them which files to check or what problems to look for. Give them the task and let them find everything independently.

If the reviewers find issues, fix them before regression testing. Then re-run the smoke test to confirm the fix didn't break the feature.

***

## Step 6: Regression — Test Existing Functionality

Run the broader test suite to verify the new feature didn't break existing functionality.

**What to run:** The full test suite for the affected component — automated tests, manual verification, or both.

**What to check:**
- All previously passing tests still pass
- No new errors in container logs
- No degradation in response times or quality (if measurable)
- **Parity:** every test run for one CLI must also be run for the other two

**On failure:** Go back to Step 4. The regression failure is a bug in the new code. Fix it, smoke test, peer review the fix, and re-run regression. Do not proceed until the suite is green.

### Write Tests for the New Feature

If the feature is testable (it almost always is), write tests for it. Update test coverage tracking with the new feature.

***

## Step 7: Close — Update and Close GitHub Issue

```bash
# Add implementation details as a comment
gh issue comment [number] \
  --body "Feature implemented. Files changed: [list]. Tests added: [test names]. Smoke test: pass. Regression: pass."
```

**Do NOT close the issue without the user's explicit permission.** Present your results and ask if the issue can be closed. Wait for a "yes."

***

## What NOT to Do

- **Do not skip the design step** — even for "obvious" features. The 3-CLI review catches conflicts and better approaches you won't see.
- **Do not batch features** — one feature at a time through the full cycle.
- **Do not skip the CLI consultation** — this is not optional, not "when stuck."
- **Do not implement without recording** — the GitHub Issue is the paper trail.
- **Do not skip regression testing** — a feature that works but breaks something else is a net negative.
- **Do not close issues without the user's permission** — present results, ask, wait.
- **Do not lead the CLIs** — no leading questions, no telling them where to look.
- **Do not take action without discussing with the user first** — present findings, get agreement, then act.

***

**Related:** [Debugging Procedure](./PROC-01-debugging-guide.md) · [Tmux Guide](../guides/using-other-clis-via-tmux.md) · [Deployment Guide](../guides/workbench-deployment.md)
