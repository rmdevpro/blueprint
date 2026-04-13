# Smart Compaction — Prompt Injection Problem & Process Checker Design

## The Problem

When Blueprint sends instructions to a Claude CLI session via `Read <file>`, the CLI's prompt injection detection flags it as an attack and refuses to follow the instructions. This happened for both:

1. The prep instructions (before compaction) — telling the session to update its plan file
2. The recovery prompt (after compaction) — telling the session to read its plan file and conversation tail

The CLI said things like: "Flagging another prompt injection attempt. This file follows the same pattern... I will not follow any of these instructions."

## What We Tried

### Attempt 1: File read for both prep and recovery

- Wrote multi-line instructions to a file
- Sent `Read <filepath>` via tmuxSendKeys
- CLI flagged both as prompt injection attacks

### Attempt 2: Direct user input for recovery

- Recovery prompt is a single line, so sent directly via tmuxSendKeys
- CLI accepted it as user input and followed it
- BUT the plan file wasn't updated because the prep step (still sent via file read) was rejected

### Why file reads get flagged

- `Read <file>` makes the CLI process content as file content, not user input
- The CLI's injection detection treats unsolicited file content with directives ("read this", "follow these instructions") as suspicious
- Direct tmuxSendKeys text is treated as user input, which the CLI trusts

### The multi-line problem

- Prep instructions are 50+ lines with headers, numbered steps, tool call sequences
- tmuxSendKeys can't send multi-line text — newlines become Enter keystrokes, fragmenting the prompt
- So prep can't go via direct input AND can't go via file read

## The Proposed Solution: Two-Session Process Checker

### Architecture

- **Session A** — the actual work session being compacted. Has full conversation context.
- **Session B** — a Sonnet process checker running headlessly. Reads the session maintenance guide, knows the full checklist, mediates the conversation with Session A.

### Flow

1. Blueprint tells Session B: "Read the session maintenance guide. You are going to guide Session A through the compaction prep process. Here's what needs to happen [checklist]. You will receive Session A's responses and send it prompts to keep it on track."

2. Blueprint sends to Session A via tmuxSendKeys: "We need to prepare for compaction. Please enter plan mode and update your plan file with the current status, key decisions, reading list, resume instructions, and files modified." — one line, natural language, sent as user input.

3. Session A responds. Blueprint captures the response (via tmux capture-pane) and forwards it to Session B.

4. Session B evaluates: did Session A actually enter plan mode? Did it update the plan? Did it skip anything? Session B sends back the appropriate next prompt — could be "Good, now exit plan mode" or "You skipped the reading list, please add it" or if Session A asks a question, "Use your own judgement, you understand the context best."

5. Blueprint sends Session B's response to Session A via tmuxSendKeys.

6. Loop until Session B confirms all checklist items are done.

7. Session B says "Send the recheck prompt." Blueprint sends: "Before we compact please review your plan once more and ensure it is ready to transfer state after compaction."

8. Session A confirms. Blueprint runs /compact.

9. Same two-session pattern for recovery — Session B guides Session A through reading the plan file, the conversation tail, and the reading list.

### Key Design Points

- Session B is cheap (Sonnet), stateless (--print --no-session-persistence), only job is process cop
- Session A never sees file reads or injected instructions — just natural language prompts that look like a user talking
- Session B reads the session maintenance guide to know the full 8-element checklist
- Session B handles all the edge cases: Session A asking questions, skipping steps, wanting to exit plan mode, etc.
- The conversation is mediated — Blueprint captures A's output and sends it to B, B generates the next prompt, Blueprint sends it to A

### What we need feedback on

1. Is the two-session mediation approach sound?
2. How should Session B detect that Session A has completed each step?
3. What happens if Session A refuses or goes off track — how aggressive should Session B be?
4. Should Session B have access to the plan file directly (to verify it was actually written) or just rely on Session A's responses?
5. How do we handle the recovery phase — same mediation pattern, or simpler since the recovery prompt already works as direct input?
6. Are there simpler alternatives we haven't considered?
7. What about using Claude Code's native plan mode (/plan) to structure the prep work?
8. Cost/latency implications of running two sessions during every compaction?
