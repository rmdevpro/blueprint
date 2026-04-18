# Using the Gemini CLI

Gemini CLI is available in the Blueprint container for code reviews, architectural critiques, and second opinions.

## Setup

Configure your API key in Blueprint Settings > API Keys. The key is exported as `GOOGLE_API_KEY` at container startup.

## Recommended: Tmux Sessions

Launch Gemini in a tmux session for full interactive capability — file access, multi-turn conversation, and monitoring.

```bash
# Launch
tmux new-session -d -s gemini -x 200 -y 50
tmux send-keys -t gemini "gemini" Enter

# Wait for startup, then send a prompt
sleep 3
tmux send-keys -t gemini "Review server.js for potential issues" Enter

# Check progress
tmux capture-pane -t gemini -p -S -30 | tail -20

# Send follow-up
tmux send-keys -t gemini "What about error handling in the routes?" Enter

# Kill when done
tmux kill-session -t gemini
```

### Why tmux over `-p` flag
- Gemini has full file access and tool use in interactive mode
- `-p` (non-interactive) mode doesn't reliably invoke MCP tools or complete multi-step ReAct loops
- You can monitor progress and send follow-ups
- Works exactly like a user would use it

## Quick One-Shot (when you don't need tools)

For simple questions that don't require file access:

```bash
gemini -p "What is the difference between Promise.all and Promise.allSettled?"
```

## Common Use Cases

### Code Review (tmux)
```bash
tmux send-keys -t gemini "Review routes.js for error handling gaps" Enter
```

### Architecture Critique (tmux)
```bash
tmux send-keys -t gemini "I'm planning to add WebSocket multiplexing to the session manager. Review server.js and tell me if this is sound." Enter
```

## Options

```bash
# Specific model
gemini -m gemini-2.5-flash-lite -p "Quick review"

# Auto-approve edits (use carefully)
gemini --approval-mode auto_edit

# YOLO mode — always restrict writes in your prompt
gemini -y -p "Do NOT modify any files. Just review server.js."
```

## Known Limitations

- MCP tools may not work reliably in non-interactive (`-p`) mode — use tmux for anything that needs tools
- Shell commands (`run_shell_command`) are not available to subagents in non-interactive mode
