# AlphaForge

A professional, multi-market trading desk for **Crypto** and **Indian NSE F&O** — built with Next.js, a Python ML microservice, and an institutional-grade research platform.

---

## What It Is

AlphaForge runs two fully independent trading surfaces in one shell, toggled by a sidebar switcher:

- **Crypto** — BTC · ETH · SOL via Delta Exchange India (default) or Binance. Futures analytics, options chain, AI signals, 10 scalping strategies, strategy backtest, conversational strategy lab, and paper trading.
- **Indian F&O (NSE)** — Full sidebar parity with the crypto surface. NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY + 200+ F&O stocks. Live option chain, 9 F&O strategies, AI signals with real-time derivatives context, Daily Picks, FnO trend scanners, intelligent auto paper-trading engine, trade history, Signal Center, WhatsApp notifications, an evidence-driven quant research platform, and per-user Upstox Analytics API credential configuration.

The URL is the source of truth — `/` is Crypto, `/in/*` is Indian Market.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | **Next.js** (App Router, Turbopack) + **React 19** + TypeScript |
| Styling | **TailwindCSS v4** — OKLCH design token system |
| Client State | **Zustand v5** (UIStore + market-scoped stores, localStorage persist) |
| Server State | **TanStack Query v5** |
| Tables | **TanStack Table v9** (Options Chain, AI Radar, Journal, Daily Picks History) |
| Charts | **lightweight-charts v5** + custom Anchored VWAP + Volume Profile plugins; Recharts |
| Animation | **Framer Motion** (4 named Spring presets: MICRO / FAST / DEFAULT / GENTLE) |
| Validation | **Zod v4** on every external input and env var |
| Cache | **Redis** via ioredis (in-memory fallback for dev) |
| Database | **PostgreSQL 17** + **Prisma 7** (driver-adapter pattern) |
| Realtime | data-service2.0 WebSocket `/v1/stream/ticks` (authenticated via `X-API-KEY` / `?api_key=`) |
| ML Engine | **Python 3.11** + FastAPI + XGBoost + LightGBM + CatBoost + PPO (SB3) + SHAP + Riskfolio-Lib + TA-Lib + mibian |
| Market Data | **data-service2.0** — dedicated Python FastAPI service (port 8200), runs as a separate Docker Compose stack |

---

## Services Overview

AlphaForge is composed of two Docker Compose stacks:

### Stack 1 — data-service2.0 (external, always running)

The canonical market data platform. All live quotes, tick streams, option chains, historical OHLCV, and crypto liquidation feeds flow through here.

| Container | Image | Port |
|---|---|---|
| `data-service-api` | `data-service:2.0.0` | `8200` |
| `data-service-postgres` | `timescale/timescaledb:latest-pg15` | `5444` |
| `data-service-redis` | `redis:7-alpine` | — (internal) |

### Stack 2 — AlphaForge (this repo)

| Container | Image | Port |
|---|---|---|
| `alpha-forge-postgres` | `postgres:17` | `5433` |
| `alpha-forge-redis` | `redis:7` | `6379` |
| `alpha-forge-ml` | `alpha-forge-ml-service` | `8100` |
| `alpha-forge-app` | `alpha-forge-app` | `3000` |
| `alpha-forge-worker` | `alpha-forge-worker` | — |

`app` and `worker` are under the `integration` profile — they require a Docker build and are not started by default with `docker compose up`.

---

## Quick Start (Local Dev)

You need **Node.js ≥ 20.9**, **Docker Desktop**, and the **data-service2.0** stack already running on port 8200.

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis + ML service
npm run docker:up

# 3. Copy env template and fill in secrets
cp .env.example .env.local

# 4. Generate required secrets
npx auth secret                                                             # → AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → ENCRYPTION_KEY

# 5. Set data-service2.0 connection in .env.local
# DATA_SERVICE_URL=http://localhost:8200
# DATA_SERVICE_API_KEY=<your-key>                # must match CONSUMER_API_KEYS in data-service2.0
# NEXT_PUBLIC_DATA_SERVICE_URL=http://localhost:8200
# NEXT_PUBLIC_DATA_SERVICE_API_KEY=<your-key>    # same key — needed for browser WebSocket auth

# 5a. (Optional) SentinelPulse news service
# SENTINEL_PULSE_URL=http://localhost:3001
# SENTINEL_PULSE_API_KEY=<your-key>

# 6. Run the first DB migration
npm run db:migrate -- --name init

# 7. Start the dev server
npm run dev

# 8. Start the background worker (separate terminal)
npm run worker:dev

# 9. (Optional) Start the ML service if not already running
docker compose up ml-service -d
```

Or use the one-shot setup (installs deps + starts infra + migrates DB):

```bash
npm run setup
```

Open [http://localhost:3000](http://localhost:3000) and create an account at `/signup`.

---

## Docker Commands

### Infrastructure (Postgres · Redis · ML)

```bash
# Start Postgres, Redis, and ML service
npm run docker:up
# equivalent to: docker compose up -d

# Stop all infra containers
npm run docker:down
# equivalent to: docker compose down

# Stop and wipe all volumes (full reset — destroys DB data)
npm run docker:reset
# equivalent to: docker compose down -v

# Check status of all containers
docker compose ps

# Live logs — all containers
docker compose logs -f

# Live logs — specific services
docker compose logs -f app worker
docker compose logs -f ml-service

# Live logs with timestamps
docker compose logs -f -t

# Last 100 lines then follow
docker compose logs -f --tail=100
```

### App + Worker (integration profile)

`app` and `worker` are built images — they must be rebuilt whenever code changes.

```bash
# Build both images
docker compose build app worker

# Build and start everything (infra + app + worker)
docker compose --profile integration up -d

# Start only app + worker (infra already running)
docker compose --profile integration up -d app worker

# Rebuild then restart (after code changes)
docker compose build app worker && docker compose --profile integration up -d app worker

# Force recreate containers (picks up env changes without rebuild)
docker compose --profile integration up -d --force-recreate app worker

# Stop app + worker only
docker compose stop app worker

# Remove app + worker containers
docker compose rm -f app worker
```

### Useful one-liners

```bash
# Full teardown and restart from scratch
docker compose down && docker compose --profile integration up -d --build

# Tail errors only across all containers
docker compose logs -f 2>&1 | grep -iE "error|warn|403|failed"

# Check which containers are unhealthy
docker compose ps | grep -v "healthy\|running"

# Shell into a running container
docker compose exec app sh
docker compose exec worker sh

# View resource usage
docker stats
```

### data-service2.0 (separate stack)

```bash
# Health check
curl http://localhost:8200/health

# Test WebSocket auth (requires wscat: npm i -g wscat)
wscat -c "ws://localhost:8200/v1/stream/ticks?api_key=dev-key-local-1"

# Or with header
wscat -c ws://localhost:8200/v1/stream/ticks -H "X-API-KEY: dev-key-local-1"

# Live logs
docker logs data-service-api -f

# Check WebSocket 403s are gone
docker logs data-service-api --since 5m 2>&1 | grep -E "stream/ticks|403|accepted"
```

---

## Database Access

AlphaForge has two Postgres instances and two Redis instances — one set for AlphaForge itself, one owned by data-service2.0.

### AlphaForge Postgres (port 5433)

```bash
# Prisma Studio — visual DB browser (recommended)
npm run db:studio

# psql CLI
psql postgresql://crypto:crypto@localhost:5433/crypto_dashboard

# Or via docker exec
docker compose exec postgres psql -U crypto -d crypto_dashboard

# Run a quick query
docker compose exec postgres psql -U crypto -d crypto_dashboard \
  -c "SELECT COUNT(*) FROM \"SignalHistory\";"

# List all tables
docker compose exec postgres psql -U crypto -d crypto_dashboard \
  -c "\dt"
```

### data-service2.0 Postgres / TimescaleDB (port 5444)

```bash
# psql CLI (credentials from data-service2.0 .env)
psql postgresql://<user>:<pass>@localhost:5444/<dbname>

# Or via docker exec
docker exec -it data-service-postgres psql -U <user> -d <dbname>
```

Replace `<user>`, `<pass>`, `<dbname>` with the values from your data-service2.0 `.env`.

### AlphaForge Redis (port 6379)

```bash
# Redis CLI
redis-cli

# Or via docker exec
docker compose exec redis redis-cli

# Useful commands
redis-cli PING                        # should return PONG
redis-cli KEYS "*"                    # list all keys (careful in prod)
redis-cli KEYS "fno-pulse:*"          # India market keys
redis-cli GET "fno-pulse:<key>"
redis-cli MONITOR                     # live stream of all commands
redis-cli INFO stats                  # throughput stats
redis-cli DBSIZE                      # total key count
redis-cli FLUSHDB                     # ⚠️ wipe all keys (dev only)
```

### data-service2.0 Redis (internal, no host port)

Accessible only from inside the data-service2.0 Docker network. To inspect:

```bash
docker exec -it data-service-redis redis-cli

# Check tick pub/sub channels
docker exec -it data-service-redis redis-cli PUBSUB CHANNELS "*"

# Monitor live tick publications
docker exec -it data-service-redis redis-cli SUBSCRIBE "af:ticks:NIFTY"
```

### Prisma Migrations

```bash
# Create and apply a new migration
npm run db:migrate -- --name <migration-name>

# Apply existing migrations to a fresh DB (CI / production)
npm run db:deploy

# Reset DB and re-run all migrations (destroys all data)
npm run db:reset

# Generate Prisma client after schema changes
npm run db:generate
```

---

## Available Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Next.js dev server on :3000 (Turbopack) |
| `npm run build` | Production build — runs full test suite first via `prebuild` |
| `npm run worker:dev` | Background worker (no watcher — low fork pressure) |
| `npm run worker:watch` | Worker with `tsx watch` auto-restart |
| `npm run dev:tdd` | `next dev` + `vitest --watch` in parallel via concurrently |
| `npm run check` | Full pre-PR gate — `lint` + `typecheck` + full test suite |
| `npm test` | Run the full Vitest suite once |
| `npm run test:<layer>` | Per-layer test slices: `lib`, `features`, `components`, `api`, `services`, `hooks`, `stores`, `pages`, `worker` |
| `npm run test:coverage` | v8 coverage → `coverage/` |
| `npm run db:migrate` | Create and apply a DB migration in dev |
| `npm run db:studio` | Open Prisma Studio |
| `npm run docker:up/down/reset` | Manage Postgres + Redis + ML containers |

> **TDD is mandatory.** Write the failing test first, then the implementation. The `prebuild` hook enforces a green suite before every build. When building Docker images, `npx next build` is used directly to skip this hook (tests belong in CI, not image builds).

---

## Architecture Overview

### Frontend

The `(dashboard)` App Router layout hosts both markets inside a shared shell (Topbar, Sidebar, MarketTickerBar). Market-specific code lives in fully isolated directories — no cross-imports between Crypto and India surfaces:

```
src/app/(dashboard)/
  page.tsx              Crypto Overview
  best-time/ options/ signals/ ai-signals/ strategies/ paper-trading/
  strategy-backtest/ strategy-lab/ heatmap/ futures/
  profile/              Consolidated profile page
  in/                   India route group — exact sidebar parity
    dashboard/          NIFTY Pulse + MSB signals + Top Picks
    options/            NSE option chain + IV Surface + GEX tab
    ai-signals/         Multi-confluence F&O AI signals
    daily-picks/        Top-3-per-bucket frozen picks + history
    strategies/         9-strategy picker + live signal feed
    paper-trading/      Open positions + journal + performance
    options-workbench/  Multi-leg options payoff builder
    portfolio/          Quant portfolio optimizer (HRP / CVaR)
    history/            Unified trade history (Picks + Scalper + FnO Trend)
```

### Backend

All market data — Indian and Crypto — flows exclusively through **data-service2.0** (`src/lib/data-service/client.ts`). There are no direct broker or exchange connections in the TypeScript layer.

```
data-service2.0 (port 8200)
  ├── REST  → getQuote / getCandles / getOptionChain / getInstruments / ...
  └── WS    → /v1/stream/ticks  (authenticated: X-API-KEY header or ?api_key= param)
```

The `DataServiceClient` in `src/lib/data-service/client.ts` is the single entry point. It is `server-only` — never imported by browser code. Browser WebSocket connections go through `src/services/brokers/client.ts` which appends `?api_key=NEXT_PUBLIC_DATA_SERVICE_API_KEY` to the WS URL.

### Worker

A separate Node process (`worker/src/`) runs 14 background jobs:

| Job | What it does |
|---|---|
| `india-auto-trader` | Signal scoring + intelligent paper trade execution (₹1L daily budget) |
| `india-daily-picks` | Freeze top-3 picks per bucket at 09:15 IST; track outcomes all day |
| `india-scanner` | Run 6 F&O scanners on every tick |
| `india-oc-capture` | Snapshot option chains at regular intraday intervals |
| `india-scalper` | Intraday F&O scalping loop; persists CandleBar rows |
| `india-eod-squareoff` | Close all open India trades at 15:30 IST |
| `india-fno-trend-track` | Track 14-condition FnO Trend Scanner outcomes |
| `india-whatsapp-scanner` | Scanner delta detection → WhatsApp `SCANNER_HIT_NEW` (fires only on new hits) |
| `scalper` | Crypto 10-strategy scalping loop |
| `signal-ingest/outcome` | Record and resolve signal history |
| `alerts` | Evaluate user-configured alerts |
| `liquidations` | Crypto liquidation WebSocket feed — connects to data-service2.0 `/v1/stream/ticks` with `X-API-KEY` header |
| `strategy-lab` | Background runner for user-saved strategy lab rules |

The worker connects to data-service2.0 using `DATA_SERVICE_URL` (resolved to `http://host.docker.internal:8200` in Docker, `http://localhost:8200` in local dev) with `DATA_SERVICE_API_KEY` sent as an `X-API-KEY` header.

### ML Microservice

A FastAPI Python service (`ml-service/`, port 8100) implements a multi-model decision engine:

```
NSE Data (via data-service2.0) → Feature Engineering (150+ features)
    ├── Market Regime Classifier (XGBoost) → 6 regimes
    ├── Stock Ranker (LightGBM) → outperformance scores for 200+ stocks
    ├── Strategy Selector (CatBoost) → 9 strategies
    ├── Risk Predictor (XGBoost ×3) → P(stop hit), P(target hit), drawdown
    ├── Portfolio Optimizer (Riskfolio-Lib HRP + CVaR) → capital allocation
    ├── RL Executor (PPO / SB3) → execution timing
    ├── Price Forecaster (TFT heuristic) → 1h price regime
    ├── IV Regime Classifier (heuristic) → CRUSH / STABLE / SPIKE
    ├── Meta Decision Engine → calibration + ensemble + abstention
    ├── ML Validation Framework → walk-forward + purged K-fold + CPCV
    └── Model Monitoring → PSI / KS / Jensen-Shannon drift + Brier/ECE
```

All models have rule-based heuristic fallbacks. When the ML service is down, signals continue without degradation.

---

## Key Features

### AI Signals (Crypto + India)

Every signal is a complete, confidence-scored trade plan:

- **Action** — LONG / SHORT / BUY / SELL / WAIT
- **Confidence** — 0–100 + letter grade (S / A / B / C / D)
- **Calibrated win probability** — Platt-scaled to `[0.28, 0.82]`; never pretends certainty
- **Tiered take-profit ladder** — TP1 / TP2 / TP3 with 50% / 30% / 20% scale-out allocations
- **ATR-sized stop loss** + explicit invalidation criteria line
- **Risk:Reward** — per-TP and blended
- **Position sizing %** — 1% risk budget, horizon-capped
- **Live timing window** — "Valid 1h 24m" countdown; stale badge on expiry
- **AI rationale** — top 6 confluence factors with category chips

India AI engine v2 (`alphaforge-ai-v2`) adds:
- 8-factor quant score per stock (SMA-50/200, intraday, analyst target, RSI, ADX, relative volume, NSE delivery %)
- Quant pre-filter gate — ADX ≥ 18, relative volume ≥ 1.1×, ATR% ≥ 0.4%; failures penalised −18% confidence
- ML regime blending — 65% heuristic + 35% ML service
- ML stock rank boost — ±0.06 confidence delta based on LightGBM rank
- **SentinelPulse news factor** — `importanceScore`-weighted sentiment replaces RSS headlines (weight 0.08 in 14-factor composite)

### Daily Picks (India F&O)

Distils the full F&O signal pool into the **top 3 per bucket**, frozen at 09:15 IST and live-tracked all day:

- **Indices Scalping** — institutional index scalps driven by OI build-up + PCR + max-pain
- **Opening Breakout** — first 5-min candle ORB, lazy-frozen after the retest
- **Highly Momentum** — daily SMA trend stack + 5d momentum + volume thrust
- **Highly Scalping** — expected range + sharp R:R + scanner agreement
- **Highly Potential** — highest-conviction setups by confidence + win-probability + blended R:R
- **Gamma Blast / Hero Zero** — expiry-day only; ATM option or far-OTM lottery play

### Intelligent Auto Paper-Trading Engine

Runs continuously via the `india-auto-trader` worker:

- Scores every Daily Pick and AI Signal: `35%×confidence + 25%×winProbability + 25%×grade + 15%×R:R`
- Candidates scoring ≥ 0.52 only (low-conviction setups are skipped)
- Daily ₹1,00,000 budget — max 5 open positions × ₹20,000 notional
- Risk gate: SL distance / entry ≤ 2.5%
- Signals routed through the **12-stage Opportunity Pipeline** before execution
- All positions closed at 15:30 IST; fresh ₹1L budget every day

### Opportunity Engine (12-Stage Pipeline)

Every signal passes through `src/lib/opportunity-engine/` before a paper trade is opened:

1. Universe coverage validation
2. Market context snapshot
3. Multi-layer signal evaluation (12 layers; VETO from any = rejection)
4. Derivatives intelligence (OI freshness, chain quality, flow labels)
5. Signal quality vector (14 components)
6. Expected value calculation (Platt-calibrated; `EV = P(win)×E[win] − P(loss)×E[loss] − costs`)
7. Opportunity clustering (correlated signals → one cluster, not N inflated confirmations)
8. Conflict resolution (BUY / SELL / WAIT / NO_TRADE)
9. Abstention evaluation (15 explicit reasons)
10. Risk check (Portfolio Risk Engine v2)
11. Position sizing (dynamic: base × confidence × vol × correlation × drawdown)
12. Execution mode isolation (BACKTEST / RESEARCH / SHADOW / PAPER / LIVE)

### V6 Quant Research Platform

A 24-phase research infrastructure that governs how strategies move from idea to live:

- Every strategy has a declared **hypothesis** with explicit falsification criteria
- All promotion decisions use exclusively **out-of-sample** metrics
- **LIVE promotion always requires a human `approvalToken` + `approvedBy`** — never automatic
- Research dashboard at `/research` with 10 pages: Leaderboard, Regime Matrix, Monte Carlo, Parameter Stability, Signal Calibration, Correlation, Promotion Pipeline, Alpha Decay Monitor, Experiment History, Strategy Inventory

### Signal Center (V3.0)

`/in/signal-center` — a unified view of all signal families with `OpportunityCluster` deduplication:

- **9 signal families** aggregated: AI_SIGNAL, SCANNER, DAILY_PICK, FNO_TREND, PAPER_TRADE, MANUAL, OPPORTUNITY, SCALP, RESEARCH
- Same instrument + direction within a 30-min window → one cluster (not N duplicated cards)
- `independentConfirmations` = unique-family count (geometric mean confidence, never inflated)

### WhatsApp Notifications (V3.0)

Real-time trading alerts delivered to WhatsApp via the Evolution-Go API:

- **6 event types:** `AI_SIGNAL_NEW`, `SIGNALS_BOARD_NEW`, `DAILY_PICKS_NEW`, `PAPER_TRADE_OPENED`, `PAPER_TRADE_CLOSED`, `SCANNER_HIT_NEW`
- Per-user opt-in per event type (managed from `/in/profile`)
- Per-user Redis cooldown (default 5 min) prevents duplicate alerts
- Phone numbers stored AES-256-GCM encrypted; E.164 validated

---

## News Intelligence — SentinelPulse

India AI signals and the news feed are powered by **SentinelPulse**, an external NLP/financial-news microservice. The legacy RSS stack (ET, Moneycontrol, WSJ feeds with a hand-rolled XML parser) has been completely removed and replaced.

### What SentinelPulse provides

| Endpoint | Purpose |
|---|---|
| `GET /news/latest` | Latest articles with ML sentiment scores |
| `GET /news/market/india` | India-specific market news |
| `GET /regime` | Current market regime narrative |
| `GET /alphaforge-context` | Pre-processed signal context for AI engine |
| `GET /high-impact-events` | High-impact scheduled events |

### Integration points

- **`src/features/india/news/`** — `sentinel-client.ts` (typed HTTP client), `index.ts` (service layer), Redis cache keys `sp:news:*` (90 s TTL) and `sp:market:india` (60 s TTL)
- **`src/app/api/in/news/`** — expanded route set: `/route` (latest), `/market-india`, `/regime`, `/context`, `/high-impact`
- **`src/hooks/useIndiaNews`** — updated to consume SentinelPulse `NewsItem` shape
- **`src/features/ai-signals/`** — `loadNewsScores()` updated to read `importanceScore` and `sentimentScore` from the SentinelPulse wire format
- **`INDIA_AI_SIGNALS` strategy** — news factor (weight 0.08) now uses `importanceScore`-weighted SentinelPulse sentiment instead of RSS headlines

### Configuration

```bash
# .env.local
SENTINEL_PULSE_URL=http://localhost:3001      # SentinelPulse service URL
SENTINEL_PULSE_API_KEY=<your-key>             # API key for SentinelPulse
```

In Docker, inject via `docker-compose.yml` (already configured) — both `app` and `worker` services receive these env vars.

Internal test-pipeline articles are filtered out automatically (the service detects `source: "SentinelPulse Internal"` and excludes them).

---

## Simulated Market Data (Dev / Staging Fallback)

When `data-service2.0` is running but has no live upstream provider configured (e.g. dev or staging environments without broker credentials), the India API layer falls back to `src/lib/data-service/simulated-india.ts`.

This module produces realistic synthetic data for all India API surfaces:
- Market snapshot (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, India VIX)
- Sector stocks with coherent price action
- Scanner hits with realistic OI and volume figures
- Top picks and daily picks
- Nifty bias signal

The fallback is automatic — no configuration required. When live data arrives from data-service2.0, it takes priority. The `DataSourceBadge` component in the UI reflects the current data source (`LIVE` / `SIMULATED`).

---

## Auto-Rebuild & Redeploy

Every `git commit` can automatically rebuild and restart affected Docker services. One-time setup:

```bash
make install-hooks
```

After that, every commit triggers a smart diff that decides which services to rebuild:

| Changed path | Services rebuilt |
|---|---|
| `src/**`, `public/**`, `Dockerfile.app`, `package*.json` | app + worker |
| `worker/src/**`, `Dockerfile.worker` | worker |
| `ml-service/**` | ml-service |
| `docs/**`, `*.md` | *(nothing — skipped)* |

Manual deploy commands:

```bash
make deploy           # rebuild + redeploy app & worker
make deploy-app       # app only
make deploy-worker    # worker only
make deploy-ml        # ML service only
make deploy-all       # all three
make deploy-log       # tail the live deploy log
make watch-deploy     # file-watcher mode (requires fswatch)
```

Skip a rebuild on a specific commit:

```bash
SKIP_DEPLOY=1 git commit -m "docs: update readme"
```

Full reference: [docs/AUTO_DEPLOY.md](./docs/AUTO_DEPLOY.md)

---

## Indian Market Data Provider Chain

All Indian market data flows through **data-service2.0** as the single source of truth. The TypeScript layer has no direct broker or exchange connections.

| Priority | Provider | Capabilities | Activation |
|---|---|---|---|
| 0 | **data-service2.0** (`localhost:8200`) | Live quotes, tick stream, option chain, historical OHLCV, crypto liquidations, instrument master | Always running (separate stack) |
| 1 | **Angel One SmartAPI** | Quotes, historical, option chain, live stream, greeks, GEX, instrument master | `SMARTAPI_API_KEY` + `SMARTAPI_CLIENT_CODE` + `SMARTAPI_PIN` + `SMARTAPI_TOTP_SECRET` |
| 2 | **Upstox Analytics** | REST quotes/historical/option chain (v2) + live WebSocket (v3 Protobuf feed) | `UPSTOX_ANALYTICS_TOKEN` or full OAuth credentials |
| 3 | **Yahoo Finance** | Historical OHLCV, quotes | Always available (last resort) |

`INDIA_BROKER=nse` is no longer valid. The `"nse"` `ProviderId` has been removed from the TypeScript type system. 12 automated guard tests in `tests/lib/market-data/nse-elimination.test.ts` prevent any regression.

---

## Environment Variables

### Required

```bash
DATABASE_URL=postgresql://...
AUTH_SECRET=...          # from: npx auth secret
ENCRYPTION_KEY=...       # 32-byte hex string
```

### data-service2.0 (required for any market data)

```bash
# Server-side (REST + worker WebSocket)
DATA_SERVICE_URL=http://localhost:8200
DATA_SERVICE_API_KEY=<key>           # must match CONSUMER_API_KEYS in data-service2.0

# Browser-side (client WebSocket to /v1/stream/ticks)
NEXT_PUBLIC_DATA_SERVICE_URL=http://localhost:8200
NEXT_PUBLIC_DATA_SERVICE_API_KEY=<key>   # same key as above
```

In Docker (`--profile integration`), the server-side URL resolves to `http://host.docker.internal:8200` since data-service2.0 runs as a separate stack. The `NEXT_PUBLIC_*` vars always use `localhost:8200` (browser connects from the host machine).

### Optional — Indian Market

```bash
# Angel One SmartAPI (primary data source after data-service2.0)
SMARTAPI_API_KEY=
SMARTAPI_CLIENT_CODE=
SMARTAPI_PIN=
SMARTAPI_TOTP_SECRET=
SMARTAPI_PUBLIC_IP=      # your real egress IP — prevents WAF 403s

# Upstox (secondary data source)
UPSTOX_CLIENT_ID=
UPSTOX_CLIENT_SECRET=
UPSTOX_REDIRECT_URI=
UPSTOX_ANALYTICS_TOKEN=  # configure via Profile → API Keys in the UI

# SentinelPulse (India news intelligence)
SENTINEL_PULSE_URL=http://localhost:3001
SENTINEL_PULSE_API_KEY=

# WhatsApp notifications (V3.0)
WHATSAPP_EVOLUTION_API_URL=
WHATSAPP_INSTANCE=
WHATSAPP_API_KEY=

# Worker and ML
ML_SERVICE_URL=http://localhost:8100
REDIS_URL=redis://localhost:6379
```

### Broker Switching (Crypto)

```bash
ACTIVE_BROKER=delta          # or: binance
NEXT_PUBLIC_ACTIVE_BROKER=delta
```

---

## Database Schema (18 models)

| Model | Purpose |
|---|---|
| `User`, `UserSetting` | Auth and per-user preferences |
| `Alert`, `Notification` | User-configured alerts + in-app notifications |
| `SignalHistory` | Signal audit records with outcome tracking |
| `PaperTrade` | All paper trades — India (`in:` prefix) and Crypto share one table |
| `Strategy`, `StrategyBacktest`, `StrategyPaperTrade` | Strategy lab + backtest snapshots |
| `IndiaDailyPick` | Daily picks frozen at 09:15 IST; outcome tracked |
| `CandleBar` | OHLCV candles (1m–1d, NSE-aligned, OI/OIChange for derivatives) |
| `OptionChainSnapshot` | Intraday option chain snapshots for strategy backtesting |
| `FnoTrendScan` | 14-condition FnO trend scanner results with TARGET_HIT/STOP_HIT tracking |
| `IndiaDaySession` | Daily auto-trading session — ₹1L budget, EOD P&L |
| `SignalLifecycleEvent` | Full state-machine audit trail per signal (replay-ready) |
| `UniverseCoverageSnapshot` | Per-session F&O universe coverage; < 80% = INVALID |
| `OpportunityCluster` | Groups of correlated signals on the same underlying event |
| `SignalIntelligenceRecord` | Full enriched signal envelope through the intelligence engine |

---

## Testing

AlphaForge is TDD-first. Tests must be written before implementation — no exceptions.

```bash
npm test                    # full suite
npm run test:features       # feature engines only
npm run test:api            # API route handlers only
npm run test:coverage       # v8 coverage → coverage/
npm run dev:tdd             # dev server + vitest --watch in parallel
```

Test layout mirrors `src/` by concern:

```
tests/
  lib/           Pure utilities, validators, market-data layer
                 nse-elimination.test.ts — 12 guard tests (V3.0)
  features/      Domain engines (best-time, scalping, daily-picks, ...)
  components/    React component render + interaction tests
  api/           Next.js Route Handler tests (Request/Response)
  services/      Service layer (cache, broker adapters)
  hooks/         Custom React hooks
  stores/        Zustand store tests
  pages/         Page-level smoke + redirect tests
  worker/        Worker scheduler, config, log, env-validation
  research/      V6 research platform
  runtime/       Certification harnesses (phase tests)
```

---

## Project Structure

```
src/
  app/
    (auth)/                  /login, /signup
    (dashboard)/             Authenticated shell — sidebar + topbar
      page.tsx               Crypto Overview
      in/                    India route group
        signal-center/       Unified signal center page
      api/                   All API routes
  components/
    ai-signals/              AiSignalCard, AiSignalsBoard, AiMarketContextBanner
    dashboard/               Sidebar, Topbar, MarketTickerBar
    india/                   All India UI (option-chain, ticker, signal-center, ...)
    trading/                 SignalBadge, ConfidenceBar, RegimeBadge, AiRadar
    layout/                  BentoGrid, PageHeader, EmptyState, ErrorState
  features/
    ai-signals/              Cross-market AI engine + crypto/india builders
    best-time/               IST window engine (crypto + NSE versions)
    scalping/                10 crypto scalping strategies + journal + backtest
    whatsapp/                Phone, types, preferences, formatters, notifier
    india/
      best-time/             NSE-anchored session engine (7 windows)
      daily-picks/           Top-3-per-bucket engine + freeze/track/history
      scalping/              9 F&O strategies + journal + option-chain replay
      expiry-trades/         Gamma Blast / Hero Zero expiry-day playbooks
      news/                  SentinelPulse integration (client, service, API routes)
                             Replaces: RSS feed stack (feeds.ts, rss.ts) — removed
      options-workbench/     Multi-leg payoff engine
  lib/
    data-service/            client.ts — single entry point for all market data
                             (server-only; calls data-service2.0 REST + WebSocket)
                             simulated-india.ts — realistic synthetic fallback for dev/staging
    signal-intelligence/     45-phase signal intelligence engine (12 modules)
    opportunity-engine/      12-stage opportunity validation pipeline
    research/                24-phase V6 quant research platform
    risk/                    Portfolio Risk Engine v2 (7 modules)
    microstructure/          Market Microstructure Intelligence (7 modules)
    experiments/             Shadow Trading + A/B experiment framework
    backtesting-v2/          Event-driven NSE F&O backtesting engine
    india/                   NSE calendar, atomic trade guard, feature validators
  services/
    brokers/
      client.ts              Browser-side WebSocket factory (ticker + liquidation streams)
                             Appends ?api_key= to WS URL for data-service2.0 auth
    india/                   Angel One, Upstox, Yahoo broker adapters
  store/                     Zustand stores (UIStore + market-scoped stores)
  hooks/                     useBinanceTickers, useLiveQuotes, useOptionChain, ...
worker/
  src/jobs/                  14 background jobs
  src/config.ts              Reads DATA_SERVICE_URL + DATA_SERVICE_API_KEY
  src/index.ts               Graceful shutdown + job registry
ml-service/
  src/
    features/                Feature engineering (150+ features, TA-Lib backed)
    models/                  XGBoost, LightGBM, CatBoost, PPO, Riskfolio-Lib
    meta/                    Calibration, ensemble, abstention, decision policy
    monitoring/              Drift detection (PSI/KS/JS), performance tracking
    validation/              Walk-forward, embargo, Purged K-Fold, CPCV
prisma/schema.prisma         18 models
docker-compose.yml           Postgres 17 + Redis 7 + ML service (+ app/worker under integration profile)
.dockerignore                Excludes node_modules, .next, coverage, .git from build context
```

---

## Switching Brokers (Crypto)

```bash
# .env.local
ACTIVE_BROKER=binance
NEXT_PUBLIC_ACTIVE_BROKER=binance
```

This flips the entire stack — WS endpoint, REST adapters, pair names, and worker liquidation subscriber — without touching any call sites.

---

## Theming

Three-segment toggle (Light · System · Dark) in the topbar, shared across both markets. Uses OKLCH color tokens in `globals.css` for perceptually-uniform palettes. A pre-hydration inline script in `app/layout.tsx` prevents any flash of incorrect theme on reload.

---

## Troubleshooting

**`Missing required environment variable: DATABASE_URL`**
Copy `.env.example` to `.env.local`. Defaults match the docker-compose services.

**`REDIS_URL not set — using in-memory fallback`**
Run `npm run docker:up` or accept the in-memory cache for dev.

**`WebSocket /v1/stream/ticks` → 403**
The API key is not being sent. Ensure both `DATA_SERVICE_API_KEY` (server-side) and `NEXT_PUBLIC_DATA_SERVICE_API_KEY` (browser-side) are set in `.env.local` and match `CONSUMER_API_KEYS` in data-service2.0. The worker sends `X-API-KEY` header; the browser appends `?api_key=` to the WS URL.

**`Connection refused (5432 / 6379)`**
Docker Desktop isn't running or `docker compose up -d` was never run. Check: `docker compose ps`.

**Market Pulse shows 0.00 prices or changePct for some indices**
The ticker bar SSE merge was guarding `ltp === 0` correctly. If you see this, ensure data-service2.0 is healthy: `curl http://localhost:8200/health`. The heatmap auto-refreshes every 30 s; the market snapshot enriches each index individually (not all-or-nothing).

**MSB-OB Intraday Signals section missing**
This section was intentionally removed. It relied on an external Python scanner CSV not included in the standard deployment.

**`getaddrinfo ENOTFOUND data-service`**
The worker or app is trying to resolve the old `data-service` hostname. Ensure `.env.docker` has `DATA_SERVICE_URL=http://host.docker.internal:8200` (not `http://data-service:8200`).

**App or worker `unhealthy` after `docker compose --profile integration up`**
The app health check hits `/api/health/ready` — give it up to 60s to start. Check logs: `docker compose logs -f app`.

**Module not found / corrupted `node_modules`**

```bash
rm -rf node_modules .next
npm install
npm run dev
```

**Docker build slow (first time)**
The `.dockerignore` file excludes `node_modules`, `.next`, and `coverage` — build context should be ~7MB. If it's uploading gigabytes, verify `.dockerignore` exists at the repo root.

**Windows fork exhaustion** (`STATUS_COMMITMENT_LIMIT` / code `127`)
Close extra Electron apps. Avoid running dev server + worker + `vitest --watch` simultaneously. Use `npm run worker:dev` (no watcher) rather than `worker:watch`.

### Upstox Analytics API Credential Configuration

Users can configure their Upstox Analytics Token directly in the UI:

- Navigate to **Profile → API Keys → Upstox Analytics API**
- Paste the Analytics Token from the Upstox Developer Console
- Token is encrypted with AES-256-GCM at rest
- Tokens can be up to 2048 characters (JWT bearer token length)

---

> Architecture deep-dive: [ARCHITECTURE.md](./ARCHITECTURE.md)  
> Auto-deploy reference: [docs/AUTO_DEPLOY.md](./docs/AUTO_DEPLOY.md)  
> Codebase inventory: [ALPHAFORGE_FINAL_CODEBASE_INVENTORY.md](./ALPHAFORGE_FINAL_CODEBASE_INVENTORY.md)
