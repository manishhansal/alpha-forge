#!/usr/bin/env bash
# verify-local.sh — Phase 16: Reproducible integration environment
#
# Usage:
#   ./scripts/verify-local.sh [--skip-build] [--skip-e2e] [--stop-after-tests]
#
# This script:
#   1. Starts infrastructure (PostgreSQL + Redis) via docker compose
#   2. Waits for health checks
#   3. Runs database migrations
#   4. Seeds deterministic test fixtures
#   5. (Optional) Starts ML service
#   6. Runs integration tests
#   7. Runs unit tests
#   8. Shuts down safely
#
# Requirements:
#   - Docker and docker compose installed
#   - Node.js 20+ and npm installed
#   - .env.local file with DATABASE_URL and REDIS_URL pointing to local services

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
SKIP_BUILD=false
SKIP_E2E=false
STOP_AFTER_TESTS=false
START_ML_SERVICE=false

for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --skip-e2e) SKIP_E2E=true ;;
    --stop-after-tests) STOP_AFTER_TESTS=true ;;
    --with-ml) START_ML_SERVICE=true ;;
  esac
done

# Colours
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Colour

log_step() { echo -e "${GREEN}[verify-local]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[verify-local WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[verify-local ERROR]${NC} $1"; }

# ── Root directory ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Step 1: Start infrastructure ──────────────────────────────────────────────
log_step "Starting infrastructure (PostgreSQL + Redis)..."
docker compose up -d postgres redis

# ── Step 2: Wait for health checks ───────────────────────────────────────────
log_step "Waiting for PostgreSQL to be healthy..."
RETRIES=30
until docker compose exec -T postgres pg_isready -U crypto -d crypto_dashboard > /dev/null 2>&1; do
  RETRIES=$((RETRIES-1))
  if [ $RETRIES -eq 0 ]; then
    log_error "PostgreSQL did not become healthy in time"
    exit 1
  fi
  sleep 2
done
log_step "PostgreSQL is healthy."

log_step "Waiting for Redis to be healthy..."
RETRIES=30
until docker compose exec -T redis redis-cli ping > /dev/null 2>&1; do
  RETRIES=$((RETRIES-1))
  if [ $RETRIES -eq 0 ]; then
    log_error "Redis did not become healthy in time"
    exit 1
  fi
  sleep 2
done
log_step "Redis is healthy."

# ── Step 3: Run database migrations ──────────────────────────────────────────
log_step "Running database migrations..."
DATABASE_URL="postgresql://crypto:crypto@localhost:5433/crypto_dashboard" \
  npm run db:migrate -- --skip-seed 2>&1 | tail -5 || {
  log_warn "Migration returned non-zero — may already be up to date."
}

# ── Step 4: Seed deterministic fixtures ──────────────────────────────────────
log_step "Seeding test fixtures..."
# The integration seed creates deterministic NSE F&O fixtures for testing.
# Only run if the seed script exists.
if [ -f "prisma/seed-integration.ts" ]; then
  DATABASE_URL="postgresql://crypto:crypto@localhost:5433/crypto_dashboard" \
    npx tsx prisma/seed-integration.ts
else
  log_warn "No integration seed script found (prisma/seed-integration.ts) — skipping"
fi

# ── Step 5: Optional ML service ──────────────────────────────────────────────
if [ "$START_ML_SERVICE" = true ]; then
  log_step "Starting ML service..."
  docker compose up -d ml-service
  log_step "Waiting for ML service health check (up to 60s)..."
  RETRIES=20
  until curl -sf http://localhost:8100/health > /dev/null 2>&1; do
    RETRIES=$((RETRIES-1))
    if [ $RETRIES -eq 0 ]; then
      log_warn "ML service did not become healthy — continuing with ML_MODE=fallback"
      break
    fi
    sleep 3
  done
fi

# ── Step 6: Run unit + integration tests ─────────────────────────────────────
log_step "Running unit and integration tests..."
if ! DATABASE_URL="postgresql://crypto:crypto@localhost:5433/crypto_dashboard" \
     REDIS_URL="redis://localhost:6379" \
     ML_MODE="fallback" \
     npm test -- --run 2>&1 | tee /tmp/alphaforge-test-results.txt; then
  log_error "Unit tests FAILED"
  cat /tmp/alphaforge-test-results.txt | grep -E "(FAIL|ERROR)" | head -20
  EXIT_CODE=1
else
  log_step "Unit tests PASSED."
  EXIT_CODE=0
fi

# ── Step 7: E2E tests (optional) ─────────────────────────────────────────────
if [ "$SKIP_E2E" = false ]; then
  log_step "Running E2E smoke tests..."
  if ! npx playwright test --grep @smoke 2>&1 | tee /tmp/alphaforge-e2e-results.txt; then
    log_warn "E2E tests failed (non-blocking)"
  else
    log_step "E2E smoke tests PASSED."
  fi
fi

# ── Step 8: Shutdown ──────────────────────────────────────────────────────────
if [ "$STOP_AFTER_TESTS" = true ]; then
  log_step "Stopping infrastructure..."
  docker compose stop postgres redis
  if [ "$START_ML_SERVICE" = true ]; then
    docker compose stop ml-service
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  ✅ AlphaForge local verification PASSED       ${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
else
  echo -e "${RED}═══════════════════════════════════════════════${NC}"
  echo -e "${RED}  ❌ AlphaForge local verification FAILED       ${NC}"
  echo -e "${RED}═══════════════════════════════════════════════${NC}"
  echo ""
  echo "Test results: /tmp/alphaforge-test-results.txt"
fi

exit $EXIT_CODE
