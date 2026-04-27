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

HF Space deployment is fully separate from the Admin-repo compose-override pipeline. Same image, same code; the Space-side runtime is owned by HF.

### What HF gets vs what GitHub holds

GitHub `main` is the canonical source of truth and holds full development history. HF Space repositories are deploy targets — they hold only the **current snapshot** of the workbench, with no concept of (or need for) GitHub's history. This intentional separation matters because HF's pre-receive hook scans every binary blob in any git push and rejects PNGs/binaries above its size threshold without LFS — so pushing GitHub's full history (including blobs from old commits that no longer exist in HEAD) reliably fails. The deploy mechanism therefore **does not use `git push`** — it uses HF's file-upload API.

### Deploy mechanism: `hf upload`

Prerequisites (one-time):

```bash
pip3 install --user --break-system-packages huggingface_hub
export PATH=~/.local/bin:$PATH
export HF_TOKEN=<your-hf-token>   # write scope; from /mnt/storage/credentials/api-keys/huggingface.env
```

Per-deploy procedure:

```bash
cd /data/workspace/repos/agentic-workbench

# Stage only tracked files into a clean directory (no node_modules, no .git, no junk).
rm -rf /tmp/hf-deploy
mkdir -p /tmp/hf-deploy
git archive HEAD | tar -x -C /tmp/hf-deploy

# Upload. --delete '*' makes it a true sync (removes Space-side files not in staging).
hf upload <space-id> /tmp/hf-deploy . --repo-type space \
  --commit-message "Deploy snapshot of main@$(git rev-parse --short=12 main)" \
  --delete '*'
```

`<space-id>` is e.g. `aristotle9/agentic-workbench`. HF makes one new commit on the Space's repo containing the snapshot, then auto-rebuilds the Docker image. Build typically completes in 1–2 minutes; poll `https://huggingface.co/api/spaces/<space-id>` for `runtime.stage == RUNNING`.

**No clone of the HF Space repo is needed**, no `.gitattributes`, no LFS, no force push, no rename of files at deploy time, no separate branches in either repo.

### Two-Space pattern

Deploy the same content to two Spaces with different Space-level Secrets to get two distinct user experiences from one image:

| Space | URL | Secrets | Auth mode (auto-detected) | Use |
|---|---|---|---|---|
| `aristotle9/agentic-workbench` | https://aristotle9-agentic-workbench.hf.space | (none) | `template` | Public landing — duplicate-me gate; if a visitor duplicates as a private Space they get full access |
| `aristotle9/agentic-workbench-test` | https://aristotle9-agentic-workbench-test.hf.space | `BLUEPRINT_USER`, `BLUEPRINT_PASS` | `password` | Login-gated test deploy — for verifying changes against a real HF deployment |

Auth-mode detection logic lives in `server.js:detectAuthMode()` — password mode wins over public-Space template mode when both creds are set.

Set or remove Secrets via HF API:

```bash
# Set
curl -sX POST "https://huggingface.co/api/spaces/<space-id>/secrets" \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"BLUEPRINT_USER","value":"<username>"}'

# Remove
curl -sX DELETE "https://huggingface.co/api/spaces/<space-id>/secrets" \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"BLUEPRINT_USER"}'

# Restart to pick up env changes
curl -sX POST "https://huggingface.co/api/spaces/<space-id>/restart" \
  -H "Authorization: Bearer $HF_TOKEN"
```

### Persistent storage

HF provides a persistent volume at `/data` when persistent storage is enabled in the Space settings (HF web UI → Settings → Persistent storage). Without it, the SQLite DB, qdrant collections, session JSONLs, and workspace all wipe on every Space restart. Recommended for any Space that's used beyond a one-off demo.

### README.md is the HF cardData

The Space's `README.md` carries the HF Space metadata (frontmatter: `title`, `sdk`, `app_port`, etc.) — HF's docker SDK reads this to know how to build and serve the Space. The canonical `README.md` in the GitHub repo includes this frontmatter at the top, so the same file works for both GitHub readers and HF. Don't keep a separate `README.huggingface.md` — that's the historical hack that complicated deploys.

### Logo variant

A Space's `logo_variant` setting is typically left at `default` (canonical blue lockup). Override only if the Space is a designated dev or prod for some user-facing purpose; for marketing/test deploys the default is correct.

### Per-deploy auth setup (Hymie, one-time per deploy)

HF deploys are rare; spend the manual time per deploy to set up auth properly. **HF Spaces here run without persistent storage** — every `hf upload` triggers a Docker rebuild that wipes `/data`, including all CLI auth. So auth has to be re-established after every deploy.

Use Hymie (or Hymie2) to drive a real Firefox session. Steps (one-time per deploy, on the **password test Space**):

1. **Open the test Space** in Hymie's Firefox: `https://aristotle9-agentic-workbench-test.hf.space/` — login form appears (gate is in `password` mode because Space Secrets are set).
2. **Log in** with the gate creds (`aristotle9` / `Vault2011$` from `/mnt/storage/credentials/api-keys/huggingface.env`). Workbench shell appears with "Not authenticated — open any session and run `/login`" warning at top.
3. **Open Settings → API KEYS section.**
   - Paste the Gemini API key (from `/mnt/storage/credentials/api-keys/gemini.env`) into "Gemini API Key".
   - Paste the OpenAI key (from `/mnt/storage/credentials/api-keys/openai.env`) into "OpenAI / Codex API Key" (Codex CLI uses the OpenAI key).
   - Close Settings (auto-save on blur).
4. **Create a project** (sidebar `+` → pick a folder under `/data/workspace`, e.g. `docs`).
5. **Create a Claude session** (project header `+` → CLAUDE → enter any prompt like "say hello" → Start Session).
6. **In the Claude tab, run `/login`** → menu appears → press Enter to select option 1 ("Claude account with subscription"). Two parallel UI channels appear:
   - The Workbench **gate modal** ("Authentication Required") — **this is the designed path**.
   - The CLI's own terminal prompt: `Paste code here if prompted >` — **ignore this entirely**.
7. **Click "Authenticate with Claude"** in the modal → opens the OAuth tab on `claude.ai`.
8. **Authorize** → redirected to `platform.claude.com/oauth/code/callback` with the auth code displayed → click "Copy Code".
9. **Switch back to the test Space tab**, paste the code in the modal's input field, click Submit. Modal closes; the "Not authenticated" warning at top disappears.

**Known bug (#184):** the modal Submit successfully sets up Workbench-side auth but does NOT advance the running CLI session out of its `/login` prompt — the CLI sits at `Paste code here if prompted >` indefinitely. Until that's fixed, **close and recreate the Claude session after the modal Submit completes.** The new session will pick up the freshly-written `~/.claude/.credentials.json` and start authenticated.

10. **Confirm Claude is authenticated** by creating a new Claude session — it should show "Welcome back …" and the workbench-top warning should be gone.

After this, Hymie can be closed. **Switch to Playwright for the verification suite.**

### Verification suite (Playwright, every deploy)

Run **as a user would** via Playwright — actually navigate, click, type, screenshot, observe. Do not script `browser_evaluate` calls reading the DOM as a substitute for user actions; the runbook entries are descriptions of what a user does, not copy-paste scripts.

Eight tests, ~10 min total:

| # | ID | Where to run | What it covers | Notes |
|---|---|---|---|---|
| 1 | **GATE-MKT-01** (HF-deploy-specific) | Marketing Space (no creds) | Page loads; `__GATE_MODE__ === 'template'`; `planlogo.png` renders (not broken-image); `workbench-preview.png` background renders; "Duplicate this Space" button present | No login required |
| 2 | **GATE-LOGIN-01** (HF-deploy-specific) | Test Space (creds set) | Page loads; `__GATE_MODE__ === 'password'`; login form rendered with username + password fields; planlogo visible | No login required |
| 3 | **GATE-LOGIN-02** (HF-deploy-specific) | Test Space | Submit valid creds → redirected past gate; full app shell visible (sidebar, status bar, panel toggles) | Uses gate creds |
| 4 | **SMOKE-01** (`tests/workbench-test-runbook.md` Phase 1) | Test Space (post-login) | Page title "Blueprint"; sidebar present; project list populates; settings modal hidden | |
| 5 | **SMOKE-02** (Phase 1) | Test Space | `.project-group` count matches `/api/state` projects; active filter selected by default | |
| 6 | **SMOKE-03** (Phase 1) | Test Space | `/health` returns ok; `/api/auth/status` returns valid; `/api/mounts` returns array | |
| 7 | **USR-05** (Phase 7) | Test Space | Open Files panel, expand a mount, click into a directory, file tree renders | |
| 8 | **REG-148-01** (`tests/workbench-test-runbook.md` REG-148-01, P0) | Test Space | Create one Claude + one Gemini + one Codex session in the same project; for 5 rounds, click each tab → send a verifiable message ("what is 7 times 8") → wait 10s → confirm CLI responded with the correct answer (not just echoed input). | Requires Hymie auth setup above to be complete. |

REG-148-01 is the definitive functional check — runbook is explicit that "clicking tabs is NOT enough; you must chat with each CLI and verify it responds." Failure criteria are strict (any 401, blank response, login screen, piled-up input, or wrong-CLI content = FAIL).

If REG-148-01 fails because a CLI shows a login prompt or 401, the per-deploy Hymie auth step (above) was incomplete — go redo it.

### What NOT to do

- **Do not `git push` to the HF Space repo.** GitHub history will be rejected (per the size-threshold issue above) or, worse, will accidentally remove `public/*.png` if the local working tree has the historical `*.png` gitignore rule active.
- **Do not maintain a clone of the HF Space repo.** Earlier deploys did this and accumulated stale LFS hooks in `.git/config` that silently converted PNGs to pointer files. The `hf upload` mechanism does not need a clone.
- **Do not introduce LFS for `public/*.png`.** They're under HF's API-path size threshold and ship as regular blobs without complication. LFS only adds friction (need `git lfs pull` in the Dockerfile or HF won't resolve pointer files into the build context).
- **Do not split the HF README from the canonical README.** One file with HF frontmatter at the top serves both audiences.
- **Do not paste the OAuth code into the Claude CLI's `/login` prompt** when the gate modal is also showing. The modal is the designed path; the CLI prompt is a parallel channel that races for the same single-use code. Using both will break one or the other (#184). Modal-only.
- **Do not assume the modal Submit advances the live CLI.** Per #184, it doesn't. Close + recreate any Claude session that was mid-`/login` when you completed the modal.
- **Do not OAuth into the wrong Workbench** when copying the auth code back. If you have multiple Workbench tabs open in the same Hymie browser (e.g. both irina prod at `192.168.1.110:7860` AND the HF test Space), check the URL bar before pasting — the auth code is single-use and will land wherever you submit it first.

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
