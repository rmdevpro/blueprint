# Workbench Deployment Notes

This guide covers **workbench-specific** deployment behavior — what's inside the container, how the dev/prod indicator works, what `/data` looks like, how to install add-ons, how to authenticate.

**Host-level deployment procedure** (which host runs what, how images get built and registered, how compose files merge, how to set up a new bare-metal host) is **not** documented here. It lives in the **Admin** repo:

- `Admin/docs/infrastructure/INF-001-bare-metal-configuration.md` — host inventory, base config
- `Admin/docs/infrastructure/INF-002-storage-conventions.md` — `/srv/<service>/` and `/mnt/storage/<purpose>/` rules
- `Admin/docs/infrastructure/INF-003-container-deployment.md` — registry, compose-override pattern, dev-vs-prod
- `Admin/docs/runbooks/RUN-001-deployment.md` — step-by-step deploy procedure (build → push → pull → up)
- `Admin/docs/runbooks/RUN-002-host-setup.md` — bringing a new host to standard

Per-host compose overrides for the workbench live at `Admin/compose/<host>/workbench/docker-compose.override.yml`.

---

## Architecture

The workbench is a single-container application. All persistent state lives under one mount point: `/data` inside the container. The container image is identical for all deployment targets — the only thing that varies is the value of the `logo_variant` setting in the container's DB.

## Dev/Prod Indicator

**Principle**: dev vs prod is **solely the DB-stored `logo_variant` setting**. Never baked into folder names, image names, container names, env vars, Dockerfiles, or any other physical artifact.

| `logo_variant` value | Logo rendered | Intended use |
|---|---|---|
| `production` | red "Pro" lockup | live/production hosts |
| `development` | green "Dev" lockup | dev/test hosts |
| `default` | canonical blue lockup | public/shared deployments (e.g., HF Space) |

See `README.md` → "Logo Variant" for the underlying mechanism. The setting is swapped via `PUT /api/settings` or directly in SQLite; there is intentionally no UI.

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

The host-side path that backs `/data` is determined by the per-host compose override (Admin repo). The container does not care.

## Installing Persistent Add-ons

The workbench supports installing additional tools that survive container rebuilds. Anything installed to `/data/.local/` persists on the volume. The entrypoint adds `/data/.local/bin` to `PATH` and `/data/.local/lib/node_modules` to `NODE_PATH` automatically.

### npm packages (e.g. Playwright MCP)

```bash
npm install --prefix /data/.local @playwright/mcp
npx playwright install chrome
```

The npm package installs to `/data/.local/node_modules/` and Chrome installs to `/data/.cache/ms-playwright/` — both on the persistent volume. After a container rebuild, they're still there.

### System packages (apt)

System packages installed via `apt-get` do **not** persist — they live in the container filesystem. For system-level tools that must always be present, add them to the `Dockerfile`. For tools needed only on a specific host, add them via the host's compose override (Admin repo).

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

Alternatively, copy credentials from an already-authenticated machine (with permission). For dev hosts that mirror prod data, credentials come along automatically with the data migration.

## Hugging Face Spaces

The workbench is also deployable as a Hugging Face Space. HF provides a persistent volume at `/data` automatically when persistent storage is enabled in the Space settings. HF builds the same `Dockerfile` as every other host; Space configuration lives in `README.huggingface.md`. The Space's logo_variant is typically left at `default`.

HF Space deployment doesn't go through the Admin-repo compose-override pipeline — it's a separate mechanism owned by the HF Spaces runtime.

## Seeding a Dev Host from Prod Data

Per Admin/RUN-001 §111-114, **data migration between hosts is a per-service concern**. For the workbench specifically, dev hosts are most useful when they run against a recent snapshot of prod's `/data`, so testing happens on real content rather than an empty database.

Procedure (on the dev host, with the dev container stopped):

```bash
rsync -aHAX --delete \
  --exclude='.blueprint/qdrant/.lock' \
  --exclude='*.wal' --exclude='*.shm' \
  <produser>@<prodhost>:/srv/workbench/ \
  /srv/workbench/

sudo chown -R 1000:2001 /srv/workbench

# Re-assert dev-mode logo after the rsync (which overwrote the setting):
sqlite3 /srv/workbench/.blueprint/blueprint.db \
  "INSERT OR REPLACE INTO settings(key, value) VALUES ('logo_variant', '\"development\"');"

# Start the dev container via the normal Admin-repo compose procedure
# (see Admin/RUN-001). Do NOT rebuild locally — pull the registry image.
```

The excludes cover files typically open on a live prod container (Qdrant lock, SQLite WAL/SHM). If a corrupted DB shows up at validation time, stop the prod container briefly and repeat the rsync for a clean snapshot.

Dev's `/data` will drift between rsyncs as the tester creates projects, writes files, accumulates junk — that drift is intentional. Re-run this procedure whenever you want a fresh snapshot. Not automatic; not tied to the deploy pipeline.

Credentials (Claude OAuth, API keys in settings DB) come along with the rsync, so the dev container is authenticated the moment it starts.

**Verify after rsync:**
1. Load the dev URL in a browser.
2. Sidebar lists prod's projects/sessions (data made it across).
3. Status bar updates when you click into a session (model name, context %, message count).
4. Open one session, send a trivial prompt, get a real reply (chat path works).

If any of those fail, don't proceed to use the dev host yet — re-check ownership (`chown -R 1000:2001 /srv/workbench`) and that the container started after the rsync, not before.

## Dev ↔ Prod Swap Procedure

Two distinct things people mean by "swap":

### A. Flip ONE host's mode (logo only)

The host stays where it is, just changes which logo it renders. No data movement.

```bash
# Inside the container (or via curl/sqlite from the host):
sqlite3 /data/.blueprint/blueprint.db \
  "INSERT OR REPLACE INTO settings(key, value) VALUES ('logo_variant', '\"production\"');"
```

Refresh the browser. Done. (Same DB write with `'\"development\"'` to flip the other way.)

### B. Swap which host serves prod (cutover)

Genuine cutover where a different host takes over the prod role.

**Operating principle**: outgoing-prod (the host currently serving prod) is
**never stopped** during the swap — it stays live the whole time so the user's
work isn't interrupted. The only stop in the procedure is on **incoming-prod**,
and only because we're wiping and replacing its `/data` (SQLite handles must be
released before that's safe). Future code-update restarts of outgoing-prod are
a separate concern, not part of the swap.

**Pre-cutover on outgoing-prod**: finalize work in flight, close all
workbench tabs/sessions on outgoing-prod **except the one you're using to
drive the swap**. The driving session writes nothing meaningful, so the
SQLite DB and CLI state files stay quiescent during the rsync.

**Why we explicitly wipe before rsync**: don't rely on `rsync --delete` alone —
the excludes (`*.wal`, `*.shm`, `qdrant/.lock`) leave incoming-prod's
pre-existing copies of those in place. A stale `qdrant/.lock` from
incoming-prod's prior dev role will prevent Qdrant from starting. Explicit
wipe avoids the footgun.

1. **Pre-flight on incoming-prod**: confirm its image is current (`docker image inspect irina:5000/workbench:latest`) and the container has been built/deployed with the code you intend to ship.
2. **Quiesce outgoing-prod** (UI-side, no container action): finalize work, close every workbench tab except the one driving the swap.
3. **Stop the incoming-prod container** (only this one, briefly — releases file locks and SQLite handles before the wipe):
   ```bash
   ssh <user>@<incoming-prod> "cd /srv/.admin/workbench && docker compose stop workbench"
   ```
4. **Wipe incoming-prod's `/srv/workbench/`** entirely so no residual dev state survives the cutover (stale qdrant lock, leftover test sessions in DB, orphaned CLI session JSONLs, etc.):
   ```bash
   ssh <user>@<incoming-prod> "sudo rm -rf /srv/workbench/* /srv/workbench/.[!.]* /srv/workbench/..?* 2>/dev/null"
   ```
5. **Rsync from outgoing-prod** (which stays running — the WAL/SHM excludes mean we copy the last-checkpointed state, which SQLite recovers from cleanly on first open):
   ```bash
   ssh <user>@<incoming-prod> "rsync -aHAX --delete \\
     --exclude='.blueprint/qdrant/.lock' \\
     --exclude='*.wal' --exclude='*.shm' \\
     blueprint@<outgoing-prod>:/srv/workbench/ /srv/workbench/ && \\
     sudo chown -R 1000:2001 /srv/workbench"
   ```
   (`--delete` is redundant after the wipe but harmless; keep it as belt-and-suspenders.)
6. **Flip incoming-prod's logo to `production`** while its container is still stopped (writes go straight to the SQLite file with no live process holding it):
   ```bash
   ssh <user>@<incoming-prod> "sqlite3 /srv/workbench/.blueprint/blueprint.db \\
     \"INSERT OR REPLACE INTO settings(key, value) VALUES ('logo_variant', '\\\"production\\\"');\""
   ```
7. **Start incoming-prod container** with the seeded data:
   ```bash
   ssh <user>@<incoming-prod> "cd /srv/.admin/workbench && docker compose up -d workbench"
   ```
8. **Verify on incoming-prod**: open it in a browser, confirm red Prod logo, sidebar populates with outgoing-prod's projects/sessions, click into one, send a trivial prompt, get a real reply.
9. **Move your browser to incoming-prod and start working there.** Until step 10 fires, both hosts are showing the Prod logo; the URL you load determines which one you're using.
10. **Demote outgoing-prod to `development`** (live DB write, no container stop — outgoing-prod stays running as the new dev host):
   ```bash
   ssh blueprint@<outgoing-prod> "sqlite3 /srv/workbench/.blueprint/blueprint.db \\
     \"INSERT OR REPLACE INTO settings(key, value) VALUES ('logo_variant', '\\\"development\\\"');\""
   ```

Rollback before step 10: incoming-prod is just a host with the Prod logo that nobody's using; outgoing-prod is unchanged and serving prod normally. Re-flip incoming-prod's logo back to `development` and you're back to the pre-cutover state with no data loss.

Rollback after step 10: both writes are fully reversible — flip the logos back the other way, no data loss either side.

Both A and B are seconds-to-minutes, not hours, when nothing else is changing — they're DB writes plus the rsync. If a cutover is taking longer than that, something else is going on (code change, data path change, schema change) and you're doing more than a swap.

## Workspace Conventions

### Testing project

When using the workbench as a dev environment, designate one workspace directory (e.g., `/data/workspace/testing/`) as the scratch project. Throwaway experiments go there and get periodically cleaned, so dev experimentation doesn't pollute the rest of the workspace.

### Self-reference

A user inside the container may at some point clone the workbench's own repo into `/data/workspace/repos/agentic_workbench/` to work on it. **This is unrelated to the deploy process** — the deploy never reads from `/data/...` to build images. Treat that path purely as a user workspace clone.
