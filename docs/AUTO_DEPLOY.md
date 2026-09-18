# AlphaForge — Auto-Rebuild & Redeploy System

Every `git commit` automatically rebuilds and restarts the affected Docker
services. No manual `make rebuild-*` needed during normal development.

---

## How It Works

```
git commit
    │
    └─► .git/hooks/post-commit          ← installed by make install-hooks
            │
            ├─ diffs changed files
            ├─ decides which services are affected
            └─► scripts/deploy.sh [target]
                    │
                    ├─ docker build …    ← rebuilds image(s)
                    ├─ docker stop/rm …  ← tears down old container
                    └─ docker run …      ← starts new container
                            │
                            └─► scripts/deploy.log  ← append-only log
```

### Smart diff logic

| Changed path | Services rebuilt |
|---|---|
| `src/**`, `public/**`, `Dockerfile.app`, `package*.json`, `next.config.*` | app + worker |
| `worker/src/**`, `Dockerfile.worker` | worker |
| `ml-service/**` | ml-service (via docker compose) |
| `docker-compose.yml`, `.env.docker` | app + worker |
| `docs/**`, `*.md`, `coverage/**` | *(nothing — skipped)* |

---

## First-Time Setup

Run once per clone to wire up the git hook:

```bash
make install-hooks
```

That's it. From this point on, every commit triggers a redeploy.

---

## Manual Commands

| Command | What it does |
|---|---|
| `make deploy` | Rebuild + redeploy app & worker right now |
| `make deploy-app` | App only |
| `make deploy-worker` | Worker only |
| `make deploy-ml` | ML service only |
| `make deploy-all` | All three services |
| `make deploy-log` | Tail the live deploy log |
| `make watch-deploy` | File-watcher mode — redeploy on any `src/` change |
| `make install-hooks` | (Re-)install the git hook |

You can also call the deploy script directly:

```bash
bash scripts/deploy.sh           # app + worker
bash scripts/deploy.sh app
bash scripts/deploy.sh worker
bash scripts/deploy.sh ml
bash scripts/deploy.sh all
```

---

## Skipping a Redeploy

If you need to commit without triggering a rebuild (e.g. docs-only changes
that the diff logic doesn't catch, or a fast iteration where you'll rebuild
manually):

```bash
SKIP_DEPLOY=1 git commit -m "docs: update readme"
```

---

## File-Watcher Mode

For tight inner-loop development without committing:

```bash
# Requires fswatch (one-time install)
brew install fswatch

make watch-deploy
```

Every time a file in `src/`, `public/`, `Dockerfile.app`, or `Dockerfile.worker`
changes on disk, the affected containers are rebuilt automatically.

---

## Logs

All deploy runs append to `scripts/deploy.log`:

```bash
make deploy-log          # live tail
tail -100 scripts/deploy.log   # last 100 lines
```

---

## Files Added

```
scripts/
├── deploy.sh              ← core rebuild + redeploy logic
├── install-hooks.sh       ← one-command git hook installer
├── deploy.log             ← append-only deploy history (auto-created)
└── git-hooks/
    └── post-commit        ← source-controlled hook (copied to .git/hooks/)

.kiro/hooks/
└── docker-redeploy-on-commit.json   ← Kiro IDE hook (surfaces deploy.log in chat)
```

---

## Requirements

| Tool | Notes |
|---|---|
| Docker Desktop | Must be running for deploys to fire |
| Git | Hook fires on `git commit` |
| `fswatch` | Only needed for `make watch-deploy` (`brew install fswatch`) |
| bash ≥ 3 | Ships with macOS |
