# Workbench Production Upgrade Guide

Standard procedure for upgrading a Workbench production instance. Follow every step in order.

---

## Pre-Upgrade Checklist

Before starting, confirm:

- [ ] All changes are committed and pushed to the branch
- [ ] Changes have been tested on a test environment (M5 or similar) with passing Phase 13 tests
- [ ] You know the current container name, image name, port mapping, and volume mounts
- [ ] You have SSH access to the production host
- [ ] You know the git remote name on the prod host (may differ from `origin`)

Gather this info:
```bash
ssh <user>@<host>
docker inspect <container> --format '{{.Config.Image}}'
docker port <container>
docker inspect <container> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
docker inspect <container> --format '{{.HostConfig.RestartPolicy.Name}}'
cd <git-repo-path> && git remote -v && git branch --show-current && git log --oneline -1
```

---

## Step 1: Backup

Always backup before touching anything. Both the data volume and the Docker image.

```bash
# Create dated backup directory
mkdir -p /mnt/storage/backups/blueprint/<YYYY-MM-DD>

# Backup persistent data volume
tar -czf /mnt/storage/backups/blueprint/<YYYY-MM-DD>/data-backup.tar.gz -C <volume-host-path-parent> <volume-dir-name>

# Backup current Docker image
docker save <image-name> -o /mnt/storage/backups/blueprint/<YYYY-MM-DD>/image-backup.tar

# Verify
ls -lh /mnt/storage/backups/blueprint/<YYYY-MM-DD>/
```

**Do not proceed until both backups exist and have reasonable sizes.**

---

## Step 2: Pull Latest Code

```bash
# From your dev machine: push everything
git push origin <branch>

# On the prod host: pull
cd <git-repo-path>
git pull <remote> <branch>
# Verify
git log --oneline -3
```

**Note:** The git remote on the prod host may not be `origin`. Check with `git remote -v` and use the correct remote name.

---

## Step 3: Build New Image

```bash
cd <git-repo-path>
docker build -t <image-name> .
```

Wait for the build to complete. Verify it says "Successfully tagged."

---

## Step 4: Replace Container

```bash
docker stop <container-name>
docker rm <container-name>
docker run -d --name <container-name> \
  --restart unless-stopped \
  -p <external-port>:<internal-port> \
  -v <data-volume-host>:/data \
  -v <storage-volume-host>:/mnt/storage \
  <image-name>
```

**Important:**
- Include `--restart unless-stopped` to match the original restart policy
- Internal port is set by `ENV PORT` in the Dockerfile (currently 7860)
- Preserve the exact same volume mounts as the original container

---

## Step 5: Verify Health

```bash
# Wait 15 seconds for startup
sleep 15
curl -s http://localhost:<external-port>/health
```

Expected: `{"status":"ok","dependencies":{"db":"healthy","workspace":"healthy","auth":"healthy"}}`

If auth is "degraded", Claude credentials may need a `/login` refresh — that's not a blocker.

---

## Step 6: Post-Upgrade Data Fixes

Run any one-time data migrations needed for the new code. Check the commit log for known issues.

**Common fixes:**

```bash
# Clear poisoned Codex cli_session_ids (if upgrading from pre-#152 code)
docker exec <container> sqlite3 /data/.blueprint/blueprint.db \
  "UPDATE sessions SET cli_session_id = NULL WHERE cli_type = 'codex' AND length(cli_session_id) < 10;"

# Clear Gemini cli_session_ids (if upgrading from pre-#152 code)
docker exec <container> sqlite3 /data/.blueprint/blueprint.db \
  "UPDATE sessions SET cli_session_id = NULL WHERE cli_type = 'gemini';"
```

---

## Step 7: Verify API Keys and MCP

```bash
# Check CLI credentials are loaded
curl -s http://localhost:<external-port>/api/cli-credentials
# Expected: {"gemini":true,"openai":true}

# If missing, set via Settings API:
curl -X PUT http://localhost:<external-port>/api/settings \
  -H "Content-Type: application/json" \
  -d '{"key":"gemini_api_key","value":"<key>"}'

curl -X PUT http://localhost:<external-port>/api/settings \
  -H "Content-Type: application/json" \
  -d '{"key":"codex_api_key","value":"<key>"}'

# Verify MCP registered for all 3 CLIs
docker exec <container> grep blueprint /data/.claude/settings.json
docker exec <container> grep blueprint /data/.gemini/settings.json
docker exec <container> grep blueprint /data/.codex/config.toml
```

---

## Step 8: Smoke Test

Open the UI in a browser and verify:

1. Sidebar renders with all existing projects and sessions
2. Click 3 different sessions — they open without reconnect loops
3. Status bar shows correct model for each CLI type
4. Send a message in a Claude session — verify response

---

## Step 9: Run Regression Tests

Launch an independent Sonnet session to run the Phase 13 tests:

```bash
tmux new-session -d -s upgrade-test -x 200 -y 50
tmux send-keys -t upgrade-test "claude --model sonnet --dangerously-skip-permissions" Enter
# Wait for startup, then send test instructions via load-buffer
```

The test must:
- Create sessions for all 3 CLI types
- Chat with each CLI and verify correct responses (not just buffer text)
- Verify status bar, sidebar, MCP, and settings

**The upgrade is not complete until tests pass.**

---

## Rollback Procedure

If anything goes wrong:

```bash
# Stop the new container
docker stop <container-name> && docker rm <container-name>

# Restore the old image
docker load -i /mnt/storage/backups/blueprint/<YYYY-MM-DD>/image-backup.tar

# Restore data if corruption occurred
tar -xzf /mnt/storage/backups/blueprint/<YYYY-MM-DD>/data-backup.tar.gz -C <volume-host-path-parent>

# Restart with old image
docker run -d --name <container-name> \
  --restart unless-stopped \
  -p <external-port>:<internal-port> \
  -v <data-volume-host>:/data \
  -v <storage-volume-host>:/mnt/storage \
  <image-name>
```

---

## What Survives an Upgrade

Everything on the `/data` volume persists across container rebuilds:
- Database (sessions, settings, tasks)
- Claude/Gemini/Codex credentials and session files
- SSH keys and config
- Workspace projects and documents
- Qdrant vector data
- Persistently installed packages (`/data/.local/`)

**What does NOT survive:** Anything installed in the container filesystem outside `/data` (e.g., `apt-get install` packages). Add those to the Dockerfile.

---

## Production Instance Reference

| Field | Prod1 (irina) |
|-------|---------------|
| Host | 192.168.1.110 |
| SSH user | aristotle9 |
| Container | blueprint-prod1 |
| Image | blueprint-prod |
| External port | 6343 |
| Internal port | 7860 |
| Data volume | /mnt/workspace/blueprint → /data |
| Storage volume | /mnt/storage → /mnt/storage |
| Git repo | /mnt/storage/projects/blueprint |
| Git remote | rmdevpro (not origin) |
| Branch | huggingface-space |
