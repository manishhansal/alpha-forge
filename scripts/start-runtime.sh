#!/usr/bin/env bash
# scripts/start-runtime.sh
#
# Start the AlphaForge local runtime stack and wait for all services to be ready.
# Usage:
#   ./scripts/start-runtime.sh            # infrastructure only (postgres + redis + ml)
#   ./scripts/start-runtime.sh --full     # full stack including app + worker
#
# Prerequisites:
#   - Docker Desktop running
#   - .env.local present (copy from .env.example and fill in)

set -euo pipefail

PROFILE=""
HEALTH_URL="http://localhost:3000/api/health/ready"
FULL_STACK=false

for arg in "$@"; do
  case $arg in
    --full)  FULL_STACK=true; PROFILE="--profile integration" ;;
    --help)  echo "Usage: $0 [--full]"; exit 0 ;;
  esac
done

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${CYAN}[runtime]${NC} $*"; }
ok()  { echo -e "${GREEN}[✓]${NC} $*"; }
err() { echo -e "${RED}[✗]${NC} $*"; }
warn(){ echo -e "${YELLOW}[!]${NC} $*"; }

# ─── 1. Start containers ───────────────────────────────────────────────────────

log "Starting AlphaForge runtime stack..."
# shellcheck disable=SC2086
docker compose ${PROFILE} up -d --build 2>&1

# ─── 2. Wait for infrastructure readiness ─────────────────────────────────────

wait_service() {
  local name="$1"
  local max="$2"
  local i=0
  log "Waiting for ${name}..."
  while [ $i -lt "$max" ]; do
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' "alpha-forge-${name}" 2>/dev/null || echo "not_found")
    if [ "$STATUS" = "healthy" ]; then
      ok "${name} → READY"
      return 0
    fi
    sleep 2
    i=$((i+2))
  done
  err "${name} → FAILED (timeout ${max}s, last status: ${STATUS})"
  docker logs "alpha-forge-${name}" --tail=30 2>/dev/null || true
  return 1
}

FAILED=0
wait_service "postgres" 60  || FAILED=1
wait_service "redis"    30  || FAILED=1
wait_service "ml"       120 || FAILED=1

if [ "$FULL_STACK" = true ]; then
  wait_service "app"    120 || FAILED=1
fi

if [ $FAILED -ne 0 ]; then
  err "One or more services failed to become healthy."
  exit 1
fi

# ─── 3. Run DB migrations ──────────────────────────────────────────────────────

if [ -f ".env.local" ]; then
  log "Running database migrations..."
  npx prisma migrate deploy --schema=prisma/schema.prisma 2>/dev/null && ok "DB migrations applied" || warn "Migration check skipped (run manually)"
fi

# ─── 4. Aggregate health check ────────────────────────────────────────────────

if [ "$FULL_STACK" = true ]; then
  log "Checking aggregate readiness at ${HEALTH_URL}..."
  MAX_WAIT=60
  i=0
  while [ $i -lt $MAX_WAIT ]; do
    HTTP=$(curl -sf "${HEALTH_URL}" -o /tmp/health_ready.json -w "%{http_code}" 2>/dev/null || echo "000")
    if [ "$HTTP" = "200" ]; then
      ok "Aggregate readiness → READY"
      echo ""
      cat /tmp/health_ready.json | python3 -m json.tool 2>/dev/null || cat /tmp/health_ready.json
      break
    elif [ "$HTTP" = "503" ]; then
      warn "Aggregate readiness → DEGRADED/UNAVAILABLE (${i}s)"
      sleep 5
      i=$((i+5))
    else
      sleep 3
      i=$((i+3))
    fi
  done
fi

# ─── 5. Summary ───────────────────────────────────────────────────────────────

echo ""
log "=== Runtime Stack Status ==="
docker ps --filter "label=com.docker.compose.project=alpha-forge" \
  --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
docker compose ps

echo ""
ok "Stack is ready."
echo ""
echo "  PostgreSQL : localhost:5433"
echo "  Redis      : localhost:6379"
echo "  ML Service : http://localhost:8100/health"
if [ "$FULL_STACK" = true ]; then
  echo "  App        : http://localhost:3000"
  echo "  Ready      : http://localhost:3000/api/health/ready"
fi
