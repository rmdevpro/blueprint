# Using Other CLIs via Tmux

Blueprint containers include multiple AI CLIs: Claude, Gemini, and Codex. This guide covers how to interact with them from within a Claude session.

## Why Tmux

The `--print` / `-p` / `exec` modes are limited: no MCP tool access, no multi-turn conversation, and they can hang on permission prompts. Tmux gives you a full interactive session — file access, tool use, monitoring, and follow-ups.

## Pattern: Launch, Send, Read

```bash
# Launch a CLI in a named tmux session
tmux new-session -d -s helper -x 200 -y 50
tmux send-keys -t helper "claude --model haiku --dangerously-skip-permissions" Enter

# Wait for startup, then send a prompt
sleep 5
tmux send-keys -t helper "Your question or instruction here" Enter

# Read the output (check periodically)
tmux capture-pane -t helper -p -S -30 | tail -20

# Send follow-ups
tmux send-keys -t helper "Follow-up question" Enter

# Kill when done
tmux kill-session -t helper
```

## CRITICAL: Handle Startup Prompts Before Sending Work

Interactive CLIs have startup prompts that MUST be handled before any real prompts will work. If you send a prompt while a startup dialog is active, your text either answers the dialog incorrectly or goes into a buffer that never gets processed.

**After launching any CLI, you MUST:**
1. Check the screen with `tmux capture-pane`
2. Handle any interactive prompts (trust dialogs, update prompts, model selection)
3. Verify the CLI is at an empty input prompt ready for work
4. Only THEN send your actual prompt
5. Check the screen AGAIN to verify it started processing ("Thinking...", "Searching...", etc.)

**Common startup blockers:**
- **Codex**: "Do you trust the contents of this directory?" — must answer before prompts work
- **Codex**: "Update available! Press enter to continue" — blocks all input until dismissed
- **Gemini**: "Do you trust the files in this folder?" — same blocking pattern
- **Gemini**: First Enter after sending text may be consumed by the multiline editor — check if prompt submitted, send another Enter if needed

**The rule: ONE send-keys, then CHECK the screen. Never send a second command without verifying the first one was received and processed.** Prompts that pile up in the input buffer are lost work — they accumulate as text but never execute.

## Important: Hide Sub-Sessions

When you launch a Claude sub-session via tmux, it will appear in Blueprint's session list in the left sidebar automatically. After launching, update the sub-session to hidden status so it does not clutter the user's session list:

```
Use blueprint_set_session_config with session_id="<sub-session-id>" and state="hidden"
```

## Gemini

Requires `GOOGLE_API_KEY` — set it in Blueprint Settings > API Keys.

```bash
tmux new-session -d -s gemini -x 200 -y 50
tmux send-keys -t gemini "gemini" Enter
sleep 3
tmux send-keys -t gemini "Review server.js for potential issues" Enter
tmux capture-pane -t gemini -p -S -30 | tail -20
tmux kill-session -t gemini
```

Options:
```bash
gemini -m gemini-2.5-flash-lite -p "Quick one-shot question"
gemini --approval-mode auto_edit  # auto-approve edits
```

## Codex

Requires `OPENAI_API_KEY` — set it in Blueprint Settings > API Keys.

```bash
tmux new-session -d -s codex -x 200 -y 50
tmux send-keys -t codex "codex" Enter
sleep 3
tmux send-keys -t codex "Review server.js for potential issues" Enter
tmux capture-pane -t codex -p -S -30 | tail -20
tmux kill-session -t codex
```

Options:
```bash
codex --model gpt-5.3-codex exec "Quick one-shot question"
codex --cd /mnt/workspace/my-project exec "Explain the codebase"
```

## When Non-Interactive Mode is OK

- Simple one-shot questions that don't need tools or file access
- Scripted pipelines where you just need text output
- When you explicitly don't want the CLI to use tools

## Gemini-Specific Notes

- **CWD matters**: Gemini can only see its CWD and directories below it. Launch from a broad directory (e.g. `/storage`) or use `/add-directory` to grant access to paths outside the CWD.
- **Multiline editor**: Gemini uses a multiline text editor for input. The first Enter from `send-keys` sometimes acts as a newline rather than submit. Always verify "Thinking..." appears — if the text is sitting in the input field, send another Enter.
- **Double Escape**: Clears the input buffer and rewinds conversation. Use this to recover from accumulated text in the input field.

## Codex-Specific Notes

- **Web search works**: Codex CAN search the web — it will show "Searching the web" when doing so. If prompts silently return with no response, the session is stuck on an unhandled startup prompt.
- **Trust dialog**: Must be answered before any prompts work. Check for it after every fresh launch.

## Known Limitations

- Gemini MCP tools may not work reliably in non-interactive (`-p`) mode
- Codex default sandbox is read-only — `--yolo` required for file writes (restrict writes in your prompt)
- Non-interactive modes have limited tool access across all CLIs — prefer tmux for anything complex
