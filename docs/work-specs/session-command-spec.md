# Work Spec: Replace Smart Compaction with `/session` Command

**Status:** Ready for implementation  
**Branch:** main  
**Restart required:** Yes (Node.js process must restart after code changes)

---

## Overview

Strip Blueprint's smart compaction system entirely and replace it with:

1. A simple 75% context nudge telling the user to run `/session transition`
2. A `/session` slash command with three modes: no-arg (info), `transition`, `resume`
3. A `blueprint_session` MCP tool that does the heavy lifting server-side

The core idea: after `/compact`, the session ID and JSONL file don't change. `/session resume` reads the tail of that same JSONL and re-injects it as context so Claude can pick up where it left off.

---

## Files to Change

### 1. `server.js` — Strip compaction, add nudge, add session endpoint

**Remove entirely:**
- `runSmartCompaction()` function (~lines 873–885)
- `_runSmartCompaction()` function (~lines 887–960+)
- `checkCompactionNeeds()` function (~lines 1320–1363) — **replace with simplified version below**
- `startCompactionMonitor()` function (~lines 1797–1822) — the fallback headless poller
- `POST /api/sessions/:sessionId/smart-compact` endpoint (~lines 856–868)
- The `startCompactionMonitor()` call in the server startup callback (~line 1839)

**Modify `startJsonlWatcher()`:**  
Keep the token usage polling and WebSocket broadcast. Replace the call to `checkCompactionNeeds()` with a call to the new simplified function.

**Add new `checkContextUsage(sessionId, project, pct)` function** to replace `checkCompactionNeeds()`:

```javascript
function checkContextUsage(sessionId, project, pct) {
  const state = getSessionState(sessionId);
  const threshold = config.get('session.nudgeThresholdPercent', 75);
  if (pct >= threshold && !state.nudgeSent) {
    state.nudgeSent = true;
    const tmux = state.tmux;
    if (tmux) {
      safe.tmuxSendKeys(tmux, config.getPrompt('session-nudge', { PERCENT: pct.toFixed(0) }));
    }
  }
}
```

Call `checkContextUsage(sessionId, project, pct)` in place of `checkCompactionNeeds()` inside `startJsonlWatcher()`.

**Add `POST /api/sessions/:sessionId/session` endpoint:**

```javascript
app.post('/api/sessions/:sessionId/session', async (req, res) => {
  const { sessionId } = req.params;
  const { mode = 'info', tailLines = 60 } = req.body;

  const entry = db.getSession(sessionId);
  if (!entry) return res.status(404).json({ error: 'Session not found' });

  const projectHash = entry.project.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionFile = path.join(os.homedir(), '.claude', 'projects', projectHash, `${sessionId}.jsonl`);

  if (mode === 'info') {
    const exists = fs.existsSync(sessionFile);
    return res.json({ sessionId, sessionFile, exists });
  }

  if (mode === 'resume') {
    let tail = '';
    try {
      const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-tailLines);
      tail = formatSessionTail(recent);
    } catch (err) {
      tail = '(could not read session file)';
    }
    const prompt = config.getPrompt('session-resume', { SESSION_TAIL: tail });
    return res.json({ prompt });
  }

  if (mode === 'transition') {
    const prompt = config.getPrompt('session-transition', {});
    return res.json({ prompt });
  }

  return res.status(400).json({ error: 'Unknown mode' });
});
```

**Add `formatSessionTail(lines)` helper:**

```javascript
function formatSessionTail(lines) {
  const turns = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = Array.isArray(entry.message.content)
          ? entry.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          : String(entry.message.content);
        if (text.trim()) turns.push(`**User:** ${text.trim()}`);
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = Array.isArray(entry.message.content)
          ? entry.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          : String(entry.message.content);
        if (text.trim()) turns.push(`**Assistant:** ${text.trim()}`);
      }
    } catch { /* skip malformed lines */ }
  }
  return turns.join('\n\n');
}
```

---

### 2. `mcp-tools.js` — Remove `blueprint_smart_compaction`, add `blueprint_session`

**Remove:** The `blueprint_smart_compaction` tool definition and its handler (~lines 76–77 definition, ~lines 360–370 handler).

**Add** a new `blueprint_session` tool:

Tool definition:
```javascript
{
  name: 'blueprint_session',
  description: 'Get session info or retrieve formatted context for transition/resume. Mode "info" returns session ID and file path. Mode "resume" returns a ready-to-inject resume prompt with recent conversation tail. Mode "transition" returns the transition checklist prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'The current session ID' },
      mode: { type: 'string', enum: ['info', 'transition', 'resume'], description: 'What to do' },
      tail_lines: { type: 'number', description: 'Number of JSONL lines to include in resume tail (default 60)' }
    },
    required: ['session_id', 'mode']
  }
}
```

Handler: POST to `http://localhost:3000/api/sessions/{session_id}/session` with `{ mode, tailLines: tail_lines }`.

For `mode: 'resume'`, the response contains `{ prompt }` — the MCP tool should return that prompt text directly as its result so the skill can inject it.

For `mode: 'info'`, return `Session ID: {sessionId}\nSession file: {sessionFile}`.

For `mode: 'transition'`, return the prompt text.

---

### 3. `config/defaults.json` — Simplify compaction section

Replace the entire `compaction` block with:

```json
"session": {
  "nudgeThresholdPercent": 75,
  "resumeTailLines": 60,
  "nameMaxLength": 60,
  "promptInjectionDelayMs": 2000,
  "promptMaxLength": 4096
}
```

Note: merge `nudgeThresholdPercent` and `resumeTailLines` into the existing `session` block — don't create a duplicate key.

Remove the `polling.compactionMonitorIntervalMs` key from the `polling` block (keep `tokenUsageIntervalMs`).

---

### 4. `config/prompts/` — Replace compaction prompts, add session prompts

**Delete these files:**
- `compaction-prep.md`
- `compaction-prep-to-agent.md`
- `compaction-auto.md`
- `compaction-nudge-advisory.md`
- `compaction-nudge-warning.md`
- `compaction-nudge-urgent.md`
- `compaction-resume.md`

**Create `config/prompts/session-nudge.md`:**

```markdown
Context is at {{PERCENT}}%. Run `/session transition` at a natural break point to preserve your session state before the context window fills.
```

**Create `config/prompts/session-resume.md`:**

```markdown
You are resuming after compaction. The following are the verbatim last turns from your session prior to compaction:

---
{{SESSION_TAIL}}
---

Please read the above carefully to restore your working context. Then:

1. Acknowledge the current state of work — what was being done, what decisions had been made
2. Check your plan file and read any documents on the reading list
3. State the immediate next step
4. Ask the user if anything has changed or if there are new instructions before proceeding
```

**Create `config/prompts/session-transition.md`:**

```markdown
Context is getting full. Work through the following session end checklist now, before running `/compact`:

**1. Update the plan file**
Update your plan file (`~/.claude/plans/`) with:
- Current status: what phase, what's done, what's next
- Key decisions made this session and the rationale behind them (not just "we decided X" — the WHY)
- Any deviations from the original plan and why
- Files created or modified this session

**2. Update the reading list**
Reflect on what you used this session. Update the Required and Situational reading lists in the plan file with specific file paths and a one-line reason each is needed. Bias toward inclusion — the next context pays for missing a critical doc, not for over-reading.

**3. Write resume instructions**
Add explicit, actionable resume instructions to the plan file. Be specific:
- What commands to run
- What to check
- What state the system is in
- What the immediate next task is

**4. Update GitHub issues**
Comment on all open issues with current state. If mid-task, record exactly where work paused.

**5. Update memory files**
If durable facts emerged this session (user preferences, process decisions, component-specific constraints), write them to the appropriate memory file.

When the checklist is complete, run `/compact`. After compaction, run `/session resume` to restore context.
```

---

### 5. `.claude/skills/session/SKILL.md` — Create the `/session` skill

Create the directory `.claude/skills/session/` and write `SKILL.md`:

```markdown
---
name: session
description: Session management. No arg: show session info. "transition" runs end-of-session checklist. "resume" restores context after compaction.
---

Look at the argument the user provided after `/session`:

**If no argument (just `/session`):**
Call the `blueprint_session` MCP tool with:
- `session_id`: `${CLAUDE_SESSION_ID}`
- `mode`: `"info"`

Print the result clearly: session ID and session file path.

**If the argument is `transition`:**
Call the `blueprint_session` MCP tool with:
- `session_id`: `${CLAUDE_SESSION_ID}`
- `mode`: `"transition"`

The tool returns the transition checklist prompt. Follow it.

**If the argument is `resume`:**
Call the `blueprint_session` MCP tool with:
- `session_id`: `${CLAUDE_SESSION_ID}`
- `mode`: `"resume"`

The tool returns a resume prompt with the recent session tail already embedded. Follow it to restore context.
```

---

### 6. Remove the old `smart-compact` skill

Delete `.claude/skills/smart-compact/SKILL.md` and its directory.

---

## Session File Path Logic

The JSONL session files live at:
```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

Where `<project-hash>` is the project's working directory with all non-alphanumeric characters replaced by `-`. Example: `/workspace/blueprint/projects/Joshua26` → `-workspace-blueprint-projects-Joshua26`.

Use Node's `os.homedir()` + `path.join()` to construct this path. Do not hardcode `/root` or any home dir.

---

## What to NOT Change

- `startJsonlWatcher()` / `stopJsonlWatcher()` — keep, just swap `checkCompactionNeeds()` for `checkContextUsage()`
- Token usage polling and WebSocket `token_update` broadcasts — keep entirely
- `summarize-session.md` prompt template — keep (used by `blueprint_summarize_session` MCP tool)
- All other MCP tools — untouched
- `session-utils.js` — untouched

---

## Testing Checklist

After implementation:

- [ ] Server starts without errors
- [ ] Token usage percentage appears in the UI as before
- [ ] At 75% usage, nudge message appears in terminal (test by temporarily lowering threshold in `defaults.json`)
- [ ] `/session` returns session ID and file path
- [ ] `/session transition` injects the transition checklist prompt
- [ ] `/session resume` injects a prompt with readable conversation turns embedded
- [ ] `blueprint_smart_compaction` MCP tool no longer exists (calling it returns an error)
- [ ] `blueprint_session` MCP tool works for all three modes
- [ ] No references to removed compaction functions remain (grep for `runSmartCompaction`, `checkCompactionNeeds`, `startCompactionMonitor`)

---

## Design Conversation

The following is the verbatim conversation between the user and Claude that produced this spec. Read it to understand the reasoning behind each decision.

---

**User:**

I need to make some small changes to blueprint and then we'll push the changes, I'll have an outside session do the work but since we are here, I want to create the work spec for them.  Do you understand?

---

**Assistant:**

Yes, understood. You want to draft a work spec document here that an outside session can pick up and execute. What changes do you want made to Blueprint?

---

**User:**

take a look at the blueprint open issues

---

**Assistant:**

30 open issues. Want me to pull the details on specific ones, or give you a quick grouping by theme so we can decide what to include in the work spec?

---

**User:**

30, hmm I bet a bunch of those are actaully closed.  Have a look and see what you thin?

---

**Assistant:**

Based on the commits and code, here's my read on which issues are actually done but not closed:

**Clearly done (should be closed):**
- **#27** — Bash terminal tab: implemented in `c3ffd86`
- **#20 / #26** — Terminal scrolling: `c3ffd86` added mouse scroll + 10k history; #26 closed but #20 still open (may overlap)
- **#19 / #24** — `/smart-compact` slash command: skill exists at `.claude/skills/smart-compact/SKILL.md`; both issues are open (one is the request, one is "added" — both should close)
- **#11** — Drag file to terminal: implemented in `7bebc5b`
- **#12** — Raise advisory threshold: we just set everything to 999 this session; done differently but done

**Probably done / needs verification:**
- **#22** — Quorum juniors use CLI: `8b5fa1d` exposed all MCP tools to CLI sessions — may address this
- **#8** — Renaming session doesn't update tab: worth checking if the file browser PR touched this

**Likely still open (no evidence of work):**
- #1, #2, #3, #4, #5, #6, #7, #9, #10, #13, #14, #15, #16, #17, #18, #21, #23, #25, #28, #29, #30

---

**User:**

yeah, the smart compacton setting you made did not do anything, it all still ran so one of the tings I want to do is actaully strip it.  instead at the 75% threshold I just want it to suggest smart compaction and if you make the slash command it inserts the contents of this document projects/Joshua26/docs/guides/session-maintenance-guide.md prefixed with something like "Follow this guid..  etc"  the idea is that the 75% warning tells yiu to run the slash command, and the slash command inserts a prompt.  Do link that actual file, it will need its own MD that is part of blueprint as the smar compaction prompt.  The user can makes sure they do it right and resume. Also the slash command should create the current turns file with a unique ID.  Actually lets have two slash commands.  One that creates that file and inputs the instruction prompt, and then another for resume, better yet, can it be a slash command with a paramenter for summarize and resume?

---

**Assistant:**

Good, I have the full picture now. Let me draft the work spec.

The shape of the work is:

1. **Strip smart compaction** from `server.js`, `mcp-tools.js`, and related config/prompts
2. **Replace auto-trigger** with a simple 75% nudge message saying "run `/summarize`"
3. **Two slash commands** (or one with params): `summarize` — creates a `recent-turns-<id>.md` file and injects the session maintenance prompt; `resume` — injects the resume prompt
4. **Blueprint-owned copy** of the session maintenance content as a prompt template (not linked to Joshua26)

Before I write the spec, a few quick questions to get it right:

- For the **75% nudge** — should it fire once per session (no repeat) or every N minutes while above threshold?
- For **`/summarize`** — the "unique ID" on the `recent-turns` file: timestamp, session ID, or UUID? And where does it save — relative to the project's working directory or a fixed path?
- For the slash command naming — do you want `/session summarize` + `/session resume` as two separate named skills, or a single `/session` skill where `summarize`/`resume` are arguments passed by the user?
- The session maintenance guide has Joshua26-specific content (repo paths, scripts, CLI commands). Should the Blueprint prompt template be a generic/stripped-down version, or copy it verbatim?

---

**User:**

lets do a single slash command with switches  /session transition  /session resume  just /session  resturns your session ID and the lication of the recent turns file.  I think when you can /session transition it write the recent turns file with a unique ID, probably the session ID inside it.  that way  /session resume should be able to programically find it and insert the path, no?

---

**Assistant:**

That's a clean design. The session ID is the natural key — transition writes `recent-turns-<session-id>.md`, and resume just finds that file. Since Blueprint knows the session ID server-side, the skill can even have it injected as a variable.

Let me sketch the full spec before writing it out:

**`/session`** → prints current session ID + path to recent-turns file (if exists)  
**`/session transition`** → extracts recent turns → saves to `~/.claude/sessions/recent-turns-<session-id>.md` → injects session maintenance prompt  
**`/session resume`** → finds the most recent `recent-turns-*.md` → injects resume prompt with that path baked in  

One thing to nail down: **where does the recent-turns file live?** Options:
- `~/.claude/sessions/` — fixed, always findable, survives project switches
- Relative to the project CWD — project-scoped, matches the guide's convention

Also — the session maintenance guide has Joshua26-specific content (repo names, scripts, CLI paths). The Blueprint copy should be a **generic version** — strip the project-specific parts, keep the universal process (plan file, reading list, resume instructions, conversation re-injection). Sound right?

---

**User:**

I've got a better idea, the recent turns is just a playback of what is already in the actial claude session file. /resume could just read the tail on the actual session file.  The prompt could stat with a resume message like "you are reuming after compact, these are the vertabik last turn pior, yada yada" insert the tail, "please read, etec ect, <whatever the final resume instructions are>"  and /session could should the session id and the path to the session file in case it needed to be searched or smething. what do yu think of that?

---

**Assistant:**

That's actually cleaner. No file management, no separate artifact to maintain — the session JSONL is always there and is the authoritative record.

The only wrinkle: **`/session resume` runs in a *new* session**, so it doesn't know the previous session's file path automatically. Two ways to handle it:

1. **`/session transition` writes a tiny pointer file** — something like `~/.claude/last-session` containing just the path to the JSONL. Then `/session resume` reads that one file to find the tail. Simple, one extra file, always current.
2. **Pass the session ID explicitly** — `/session resume <session-id>`, and Blueprint knows where all session files live.

Option 1 is better UX — `/session resume` just works with no arguments.

For the **resume prompt**, Blueprint pre-populates `{{SESSION_TAIL}}` server-side (reads the JSONL tail before injecting), so the prompt arrives with the context already embedded — no tool calls needed to recover context.

---

**User:**

I dont think compaction changes the session ID.

---

**Assistant:**

Right — compaction keeps the same session ID, same JSONL file. The context window gets wiped but the file keeps growing. So after `/compact`:

- You're still in the same session
- The JSONL already has everything pre-compaction
- `/session resume` just reads the tail of **the current session's own file**

No pointer file needed at all. Blueprint already knows `{{SESSION_ID}}` and can derive the JSONL path.

So the full design becomes very clean:

- **`/session`** → prints session ID + session file path
- **`/session transition`** → coaches Claude through the end-of-session checklist
- **`/session resume`** → Blueprint injects `{{SESSION_FILE}}`, Claude reads the tail, re-establishes context

---

**User:**

I prefer what I said "/session resume could just read the tail on the actual session file.  The prompt could stat with a resume message like "you are reuming after compact, these are the vertabik last turn pior, yada yada" insert the tail, "please read, etec ect, <whatever the final resume instructions are>"  and /session could should the session id and the path to the session file in case it needed to be searched or smething."

---

**Assistant:**

Got it — Blueprint reads the tail server-side, substitutes `{{SESSION_TAIL}}` into the prompt template before injecting. Same hot-reload pattern already used for `{{PERCENT}}` in `compaction-auto.md`.

The prompt template (`session-resume.md`) looks like:

```
You are resuming after compaction. These are the verbatim last turns prior to compaction:

---
{{SESSION_TAIL}}
---

Please read the above carefully. [resume instructions...]
```

Blueprint reads the JSONL tail, substitutes it in, injects the whole thing. Clean.

Ready to write the spec now — here's what it covers:

1. Strip all smart compaction from `server.js`, `mcp-tools.js`, `config/defaults.json`, related prompts
2. Replace auto-trigger with simple 75% nudge message (no subprocess, no checker)
3. Server-side: support `{{SESSION_ID}}`, `{{SESSION_FILE}}`, `{{SESSION_TAIL}}` variables in skill prompt injection
4. `config/prompts/session-resume.md` — opening message + `{{SESSION_TAIL}}` + closing instructions
5. `config/prompts/session-transition.md` — end-of-session checklist prompt (based on the guide, genericized)
6. `.claude/skills/session/SKILL.md` — handles all three modes: no arg, `transition`, `resume`
