# Using the Codex CLI

Codex CLI (OpenAI) is available in the Blueprint container for code reviews, debugging, and second opinions.

## Setup

Configure your API key in Blueprint Settings > API Keys (OpenAI / Codex API Key). The key is exported as `OPENAI_API_KEY` at container startup.

## Recommended: Tmux Sessions

Launch Codex in a tmux session for full interactive capability.

```bash
# Launch
tmux new-session -d -s codex -x 200 -y 50
tmux send-keys -t codex "codex" Enter

# Wait for startup, then send a prompt
sleep 3
tmux send-keys -t codex "Review server.js for potential issues" Enter

# Check progress
tmux capture-pane -t codex -p -S -30 | tail -20

# Send follow-up
tmux send-keys -t codex "What about the error handling?" Enter

# Kill when done
tmux kill-session -t codex
```

### Why tmux over `codex exec`
- Full interactive session with tool use
- Can monitor progress and send follow-ups
- Resume conversations naturally
- `codex exec` is limited to stdout output with no tool interaction

## Quick One-Shot (when you don't need tools)

```bash
codex exec "What is the difference between Promise.all and Promise.allSettled?"
```

## Common Use Cases

### Code Review (tmux)
```bash
tmux send-keys -t codex "Review routes.js against our error handling patterns" Enter
```

### Debugging Help (tmux)
```bash
tmux send-keys -t codex "I'm getting this error: [paste]. Look at server.js and tell me what's wrong." Enter
```

### Multi-Turn Consultation (tmux)
```bash
# Initial question
tmux send-keys -t codex "I'm stuck on the WebSocket reconnection logic. Here's the error: [paste]" Enter
# Check response
tmux capture-pane -t codex -p -S -30 | tail -20
# Follow up
tmux send-keys -t codex "What if the heartbeat interval is too short?" Enter
```

## Options

```bash
# Specific model
codex --model gpt-5.3-codex exec "Review this code"

# Working directory
codex --cd /mnt/workspace/my-project exec "Explain the codebase"

# Auto-approve file writes (restrict in your prompt)
codex exec --yolo "Do NOT modify any files. Just review server.js."
```

## Known Limitations

- Default sandbox is read-only — `--yolo` required for file writes
- Always restrict writes explicitly in your prompt when using `--yolo`
- Non-interactive mode (`exec`) has limited tool access — prefer tmux
