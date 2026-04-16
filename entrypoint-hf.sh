#!/bin/bash
set -e

# Blueprint HF Spaces entrypoint — runs as non-root user (UID 1000)

# Ensure data directories exist (persistent across restarts via /data volume)
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
BP_DATA="${BLUEPRINT_DATA:-/data/blueprint}"

mkdir -p "$BP_DATA"
mkdir -p "$CLAUDE/projects"
mkdir -p "$BP_DATA/quorum" 2>/dev/null || true
mkdir -p /data/workspace /data/storage 2>/dev/null || true

# Ensure .claude.json exists for workspace trust
test -f "$HOME/.claude.json" || echo '{}' > "$HOME/.claude.json"

# Ensure .claude.json config exists in CLAUDE_CONFIG_DIR
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

# Use ANTHROPIC_API_KEY from HF Space secrets if available
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

# Register Playwright MCP server
claude mcp add-json --scope user playwright '{"command":"npx","args":["@playwright/mcp@latest","--headless"]}' 2>/dev/null || true

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
  const f = (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || (process.env.HOME + '/.claude')) + '/.claude.json';
  let d = {};
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const ver = process.argv[1] || '99.99.99';
  let changed = false;
  if (!d.hasCompletedOnboarding) { d.hasCompletedOnboarding = true; changed = true; }
  if (!d.theme) { d.theme = 'dark'; changed = true; }
  if (!d.bypassPermissionsModeAccepted) { d.bypassPermissionsModeAccepted = true; changed = true; }
  if (d.lastOnboardingVersion !== ver) { d.lastOnboardingVersion = ver; changed = true; }
  if (changed) {
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
    console.log('[entrypoint] Set hasCompletedOnboarding (version ' + ver + ')');
  }
" "$CLI_VERSION" || echo "[entrypoint] WARNING: Failed to set onboarding state"

echo "[entrypoint] Blueprint starting on port ${PORT:-7860}"
exec "$@"
