#!/bin/bash
set -e

# Blueprint entrypoint — runs as root, drops to blueprint user via gosu
# This allows dynamic docker socket group matching at startup

SOCK=/var/run/docker.sock
if [ -S "$SOCK" ]; then
  GID=$(stat -c '%g' "$SOCK")
  if [ "$GID" -ne 0 ]; then
    if ! getent group "$GID" > /dev/null 2>&1; then
      groupadd -g "$GID" dockerhost
    fi
    usermod -aG "$(getent group "$GID" | cut -d: -f1)" blueprint
    echo "[entrypoint] Added blueprint to docker socket group (GID $GID)"
  else
    echo "[entrypoint] WARNING: docker socket owned by root — docker commands may fail"
  fi
fi

# Everything below runs as blueprint user
run_as_blueprint() {
  CLAUDE="$HOME/.claude"
  BP_DATA="${BLUEPRINT_DATA:-$HOME/.blueprint}"
  WORK="${WORKSPACE:-$HOME/workspace}"

  # Ensure .claude.json exists for workspace trust
  test -f "$HOME/.claude.json" || echo '{}' > "$HOME/.claude.json"
  if [ ! -f "$CLAUDE/.claude.json" ]; then
    echo '{}' > "$CLAUDE/.claude.json"
  fi
  mkdir -p "$BP_DATA" "$CLAUDE/projects" "$WORK"

  # Ensure docs library exists with standard structure
  mkdir -p "$WORK/docs/guides" "$WORK/docs/processes" "$WORK/docs/reference" "$WORK/docs/system-prompts"
  if [ -d /app/config/guides ] && [ -z "$(ls -A "$WORK/docs/guides" 2>/dev/null)" ]; then
    cp /app/config/guides/*.md "$WORK/docs/guides/" 2>/dev/null || true
    echo "[entrypoint] Seeded docs library from config/guides"
  fi

  # Seed default CLAUDE.md if not present
  if [ -f /app/config/CLAUDE.md ] && [ ! -f "$CLAUDE/CLAUDE.md" ]; then
    cp /app/config/CLAUDE.md "$CLAUDE/CLAUDE.md"
    echo "[entrypoint] Seeded global CLAUDE.md"
  fi

  # Export API keys from Blueprint DB for CLI use
  if [ -f "$BP_DATA/blueprint.db" ]; then
    GEMINI_KEY=$(node -e "try{const d=require('/app/db.js');console.log(d.getSetting('gemini_api_key',''))}catch{}" 2>/dev/null)
    CODEX_KEY=$(node -e "try{const d=require('/app/db.js');console.log(d.getSetting('codex_api_key',''))}catch{}" 2>/dev/null)
    [ -n "$GEMINI_KEY" ] && export GOOGLE_API_KEY="$GEMINI_KEY" && echo "[entrypoint] Exported GOOGLE_API_KEY from settings"
    [ -n "$CODEX_KEY" ] && export OPENAI_API_KEY="$CODEX_KEY" && echo "[entrypoint] Exported OPENAI_API_KEY from settings"
  fi

  # Ensure Claude CLI settings exist
  if [ ! -f "$CLAUDE/settings.json" ]; then
    echo '{"skipDangerousModePermissionPrompt":true}' > "$CLAUDE/settings.json"
    echo "[entrypoint] Created settings.json"
  fi

  # Register Blueprint MCP server globally
  claude mcp add-json --scope user blueprint '{"command":"node","args":["/app/mcp-server.js"],"env":{"BLUEPRINT_PORT":"3000"}}' 2>/dev/null || true

  # Register Playwright MCP server (headless Chromium for browser automation)
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
    const f = (process.env.HOME + '/.claude') + '/.claude.json';
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
}

# Fix ownership for blueprint user
chown -R blueprint:blueprint /home/blueprint/workspace 2>/dev/null || true

# Start Qdrant vector database in background
QDRANT_STORAGE="${BLUEPRINT_DATA:-/home/blueprint/.blueprint}/qdrant"
mkdir -p "$QDRANT_STORAGE" 2>/dev/null || true
chown -R blueprint:blueprint "$QDRANT_STORAGE" 2>/dev/null || true
if command -v qdrant &>/dev/null; then
  export QDRANT__STORAGE__STORAGE_PATH="$QDRANT_STORAGE"
  gosu blueprint qdrant --disable-telemetry &
  echo "[entrypoint] Qdrant started on port 6333 (storage: $QDRANT_STORAGE)"
fi

# Run setup as blueprint, then exec the main command as blueprint
export -f run_as_blueprint
gosu blueprint bash -c "run_as_blueprint"
exec gosu blueprint "$@"
