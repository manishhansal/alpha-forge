# AlphaForge — Architecture & Product Specification

This document is the authoritative reference for AlphaForge's product design, system architecture, data flows, and coding standards. It covers both markets (Crypto and Indian NSE F&O) and all major subsystems from the frontend through the ML microservice.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Market Surfaces](#2-market-surfaces)
3. [Design System — IIT](#3-design-system--iit)
4. [Core Architecture](#4-core-architecture)
5. [Indian Market Data Layer](#5-indian-market-data-layer)
6. [AI Signals Engine](#6-ai-signals-engine)
7. [Daily Picks & Auto Paper-Trading](#7-daily-picks--auto-paper-trading)
8. [Opportunity Engine (12-Stage Pipeline)](#8-opportunity-engine-12-stage-pipeline)
9. [Signal Intelligence Engine (45-Phase)](#9-signal-intelligence-engine-45-phase)
10. [V6 Quant Research Platform (24-Phase)](#10-v6-quant-research-platform-24-phase)
11. [Institutional Infrastructure](#11-institutional-infrastructure)
12. [ML Microservice](#12-ml-microservice)
13. [Strategy Catalogue](#13-strategy-catalogue)
14. [Worker Jobs](#14-worker-jobs)
15. [Database Schema](#15-database-schema)
16. [API Surface](#16-api-surface)
17. [Folder Structure](#17-folder-structure)
18. [Environment Variables](#18-environment-variables)
19. [Testing & TDD Policy](#19-testing--tdd-policy)
20. [Coding Standards](#20-coding-standards)

---

## 1. Product Overview

AlphaForge is a professional multi-market trading desk that ships two fully independent surfaces in one shell:

- **Crypto** — BTC · ETH · SOL via a pluggable broker adapter (Delta Exchange India by default, Binance opt-in). Derivatives analytics, sentiment engine, AI signals, 10 scalping strategies, 5-year strategy backtest, conversational strategy lab, paper trading.
- **Indian NSE F&O** — Complete sidebar parity with the Crypto surface. NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY + 200+ F&O stocks. Live option chain, 9 F&O strategies, multi-confluence AI signals, Daily Picks, FnO trend scanners, intelligent auto paper-trading (₹1L/day), trade history, GEX, IV surface, options workbench, portfolio optimizer, and a full evidence-driven quant research platform.

A top-of-sidebar **Market Switcher** toggles between surfaces. The URL is the source of truth — `/` is Crypto, `/in/*` is India. Deep links and browser history always land correctly with no extra persistence.

---

## 2. Market Surfaces

### 2.1 Shared Core (both markets, same order)

Both sidebars expose the same 10 surfaces in the same order so the user's mental map carries across the switcher:

| # | Crypto | India (NSE F&O) | Auth |
|---|---|---|---|
| 1 | Overview (`/`) | Overview (`/in/dashboard`) | **Public** |
| 2 | Best Time (`/best-time`) | Best Time (`/in/best-time`) | Protected |
| 3 | Options (`/options`) | Options (`/in/options`) | Protected |
| 4 | Signals (`/signals`) | Signals (`/in/signals`) | Protected |
| 5 | AI Signals (`/ai-signals`) | AI Signals (`/in/ai-signals`) | Protected |
| 6 | Strategies (`/strategies`) | Strategies (`/in/strategies`) | Protected |
| 7 | Paper Trading (`/paper-trading`) | Paper Trading (`/in/paper-trading`) | Protected |
| 8 | Strategy Backtest (`/strategy-backtest`) | Strategy Backtest (`/in/strategy-backtest`) | Protected |
| 9 | Strategy Lab (`/strategy-lab`) | Strategy Lab (`/in/strategy-lab`) | Protected |
| 10 | Heatmap (`/heatmap`) | Heatmap (`/in/heatmap`) | **Public** |

Market-specific extras are appended below the shared core. Profile lives on the topbar avatar (`/profile`, `/in/profile`).

### 2.2 India-Only Extras

| Page | Path | Purpose |
|---|---|---|
| Daily Picks | `/in/daily-picks` | Top-3-per-bucket frozen picks + expiry-day plays + history |
| Trade History | `/in/history` | Unified history: Daily Picks + Scalper + FnO Trend Scanner |
| News | `/in/news` | RSS feeds + bull/bear sentiment + F&O impact tags |
| Scanner | `/in/scanner` | Single-mode F&O scanner |
| Watchlist | `/in/watchlist` | Persistent F&O watchlist |
| Chart | `/in/chart/[symbol]` | Per-symbol lightweight-charts deep-dive |
| Options Workbench | `/in/options-workbench` | Multi-leg options payoff builder + greeks + GEX strike scan |
| Portfolio Optimizer | `/in/portfolio` | Riskfolio-Lib HRP + CVaR allocation |

### 2.3 Auth Gating

`src/proxy.ts` (Next.js middleware) gates every non-public route via Auth.js v5. The `isPublicPath()` helper is the single source of truth. Anonymous users see Overview + Heatmap per market and a "Sign in to unlock" CTA. All other routes redirect to `/login?callbackUrl=…`.

### 2.4 Best Time to Trade

**Crypto engine** (`src/features/best-time/engine.ts`) — pure, IST-anchored. Six named windows from Worst Zone (02:00–07:00) to Golden Scalp Zone (19:00–22:00). Higher-priority windows win on overlap. Day-of-week quality multiplier (Tue/Wed/Thu = excellent, Sun = low liquidity). Forces WAIT outside active windows.

**NSE engine** (`src/features/india/best-time/engine.ts`) — same API, seven NSE-specific windows:

| Window | Hours (IST) | Quality |
|---|---|---|
| Pre-Open Auction | 09:00–09:15 | Preparation |
| Opening Volatility | 09:15–10:00 | High |
| Morning Trend | 10:00–11:30 | Ideal |
| Midday Lull | 11:30–13:30 | Avoid |
| Afternoon Trend | 13:30–15:00 | Good |
| Power Hour | 15:00–15:30 | Ideal |
| Closing Auction | 15:30–15:40 | Closing risk |

Expiry-aware day quality: Thursday (NIFTY weekly) adds a gamma-risk flag.

### 2.5 Paginated Data Views

All large Indian market tables are paginated at **5 items per page** using a shared `usePaginationFilter` hook with three filter tabs — All / Most Confidence / High Winrate. Covers: Scanner, MSB Signals, Range Expansion, Sector Stocks Modal, Live Signals, Open Positions, News Feed, Watchlist.

---

## 3. Design System — IIT

AlphaForge's visual language is the **Institutional Intelligence Terminal (IIT)** — precision-first, data-dense, and regime-reactive.

### 3.1 Color Tokens

All colors are defined in OKLCH via the `@theme inline` block in `globals.css`. No hardcoded hex or RGB values in component files.

```css
--color-panel-bg         /* card / panel background */
--color-panel-border     /* 1px panel borders */
--color-data-positive    /* green: profits, bullish readings */
--color-data-negative    /* red: losses, bearish readings */
--color-data-neutral     /* amber: caution, neutral */
--color-ai-accent        /* AI/ML signal highlight */
--color-regime-bull      /* bull regime: green */
--color-regime-bear      /* bear regime: red */
--color-regime-sideways  /* sideways: amber */
--color-regime-highvol   /* high volatility: purple */
```

### 3.2 Motion System

Four named Spring presets exported from `src/lib/motion-presets.ts`:

| Preset | Stiffness / Damping | Use case |
|---|---|---|
| `SPRING_MICRO` | 800 / 40 | Price ticks, badge updates |
| `SPRING_FAST` | 600 / 35 | Tab indicators, theme toggle |
| `SPRING_DEFAULT` | 400 / 28 | Panel opens, sidebar |
| `SPRING_GENTLE` | 240 / 24 | Page transitions |

All spring animations reference named presets — no ad-hoc values in components.

### 3.3 Data Density

Components read `data-density` from their DOM ancestor. No prop drilling:
- `compact` — 32px rows
- `default` — 40px rows
- `comfortable` — 48px rows

### 3.4 CSS Keyframes

Six custom animations: `price-flash-up`, `price-flash-down`, `breakout-pulse`, `vix-warning-pulse`, `celebration-pulse`, `shimmer-border`. All respect `prefers-reduced-motion`.

### 3.5 Regime-Reactive UI

`RegimeProvider` wraps the `(dashboard)` layout. It reads `UIStore.activeRegime` and injects `--aurora-regime-a` CSS variable for the shell aurora background (1200ms CSS transition). `RegimeSync` (India) and `CryptoRegimeSync` bridge their market stores into UIStore without direct coupling.

### 3.6 UIStore

`src/store/uiStore.ts` — Zustand v5, persists to localStorage:

```ts
sidebarCollapsed: boolean    // persisted: af-ui-sidebar-collapsed
tableDensity: Density        // persisted: af-ui-table-density
activeRegime: MarketRegime
commandPaletteOpen: boolean  // blocks body scroll when open
chartFullscreen: boolean
radarVisible: boolean
```

### 3.7 Trading Component Library

Located in `src/components/trading/`:

| Component | Purpose |
|---|---|
| `SignalBadge` | LONG / SHORT / BUY / SELL / WAIT with IIT tokens + icon |
| `ConfidenceBar` | 0–100 gradient fill with optional numeric label |
| `RegimeBadge` | BULL / BEAR / SIDEWAYS / HIGH_VOL with regime tokens + SPRING_MICRO entrance |
| `NumberMorph` | Framer Motion number interpolation; magnitude-scaled duration (120ms–360ms) |
| `StatGrid` | Responsive grid of stat cells (`--font-label` keys + `--font-data` values) |
| `PanelHeader` | 40px fixed row: title + optional badge + optional right-slot |
| `RiskMeter` | Segmented bar (green / yellow / red); horizontal or vertical |
| `AiRadar` | TanStack Table v9; hover detail panels; multi-column sort; keyboard nav |

### 3.8 Layout Primitives

Located in `src/components/layout/`:

| Component | Purpose |
|---|---|
| `BentoGrid` + `BentoCell` | 12-column CSS grid; `data-bento-cell` for mobile reflow priority |
| `PageHeader` | `<h1>` + optional subtitle + optional regime badge |
| `EmptyState` | Centered Lucide icon + heading + description + optional action |
| `ErrorState` | Red-tinted error + "Retry" → nearest TanStack Query `refetch()` |
| `PageTransition` | SPRING_GENTLE fade-from-below entrance for page default exports |

### 3.9 3D Suite

All 3D components use `next/dynamic` with `ssr: false` and skeleton loading states:
- `MarketIntelligenceCore` — quality prop (low/medium/high); `useReducedMotion()` halts frame updates
- `RiskSphere` — R3F sphere; color + scale + opacity encode portfolio risk 0–100
- `PortfolioGalaxy` — R3F `Points` particle system; Fibonacci sphere; particle size = position size; color = P&L sign

---

## 4. Core Architecture

### 4.1 Data Flow

```
Browser
  └── Zustand stores (UIStore + market stores)
        ↑ WebSocket (broker adapter)
        ↑ TanStack Query (polling REST routes)

Next.js Route Handlers (Node runtime)
  └── cached(key, ttl, fn) → Redis → provider adapter → response

Background Worker (tsx, separate process)
  └── Scheduler (non-overlapping tick) → jobs → DB + Redis

ML Microservice (FastAPI, port 8100)
  └── Prediction endpoints ← HTTP from Next.js route handlers
```

### 4.2 Broker Adapter Pattern

```ts
interface BrokerAdapter {
  getTicker(symbol): Promise<Ticker>
  getKlines(symbol, interval, limit): Promise<Candle[]>
  fetchKlinesRange(symbol, interval, start, end): Promise<Candle[]>
  getFundingRate(symbol): Promise<number>
  getOpenInterest(symbol): Promise<number>
  getLongShortRatio(symbol): Promise<LongShortRatio>
  getAllFuturesTickers(): Promise<Ticker[]>
  createTickerWS(symbol): WebSocketFactory
  createLiquidationWS(): WebSocketFactory
  capabilities: BrokerCapabilities
}
```

Active broker resolved from `ACTIVE_BROKER` env var (`delta` or `binance`). The `capabilities` flags let signal/alert pipelines handle feature gaps without special-casing the broker ID.

### 4.3 Redis Usage

- API response caching (`cached(key, ttl, loader)`)
- WebSocket snapshots (last tick per symbol)
- Rate limit protection
- Liquidation rolling buffer (sorted sets, `liq:rolling:{PAIR}`)
- Atomic trade guard (`SET key value NX EX` — exactly-once execution)
- Option chain health tracking (`india:oc-capture:last-success-ms`)
- Indicator state snapshots for worker warm-start
- Alert cooldown keys
- Experiment results

### 4.4 Auth

Auth.js v5 with Credentials provider + JWT sessions. `src/proxy.ts` protects routes via the `authorized` callback. API keys stored AES-256-GCM encrypted; `src/lib/crypto.ts` owns the key operations.

---

## 5. Indian Market Data Layer

`src/lib/market-data/` — provider-agnostic, single canonical type system for all Indian market data.

### 5.1 Provider Priority Chain

```
Angel One SmartAPI (1)  →  Upstox Analytics v2 (2)  →  NSE direct (3)  →  Yahoo Finance (4)
```

| Provider | File | Capabilities |
|---|---|---|
| Angel One SmartAPI | `providers/angel-one.ts` | Quotes, historical, option chain, live stream, instrument master |
| Upstox Analytics v2 | `providers/upstox.ts` | Quotes, historical, option chain |
| NSE direct | `providers/nse.ts` | Option chain, quotes (cookie-warmed scraper) |
| Yahoo Finance | `providers/yahoo.ts` | Historical OHLCV, quotes (no derivatives) |

When a provider's env vars are absent, it is silently registered as `enabled: false` — no degradation.

### 5.2 Failover Engine

`withFailover(capability, fn, context?)` — wraps any provider call:
1. Retries up to 3× within the current provider with exponential backoff (300ms base, 5s cap, 20% jitter)
2. Fails over to the next provider in priority order
3. 10s cooldown prevents provider oscillation
4. Every failover emits a structured log event (`from`, `to`, `reason`, `attempt`)

### 5.3 Circuit Breaker

Health scores start at 100. Each consecutive failure subtracts up to 40 pts; each success recovers 10 pts. Auth failures add an extra −25 pt penalty. Circuit opens at < 20 pts, attempts half-open after 30s.

### 5.4 Canonical Types

`src/lib/market-data/types.ts` — the single source of truth:

```ts
type ProviderId = "angel_one" | "upstox" | "nse" | "yahoo"
type Exchange = "NSE" | "NFO" | "BSE" | "BFO" | "MCX" | "CDS"
type MDQuote      // normalized quote: ltp, OHLCV, OI, 52W, circuits, depth
type OHLCVCandle  // OHLCV + interval + UTC timestamp
type OptionChain  // per-strike CE/PE with greeks + PCR/max-pain/ATM IV analytics
type LiveTick     // normalized streaming tick: LTP, OI, bid/ask
```

### 5.5 CandleBuilder Service

`src/lib/market-data/services/candle-builder.service.ts` — real-time OHLCV candle assembly:
- Assembles candles for all 8 NSE-aligned timeframes: `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `1h`, `1d`
- All bar boundaries aligned to **09:15 IST** (NSE open), never Unix-epoch midnight
- Redis-backed active candle state — mid-bar restart recovery
- Confirmed candles upserted to `CandleBar` table (idempotent)
- Configurable late-tick tolerance (default 2s); closed candles never mutated
- Backfill gap detection on reconnect; caller-supplied `loader` fills gaps

### 5.6 Validation

`candle-validator.ts` — rejects zero/negative prices, `high < low`, `close` outside `[low, high]`.
`tick-validator.ts` — rejects negative LTP, future timestamps (> 5s ahead), extreme single-bar moves (> 20%).

### 5.7 Angel One SmartAPI Integration

Beyond the data layer, the Angel One adapter (`services/india/angelone/`) provides:
- **First-party F&O scanners** — gainers/losers, PCR, OI buildup from the `marketData/v1/` API
- **Full option greeks** — delta, gamma, theta, vega per strike (not just IV)
- **Real ΔOI** — diffs live OI against a session-open baseline cached until midnight IST
- **FULL-mode quotes** — OI, 52W high/low, daily circuit limits, order-book imbalance ∈ [−1, 1]
- **SmartStream WebSocket 2.0** — binary tick stream; decodes LTP/Quote/SnapQuote little-endian frames; exponential-backoff reconnect; falls back to 5s FULL-quote poll on failure
- **Read-only account layer** — funds/margin, holdings, net positions (all number-typed, string-parsed)
- **BSE (BFO) option chain** — for SENSEX expiry-day Gamma Blast / Hero Zero plays

---

## 6. AI Signals Engine

### 6.1 Architecture

```
features/ai-signals/engine.ts     — pure, deterministic helpers (no I/O)
features/ai-signals/crypto-builder.ts  — getCryptoAiSignals()
features/ai-signals/india-builder.ts   — getIndiaAiSignals()
app/api/ai-signals/route.ts        — Crypto AI Signals endpoint
app/api/in/ai-signals/route.ts     — India AI Signals endpoint
```

The engine is cross-market. Both builders call the same pure helpers:

```ts
compositeScore(factors, coverage)
classifyAction(score, minMagnitude)
gradeFromConfidence(confidence)
calibrateWinProbability(confidence)   // Platt-scaled, [0.28, 0.82]
buildTakeProfits(entry, atr, horizon) // TP1/TP2/TP3 + scale-out allocations
buildTradeLevels(entry, atr, direction)
buildTimingWindow(horizon)            // enterBy + exitBy + live countdown
buildReasons(factors)                 // top-6 confluence factors
suggestPositionSizePct(confidence, horizon, atr, entry)
```

### 6.2 Every Signal Carries

- **Action** — `LONG | SHORT | BUY | SELL | WAIT`
- **Confidence** — 0–100 + grade (S / A / B / C / D)
- **Win probability** — Platt-calibrated, never pretends certainty
- **Entry zone** — point entry ± 0.25×ATR
- **ATM strike** — nearest tradeable instrument (from live NSE chain for India)
- **TP1 / TP2 / TP3** — ATR-multiple ladder with 50% / 30% / 20% scale-outs
- **Stop loss** — ATR-sized, with explicit invalidation criteria line
- **Risk:Reward** — per-TP and blended
- **Position sizing %** — 1% risk budget, horizon-capped
- **Time horizon** — `scalp | intraday | swing | positional`
- **Timing window** — `enterBy` + `exitBy` + live countdown; "Stale" badge on expiry
- **AI rationale** — top-6 factors with category chips (Tech / Deriv / Sent / Macro / News / Flow)

### 6.3 Crypto Engine (9 factors)

RSI(14), MACD histogram, EMA 20/50 spread, volume thrust, funding rate (inverted), OI 1h Δ, long/short ratio (inverted), liquidation imbalance, Fear & Greed (inverted). Session quality bonus from the IST Best-Time engine.

### 6.4 India Engine v2 — `alphaforge-ai-v2` (10+ factors)

| Factor | Notes |
|---|---|
| Daily SMA 20/50/200 trend stack | Price vs each SMA; directional bias |
| RSI(14) | Wilder method |
| 5-day momentum | % change |
| Volume thrust | Today vs 20d average |
| PCR (OI) | Angel One first-party or chain-derived; put-writing = bullish |
| ATM IV | Inverted — elevated IV crushes options post-move |
| ΔPE-CE OI build-up | From live NSE option chain |
| Max-pain pull | Distance from spot to max-pain strike |
| Scanner agreement | Cross-references all 6 F&O scanners |
| NSE session quality | Forces WAIT outside 09:15–15:30 IST |
| Super Confluence | UT Bot + AI Neural (HMA) + SMC BOS/CHoCH + EMA 9/15/21 |

**Quant pre-filter gate** — ADX ≥ 18, relative volume ≥ 1.1×, ATR% ≥ 0.4%; failures get −18% confidence penalty. Index underlyings always pass.

**ML regime blending** — 65% heuristic + 35% Python ML service.

**ML stock rank boost** — top-20 ML-ranked stocks earn up to +0.06 confidence; bottom stocks up to −0.06.

**Flow-factor confidence bonus** — up to +0.08 when scanner + futuresScreen + volume + oiBuildup + dayChange are all available.

### 6.5 v2 Threshold Changes

| Parameter | Old | New |
|---|---|---|
| WAIT threshold | 0.18 composite magnitude | **0.22** |
| Grade S | ≥ 0.85 | ≥ **0.82** |
| Grade A | ≥ 0.72 | ≥ **0.68** |
| Grade B | ≥ 0.58 | ≥ **0.54** |
| Win probability offset | 0.35 | **0.38** |
| Low-risk confidence floor | ≥ 0.62 | ≥ **0.68** |

---

## 7. Daily Picks & Auto Paper-Trading

### 7.1 Daily Picks

`/in/daily-picks` — five buckets, top 3 per bucket, frozen at 09:15 IST:

| Bucket | Source | Logic |
|---|---|---|
| **Indices Scalping** | F&O index underlyings only | OI build-up + PCR + max-pain + intraday momentum |
| **Opening Breakout** | `opening-breakout.ts` strategy | First 5-min candle ORB; lazy-frozen after retest |
| **Highly Momentum** | AI universe + F&O stocks | SMA trend stack + 5d momentum + volume thrust |
| **Highly Scalping** | AI universe + F&O stocks | Expected range + R:R ≥ 1.5 + scanner agreement |
| **Highly Potential** | AI universe + F&O stocks | Confidence + win-probability + blended R:R |

Bucket quality floors (v2):
- MOMENTUM: confidence ≥ 0.25 + dayChange ≥ 0.30
- SCALPING: confidence ≥ 0.22 + R:R ≥ 1.5 + dayChange ≥ 0.30
- POTENTIAL: confidence ≥ 0.28 + breakout ≥ 0.25

**Every pick ships**: entry / stop / target / can-move-upto / can-expect / logic / timing.

**Lifecycle**: OPEN → TARGET_HIT / STOP_HIT / CLOSED (force-squared at 15:30 IST if unresolved). Timing fields: `generatedAt` (appeared on board) and `resolvedAt` (how long it took).

**Pre-market guard**: no picks before 09:15 IST. Stale pre-market rows auto-evicted on first post-open request.

**Engine architecture**:
- `src/features/india/daily-picks/engine.ts` — pure functions (bucketScores, selectDailyPicks, trackPick, groupDailyPicks). No I/O.
- `src/features/india/daily-picks/builder.ts` — `getIndiaDailyPicks()` (freeze-or-track) + `getIndiaDailyPicksHistory()`. DB-resilient: degrades to ephemeral live picks when Postgres is down.
- `worker/src/jobs/india-daily-picks.ts` — 5-min cadence, market-hours gated. Both the worker and the on-read path are idempotent.

### 7.2 Expiry-Day Plays (Gamma Blast / Hero Zero)

Rendered on `/in/daily-picks` **only** on a NIFTY (Tuesday) or SENSEX (Thursday) expiry day:

- **Gamma Blast** — Buy ATM option in trend direction. ~2.2× target / 50% hard stop. Maximal gamma with one expiry session of theta left.
- **Hero / Zero** — Buy far-OTM (3 strikes out) lottery. ~5× target / stop at 0.

NIFTY expiry + premiums from the live NSE chain. SENSEX from the live BSE (BFO) chain via Angel One, with a spot + India VIX Black-Scholes estimate fallback.

### 7.3 Intelligent Auto Paper-Trading Engine

Runs via `worker/src/jobs/india-auto-trader.ts`:

**Signal scoring formula:**
```
score = 0.35×confidence + 0.25×winProbability + 0.25×grade + 0.15×R:R
```

**Rules:**
- Score threshold ≥ 0.52 (eliminates low-conviction setups)
- Daily ₹1,00,000 budget — max 5 positions × ₹20,000 notional
- Risk gate: stop distance / entry ≤ 2.5%
- No new entries after 14:45 IST
- All positions closed at 15:30 IST
- Every candidate routed through the **12-stage Opportunity Pipeline** before execution
- `IndiaDaySession` table tracks daily budget utilisation and session P&L
- Analytics at `GET /api/in/paper-trade/analytics?range=1d|7d|15d|30d|6mo|1y|all`

---

## 8. Opportunity Engine (12-Stage Pipeline)

`src/lib/opportunity-engine/` — sits between raw AI signals and paper trade execution. Every candidate signal passes all 12 stages before a paper trade is opened.

```
Stage 1   Universe Coverage Validation
Stage 2   Market Context Snapshot (NIFTY trend, VIX, breadth, VWAP)
Stage 3   Multi-Layer Signal Evaluation (12 layers; VETO from any = rejection)
Stage 4   Derivatives Intelligence (OI freshness, chain quality, flow classification)
Stage 5   Signal Quality Vector (14 independently-inspectable components)
Stage 6   Expected Value (EV = P(win)×E[win] − P(loss)×E[loss] − costs − slippage)
Stage 7   Opportunity Clustering (correlated signals → one cluster; geometric mean confidence)
Stage 8   Conflict Resolution (BUY | SELL | WAIT | NO_TRADE)
Stage 9   Abstention Evaluation (15 explicit abstention reasons)
Stage 10  Risk Check (Portfolio Risk Engine v2 pre-trade check)
Stage 11  Position Sizing (base × confidence × vol × correlation × drawdown)
Stage 12  Execution Mode Isolation (BACKTEST | RESEARCH | SHADOW | PAPER | LIVE)
```

**Pipeline versions**: `PIPELINE_VERSION = "opportunity-engine-v1"`, `FEATURE_VERSION = "fv1.0"`, `POLICY_VERSION = "pv1.0"`.

**OPP-001 fix**: The pipeline pre-fetches real 1-year daily OHLCV for every candidate (Angel One → Upstox → Yahoo failover) before the pipeline loop, providing real ATR, RSI, SMA20/SMA50, average volume, and regime detection.

**API routes**: `GET /api/in/opportunity-engine`, `/calibration`, `/attribution`, `/regime`, `/[opportunityId]`.

---

## 9. Signal Intelligence Engine (45-Phase)

`src/lib/signal-intelligence/` — measurement and attribution infrastructure. Does not add new strategies. Instruments existing ones so the system can answer what works, what doesn't, and why.

### 9.1 Modules

| Module | Key Exports |
|---|---|
| `types.ts` | `EnrichedSignal` (40 fields), `SignalQualityVector`, `ExpectedValueEstimate`, `OpportunityCluster`, all shared types |
| `signal-source-registry.ts` | `SignalSourceRegistry` — validates source IDs; classifies into `SignalReportingBucket`; only 9 official strategies are leaderboard-eligible; `AI_SIGNAL` = `MANUAL`, never `STRATEGY` |
| `fno-universe.ts` | `FNOUniverseService` — canonical ~200 stock + 4 index universe; `buildUniverseCoverageSnapshot()` — session INVALID when coverage < 80% |
| `market-context-engine.ts` | `buildMarketContextSnapshot()` — NIFTY trend, VIX regime, A/D breadth, opening range, VWAP, gap; `scoreContextAlignment()` → [−1, 1] |
| `multi-layer-engine.ts` | 12-layer architecture (MARKET_CONTEXT → EXECUTION); VETO from any layer = immediate rejection; `aggregateLayerResults()` weighted composite |
| `derivatives-intelligence.ts` | OI buildup classification (LONG_BUILDUP → UNCLASSIFIED; freshness guard 15min); options flow labels (OBSERVATION / INFERENCE / HIGH_CONFIDENCE_INFERENCE); expiry context |
| `signal-quality-vector.ts` | 14-component `SignalQualityVector`; `computeExpectedValue()` with Platt-calibrated win probability (35% shrinkage); `gradeSignal()` (A_PLUS / A / B / C / REJECT); `evaluateAbstention()` — 15 explicit reasons |
| `conflict-resolver.ts` | `resolveSignalConflict()` → BUY/SELL/WAIT/NO_TRADE; `clusterSignals()` — anti-double-counting (ORB + Momentum + Volume Breakout on same event = ONE cluster) |
| `signal-lifecycle.ts` | State machine: DETECTED → VALIDATING → QUALIFIED → RISK_CHECK → APPROVED → PAPER_EXECUTED → ACTIVE → EXITED/EXPIRED/REJECTED; all transitions persisted; invalid transitions throw |
| `paper-trading-fidelity.ts` | `computePaperFill()` — realistic execution (mid + half-spread + market impact + latency drift); 8-stage signal funnel; deterministic `computeReplayHash()` |
| `strategy-scorecard.ts` | `buildScorecardEntry()` — 16 required metrics per strategy; `evaluateProductionGates()` — 8 mandatory gates for LIVE_CANDIDATE |

### 9.2 Production Guard (8 Gates for LIVE_CANDIDATE)

Positive backtest P&L satisfies **none** of these:

1. Minimum sample size (≥ 30 resolved trades)
2. Out-of-sample validation
3. Walk-forward stability
4. Cost sensitivity (profitable at 2× base cost)
5. Regime coverage (≥ 3 distinct regimes)
6. Calibration (Brier score < 0.25)
7. Paper trading evidence (≥ 10 sessions)
8. Execution quality (≥ 0.70)

### 9.3 Strategy Status

All 9 official India F&O strategies are currently `INSUFFICIENT_EVIDENCE`. That is the correct and expected state — no fabricated promotions.

### 9.4 New DB Models

| Model | Purpose |
|---|---|
| `SignalLifecycleEvent` | Full state-machine audit trail; enables deterministic replay |
| `UniverseCoverageSnapshot` | Per-session coverage; session validity gate |
| `OpportunityCluster` | Correlated signal groups for anti-double-counting |
| `SignalIntelligenceRecord` | Full 40-field enriched signal envelope |

---

## 10. V6 Quant Research Platform (24-Phase)

`src/lib/research/` — a scientifically rigorous evidence-based research infrastructure. The most important architectural shift in the project's history.

### 10.1 Absolute Rules (enforced in code)

1. **No in-sample promotion** — `PerformancePeriod.IN_SAMPLE` metrics are computed but the promotion engine ignores them
2. **LIVE requires human approval** — `MANUAL_HUMAN_APPROVAL` gate cannot be bypassed; `approvalToken` + `approvedBy` always required
3. **Temporal leakage throws** — `validateSplitIntegrity()` throws `Error` on any IS/OOS overlap
4. **Experiments are immutable** — `ExperimentStore.add()` throws on duplicate `experimentId`
5. **Kill switches never auto-remove** — require explicit `deactivateKillSwitch()` call
6. **No strategy outside the registry** — `getOrThrow()` enforced at all API entry points

### 10.2 Strategy Promotion Lifecycle

```
EXPERIMENTAL  →  hypothesis required
RESEARCH      →  backtest pipeline
BACKTEST_VALIDATED  →  OOS Sharpe ≥ 0.3, ≥ 30 trades, positive expectancy, DD < 30%, cost-profitable
WALK_FORWARD_VALIDATED  →  OOS Sharpe ≥ 0.5, not overfit, MC not FRAGILE, not COST_FRAGILE
SHADOW        →  ≥ 10 shadow trades, Sharpe ≥ 0.3, decay not CRITICAL
PAPER         →  ≥ 20 paper trades, positive expectancy, DD < 25%, no material backtest drift
LIVE_CANDIDATE  →  ≥ 20 sessions, paper Sharpe ≥ 0.6, PF ≥ 1.2, decay HEALTHY
MANUAL_APPROVAL  →  human review
LIVE          →  explicit approvalToken + approvedBy — never automatic
```

### 10.3 Research Platform Modules (24 Phases)

| Phases | Module | Key Feature |
|---|---|---|
| 1–2 | Registry + Hypothesis | 18 strategies; falsifiable hypotheses; strategies without hypothesis blocked at EXPERIMENTAL |
| 3–4 | Datasets + IS/OOS | SHA-256 fingerprinted datasets; `validateSplitIntegrity()` throws on leakage; 15 dedicated leakage tests |
| 5–6 | Performance + Costs | 35 metrics per period (Sharpe, Sortino, Calmar, t-statistic, SQN, Ulcer Index...); 1×/1.5×/2×/3× cost stress; `COST_FRAGILE` blocks promotion |
| 7–8 | Regime Attribution | Per-regime Sharpe/PF/WR per strategy; Strategy×Regime matrix (colour-coded Sharpe) |
| 9 | Correlation | Full N×N correlation matrix; single-linkage clustering at 0.70 threshold; cluster capital allocation caps |
| 10 | Alpha Decay | 5-state machine (HEALTHY → WARNING → DEGRADED → CRITICAL → DISABLED); rolling 52-week history |
| 11 | Monte Carlo | 7 simulation types × 10,000 iterations; seeded RNG; FRAGILE blocks promotion |
| 12 | Parameter Stability | Symmetric neighbourhood testing; OVERFIT_SUSPECTED blocks promotion |
| 13 | Multiple Testing | Deflated Sharpe Ratio (Bailey & López de Prado 2014); PBO estimation; Benjamini-Hochberg FDR correction |
| 14 | Signal Calibration | Brier Score, ECE, 10-bin reliability diagram; `wellCalibrated = (ECE < 0.05)` |
| 15 | Ablation Testing | Per-component incremental OOS contribution; `LOW_VALUE_COMPONENT` flag |
| 16–17 | Promotion + Demotion | 8 demotion trigger types; automatic demotion on CRITICAL decay, DD > 40%, COST_FRAGILE |
| 18 | Confidence Score | 8-component weighted 0–100 score (HIGH_CONFIDENCE / VALIDATED / WATCH / DEGRADED / DISABLED) |
| 19 | Experiment Tracking | Immutable records with `gitCommitHash`, `datasetFingerprint`, `parameterSet` |
| 20–21 | Leaderboard + Allocation | Ranked views by configurable metric; HHI concentration; per-cluster allocation caps |
| 22 | Kill Switch | SOFT_KILL (no new trades) + HARD_KILL (emergency close); automatic triggers; never auto-removed |
| 23 | Paper Analysis | Backtest vs shadow vs paper comparison; KL divergence for regime shift; `requiresInvestigation` flag |
| 24 | Validation Sessions | ≥ 20 sessions + regime diversity before LIVE_CANDIDATE; preferred 40+ sessions |

### 10.4 Research Dashboard

Navigate to `/research` — 10 pages:

| Page | Path |
|---|---|
| Strategy Leaderboard | `/research` |
| Strategy Inventory | `/research/strategies` |
| Regime Matrix | `/research/regime-matrix` |
| Monte Carlo | `/research/monte-carlo` |
| Parameter Stability | `/research/parameter-stability` |
| Signal Calibration | `/research/signal-calibration` |
| Experiment History | `/research/experiments` |
| Strategy Correlation | `/research/correlation` |
| Promotion Pipeline | `/research/promotion-pipeline` |
| Alpha Decay Monitor | `/research/alpha-decay` |

### 10.5 Strategy Universe (18 strategies)

**Crypto (11):** UT_SMC, VWAP_SWEEP_TREND, NEWS_MOMENTUM, RANGE_SCALP, EMA_PULLBACK, VWAP_REVERSION, ORDERFLOW_SWEEP, FIB_PULLBACK, INSTITUTIONAL_SMC, AI_INSTITUTIONAL_PRO, STRATEGY_LAB_USER

**NSE F&O (7):** FNO_TREND, FNO_RANGE_EXPANSION, INDIA_MOMENTUM, INDIA_VOLUME_BREAKOUT, INDIA_OI_BUILDUP, INDIA_AI_SIGNALS (SHADOW), INDIA_SUPER_CONFLUENCE

---

## 11. Institutional Infrastructure

### 11.1 Portfolio Risk Engine v2 (`src/lib/risk/`)

8-step pre-trade evaluation pipeline running in < 1ms:

| Step | Module | Logic |
|---|---|---|
| 1 | `exposure.ts` | Gross/net/long/short exposure; per-symbol/sector/strategy concentration; correlated-long cluster guard |
| 2 | `correlation.ts` | Rolling Pearson matrix; single-linkage clustering; pre-trade cluster-breach check |
| 3 | `var.ts` | Historical VaR + Parametric (Gaussian) VaR + CVaR/Expected Shortfall |
| 4 | `drawdown.ts` | 4-tier ladder: NORMAL → CAUTION → WARNING → DANGER → HALT; per-tier size multipliers |
| 5 | `position-sizing.ts` | `qty = base × confidence × vol_factor × correlation_factor × drawdown_factor`; ATR cap + notional cap |
| 6 | `risk-limits.ts` | Per-trade/strategy/sector/portfolio budgets; SOFT_KILL auto-escalation |
| 7–8 | `portfolio-risk.ts` | SOFT/HARD kill; final approval + sizing recommendation; full audit snapshot |

### 11.2 Market Microstructure Intelligence (`src/lib/microstructure/`)

Turns raw order-book snapshots and tick stream data into execution-quality signals and ML feature vectors:

| Module | Purpose |
|---|---|
| `order-book.ts` | `OrderBookSnapshot` builder; `midPrice`, `weightedMidPrice`, `spread` |
| `imbalance.ts` | L1 / L5 / weighted-depth imbalance; `DEMAND_HEAVY / SUPPLY_HEAVY / BALANCED` |
| `spread.ts` | Rolling percentile tracker; `TIGHT / NORMAL / WIDE / EXTREME` spread regime |
| `liquidity.ts` | 5-dimension score (volume, depth, spread, OI, trade frequency) |
| `toxicity.ts` | TypeScript VPIN port; composite toxicity; confidence + sizing adjustments |
| `pressure.ts` | Bid/ask replenishment; price-response pressure (informed vs noise) |
| `index.ts` | `MicrostructureEngine` facade; `ExecQuality` (EXCELLENT/GOOD/FAIR/POOR); 1m/5m ring-buffer feature store |

### 11.3 Shadow Trading & Experiment Framework (`src/lib/experiments/`)

A/B testing and safe strategy promotion infrastructure:

| Module | Purpose |
|---|---|
| `strategy-version.ts` | `StrategyVersionRegistry`; `VersionStamp`; stage FSM (DEVELOPMENT → SHADOW → PAPER → LIVE → RETIRED) |
| `experiment-manager.ts` | Multi-arm experiments; traffic allocation; immutable audit log |
| `shadow-trader.ts` | Per-arm fill simulation (SHADOW: in-memory / PAPER: DB writes); EOD sweep |
| `comparison.ts` | Welch t-test; Satterthwaite df; p-value; 95% CI on mean return difference; Cohen's d sample size |
| `promotion.ts` | SHADOW → PAPER → LIVE; LIVE always requires human approval; single-use cryptographic tokens (32 bytes, 10-min expiry) |

API: `GET /api/experiments` · `GET /api/experiments/[id]` · `POST /api/experiments/[id]`.

### 11.4 Event-Driven Backtesting Engine (`src/lib/backtesting-v2/`)

Institutional-grade NSE F&O backtester. Parallel to the existing strategy backtester — additive, existing strategies untouched.

| Layer | Key Components |
|---|---|
| `events/` | Typed discriminated-union bus: MarketEvent → SignalEvent → RiskCheckEvent → OrderEvent → FillEvent → PositionEvent |
| `models/` | `Portfolio`, `Position`, `OrderBook`, `Trade` — pure, no I/O |
| `engine/` | `SimulationClock` (NSE calendar: weekly/monthly expiry, IST gate, holiday filtering); `EventQueue`; `EventEngine`; `DefaultRiskManager` |
| `execution/` | India-specific: instrument-aware slippage (spread + √impact + ATR + OTM penalty); full NSE brokerage (STT + exchange fee + GST + SEBI + stamp); 3 latency profiles; 4 order types with partial fills + gap-through-stop |
| `analytics/` | CAGR, Sharpe, Sortino, Calmar, MaxDD; equity curve; `AttributionReport` (strategyId + modelVersion + featureVersion + marketRegime + dataQualityScore per trade) |
| `adapter/` | `india-price-adapter` (→ HistoricalService); `strategy-adapter` (wraps existing F&O strategy modules) |

**Conservative tie-break**: a bar touching both stop and target is always recorded as a stop. Consistent across all paper-trading resolvers in the codebase.

---

## 12. ML Microservice

`ml-service/` — Python 3.11, FastAPI, port 8100.

### 12.1 Model Stack

| Model | Algorithm | Purpose |
|---|---|---|
| Market Regime Classifier | XGBoost | 6 regimes: Strong Bull / Bull / Sideways / Volatile / Bear / Crash |
| Stock Ranker | LightGBM | Outperformance probability for 200+ F&O stocks |
| Strategy Selector | CatBoost | Best strategy per regime (9 strategies) |
| Risk Predictor | XGBoost ×3 | P(stop hit), P(target hit), expected drawdown |
| Portfolio Optimizer | Riskfolio-Lib | HRP + CVaR-constrained allocation |
| RL Executor | PPO (SB3) | Entry/exit timing, trailing stops, position sizing |
| Price Forecaster | TFT heuristic | 1-hour price regime forecast (EXPERIMENTAL) |
| IV Regime Classifier | Heuristic | CRUSH / STABLE / SPIKE |
| Meta Decision Engine | Platt + isotonic | Combines all 7 base models with regime-aware ensemble weighting |
| Greeks Engine | Black-76 / Black-Scholes | Delta/gamma/theta/vega + Newton-Raphson IV solver |
| GEX Engine | Pure Python | Dealer GEX per strike; gamma flip; expected daily move |
| IV Surface | SVI (scipy L-BFGS-B) | Vol smile + term structure |
| VPIN | Tick-rule buckets | Toxic order-flow score [0, 1] |

### 12.2 Feature Engineering (150+ features, TA-Lib backed)

- **Technical** — RSI, MACD, ADX, ATR, Bollinger, EMA stack (8/13/21/55/200), Stochastic RSI, CCI, MFI, OBV, Supertrend; 6 candlestick patterns (CDLENGULFING, CDLHAMMER, CDLDOJI...); HT_TRENDLINE deviation
- **Volume** — Relative volume, VWAP distance, volume profile, VPIN order-flow score
- **Momentum** — Multi-period returns (1/2/3/5/10/20/60d), sector relative strength (stock 20d return vs sector peer avg), ATR expansion, breakout score
- **Derivatives** — PCR, OI build-up (4 quadrants), IV rank/percentile, max-pain distance, OI wall proximity
- **Market Structure** — FVG, Order Blocks, BOS/CHoCH, liquidity sweeps
- **Macro** — Market breadth, A/D ratio, sector rotation, VIX regime, time-of-day, expiry effects

### 12.3 Meta Decision Engine (`ml-service/src/meta/`)

| Module | Purpose |
|---|---|
| `calibration.py` | Platt scaling + isotonic regression; `CalibrationStore` (ECE/MCE/Brier) |
| `ensemble.py` | `REGIME_WEIGHTS` table (6 regimes × 7 models); disagreement metrics (variance, spread) |
| `abstention.py` | 7 trigger conditions; `WAIT` (skip bar, retry next) vs `NO_TRADE` (system not ready) |
| `decision_policy.py` | 5-component `ConfidenceDecomposition`; `ReasonCode` audit trail |
| `meta_model.py` | End-to-end: parallel model calls → calibration → ensemble → abstention → decision |

### 12.4 ML Validation Framework (`ml-service/src/validation/`)

Replaces all random train/test splits with López de Prado methodology:

| Module | Purpose |
|---|---|
| `walk_forward.py` | Rolling + expanding window; `_validate_fold_integrity()`; fold manifest persistence |
| `embargo.py` | Bars/minutes/days embargo; `purge_train_indices_by_t1()` |
| `purged_kfold.py` | `PurgedKFold(BaseCrossValidator)` — sklearn-compatible drop-in |
| `combinatorial_cv.py` | CPCV — all C(N,k) purged+embargoed folds |
| `metrics.py` | Sharpe, Sortino, Calmar, SQN, PSR, **DSR (Deflated Sharpe Ratio)** |

### 12.5 Model Monitoring (`ml-service/src/monitoring/`)

16 FastAPI endpoints under `/monitoring/*`:

| Module | Detects |
|---|---|
| `drift_detector.py` | PSI < 0.1 stable / 0.1–0.2 minor / > 0.2 major drift; KS + p-value; Jensen-Shannon [0,1] |
| `feature_monitor.py` | Per-(model, feature) rolling deque; auto-trigger on window fill |
| `performance_monitor.py` | Brier score, ECE, accuracy, log-loss, trading expectancy; exponential decay weighting |
| `model_registry.py` | HEALTHY → WARNING → DEGRADED → DISABLED; ensemble weights auto-adjusted |
| `alerts.py` | Structured alerts (structlog); `dispatch_external()` hook; severity/category filtering |

### 12.6 Training Data Pipeline

Three-tier `MarketDataClient` (`ml-service/src/training/market_data_client.py`):
1. **AlphaForge API** (`ALPHAFORGE_API_BASE_URL`) — canonical first-party source (Angel One + Upstox backed)
2. **PostgreSQL** (`DATABASE_URL`) — direct query of `OptionChainSnapshot` + `CandleBar` tables
3. **yfinance** — last-resort OHLCV-only fallback

`DataQuality` classification — GOOD / STALE / INVALID / SUSPICIOUS — filters rows before feature engineering. `DatasetMetadata` written alongside every `.npz` file for full reproducibility.

```bash
# Start ML service
docker compose up -d

# Or run locally
cd ml-service
pip install -r requirements.txt
uvicorn src.server:app --port 8100 --reload

# Generate training data and train
python -m src.training.data_pipeline --start 2023-01-01 --end 2026-07-31
python -m src.training.train_all
```

---

## 13. Strategy Catalogue

### 13.1 Crypto Scalping Strategies (10)

| ID | Name | Trigger | ATR Stop | ATR Target |
|---|---|---|---|---|
| `UT_SMC` | UT Bot + SMC | ATR trailing-stop flip + BOS/CHoCH structure | 1× | 2× |
| `VWAP_SWEEP_TREND` | VWAP Sweep + Trend | EMA50 trend + liquidity sweep + VWAP stretch ≥ 0.8×ATR | VWAP reversion | VWAP |
| `NEWS_MOMENTUM` | News Momentum | Volume ≥ 2.8× avg + range ≥ 1.8×ATR + decisive body | 1× | 2× |
| `RANGE_SCALP` | Range Scalp | Bollinger touch + RSI extreme + range tightness ≤ 4.5×ATR | 0.5× | Bollinger mid |
| `EMA_PULLBACK` | EMA Pullback | 9/20/50 EMA stack + pullback into 9–20 zone + confirmation | 1× | 2× |
| `VWAP_REVERSION` | VWAP Reversion | Price ≥ 1.5×ATR from VWAP + RSI rolls off extreme | 1× | VWAP |
| `ORDERFLOW_SWEEP` | Orderflow Sweep | Equal highs/lows sweep + volume ≥ 1.8× + rejection close | 0.5× | 2× |
| `FIB_PULLBACK` | Fib Pullback | 1m impulse ≥ 3×ATR + retrace into 0.5–0.618 fib | 0.5× | Impulse extreme |
| `INSTITUTIONAL_SMC` | Institutional SMC | 9-component score ≥ 7 + trend + VWAP + sweep + BOS all present | 0.25× | 2× |
| `AI_INSTITUTIONAL_PRO` | AI Institutional Pro v5 | Hard gates (EMA trend + HTF + RSI + cooldown) + 8-factor score ≥ min; mode preset adapts to timeframe | Per preset | Per preset |

### 13.2 India NSE F&O Strategies (9)

| ID | Category | Trigger | Source |
|---|---|---|---|
| `RANGE_EXPANSION` | Breakout | WR8 range expansion + bullish trend | Scanner |
| `MOMENTUM` | Momentum | F&O movers by % change | Scanner |
| `VOLUME_BREAKOUT` | Breakout | Volume ≥ 1.5× avg + price quartile | Scanner |
| `OI_BUILDUP` | Options Flow | ΔOI × price direction; 4-quadrant classification | Scanner |
| `PCR_EXTREME` | Options Flow | Contrarian PCR extremes | Scanner |
| `IV_SPIKE` | Volatility | IV crush/spike detection | Scanner |
| `LIQUIDITY_EDGE` | Liquidity | 8-module ILE-Pine port: sweep detector + OI walls + max-pain + gap-fill + session timing + VIX regime + confluence score 0–10 | Positioning |
| `MAX_PAIN_GRAVITY` | Liquidity | IMPG-Pine port: max-pain gravity + OI-wall fade + pinning zone reversion + gap-fill toward PDC | Positioning |
| `OPENING_BREAKOUT` | Breakout | First 5-min candle ORB; entry on retest; PCR/OI/max-pain confirmation; 2R target | Standalone |

### 13.3 Super Confluence Engine

Port of the "Super Confluence Engine" Pine Script. Four gates must all agree:
1. **UT Bot ATR Trailing Stop** — keyValue=1, atrPeriod=10 (LuxAlgo port)
2. **AI Neural Trend Line** — HMA-smoothed adaptive trailing stop (speed=14, mult=2.0)
3. **SMC Swing Structure** — BOS/CHoCH pivot bias (pivotLen=50)
4. **EMA 9/15/21 stack** — all three in correct order

Score ∈ [−1, 1]: full 4-way confluence = ±1.0, 3/4 = ±0.75, 2/4 = ±0.5. Used as a confidence factor (weight 0.10) in the India AI signal engine. Accessible via the `🔥 SC` toolbar button on the price chart.

### 13.4 FnO Trend Scanners (14-condition Chartink port)

Bullish conditions: EMA(5) > SMA(20), WMA(10) > SMA(20), ADX DI+(14) > 20, ADX(14) > 20, Volume > 1L, MACD Line > 0, Close > prior/2d close, Close > SMA(50), Close > ₹150, DI+ > DI−, RSI > 50, MACD > Signal, SMA(20) > SMA(40). Bearish = exact mirror.

ATR(14)-based entry/SL/TP1/TP2/TP3 on every hit (intraday profile: SL = 1.4×ATR, TP1 = 1.6×ATR, TP2 = 2.6×ATR, TP3 = 4.0×ATR). Results persisted to `FnoTrendScan` table with TARGET_HIT / STOP_HIT / CLOSED outcome tracking.

---

## 14. Worker Jobs

All 13 jobs in `worker/src/jobs/`:

| Job | Cadence | Purpose |
|---|---|---|
| `india-auto-trader` | 60s, market hours | Signal scoring → Opportunity Pipeline → paper trade execution |
| `india-daily-picks` | 60s, market hours | Freeze top-3 picks at 09:15; track all day; square off at 15:30 |
| `india-scanner` | Per tick | 6 F&O scanners (range-expansion, momentum, volume-breakout, OI-buildup, PCR-extreme, IV-spike) |
| `india-oc-capture` | 5min, market hours | Option chain snapshots → `OptionChainSnapshot` table; staleness health check |
| `india-scalper` | Per tick | 9 F&O strategies; persists `CandleBar` rows after each candle fetch (RCA-001 fix) |
| `india-eod-squareoff` | 15:30 IST | Force-close all open India paper trades; finalise `IndiaDaySession` |
| `india-fno-trend-track` | 60s, market hours | Track 14-condition FnO trend scan outcomes |
| `scalper` | 30s | 10 crypto strategies on 1m/5m/15m; resolve OPEN rows via 1m klines |
| `signal-ingest` | Periodic | Persist new signals to `SignalHistory` (30-min per-symbol dedup) |
| `signal-outcome` | Periodic | Resolve open signals via 1m klines (HIT_TARGET / HIT_STOP / EXPIRED) |
| `alerts` | Periodic | Evaluate active alerts; Redis cooldown before fan-out |
| `liquidations` | Continuous | Binance `!forceOrder@arr` WS → Redis sorted set `liq:rolling:{PAIR}` |
| `strategy-lab` | Per fresh hourly bar | Evaluate user-saved strategy lab rules; open paper trades |

Worker lifecycle: graceful shutdown on `SIGINT`/`SIGTERM`; all jobs use a non-overlapping `Scheduler` primitive (a job skips its tick if the previous tick is still running).

---

## 15. Database Schema

18 Prisma models:

| Model | Key Fields | Notes |
|---|---|---|
| `User` | id, email, name, passwordHash | Auth.js credentials |
| `UserSetting` | userId, theme, defaultPair, broker | Per-user preferences |
| `Alert` | userId, type, condition, channels, cooldownMs | Funding/OI/price/liquidation/signal triggers |
| `Notification` | userId, alertId, message, readAt | In-app notification feed |
| `SignalHistory` | symbol, type, confidence, generatedAt, resolvedAt | Outcome tracked via 1m klines |
| `PaperTrade` | source, symbol, direction, entry, stop, target | `in:` prefix = India; `crypto:` = Crypto. Shared table |
| `Strategy` | userId, prompt, ast, live, name | Strategy lab saved strategies |
| `StrategyBacktest` | strategyId, symbol, period, stats | Latest backtest snapshot |
| `StrategyPaperTrade` | strategyId, symbol, entry, pnl | Strategy lab live paper trades |
| `IndiaDailyPick` | tradeDate, bucket, rank, entry, stop, target, status | Frozen at 09:15; resolvedAt stamped on outcome |
| `CandleBar` | symbol, exchange, interval, openTime, OHLCV, oi, confirmed | NSE-aligned; TimescaleDB-ready |
| `OptionChainSnapshot` | underlying, expiry, snapshot, timestamp | Built up by `india-oc-capture` for strategy backtesting |
| `FnoTrendScan` | tradeDate, scanType, symbol, entry, sl, tp1, tp2, tp3, status | Chartink-port scanner results |
| `IndiaDaySession` | date, budgetUsed, positionCount, pnl, winRate | Auto-trader daily tracking |
| `SignalLifecycleEvent` | signalId, fromState, toState, timestamp, reason | Full audit trail; invalid transitions throw |
| `UniverseCoverageSnapshot` | date, expected, scanned, coverage, valid | Session INVALID when coverage < 80% |
| `OpportunityCluster` | clusterId, signalIds, confidence, instrument | Anti-double-counting; geometric mean confidence |
| `SignalIntelligenceRecord` | signalId, sourceType, qualityVector, ev, grade, lifecycle | Full 40-field enriched signal |

---

## 16. API Surface

### Crypto API

| Endpoint | Purpose |
|---|---|
| `GET /api/market/overview` | Aggregated price + sentiment + signals (Redis-cached) |
| `GET /api/scalper/signals` | Live strategy signals (filterable by strategy + timeframe) |
| `GET /api/scalper/journal` | Paper trade journal (paginated, filterable) |
| `GET /api/scalper/backtest` | 5Y strategy backtest results (24h cache) |
| `GET /api/ai-signals` | Crypto AI signals (9-factor engine) |
| `GET /api/strategy-lab/strategies` | User-saved strategies |
| `POST /api/strategy-lab/strategies/:id/backtest` | Run a strategy lab backtest |
| `GET/POST /api/experiments/[id]` | Experiment lifecycle management |

### India API (`/api/in/`)

| Endpoint | Purpose |
|---|---|
| `GET /in/market-snapshot` | NIFTY indices snapshot |
| `GET /in/historical` | OHLCV candles (all providers) |
| `GET /in/option-chain` | Live NSE option chain + greeks + IV regime |
| `GET /in/scanner` | F&O scanner results (range-expansion default) |
| `GET /in/ai-signals` | India AI signals (10-factor v2 engine) |
| `GET /in/daily-picks` | Today's top-3-per-bucket picks |
| `GET /in/daily-picks/history` | Past picks with outcomes |
| `GET /in/signal-audit` | Session signal audit report + replay hash |
| `GET /in/universe-coverage` | F&O universe coverage snapshot |
| `GET /in/opportunity-engine` | Ranked opportunity pipeline output |
| `GET /in/opportunity-engine/[id]` | Single opportunity detail |
| `GET /in/gex` | Dealer GEX + gamma flip + expected move (5-min cache) |
| `GET /in/vol-surface` | SVI IV surface + term structure (5-min cache) |
| `GET /in/order-flow` | VPIN toxic order-flow (2-min cache) |
| `GET /in/top-picks` | Top 5 stocks for tomorrow (8-factor score) |
| `POST /in/paper-trade` | Open a paper trade (market-hours guarded) |
| `POST /in/scalper/close-all` | Force-close all open India trades |
| `GET /in/paper-trade/analytics` | Auto-trading analytics by range |
| `POST /in/portfolio-optimizer` | Riskfolio-Lib allocation |
| `GET /in/expiry-trades` | Expiry-day Gamma Blast / Hero Zero plays |
| `GET /in/news` | RSS feeds + sentiment |

### Research API (`/api/research/`)

13 endpoints with Zod validation and strategy registry enforcement — all documented in `CHANGES.md`.

---

## 17. Folder Structure

```
src/
  app/
    (auth)/                       /login, /signup
    (dashboard)/                  Authenticated shell — sidebar + topbar
      page.tsx                    Crypto Overview
      best-time/ options/ signals/ ai-signals/ strategies/
      paper-trading/ strategy-backtest/ strategy-lab/ heatmap/ futures/
      profile/
      in/                         India route group
        dashboard/                NIFTY Pulse + MSB signals + Top Picks + GEX + order-flow
        options/                  Option chain + IV Surface + GEX tabs
        daily-picks/              Top-3 picks + expiry trades + history
        options-workbench/        Multi-leg payoff builder
        portfolio/                Portfolio optimizer
        history/                  Unified trade history
      research/                   10-page V6 quant research dashboard
    api/                          All API routes (auth, market, scalper, experiments, in/*, research/*)
  components/
    ai-signals/                   AiSignalCard, AiSignalsBoard, AiMarketContextBanner
    dashboard/                    Sidebar (market-aware), Topbar, MarketTickerBar, MarketSwitcher
    india/                        All India UI — no cross-imports from Crypto
      msb-dashboard, charts/price-chart, options/, daily-picks/
      paper-trading/, signal-quality/, strategies/, ticker/
    trading/                      IIT component library (SignalBadge, NumberMorph, ...)
    layout/                       BentoGrid, PageHeader, EmptyState, PageTransition
    3d/                           R3F components (MarketIntelligenceCore, RiskSphere, PortfolioGalaxy)
    research/                     15 research dashboard components
    scalper/                      Crypto Strategies + Paper Trading components
  features/
    ai-signals/                   engine.ts + crypto-builder.ts + india-builder.ts
    best-time/                    Crypto IST window engine
    scalping/                     10 crypto strategies + helpers + backtest
    strategy-lab/                 Parser + backtest engine + live worker
    india/
      best-time/                  NSE session engine
      daily-picks/                Freeze/track/history engine + builder
      scalping/                   9 F&O strategies + journal + option-chain replay
      expiry-trades/              Gamma Blast / Hero Zero engine + builder
      news/                       RSS + lexicon + sentiment engine
      options-workbench/          Payoff + greeks aggregation engine
  lib/
    market-data/                  4-provider data layer + failover + circuit breaker
    signal-intelligence/          45-phase signal intelligence (12 modules)
    opportunity-engine/           12-stage validation pipeline
    research/                     24-phase V6 quant research platform
    risk/                         Portfolio Risk Engine v2 (7 modules)
    microstructure/               Market Microstructure Intelligence (7 modules)
    experiments/                  Shadow Trading + A/B experiment framework
    backtesting-v2/               Event-driven NSE F&O backtesting engine
    india/                        NSE calendar, atomic trade guard, feature validators,
                                  model governance, decision pipeline config
  services/
    brokers/                      BrokerAdapter contract + Delta/Binance adapters
    india/                        Angel One, Upstox, NSE, Yahoo adapters + SmartAPI
  store/
    uiStore.ts                    UIStore — Zustand v5 (regime, sidebar, density, ...)
    india/                        Market-scoped India stores
  hooks/india/                    useFetchPoll, useLiveQuotes, useOptionChain, ...
  types/india/                    Market / options / scanner type packs
worker/
  src/
    index.ts                      Graceful shutdown + job registry
    scheduler.ts                  Non-overlapping recurring tick primitive
    config.ts                     Env-driven tunables
    jobs/                         13 background jobs
ml-service/
  src/
    server.py                     FastAPI app
    features/                     Feature engineering (150+ features, TA-Lib backed)
    models/                       XGBoost, LightGBM, CatBoost, PPO, Riskfolio-Lib
    meta/                         Meta Decision Engine (calibration + ensemble + abstention)
    monitoring/                   Drift detection + performance tracking (16 endpoints)
    validation/                   Walk-forward + purged K-fold + CPCV
    greeks.py                     Black-76/BS greeks + IV solver
    gex.py                        Dealer GEX engine
    vol_surface.py                SVI IV surface
    training/                     Three-tier data pipeline + train_all.py
prisma/
  schema.prisma                   18 models
tests/                            Vitest suite (~3000 tests, 200+ files)
docker-compose.yml                Postgres 17 + Redis 7 + ML service
```

---

## 18. Environment Variables

### Required

```bash
DATABASE_URL=postgresql://...
AUTH_SECRET=...
ENCRYPTION_KEY=...   # 32-byte hex
```

### Crypto Broker

```bash
ACTIVE_BROKER=delta           # or: binance
NEXT_PUBLIC_ACTIVE_BROKER=delta
```

### Indian Market

```bash
# Angel One SmartAPI (primary — all data + SmartStream WS)
SMARTAPI_API_KEY=
SMARTAPI_CLIENT_CODE=
SMARTAPI_PIN=
SMARTAPI_TOTP_SECRET=    # base32 TOTP secret

# Upstox Analytics v2 (secondary)
UPSTOX_CLIENT_ID=
UPSTOX_CLIENT_SECRET=
UPSTOX_ANALYTICS_TOKEN=  # long-lived read-only bearer — sufficient for data-only use

# OpenAlgo (33+ broker adapter)
OPENALGO_BASE_URL=
OPENALGO_API_KEY=        # AES-256-GCM encrypted
LIVE_TRADING_ENABLED=    # Must be exactly "true" to enable placeOrder

# Cache and worker
REDIS_URL=redis://localhost:6379
INDIA_REDIS_PREFIX=fno-pulse:
INDIA_BROKER=yahoo       # yahoo | nse | groww | angel | openalgo (legacy env var)

# News feeds (optional override)
INDIA_NEWS_FEEDS=        # comma-separated url|label|category triples
```

### ML Service

```bash
ML_SERVICE_URL=http://localhost:8100
ALPHAFORGE_API_BASE_URL=http://localhost:3000   # for ML training pipeline
ML_DATA_REQUEST_DELAY=200                        # ms between API requests (Angel One rate limits)
```

### Worker Feature Flags (India ML decision pipeline)

```bash
ENABLE_PRICE_FORECASTER=false    # TFT heuristic — EXPERIMENTAL
ENABLE_RL_EXECUTOR=false
ENABLE_MICROSTRUCTURE=false
ENABLE_META_CALIBRATION=true
ENABLE_STOCK_RANKER=true
ENABLE_REGIME_CLASSIFIER=true
ENABLE_PORTFOLIO_OPTIMIZER=false
```

---

## 19. Testing & TDD Policy

Test-Driven Development is mandatory. Write failing tests first. The `prebuild` hook enforces a green suite before every `next build`.

### Tooling

- **Runner** — Vitest v4 with `jsdom` environment
- **DOM assertions** — `@testing-library/react` + `@testing-library/jest-dom`
- **Coverage** — v8 provider, outputs to `coverage/` (text + html + lcov)
- **E2E** — Playwright (smoke tests)

### Test Layout

```
tests/
  lib/           Pure utilities; market-data layer; risk/experiments/microstructure
  features/      Domain engines (best-time, scalping, daily-picks, ...)
  components/    React component render + interaction
  api/           Next.js Route Handler tests (Request/Response pattern)
  services/      Service layer (cache, broker adapters)
  hooks/         Custom React hooks
  stores/        Zustand store transitions
  pages/         Page-level smoke + redirect tests
  worker/        Worker scheduler, config, log, env-validation paths
  research/      V6 research platform (92 tests across 8 files)
```

### Mandatory Workflow

1. Write failing tests — cover the happy path, key edge cases, at least one error boundary
2. Confirm tests fail **for the right reason** (not a syntax error or missing import)
3. Write the smallest implementation that turns them green
4. Refactor under the green safety net
5. Run `npm test` (full suite) before opening a PR

### Per-Layer Scripts

```bash
npm run test:lib         # pure utilities
npm run test:features    # domain engines
npm run test:components  # UI components
npm run test:api         # API route handlers
npm run test:services    # service layer
npm run test:hooks       # React hooks
npm run test:stores      # Zustand stores
npm run test:pages       # page-level smoke
npm run test:worker      # background worker
npm run test:coverage    # v8 coverage report
```

### Anti-Patterns (automatic review block)

- Writing tests after shipping code
- Asserting on private internals or implementation details
- Snapshot tests of large component trees — prefer `getByRole`/`getByText`
- Tests that hit the network, real DB, or real broker
- `it.skip` / `describe.skip` without a TODO referencing the issue tracker

---

## 20. Coding Standards

### TypeScript

- Strict TypeScript everywhere — no `any` unless unavoidable and documented
- Feature-based architecture — keep market code in isolated sibling directories
- No cross-imports between Crypto and India features
- Use `zod` for all external inputs and env vars
- Canonical market data types never leak provider-specific shapes

### Components

- Functional React components only; App Router (no `pages/`)
- Server components by default; `"use client"` only when needed
- Never use `"use server"` — use `import "server-only"` instead
- Keep components small and reusable; hooks for shared logic
- All animations reference named Spring presets from `motion-presets.ts`
- All colors from OKLCH CSS tokens — no hardcoded hex/RGB in component files

### Backend

- Route handlers always validate inputs with Zod; type every response
- `cached(key, ttl, fn)` for Redis-backed route caching
- Use `withFailover()` for all Indian market data calls
- `assertExecutionModeIsolation()` on every paper/live order path
- Atomic trade guards (`SET NX EX`) before any paper trade creation

### Git

- Small, focused commits with a clear imperative subject line
- One concern per PR
- Test must be green locally on `main` head before opening a PR

### Security

- Never hardcode secrets — use env vars
- API keys stored AES-256-GCM encrypted via `src/lib/crypto.ts`
- Webhook payloads include HMAC-SHA256 signature (`X-Crypto-Desk-Signature`)
- `LIVE_TRADING_ENABLED=true` must be set explicitly — no accidental live order placement
- Input validation at every external boundary (Zod on all API routes)
