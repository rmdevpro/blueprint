#!/bin/bash
set -e

# Workbench entrypoint — runs as non-root workbench user (UID 1000)
# All persistent data lives under /data (mounted volume)

CLAUDE="/data/.claude"
WORK="/data/workspace"
WB_DATA="/data/.workbench"

# Ensure /data structure exists (volume may be empty on first run)
mkdir -p "$WORK" "$WB_DATA" "$CLAUDE/projects" 2>/dev/null || true

# Ensure docs library exists with standard structure
mkdir -p "$WORK/docs/guides" "$WORK/docs/processes" "$WORK/docs/reference" "$WORK/docs/system-prompts"
if [ -d /app/config/docs ]; then
  cp -rn /app/config/docs/* "$WORK/docs/" 2>/dev/null || true
  echo "[entrypoint] Synced docs from config/docs (new files only)"
fi

# Seed default system prompts if not present
# #197: use -s (file exists AND non-empty) instead of -f (file exists). Empty
# 0-byte prompt files left over from earlier deploys would otherwise survive
# forever and never get re-seeded.
if [ -f /app/config/CLAUDE.md ] && [ ! -s "$CLAUDE/CLAUDE.md" ]; then
  cp /app/config/CLAUDE.md "$CLAUDE/CLAUDE.md"
  echo "[entrypoint] Seeded global CLAUDE.md"
fi
if [ -f /app/config/GEMINI.md ] && [ ! -s "$CLAUDE/GEMINI.md" ]; then
  cp /app/config/GEMINI.md "$CLAUDE/GEMINI.md"
  echo "[entrypoint] Seeded global GEMINI.md"
fi
if [ -f /app/config/AGENTS.md ] && [ ! -s "$CLAUDE/AGENTS.md" ]; then
  cp /app/config/AGENTS.md "$CLAUDE/AGENTS.md"
  echo "[entrypoint] Seeded global AGENTS.md"
fi

# Ensure .claude.json exists for workspace trust
test -f "/data/.claude.json" || echo '{}' > "/data/.claude.json"
if [ ! -f "$CLAUDE/.claude.json" ]; then
  echo '{}' > "$CLAUDE/.claude.json"
fi

# CLIs manage their own credentials:
# - Claude: OAuth via /login (stored in ~/.claude/)
# - Gemini: API key prompt on first use (stored in ~/.gemini/)
# - Codex: API key prompt on first use (stored in ~/.codex/)

# Use ANTHROPIC_API_KEY from environment (HF Space secrets) if available
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "[entrypoint] ANTHROPIC_API_KEY found in environment"
fi

# Ensure Claude CLI settings exist
if [ ! -f "$CLAUDE/settings.json" ]; then
  echo '{"skipDangerousModePermissionPrompt":true}' > "$CLAUDE/settings.json"
  echo "[entrypoint] Created settings.json"
fi

# Register Workbench MCP server globally
claude mcp add-json --scope user workbench '{"command":"node","args":["/app/mcp-server.js"]}' 2>/dev/null || true

# Install Workbench slash commands as global skills
if [ -d /app/config/skills ]; then
  mkdir -p "$CLAUDE/skills"
  cp -r /app/config/skills/* "$CLAUDE/skills/"
  echo "[entrypoint] Installed Workbench skills to $CLAUDE/skills/"
fi

# Mark onboarding as completed
CLI_VERSION=$(claude --version 2>/dev/null | sed 's/ .*//' || true)
CLI_VERSION="${CLI_VERSION:-99.99.99}"
node -e "
  const fs = require('fs');
  const f = '/data/.claude/.claude.json';
  let d = {};
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const ver = process.argv[1] || '99.99.99';
  let changed = false;
  if (!d.hasCompletedOnboarding) { d.hasCompletedOnboarding = true; changed = true; }
  if (!d.theme) { d.theme = 'dark'; changed = true; }
  if (!d.bypassPermissionsModeAccepted) { d.bypassPermissionsModeAccepted = true; changed = true; }
  if (d.autoUpdates !== false) { d.autoUpdates = false; changed = true; }
  if (d.lastOnboardingVersion !== ver) { d.lastOnboardingVersion = ver; changed = true; }
  if (changed) {
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
    console.log('[entrypoint] Set hasCompletedOnboarding (version ' + ver + ')');
  }
" "$CLI_VERSION" || echo "[entrypoint] WARNING: Failed to set onboarding state"

# Persistent user-installed packages at /data/.local (survives container rebuilds)
mkdir -p /data/.local/bin /data/.local/lib 2>/dev/null || true
export PATH="/data/.local/bin:$PATH"
export NODE_PATH="/data/.local/node_modules:/data/.local/lib/node_modules:${NODE_PATH:-}"
PERSISTENT_COUNT=$(ls /data/.local/node_modules 2>/dev/null | wc -w)
[ "$PERSISTENT_COUNT" -gt 0 ] && echo "[entrypoint] Persistent packages: $PERSISTENT_COUNT installed"

# Start Qdrant vector database in background
QDRANT_STORAGE="$WB_DATA/qdrant"
mkdir -p "$QDRANT_STORAGE" 2>/dev/null || true
if command -v qdrant &>/dev/null; then
  export QDRANT__STORAGE__STORAGE_PATH="$QDRANT_STORAGE"
  qdrant --disable-telemetry &
  echo "[entrypoint] Qdrant started on port 6333 (storage: $QDRANT_STORAGE)"
fi

echo "[entrypoint] Workbench starting on port ${PORT:-7860}"
exec "$@"
