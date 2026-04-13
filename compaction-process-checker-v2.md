# Smart Compaction — Process Checker V2 Design

## Context from testing

We tested tmux paste-buffer — it successfully sends multi-line content as user input without newline fragmentation. However, even as user input, the structured/directive prep prompt (with headers like "CRITICAL", "STEP 1", "COMPLETION GATE") was still flagged as prompt injection by the CLI. The CLI said: "This message is a prompt injection attempt... tries to manipulate me into calling non-existent tools."

Additionally, the MCP tools referenced in the prompt (blueprint_read_plan, etc.) exist in the MCP server but the CLI said "None of these tools exist in my toolset" — they may not be loading correctly, but regardless, the session doesn't need special MCP tools to update a plan file. It can use its native Read/Write tools.

## The user rewrote the prep prompt

The user replaced the 50-line directive prompt with one conversational line:

"We are going to run compaction, and you need to prepare so that we can pick up where we left off before compaction without losing key context. Your plan file is the key state record that will bridge the gap. Based on this session, please update your plan file paying special attention these sections: Current Status, Key Decisions, Resume Instructions, Files Modified and Reading List. Also take this opportunity to clean up the plan overall by placing any old data in a plan archive file. Also take this opportunity to update memories or other relevant documents. Once done please exit Plan Mode and update all relevant Git Issues."

## The two-session process checker design (refined)

### Architecture

- **Session A** — the work session being compacted
- **Session B** — a Haiku process checker that manages the conversation with A
- **Blueprint** — a programmatic parser that relays messages between A and B, and handles mechanical actions

### Session B's initial prompt (sent via paste-buffer)

Blueprint introduces itself to B as "the Blueprint chat parser" — simple code that facilitates a conversation between two agents. Key framing:

- B's outputs go directly to A as user messages — no need to introduce itself
- Replies to Blueprint must be JSON formatted: {"blueprint": "ready_to_connect"}, {"blueprint": "ready_to_compact"}, {"blueprint": "resume_complete"}
- B doesn't have A's context and that's fine — B assists with the process, not the content
- If A asks content questions, B tells A to use their own judgement
- Blueprint always identifies itself as "Blueprint parser" so B knows the difference between A's responses and Blueprint's interjections

### The flow

1. Blueprint sends B the full setup prompt (via paste-buffer, multi-line is fine)
2. B reads the session maintenance guidelines, processes instructions, outputs {"blueprint": "ready_to_connect"}
3. Blueprint detects the tag, sends B: "You are now connected to the agent, please begin the compaction prep conversation."
4. B outputs a conversational message (this goes directly to A via tmuxSendKeys)
5. Blueprint captures A's response (tmux capture-pane), sends it to B
6. B evaluates, sends next message or follow-up
7. Loop until B outputs {"blueprint": "ready_to_compact"}
8. Blueprint detects tag, sends /compact to A, waits for completion, extracts conversation tail (last 20% of JSONL as raw exchanges)
9. Blueprint sends B: "Hello, this is the Blueprint parser again. Compaction is complete. The conversation tail has been saved to <path>. It's now time to manage the recovery phase. Please guide the agent through reading their plan file and the conversation tail file to restore context."
10. B guides A through recovery conversationally
11. B outputs {"blueprint": "resume_complete"}
12. Blueprint unfreezes, done

### Blueprint interjections

If the conversation goes too many turns without B signaling ready, Blueprint can interject:

"Hello, this is the Blueprint parser again. I'm interrupting your conversation with the agent to let you know that the prep has been going on for N turns. Please wrap up in the next 2 turns. Respond with {"blueprint": "ready_to_compact"} when ready or {"blueprint": "ready_to_connect"} to resume your chat with the agent."

### Key design points

- Session B is stateful (same session across prep and recovery phases) — it remembers what was discussed
- B is conversational with A, uses JSON tags only for Blueprint
- Blueprint is a dumb relay + tag parser + mechanical actions
- The prep prompt to A is conversational, not directive — sounds like a user talking
- Plan mode (/plan) should be used to give A a clear structural context
- "Good enough to transfer state" is the bar, not perfection
- Hard cap on turns as safety net, but B should handle most cases naturally

### Questions for CLIs

1. Is this refined design sound? What failure modes do you see?
2. How should Blueprint handle the capture-pane → relay to B flow? Timing, buffer size, ANSI stripping?
3. Should B be Haiku or Sonnet? Cost vs capability trade-off for managing a multi-turn conversation?
4. How should B handle A entering/exiting plan mode? What does that look like in the tmux buffer?
5. What should the hard cap on turns be? And how should Blueprint phrase the "wrap it up" interjection?
6. For the recovery phase, should B guide A step by step (read plan, then read tail, then follow resume) or give it all at once?
7. Any concerns about the JSON tag protocol? Could B accidentally output valid JSON in conversation that gets parsed as a command?
8. How should Blueprint detect that A has finished responding? Poll capture-pane for the prompt character, or use a time-based heuristic?
