#!/bin/bash
set -e

# Blueprint entrypoint — runs as root, drops to hopper via gosu
# This allows dynamic docker socket group matching at startup

SOCK=/var/run/docker.sock
if [ -S "$SOCK" ]; then
  GID=$(stat -c '%g' "$SOCK")
  if [ "$GID" -ne 0 ]; then
    if ! getent group "$GID" > /dev/null 2>&1; then
      groupadd -g "$GID" dockerhost
    fi
    usermod -aG "$(getent group "$GID" | cut -d: -f1)" hopper
    echo "[entrypoint] Added hopper to docker socket group (GID $GID)"
  else
    echo "[entrypoint] WARNING: docker socket owned by root — docker commands may fail"
  fi
fi

# Everything below runs as hopper
run_as_hopper() {
  # Ensure .claude.json exists for workspace trust
  test -f "$HOME/.claude.json" || echo '{}' > "$HOME/.claude.json"

  # Ensure data directories exist
  CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
  BP_DATA="${BLUEPRINT_DATA:-$HOME/.blueprint}"

  # Symlink $HOME/.claude to CLAUDE_HOME so the CLI finds credentials
  if [ "$CLAUDE" != "$HOME/.claude" ] && [ ! -e "$HOME/.claude" ]; then
    ln -s "$CLAUDE" "$HOME/.claude"
    echo "[entrypoint] Linked $HOME/.claude -> $CLAUDE"
  fi

  # Ensure .claude.json config exists in CLAUDE_CONFIG_DIR (where the CLI actually reads it)
  if [ ! -f "$CLAUDE/.claude.json" ]; then
    echo '{}' > "$CLAUDE/.claude.json"
  fi
  mkdir -p "$BP_DATA"
  mkdir -p "$CLAUDE/projects"
  mkdir -p "$BP_DATA/quorum" 2>/dev/null || true

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

  # Register Blueprint MCP server globally (user scope — survives project changes)
  claude mcp add-json --scope user blueprint '{"command":"node","args":["/app/mcp-server.js"],"env":{"BLUEPRINT_PORT":"3000"}}' 2>/dev/null || true

  # Register Playwright MCP server (headless Chromium for browser automation)
  claude mcp add-json --scope user playwright '{"command":"npx","args":["@playwright/mcp@latest","--headless"]}' 2>/dev/null || true

  # Install Blueprint slash commands as global skills
  if [ -d /app/config/skills ]; then
    mkdir -p "$CLAUDE/skills"
    cp -r /app/config/skills/* "$CLAUDE/skills/"
    echo "[entrypoint] Installed Blueprint skills to $CLAUDE/skills/"
  fi

  # Verify Claude CLI credentials (non-interactive)
  if [ -f "$CLAUDE/.credentials.json" ]; then
    timeout 15 claude --print --no-session-persistence "ok" > /dev/null 2>&1 && \
      echo "[entrypoint] Claude CLI credentials verified" || \
      echo "[entrypoint] Claude CLI probe failed — credentials may need refresh"
  fi


  # Mark onboarding as completed in ~/.claude.json
  # Query installed CLI version so it doesn't re-trigger on updates
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
}

# Fix ownership of workspace for hopper user
chown -R hopper:hopper /mnt/workspace 2>/dev/null || true
chown -R hopper:hopper /mnt/storage 2>/dev/null || true

# Run setup as hopper, then exec the main command as hopper
export -f run_as_hopper
gosu hopper bash -c "run_as_hopper"
exec gosu hopper "$@"
