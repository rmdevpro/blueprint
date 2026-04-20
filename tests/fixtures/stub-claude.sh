#!/bin/bash
# Stub Claude CLI for deterministic gating (WPR-103 §3.11)
# Replicates key behaviors of the real claude binary
set -e

RESPONSE_FILE="${STUB_RESPONSE_FILE:-}"
EXIT_CODE="${STUB_EXIT_CODE:-0}"
DELAY_MS="${STUB_DELAY_MS:-100}"

# Parse args
PRINT_MODE=false
SESSION_ID=""
MODEL="claude-sonnet-4-6"
NO_PERSIST=false
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    mcp) echo '{}'; exit 0 ;;
    --print|-p) PRINT_MODE=true; shift ;;
    --resume|-r) SESSION_ID="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --no-session-persistence) NO_PERSIST=true; shift ;;
    --dangerously-skip-permissions) shift ;;
    --permission-mode) shift 2 ;;
    --version) echo "1.0.0-stub"; exit 0 ;;
    --help) echo "stub claude cli"; exit 0 ;;
    --fallback-model) shift 2 ;;
    *) PROMPT="$1"; shift ;;
  esac
done

# Simulate processing delay
if [ "$DELAY_MS" -gt 0 ] 2>/dev/null; then
  sleep "$(echo "scale=3; $DELAY_MS/1000" | bc 2>/dev/null || echo "0.1")"
fi

# Generate JSONL if not in no-persist mode
if [ "$NO_PERSIST" = "false" ]; then
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "stub-$(date +%s)")"
  fi

  CLAUDE_HOME_DIR="${CLAUDE_HOME:-/data/.claude}"
  CWD_ENCODED="$(pwd | sed 's|/|-|g')"
  SESS_DIR="$CLAUDE_HOME_DIR/projects/$CWD_ENCODED"
  mkdir -p "$SESS_DIR" 2>/dev/null || true

  JSONL_FILE="$SESS_DIR/${SESSION_ID}.jsonl"

  # Write user entry
  echo "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"${PROMPT:-test}\"},\"uuid\":\"$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo user-stub)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}" >> "$JSONL_FILE"

  # Write assistant entry with usage
  echo "{\"type\":\"assistant\",\"message\":{\"model\":\"$MODEL\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Stub response\"}],\"usage\":{\"input_tokens\":1000,\"output_tokens\":100,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}},\"uuid\":\"$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo asst-stub)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"}" >> "$JSONL_FILE"
fi

# Output response
if [ "$PRINT_MODE" = "true" ]; then
  if [ -n "$RESPONSE_FILE" ] && [ -f "$RESPONSE_FILE" ]; then
    cat "$RESPONSE_FILE"
  else
    echo "ok"
  fi
fi

# In non-print mode, keep alive to simulate interactive Claude session
if [ "$PRINT_MODE" = "false" ]; then
  exec sleep infinity
fi

exit "$EXIT_CODE"
