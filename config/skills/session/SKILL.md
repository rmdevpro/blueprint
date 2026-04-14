---
name: session
description: Session management. No arg shows session info. "transition" runs end-of-session checklist. "resume" restores context after compaction.
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
