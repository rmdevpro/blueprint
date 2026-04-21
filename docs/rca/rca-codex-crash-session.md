# RCA: Codex Session Record Crash

## Broken Session
- ID: `72c39558-5dae-4e6c-9cdb-711c73efed68`
- Environment: M5 test (192.168.1.120:7867)
- Project: test-148
- CLI type: codex
- **DO NOT DELETE THIS RECORD**

## Symptom
- Opening this specific session causes Codex to crash immediately (exit code 0 or 1)
- The reconnect loop fires: "Session disconnected. Attempting to resume..."
- New Codex session records work fine
- Typing `codex` in a Terminal works fine
- The problem is specific to THIS session record

## What to investigate
1. Query the DB record: `SELECT * FROM sessions WHERE id = '72c39558-5dae-4e6c-9cdb-711c73efed68'`
2. Check cli_session_id — what resume args are being passed?
3. Check what `safe.tmuxCreateCLI` generates for this session vs a working one
4. Check the CWD (project_path) — does the directory exist?
5. Compare the tmux launch command for this session vs a fresh codex session
6. Run the exact same command manually in the container and see the error output

## Key observation
- On prod1, the same pattern: broken session record crashes, manual `codex` works (Capture.PNG / Capture1.PNG in /storage/tmp/)
- The update prompt behavior differs: broken session shows interactive menu that blocks, manual launch shows non-interactive info text

## Status
- RCA not started — needs fresh session with full context
