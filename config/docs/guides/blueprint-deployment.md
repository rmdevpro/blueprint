# Blueprint Deployment Guide

## Architecture

Blueprint is a single container application. All persistent data lives under one mount point: `/data` inside the container. This includes the database, Claude session files, workspace projects, configuration, and Qdrant vector data.

The container image is identical for all deployment targets. The only thing that changes is where `/data` comes from.

## Deployment Targets

### Hugging Face Spaces

HF provides a persistent volume at `/data`. The HF runtime mounts it automatically when persistent storage is enabled in the Space settings.

No compose file needed — HF builds from `Dockerfile.huggingface` and `README.huggingface.md` provides the Space configuration.

### Local / Docker Compose (Joshua26 ecosystem)

On Joshua26 hosts, Blueprint's data lives at `/mnt/workspace/blueprint/` per ERQ-005 §3. The compose file bind-mounts this to `/data` inside the container:

```yaml
services:
  blueprint:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: blueprint
    ports:
      - "6342:3000"
    volumes:
      - /mnt/workspace/blueprint:/data
    restart: unless-stopped
```

Before first deployment, create the host directory:
```bash
sudo mkdir -p /mnt/workspace/blueprint
sudo chown 1000:2001 /mnt/workspace/blueprint
```

### Standalone (any machine)

On any machine with Docker, pick a host path for data persistence:

```yaml
services:
  blueprint:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - /path/to/blueprint-data:/data
    restart: unless-stopped
```

## What's Inside `/data`

The entrypoint sets up the following structure under `/data`:

```
/data/
  .blueprint/           — SQLite database, Qdrant vector data
  .claude/              — Claude CLI config, session JSONLs, MCP registrations
  .local/               — Persistent user-installed packages (see below)
  .ssh/                 — SSH keys and config for remote host access
  workspace/            — Project directories (docs, repos, etc.)
```

## Installing Persistent Add-ons

Blueprint supports installing additional tools that survive container rebuilds. Anything installed to `/data/.local/` persists on the volume. The entrypoint adds `/data/.local/bin` to PATH and `/data/.local/lib/node_modules` to NODE_PATH automatically.

### npm packages (e.g. Playwright MCP)

```bash
npm install --prefix /data/.local @playwright/mcp
npx playwright install chrome
```

The npm package installs to `/data/.local/node_modules/` and Chrome installs to `/data/.cache/ms-playwright/` — both on the persistent volume. After a container rebuild, they're still there.

### System packages (apt)

System packages installed via `apt-get` do NOT persist — they live in the container filesystem. For system-level tools you always need, add them to the Dockerfile or a compose override.

### Registering MCP servers

After installing an MCP package, register it with Claude:

```bash
claude mcp add-json --scope user playwright '{"command":"npx","args":["-y","@playwright/mcp","--headless"]}'
```

This registration persists in `/data/.claude/` — no re-registration needed after rebuild.

## Authentication

On first start, Claude CLI has no credentials. To authenticate:

1. Create a project and Claude session in the UI
2. Claude will show "Not logged in · Please run /login"
3. Type `/login` in the terminal
4. Complete the OAuth flow in the browser
5. Auth persists in `/data/.claude/` — survives container rebuilds

Alternatively, copy credentials from an already-authenticated machine (with permission).

## Optional: Shared Storage

To expose NFS or other shared storage in Blueprint's file browser and project picker, mount it under `/mnt` inside the container:

```yaml
volumes:
  - /mnt/workspace/blueprint:/data
  - /mnt/storage:/mnt/storage:ro
```

This is additive — Blueprint works without it. The `/api/mounts` endpoint automatically discovers directories under `/mnt`.
