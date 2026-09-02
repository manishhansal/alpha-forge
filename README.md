# AlphaForge

A professional, multi-market trading desk for **Crypto** and **Indian NSE F&O** — built with Next.js 16, a Python ML microservice, and an institutional-grade research platform.

---

## What It Is

AlphaForge runs two fully independent trading surfaces in one shell, toggled by a sidebar switcher:

- **Crypto** — BTC · ETH · SOL via Delta Exchange India (default) or Binance. Futures analytics, options chain, AI signals, 10 scalping strategies, strategy backtest, conversational strategy lab, and paper trading.
- **Indian F&O (NSE)** — Full sidebar parity with the crypto surface. NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY + 200+ F&O stocks. Live option chain, 9 F&O strategies, AI signals with real-time derivatives context, Daily Picks, FnO trend scanners, intelligent auto paper-trading engine, trade history, and an evidence-driven quant research platform.

The URL is the source of truth — `/` is Crypto, `/in/*` is Indian Market. Deep links, browser back/forward, and shared links always land in the right mode.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16.3.1** (App Router, Turbopack) + **React 19.2.4** + TypeScript |
| Styling | **TailwindCSS v4** — OKLCH design token system, `@theme inline` block |
| Client State | **Zustand v5** (UIStore + market-scoped stores, localStorage persist) |
| Server State | **TanStack Query v5** |
| Tables | **TanStack Table v9** (Options Chain, AI Radar, Journal, Daily Picks History) |
| Charts | **lightweight-charts v5** + custom Anchored VWAP + Volume Profile plugins; Recharts |
| Animation | **Framer Motion** (4 named Spring presets: MICRO / FAST / DEFAULT / GENTLE) |
| Validation | **Zod v4** on every external input and env var |
| Cache | **Redis** via ioredis (in-memory fallback for dev) |
| Database | **PostgreSQL 17** + **Prisma 7** (driver-adapter pattern) |
| Realtime | Active broker WebSocket (Delta Exchange India or Binance) |
| ML Engine | **Python 3.11** + FastAPI + XGBoost + LightGBM + CatBoost + PPO (SB3) + SHAP + Riskfolio-Lib + TA-Lib + mibian |

---

## Quick Start

You need **Node.js ≥ 20.9** and **Docker Desktop**.

```bash
# 1. Install dependencies
npm install

# 2. Start Postgres + Redis
npm run docker:up

# 3. Copy env template
cp .env.example .env.local

# 4. Generate secrets and paste into .env.local
npx auth secret                              # → AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → ENCRYPTION_KEY

# 5. Run the first DB migration
npm run db:migrate -- --name init

# 6. Start the dev server
npm run dev

# 7. Start the background worker (separate terminal)
npm run worker:dev
```

Or use the one-shot setup:

```bash
npm run setup   # npm install + docker compose up + prisma migrate dev
```

Open [http://localhost:3000](http://localhost:3000) and create an account at `/signup`.

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
| `npm run docker:up/down/reset` | Manage Postgres + Redis containers |

> **TDD is mandatory.** Write the failing test first, then the implementation. The `prebuild` hook enforces a green suite before every build.

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
    ...
```

### Backend

All Indian market data flows through a **provider-agnostic data layer** (`src/lib/market-data/`) with automatic failover:

```
Angel One SmartAPI  →  Upstox Analytics v2  →  NSE direct  →  Yahoo Finance
       1                        2                    3                4
```

The `ProviderRegistry` routes each capability request to the highest-priority available provider. `withFailover()` retries 3× with exponential backoff, then switches provider. A 0–100 health score and circuit breaker prevent routing to persistently failing providers.

### Worker

A separate Node process (`worker/src/`) runs 13 background jobs:

| Job | What it does |
|---|---|
| `india-auto-trader` | Signal scoring + intelligent paper trade execution (₹1L daily budget) |
| `india-daily-picks` | Freeze top-3 picks per bucket at 09:15 IST; track outcomes all day |
| `india-scanner` | Run 6 F&O scanners on every tick |
| `india-oc-capture` | Snapshot option chains at regular intraday intervals |
| `india-scalper` | Intraday F&O scalping loop; persists CandleBar rows |
| `india-eod-squareoff` | Close all open India trades at 15:30 IST |
| `india-fno-trend-track` | Track 14-condition FnO Trend Scanner outcomes |
| `scalper` | Crypto 10-strategy scalping loop |
| `signal-ingest/outcome` | Record and resolve signal history |
| `alerts` | Evaluate user-configured alerts |
| `liquidations` | Crypto liquidation WebSocket feed |
| `strategy-lab` | Background runner for user-saved strategy lab rules |

### ML Microservice

A FastAPI Python service (`ml-service/`, port 8100) implements a multi-model decision engine:

```
NSE Data → Feature Engineering (150+ features)
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

### Daily Picks (India F&O)

Distils the full F&O signal pool into the **top 3 per bucket**, frozen at 09:15 IST and live-tracked all day:

- **Indices Scalping** — institutional index scalps driven by OI build-up + PCR + max-pain
- **Opening Breakout** — first 5-min candle ORB, lazy-frozen after the retest
- **Highly Momentum** — daily SMA trend stack + 5d momentum + volume thrust
- **Highly Scalping** — expected range + sharp R:R + scanner agreement
- **Highly Potential** — highest-conviction setups by confidence + win-probability + blended R:R
- **Gamma Blast / Hero Zero** — expiry-day only; ATM option or far-OTM lottery play

Every pick ships entry / stop / target / "can move upto" / "can expect" / logic. Outcomes (TARGET_HIT / STOP_HIT / CLOSED) are tracked live. Full queryable history with per-day win rates.

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

All 9 official India F&O strategies are currently `INSUFFICIENT_EVIDENCE` — that is the correct state. Nothing has been fabricated.

---

## Indian Market Data (Provider Chain)

| Priority | Provider | Capabilities | Activation |
|---|---|---|---|
| 1 | **Angel One SmartAPI** | Quotes, historical, option chain, live stream, instrument master | `SMARTAPI_API_KEY` + `SMARTAPI_CLIENT_CODE` + `SMARTAPI_PIN` + `SMARTAPI_TOTP_SECRET` |
| 2 | **Upstox Analytics v2** | Quotes, historical, option chain | `UPSTOX_ANALYTICS_TOKEN` |
| 3 | **NSE direct** | Option chain, quotes (cookie-warmed scraper) | Always available |
| 4 | **Yahoo Finance** | Historical OHLCV, quotes | Always available (last resort) |

Legacy `INDIA_BROKER=yahoo|nse|groww|angel|openalgo` env var still works for existing adapters.

---

## Environment Variables

### Required

```bash
DATABASE_URL=postgresql://...
AUTH_SECRET=...          # from: npx auth secret
ENCRYPTION_KEY=...       # 32-byte hex string
```

### Optional — Indian Market

```bash
# Angel One SmartAPI (primary data source)
SMARTAPI_API_KEY=
SMARTAPI_CLIENT_CODE=
SMARTAPI_PIN=
SMARTAPI_TOTP_SECRET=

# Upstox (secondary data source)
UPSTOX_ANALYTICS_TOKEN=

# OpenAlgo broker adapter (covers 33+ Indian brokers)
OPENALGO_BASE_URL=
OPENALGO_API_KEY=
LIVE_TRADING_ENABLED=   # Must be exactly "true" to allow order placement

# Worker and ML
ML_SERVICE_URL=http://localhost:8100
REDIS_URL=redis://localhost:6379
INDIA_REDIS_PREFIX=fno-pulse:
```

### Broker Switching (Crypto)

```bash
# Flip between Delta Exchange India (default) and Binance
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
npm test                    # full suite (~3000 tests)
npm run test:features       # feature engines only
npm run test:api            # API route handlers only
npm run test:coverage       # v8 coverage → coverage/
npm run dev:tdd             # dev server + vitest --watch in parallel
```

Test layout mirrors `src/` by concern:

```
tests/
  lib/           Pure utilities, validators, market-data layer
  features/      Domain engines (best-time, scalping, daily-picks, ...)
  components/    React component render + interaction tests
  api/           Next.js Route Handler tests (Request/Response)
  services/      Service layer (cache, broker adapters)
  hooks/         Custom React hooks
  stores/        Zustand store tests
  pages/         Page-level smoke + redirect tests
  worker/        Worker scheduler, config, log, env-validation
```

Key test counts:
- Microstructure Engine: 974
- Shadow Trading / Experiment Framework: 1,643
- Financial ML Validation: 1,480
- Meta Decision Engine: 1,058
- Signal Intelligence Engine: 196
- Portfolio Risk Engine v2: 64
- Research Platform (V6): 92

---

## Project Structure

```
src/
  app/
    (auth)/                  /login, /signup
    (dashboard)/             Authenticated shell — sidebar + topbar
      page.tsx               Crypto Overview
      in/                    India route group
      api/                   All API routes
  components/
    ai-signals/              AiSignalCard, AiSignalsBoard, AiMarketContextBanner
    dashboard/               Sidebar (market-aware), Topbar, MarketTickerBar
    india/                   All India UI (msb-dashboard, option-chain, ticker, ...)
    trading/                 SignalBadge, ConfidenceBar, RegimeBadge, NumberMorph, AiRadar
    layout/                  BentoGrid, PageHeader, EmptyState, ErrorState, PageTransition
    3d/                      MarketIntelligenceCore, RiskSphere, PortfolioGalaxy
  features/
    ai-signals/              Cross-market AI engine + crypto/india builders
    best-time/               IST window engine (crypto + NSE versions)
    scalping/                10 crypto scalping strategies + journal + backtest
    india/
      best-time/             NSE-anchored session engine (7 windows)
      daily-picks/           Top-3-per-bucket engine + freeze/track/history
      scalping/              9 F&O strategies + journal + option-chain replay
      expiry-trades/         Gamma Blast / Hero Zero expiry-day playbooks
      news/                  RSS feed + bull/bear lexicon + sentiment engine
      options-workbench/     Multi-leg payoff engine
  lib/
    market-data/             Provider-agnostic data layer (4 providers + failover)
    signal-intelligence/     45-phase signal intelligence engine (12 modules)
    opportunity-engine/      12-stage opportunity validation pipeline
    research/                24-phase V6 quant research platform
    risk/                    Portfolio Risk Engine v2 (7 modules)
    microstructure/          Market Microstructure Intelligence (7 modules)
    experiments/             Shadow Trading + A/B experiment framework
    backtesting-v2/          Event-driven NSE F&O backtesting engine
    india/                   NSE calendar, atomic trade guard, feature validators
  services/
    brokers/                 BrokerAdapter contract + Delta/Binance adapters
    india/                   Angel One, Upstox, NSE, Yahoo broker adapters
  store/                     Zustand stores (UIStore + market-scoped stores)
  hooks/india/               useFetchPoll, useOptionChain, useScanner, ...
worker/
  src/jobs/                  13 background jobs
  src/index.ts               Graceful shutdown + job registry
ml-service/
  src/
    features/                Feature engineering (150+ features, TA-Lib backed)
    models/                  XGBoost, LightGBM, CatBoost, PPO, Riskfolio-Lib
    meta/                    Calibration, ensemble, abstention, decision policy
    monitoring/              Drift detection (PSI/KS/JS), performance tracking
    validation/              Walk-forward, embargo, Purged K-Fold, CPCV
    greeks.py                Black-76/BS greeks + Newton-Raphson IV solver
    gex.py                   Dealer GEX engine
    vol_surface.py           SVI IV surface + term structure
prisma/schema.prisma         18 models
docker-compose.yml           Postgres 17 + Redis 7 + ML service
tests/                       Vitest suite — see Testing section
```

---

## Switching Brokers (Crypto)

```bash
# .env.local
ACTIVE_BROKER=binance
NEXT_PUBLIC_ACTIVE_BROKER=binance
```

This flips the entire stack — WS endpoint, REST adapters, pair names, and worker liquidation subscriber — without touching any call sites. The broker adapter `capabilities` flags handle feature gaps cleanly (e.g. Delta India has no liquidation feed; the signal engine drops that factor automatically).

---

## Theming

Three-segment toggle (Light · System · Dark) in the topbar, shared across both markets. Uses OKLCH color tokens in `globals.css` for perceptually-uniform palettes. A pre-hydration inline script in `app/layout.tsx` prevents any flash of incorrect theme on reload.

---

## Troubleshooting

**`Missing required environment variable: DATABASE_URL`**
Copy `.env.example` to `.env.local`. Defaults match the docker-compose services.

**`REDIS_URL not set — using in-memory fallback`**
Run `npm run docker:up` or accept the in-memory cache for dev. The fallback is process-local.

**`Connection refused (5432 / 6379)`**
Docker Desktop isn't running or `docker compose up -d` was never run. Check: `docker compose ps`.

**Module not found / corrupted `node_modules`**

```bash
rm -rf node_modules .next
npm install
npm run dev
```

**Windows fork exhaustion** (`STATUS_COMMITMENT_LIMIT` / code `127`)
Close extra Electron apps and Cursor windows. Avoid running dev server + worker + `vitest --watch` simultaneously. Use `npm run worker:dev` (no watcher) rather than `worker:watch`. Restart Docker before the dev server if the fork pool is depleted.

---

> Full product spec and architecture deep-dive: [ALPHAFORGE.md](./ALPHAFORGE.md)
> Chronological changelog: [CHANGES.md](./CHANGES.md)
