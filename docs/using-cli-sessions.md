# Driving CLI Sessions

Workbench containers run multiple AI CLIs (Claude, Gemini, Codex). When you need to drive one of those sessions from your own session — to delegate work, to look something up, to monitor a long-running run — you do it through the `session_*` MCP tools on the `workbench` server. You do not need to know the underlying transport.

## The shape

Every interaction is some sequence of:

1. **Lifecycle** — `session_new` (or `session_connect` to an existing one), `session_kill` when done.
2. **Input** — `session_send_text` to paste a prompt, then `session_send_key {key:"Enter"}` to submit.
3. **Wait** — `session_wait` while the CLI is responding.
4. **Read** — `session_read_screen` for what's visible right now, or `session_read_output` for structured transcript.

That's the whole pattern. Same shape for all three CLIs.

## Pattern: launch, send, read

```
session_new {project: "my-project", cli: "claude"}
  → { session_id, tmux }

session_send_text {session_id, text: "Read server.js and tell me what the auth path looks like"}
session_send_key  {session_id, key: "Enter"}

session_wait {seconds: 10}
session_read_screen {session_id}   # check progress
session_wait {seconds: 20}
session_read_output {session_id}   # structured response

session_kill {session_id}
```

The CLI you're driving doesn't see "tmux" or any of the plumbing — your tools are what it gets.

## send_text vs send_keys vs send_key

Three send tools, three jobs:

- **`session_send_text`** — paste arbitrary text via the buffer (load-buffer + paste-buffer). Safe with special characters, no length limit, no shell interpretation. **No trailing Enter** — call `session_send_key {key:"Enter"}` separately to submit. This is the right tool for prompts.
- **`session_send_keys`** — raw `send-keys`. For short shell-style commands where you want shell interpretation. Avoid for prompts; the buffer path is safer.
- **`session_send_key`** — a single named key (`Enter`, `Escape`, `Tab`, `Up`, `F2`, …) or a single ASCII character (`"2"`). Use this to submit input, dismiss menus, or answer y/n.

## Always check before sending the next thing

Interactive CLIs have startup prompts (trust dialogs, update notices, "Press Enter to continue"). If you send a real prompt while one of those is showing, your text either answers the dialog incorrectly or piles up unprocessed.

**The rule: one send, then read. Don't queue multiple sends without verifying the first one was received.**

```
session_new {project, cli: "codex"}
session_wait {seconds: 5}
session_read_screen {session_id}    # look for trust / update prompts
# … if a startup prompt is showing, dismiss it with session_send_key first …
session_send_text {session_id, text: "Your real prompt"}
session_send_key  {session_id, key: "Enter"}
session_wait {seconds: 10}
session_read_screen {session_id}    # confirm "Thinking..." / "Searching..."
```

Common startup blockers to watch for:

- **Codex** — "Do you trust the contents of this directory?" / "Update available! Press enter to continue".
- **Gemini** — "Do you trust the files in this folder?". Also: Gemini's input is a multiline editor — the first `Enter` may insert a newline rather than submit. After sending text + `Enter`, read the screen; if the text is still in the input field, send another `Enter`.
- **Codex** — same multiline-editor quirk; if the prompt appears but doesn't submit, send a second `Enter`.

## Reading: screen vs output

- **`session_read_screen`** — `capture-pane`, the visible terminal content. Good for checking startup state, watching for "Thinking…", verifying that a submission landed. Limited to the visible pane (default 200 lines, max 1000).
- **`session_read_output`** — parsed transcript from the session file (JSONL for Claude, chat file for Gemini, rollout JSONL for Codex). Structured content with token counts. Use this when you need the actual conversation, not just what's on screen.

## Sub-sessions stay hidden

`session_new` defaults to `hidden: true` so MCP-spawned sub-sessions don't pollute the user's sidebar. Pass `hidden: false` only if the user explicitly asked for a visible session.

## CLI-specific notes

### Gemini

- Needs `GEMINI_API_KEY` (Workbench sets this from Settings → API Keys; the CLI also accepts `GOOGLE_API_KEY`).
- CWD matters: Gemini can only see its CWD and below.
- Multiline editor — see the `Enter` quirk above.
- Double `Escape` clears the input buffer.

### Codex

- Needs `OPENAI_API_KEY` (Workbench sets this from Settings → API Keys via a custom `model_provider` block in `~/.codex/config.toml`, so the OAuth/ChatGPT flow doesn't fire).
- 1024-char paste display limit — `session_send_text` still delivers the full text via the buffer, but Codex's screen rendering truncates the visible echo. Use `session_read_output` to verify the full prompt was received.
- Trust + update prompts on every fresh launch — handle them first.
- Multiline editor — same `Enter` quirk as Gemini.

### Claude

- OAuth via `/login` once per container (auth persists in `/data/.claude/`).
- Sub-sessions launched via `session_new {cli: "claude"}` resume cleanly via `--resume` after a restart, as long as their JSONL is still on disk.

## When non-interactive (`-p` / `--print` / `exec`) is OK

Simple one-shot questions with no tool use, scripted pipelines that just need text output. Anything that needs files, MCP tools, multi-turn, or might hit a permission prompt — use a real session through `session_*`.
