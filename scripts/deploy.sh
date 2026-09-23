#!/usr/bin/env bash
# =============================================================================
# deploy.sh — AlphaForge auto-rebuild & redeploy
#
# Usage:
#   ./scripts/deploy.sh            # rebuild app + worker
#   ./scripts/deploy.sh app        # rebuild app only
#   ./scripts/deploy.sh worker     # rebuild worker only
#   ./scripts/deploy.sh ml         # rebuild ml-service only (via compose)
#   ./scripts/deploy.sh all        # rebuild everything including ml-service
#
# Called automatically by:
#   - git post-commit hook  (scripts/git-hooks/post-commit)
#   - make deploy / make watch-deploy
# =============================================================================

set -euo pipefail

# ── Resolve project root (works regardless of cwd) ──────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${PROJECT_ROOT}/scripts/deploy.log"

# ── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[deploy]${RESET} $*" | tee -a "$LOG_FILE"; }
ok()   { echo -e "${GREEN}[deploy] ✓${RESET} $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[deploy] ⚠${RESET} $*" | tee -a "$LOG_FILE"; }
fail() { echo -e "${RED}[deploy] ✗${RESET} $*" | tee -a "$LOG_FILE"; exit 1; }

# ── Config (mirrors Makefile) ────────────────────────────────────────────────
APP_IMAGE="alpha-forge-app-local"
WORKER_IMAGE="alpha-forge-worker-local"
APP_CONTAINER="alpha-forge-app"
WORKER_CONTAINER="alpha-forge-worker"
NETWORK="alpha-forge_alphaforge"

ENV_FLAGS=(
  --env-file .env.docker
  --env-file .env.local
  -e DATA_SERVICE_URL=http://host.docker.internal:8200
  -e DATA_SERVICE_2_URL=http://host.docker.internal:8200
  -e NEXT_PUBLIC_DATA_SERVICE_URL=http://localhost:8200
  -e DATABASE_URL=postgresql://crypto:crypto@postgres:5432/crypto_dashboard
  -e REDIS_URL=redis://redis:6379
  -e ML_SERVICE_URL=http://ml-service:8100
  -e ALERT_EMAIL_FROM=alerts@alphaforge.local
)

DOCKER_RUN_BASE=(
  docker run -d
  --network "$NETWORK"
  --add-host=host.docker.internal:host-gateway
  "${ENV_FLAGS[@]}"
)

# ── Helpers ──────────────────────────────────────────────────────────────────
timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

require_docker() {
  docker info &>/dev/null || fail "Docker is not running. Start Docker Desktop first."
}

container_running() {
  docker ps --format '{{.Names}}' | grep -q "^${1}$"
}

stop_and_remove() {
  local name="$1"
  if container_running "$name"; then
    log "Stopping ${name}…"
    docker stop "$name" &>/dev/null || true
  fi
  docker rm "$name" &>/dev/null || true
}

# ── Build functions ──────────────────────────────────────────────────────────
build_app() {
  log "Building app image (${APP_IMAGE})…"
  docker build -f Dockerfile.app -t "$APP_IMAGE" "$PROJECT_ROOT" \
    || fail "App build failed"
}

start_app() {
  stop_and_remove "$APP_CONTAINER"
  log "Starting app container…"
  "${DOCKER_RUN_BASE[@]}" \
    --name "$APP_CONTAINER" \
    -p 3000:3000 \
    -e SENTINEL_PULSE_URL=http://host.docker.internal:3001 \
    "$APP_IMAGE" &>/dev/null
  ok "App live → http://localhost:3000"
}

build_worker() {
  log "Building worker image (${WORKER_IMAGE})…"
  docker build -f Dockerfile.worker -t "$WORKER_IMAGE" "$PROJECT_ROOT" \
    || fail "Worker build failed"
}

start_worker() {
  stop_and_remove "$WORKER_CONTAINER"
  log "Starting worker container…"
  "${DOCKER_RUN_BASE[@]}" \
    --name "$WORKER_CONTAINER" \
    -e WORKER_APP_BASE_URL=http://${APP_CONTAINER}:3000 \
    "$WORKER_IMAGE" &>/dev/null
  ok "Worker running"
}

build_ml() {
  log "Rebuilding ml-service via docker compose…"
  docker compose -f "${PROJECT_ROOT}/docker-compose.yml" \
    build ml-service \
    || fail "ML service build failed"
  docker compose -f "${PROJECT_ROOT}/docker-compose.yml" \
    up -d --no-deps ml-service \
    || fail "ML service restart failed"
  ok "ML service restarted"
}

# ── Main ─────────────────────────────────────────────────────────────────────
cd "$PROJECT_ROOT"

echo "" >> "$LOG_FILE"
echo "======================================" >> "$LOG_FILE"
echo "  Deploy run: $(timestamp)" >> "$LOG_FILE"
echo "  Target: ${1:-all-app-worker}" >> "$LOG_FILE"
echo "======================================" >> "$LOG_FILE"

require_docker

TARGET="${1:-}"   # app | worker | ml | all | (empty = app+worker)

case "$TARGET" in
  app)
    log "$(timestamp) — Deploying app…"
    build_app
    start_app
    ;;
  worker)
    log "$(timestamp) — Deploying worker…"
    build_worker
    start_worker
    ;;
  ml)
    log "$(timestamp) — Deploying ml-service…"
    build_ml
    ;;
  all)
    log "$(timestamp) — Deploying all services…"
    build_app
    build_worker
    build_ml
    start_app
    start_worker
    ;;
  *)
    # Default: rebuild app + worker (most common on code push)
    log "$(timestamp) — Deploying app + worker…"
    build_app
    build_worker
    start_app
    start_worker
    ;;
esac

ok "Deploy complete at $(timestamp)"
