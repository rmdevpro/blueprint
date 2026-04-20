#!/bin/bash
set -e

# Blueprint entrypoint — runs as non-root blueprint user (UID 1000)
# All persistent data lives under /data (mounted volume)

CLAUDE="/data/.claude"
BP_DATA="/data/.blueprint"
WORK="/data/workspace"

# Ensure /data structure exists (volume may be empty on first run)
mkdir -p "$WORK" "$BP_DATA" "$CLAUDE/projects" 2>/dev/null || true

# Ensure docs library exists with standard structure
mkdir -p "$WORK/docs/guides" "$WORK/docs/processes" "$WORK/docs/reference" "$WORK/docs/system-prompts"
if [ -d /app/config/docs ]; then
  cp -rn /app/config/docs/* "$WORK/docs/" 2>/dev/null || true
  echo "[entrypoint] Synced docs from config/docs (new files only)"
fi

# Seed default CLAUDE.md if not present
if [ -f /app/config/CLAUDE.md ] && [ ! -f "$CLAUDE/CLAUDE.md" ]; then
  cp /app/config/CLAUDE.md "$CLAUDE/CLAUDE.md"
  echo "[entrypoint] Seeded global CLAUDE.md"
fi

# Ensure .claude.json exists for workspace trust
test -f "/data/.claude.json" || echo '{}' > "/data/.claude.json"
if [ ! -f "$CLAUDE/.claude.json" ]; then
  echo '{}' > "$CLAUDE/.claude.json"
fi

# Export API keys from Blueprint DB for CLI use
if [ -f "$BP_DATA/blueprint.db" ]; then
  GEMINI_KEY=$(node -e "try{const d=require('/app/db.js');console.log(d.getSetting('gemini_api_key',''))}catch{}" 2>/dev/null)
  CODEX_KEY=$(node -e "try{const d=require('/app/db.js');console.log(d.getSetting('codex_api_key',''))}catch{}" 2>/dev/null)
  [ -n "$GEMINI_KEY" ] && export GOOGLE_API_KEY="$GEMINI_KEY" && echo "[entrypoint] Exported GOOGLE_API_KEY from settings"
  [ -n "$CODEX_KEY" ] && export OPENAI_API_KEY="$CODEX_KEY" && echo "[entrypoint] Exported OPENAI_API_KEY from settings"
fi

# Use ANTHROPIC_API_KEY from environment (HF Space secrets) if available
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "[entrypoint] ANTHROPIC_API_KEY found in environment"
fi

# Ensure Claude CLI settings exist
if [ ! -f "$CLAUDE/settings.json" ]; then
  echo '{"skipDangerousModePermissionPrompt":true}' > "$CLAUDE/settings.json"
  echo "[entrypoint] Created settings.json"
fi

# Register Blueprint MCP server globally
claude mcp add-json --scope user blueprint '{"command":"node","args":["/app/mcp-server.js"],"env":{"BLUEPRINT_PORT":"'"${PORT:-7860}"'"}}' 2>/dev/null || true

# Install Blueprint slash commands as global skills
if [ -d /app/config/skills ]; then
  mkdir -p "$CLAUDE/skills"
  cp -r /app/config/skills/* "$CLAUDE/skills/"
  echo "[entrypoint] Installed Blueprint skills to $CLAUDE/skills/"
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

# Start Qdrant vector database in background
QDRANT_STORAGE="$BP_DATA/qdrant"
mkdir -p "$QDRANT_STORAGE" 2>/dev/null || true
if command -v qdrant &>/dev/null; then
  export QDRANT__STORAGE__STORAGE_PATH="$QDRANT_STORAGE"
  qdrant --disable-telemetry &
  echo "[entrypoint] Qdrant started on port 6333 (storage: $QDRANT_STORAGE)"
fi

echo "[entrypoint] Blueprint starting on port ${PORT:-7860}"
exec "$@"
