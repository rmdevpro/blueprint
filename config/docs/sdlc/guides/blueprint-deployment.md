# Blueprint Deployment Guide

## Architecture

Blueprint is a single container application. All persistent data lives under one mount point: `/data` inside the container. This includes the database, CLI session files (Claude / Gemini / Codex), workspace projects, configuration, and Qdrant vector data.

**The container image is identical for all deployment targets.** The only things that vary per deployment are:
1. Which host path is bind-mounted to `/data`.
2. The value of the `logo_variant` setting in the container's DB (the dev/prod indicator).

## Dev/Prod Indicator

**Principle**: dev vs prod is **solely the DB-stored `logo_variant` setting**. Never baked into folder names, image names, container names, env vars, Dockerfiles, or any other physical artifact.

| `logo_variant` value | Logo rendered | Intended use |
|---|---|---|
| `production` | red "Pro" lockup | live/production hosts |
| `development` | green "Dev" lockup | dev/test hosts |
| `default` | canonical blue lockup | public/shared deployments (e.g., HF Space) |

See `README.md` → "Logo Variant" for the mechanism. The setting is swapped via `PUT /api/settings` or directly in SQLite; there is intentionally no UI.

## Host Path Convention

**`/srv/<service>` on every host** (FHS-canonical for service data). For Blueprint specifically: `/srv/workbench`.

Per-host backing is a deployment concern — each host mounts whatever storage is appropriate at that path:

- **irina (prod)**: ZFS dataset — `zfs create -o mountpoint=/srv/workbench storage/workbench` (lives on the existing `storage` pool).
- **M5 (dev)**: NVMe via fstab — `UUID=<...> /srv/workbench ext4 defaults 0 2`, or equivalent for the chosen filesystem.
- **Other hosts**: mount anything (ZFS dataset, dedicated SSD, loopback) at `/srv/workbench`.

The semantic path is identical across hosts; the physical backing is host-specific.

## Deployment Targets

### Joshua26 hosts (irina, M5)

Identical compose on every host. Container named `workbench`. Bind-mount `/srv/workbench` to `/data`.

```yaml
services:
  workbench:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: workbench
    ports:
      - "6342:3000"   # prod port on irina; override per host as needed
    volumes:
      - /srv/workbench:/data
      - /mnt/storage:/mnt/storage:ro   # optional, for shared NFS-style storage (see below)
    restart: unless-stopped
```

Before first deployment on a new host, provision the bind-mount target:
```bash
sudo mkdir -p /srv/workbench
sudo chown 1000:2001 /srv/workbench
```

### Hugging Face Spaces

HF provides a persistent volume at `/data`. The HF runtime mounts it automatically when persistent storage is enabled in the Space settings. HF builds the same `Dockerfile` as every other host; Space configuration lives in `README.huggingface.md`.

### Standalone (any machine)

On any machine with Docker, pick a host path for data persistence:

```yaml
services:
  workbench:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    volumes:
      - /path/to/workbench-data:/data
    restart: unless-stopped
```

## Per-Deploy Data Copy (dev from prod)

Dev hosts (e.g. M5) are expected to run **against a fresh snapshot of prod's `/data`** so testing happens on real content. On each deploy to a dev host, rsync from prod's `/srv/workbench/` to the dev host's `/srv/workbench/`.

```bash
# On the dev host, with the dev container stopped:
rsync -aHAX --delete \
  --exclude='.blueprint/qdrant/.lock' \
  --exclude='*.wal' --exclude='*.shm' \
  <produser>@<prodhost>:/srv/workbench/ \
  /srv/workbench/

sudo chown -R 1000:2001 /srv/workbench

# Re-assert dev-mode logo after the rsync (which overwrote the setting):
sqlite3 /srv/workbench/.blueprint/blueprint.db \
  "INSERT OR REPLACE INTO settings(key, value) VALUES ('logo_variant', '\"development\"');"

# Start the dev container
docker compose up -d
```

The excludes cover files that are typically open on a live prod container (Qdrant lock, SQLite WAL/SHM). If a corrupted DB shows up at validation time, stop the prod container briefly and repeat the rsync for a clean snapshot — that's the fallback, not the default.

Dev's `/data` drifts between deploys as the tester creates projects, writes files, and accumulates junk — **that drift is intentional**. The next redeploy wipes it and re-seeds with current prod content.

### Testing Project

A designated scratch directory under `/data/workspace/` (name: `testing/` or similar — set at deployment) is the agreed place to create throwaway projects during testing. Clean it periodically (`rm -rf /data/workspace/testing/* && git checkpoint` if tracked) so dev experimentation doesn't pollute the rest of the workspace.

## What's Inside `/data`

The entrypoint sets up the following structure under `/data`:

```
/data/
  .blueprint/           — SQLite database (blueprint.db), Qdrant vector data
  .claude/              — Claude CLI config, session JSONLs, MCP registrations
  .codex/               — Codex CLI config, session history
  .gemini/              — Gemini CLI config, session history
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

Alternatively, copy credentials from an already-authenticated machine (with permission). For dev hosts, the per-deploy rsync from prod carries credentials automatically.

## Optional: Shared Storage

To expose NFS or other shared storage in the file browser and project picker, mount it under `/mnt` inside the container:

```yaml
volumes:
  - /srv/workbench:/data
  - /mnt/storage:/mnt/storage:ro
```

This is additive — the workbench works without it. The `/api/mounts` endpoint automatically discovers directories under `/mnt`.

## Deploy to M5 (Dev Host) — Runbook

Condensed runbook for spinning up a fresh dev environment on M5 from current prod:

```bash
# On M5, as a user with docker + sudo access:

# 1. Tear down any previous dev containers
docker ps -aq --filter "name=workbench|blueprint-test|blueprint-oauth" | xargs -r docker rm -f

# 2. Provision host backing for /srv/workbench (once per machine)
sudo mkdir -p /srv/workbench
sudo chown 1000:2001 /srv/workbench

# 3. Snapshot prod
rsync -aHAX --delete \
  --exclude='.blueprint/qdrant/.lock' \
  --exclude='*.wal' --exclude='*.shm' \
  aristotle9@192.168.1.110:/srv/workbench/ \
  /srv/workbench/
sudo chown -R 1000:2001 /srv/workbench

# 4. Seed dev-mode logo
sqlite3 /srv/workbench/.blueprint/blueprint.db \
  "INSERT OR REPLACE INTO settings(key, value) VALUES ('logo_variant', '\"development\"');"

# 5. Bring up the container
docker compose up -d --build
```

Validate by loading the UI: green "Dev" logo renders, prod projects/sessions are listed in the sidebar, resuming an existing CLI session from prod works.
