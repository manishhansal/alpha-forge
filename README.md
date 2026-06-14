# Alphaforge — Multi-Market Trading Desk (Crypto + Indian F&O)

A professional realtime trading dashboard inspired by Delta Exchange,
TradingView, and CoinGlass. Ships **two markets in one shell** with a
top-of-sidebar switcher:

- **Crypto** (default) — BTC · ETH · SOL via a pluggable broker adapter
  layer (Delta Exchange India by default, Binance opt-in), aggregates
  derivatives analytics (futures + options), runs a sentiment engine,
  produces AI-style signals (LONG / SHORT / BUY / SELL / HOLD), an
  IST-anchored Best Time to Trade indicator, and two paper-trading engines.
- **Indian Market (NSE F&O)** — full sidebar parity with the crypto
  surface. Every crypto sidebar item has an NSE-scoped counterpart under
  `/in/*`: Overview (NIFTY indices + sectoral heatmap + MSB–OB signals +
  range-expansion scanner), an **NSE-anchored Best Time** indicator
  (Pre-Open / Opening Volatility / Morning Trend / Midday Lull /
  Afternoon Trend / Power Hour / Closing Auction with weekly-expiry
  awareness), full option chain with PCR / max-pain, a unified
  **Signals** board merging six F&O scanners (range-expansion, momentum,
  volume, OI build-up, PCR, IV-spike), window-pinned **Strategies** and
  **Paper Trading** desks, **Strategy Backtest** + **Strategy Lab**
  scaffolds wired to the live
  historical fetcher, a sector + stock **Heatmap** with continuous tint
  saturation, plus India-only Scanner / Watchlist / per-symbol Chart
  extras. Powered by `yahoo-finance2` for quotes & history and the
  direct NSE feed for option chains, with a Redis-cached server layer.

The crypto surface produces AI-style trading signals
(LONG / SHORT / BUY / SELL / HOLD) with confidence and risk-managed
entries, ships an IST-anchored **Best Time to Trade** indicator on the
Overview page + a dedicated tab, and runs two paper-trading engines:

- **Strategy Lab** — conversational backtester that compiles English prompts
  into deterministic rule sets, replays them over 1W → 5Y of history, and
  optionally goes live as paper trades on every fresh hourly bar.
- **Strategies + Paper Trading** — a strategy desk that runs in
  parallel across both markets. On the crypto side, ten scalping
  strategies (UT Bot + SMC, VWAP Sweep + Trend, News Momentum, Range
  Scalp, EMA Pullback, VWAP Reversion, Orderflow Sweep, Fib Pullback,
  Institutional AI SMC, AI Institutional Pro v5) run on 1m / 5m / 15m
  Binance klines. On the F&O side, eight strategies (Range Expansion,
  Momentum, Volume Breakout, OI Build-up, PCR Extreme, IV Spike —
  derived from the existing NSE scanners — plus India Liquidity Edge,
  a liquidity-first quant framework ported from the ILE Pine indicator,
  and India Max-Pain Gravity, an option-positioning mean-reversion play
  carved from the same Pine framework)
  run against the live NSE F&O universe. Each market exposes the same two pages: **Strategies**
  (`/strategies`, `/in/strategies`) owns the picker + live signal feed
  + how-it-works reference card, while **Paper Trading**
  (`/paper-trading`, `/in/paper-trading`) owns the open positions
  table, the server-paginated journal and the per-strategy +
  per-symbol performance breakdown. The two markets share the same
  Postgres `PaperTrade` table; India rows are segregated by an `in:`
  source prefix so the journals never blend. Mix any subset of
  strategies from the picker — the strategy filter is shared between
  both pages of each market via market-scoped Zustand stores. Every
  trade is tagged with the strategy that fired it and resolved against
  1m candles. The legacy `/scalper` and `/in/scalper` URLs 308-redirect
  to `/strategies` and `/in/strategies` respectively.
- **Strategy Backtest** — a dedicated tab that runs every scalp strategy
  against five years of 4h history on BTC / ETH / SOL with $10,000 starting
  equity. Each strategy gets a 0-100 score, a letter grade (A+ → F), and a
  recommendation (Highly recommended / Recommended / Use with caution / Not
  recommended). The same score badge is rendered next to every strategy
  inside the Scalper picker so you can prefer the ones with a proven edge.
- **AI Signals** — a dedicated tab on **both** markets (`/ai-signals`,
  `/in/ai-signals`) that publishes a complete, confidence-scored trade
  plan per symbol. Each signal carries an action (LONG / SHORT / BUY /
  SELL / WAIT), confidence (0–100 + letter grade S / A / B / C / D),
  calibrated win probability, entry zone, ATM strike, **tiered**
  take-profit ladder (TP1/TP2/TP3 with 50% / 30% / 20% scale-outs),
  ATR-sized stop, explicit invalidation criteria, position-sizing %
  (1% risk budget, capped per horizon), time horizon (scalp / intraday /
  swing / positional), and a live timing window with a "Valid 1h 24m"
  countdown chip. The crypto engine reads RSI, MACD, EMA stack, volume
  thrust, funding rate, OI 1h Δ, long/short ratio, liquidation imbalance
  and Fear & Greed; the India engine reads daily SMA trend stack, RSI,
  momentum, PCR (OI), ATM IV, ΔPE-CE OI build-up, max-pain pull, and
  cross-references the six F&O scanners. Both engines force WAIT outside
  the active session via the Best-Time engine.

> Full product spec: [`ALPHAFORGE.md`](./ALPHAFORGE.md)

## Tech stack

| Layer            | Choice                                                                 |
| ---------------- | ---------------------------------------------------------------------- |
| Framework        | **Next.js 16** (App Router, Turbopack) + **React 19.2** + TypeScript   |
| Styling          | **TailwindCSS v4** (light / dark / system OKLCH palettes via `@theme`) |
| Theming          | Unified `<ThemeProvider>` — `light` / `dark` / `system`, persisted to `localStorage`, with a pre-hydration flash-prevention script and a topbar toggle shared by both markets |
| Client state     | **Zustand 5**                                                          |
| Server state     | **TanStack Query 5**                                                   |
| Charts           | **lightweight-charts**, Recharts (planned)                             |
| Animation        | **framer-motion**                                                      |
| Backend          | Next.js Route Handlers (Node runtime)                                  |
| Validation       | **zod 4** for every external API I/O and env vars                      |
| Cache            | **Redis** via `ioredis` (with in-memory fallback for dev)              |
| Database         | **PostgreSQL 17** + **Prisma 7** (driver-adapter pattern with `pg`)    |
| Realtime         | Active broker WS (Delta India ticker / Binance miniTicker + forceOrder) |
| Brokers          | **Delta Exchange India** (default), **Binance** — flip via env         |
| Indian quotes    | **yahoo-finance2** (default), NSE option-chain proxy, **Angel One SmartAPI** (live quotes / candles / feed / option chain) + Groww REST (opt-in via `INDIA_BROKER`) |
| Sentiment input  | Alternative.me Fear & Greed                                            |

## Quick start

You need **Node.js ≥ 20.9** and **Docker Desktop** (or any Docker engine + compose plugin).

```bash
# 1. Install dependencies
npm install

# 2. Bring up Postgres + Redis
npm run docker:up

# 3. Copy env template (defaults already match docker-compose)
cp .env.example .env.local

# 4. Generate AUTH_SECRET and ENCRYPTION_KEY, then paste into .env.local
npx auth secret                            # → AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → ENCRYPTION_KEY

# 5. Run the first migration (creates tables for users, alerts, signals,
#    notifications, settings)
npm run db:migrate -- --name init

# 6. Start the dev server (in one terminal)
npm run dev

# 7. Start the background worker (in a second terminal) — feeds the
#    liquidation rolling buffer, will host backtesting + alerts jobs.
npm run worker:dev
```

Open [http://localhost:3000](http://localhost:3000) and create an account at `/signup`.

### One-shot (`npm run setup`)

```bash
npm run setup
```

Runs `npm install && docker compose up -d && prisma migrate dev` for you.

## Available scripts

| Script               | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `npm run dev`        | Next.js dev server (Turbopack) on :3000                            |
| `npm run build`      | Production build (runs `npm test` first via the `prebuild` hook — a red suite blocks the build) |
| `npm run start`      | Run the production build                                           |
| `npm run lint`       | ESLint (flat config, Next 16 plugin)                               |
| `npm run typecheck`  | `tsc --noEmit` strict pass                                         |
| `npm run docker:up`  | Start Postgres + Redis containers                                  |
| `npm run docker:down`| Stop containers (keeps volumes)                                    |
| `npm run docker:reset` | Stop containers and **delete** their volumes                     |
| `npm run db:generate`| Regenerate Prisma client                                           |
| `npm run db:migrate` | Create/apply a migration in dev                                    |
| `npm run db:deploy`  | Apply pending migrations (CI/prod)                                 |
| `npm run db:reset`   | Drop, recreate, and re-migrate the database (destructive)          |
| `npm run db:studio`  | Open Prisma Studio against the local DB                            |
| `npm run worker:dev` | Background worker (one-shot tsx run) — liquidation WS, alerts, signals, strategy-lab + strategy paper trading. **No file watcher** — keeps the fork pressure low on Windows. |
| `npm run worker:big` | Same as `worker:dev` but raises the V8 heap cap (`NODE_OPTIONS=--max-old-space-size=4096`). Use if the worker hits an out-of-memory crash. Note: a V8 *Zone* allocation failure is driven by the OS commit limit, not the heap cap — free system memory if raising the cap doesn't help. |
| `npm run worker:watch` | Same as `worker:dev` but with `tsx watch` so saves auto-restart the worker. Heavy on Windows; only use it if you actively need it. |
| `npm run worker:start`| Background worker (one-shot, for prod)                            |
| `npm run dev:tdd`    | **TDD mode** — runs `next dev` AND `vitest --watch` in parallel via `concurrently`. Tests re-run on every file save. |
| `npm run check`      | Full pre-PR gate — `lint` + `typecheck` + full Vitest suite        |
| `npm test`           | Run the full Vitest suite once (CI mode, no watcher)               |
| `npm run test:watch` | Re-run tests on file changes (Vitest watcher)                      |
| `npm run test:ui`    | Open the interactive Vitest browser UI                             |
| `npm run test:coverage` | Generate v8 coverage (text + html + lcov in `coverage/`)        |
| `npm run test:lib`   | Run only `tests/lib/**` (pure utilities)                           |
| `npm run test:features` | Run only `tests/features/**` (best-time, sentiment, strategy-lab, scalping helpers, …) |
| `npm run test:components` | Run only `tests/components/**` (UI primitives + light component renders) |
| `npm run test:api`   | Run only `tests/api/**` (Next 16 Route Handler tests)              |
| `npm run test:services` | Run only `tests/services/**` (cache backends, broker shared)    |
| `npm run test:hooks` | Run only `tests/hooks/**` (custom React hooks)                     |
| `npm run test:stores`| Run only `tests/stores/**` (Zustand stores)                        |
| `npm run test:pages` | Run only `tests/pages/**` (page-level smoke / redirect tests)      |
| `npm run test:worker`| Run only `tests/worker/**` (background-worker log/scheduler/config/...) |
| `npm run test:ci`    | CI-flavoured run with JUnit XML output (`test-results/junit.xml`)  |

> **Test-Driven Development is mandatory.** Every new feature, fix, or
> enhancement **must** start with new test cases that exercise the
> intended behaviour, watch them fail (`npm test`), and only then write
> the implementation that turns them green. See
> [Testing & TDD policy](#testing--tdd-policy) below for the full
> workflow.

## Project structure

```
src/
  app/
    (auth)/                     Public route group — /login, /signup
    (dashboard)/                Authenticated route group — sidebar/topbar shell
      page.tsx                  Home — Market Overview (Best Time banner + BTC/ETH/SOL cards)
      best-time/                IST best-time-to-trade dashboard
      futures/, options/, signals/, ai-signals/, heatmap/
      profile/                  Consolidated profile page — account, data
                                sources, API keys, alerts, sign-out
                                (opened from the topbar avatar). The
                                legacy /settings route 308-redirects here.
      strategy-lab/             Conversational backtester UI
      strategies/               Multi-strategy picker + live signal feed
      paper-trading/            Open positions + journal + per-strategy perf
      scalper/                  308-redirect → /strategies (legacy URL)
      strategy-backtest/        5Y backtest leaderboard + scores per strategy
      in/                       Indian-Market route group (mounted via sidebar switcher)
        page.tsx                Redirects /in → /in/dashboard
        dashboard/              Overview — NIFTY indices, sectoral heatmap,
                                MSB–OB signals, Range Expansion (WR8) scanner
        best-time/              NSE-anchored session guide (09:15–15:30 IST,
                                7 windows, weekly-expiry quality, "now" cursor)
        options/                NSE option chain (PCR, max pain, ATM ±5 strikes)
        signals/                Unified F&O signal board (6 scanners merged)
        ai-signals/             AI multi-confluence F&O signals (indices + F&O leaders)
        strategies/             F&O 8-strategy picker + live signals + how-it-works
        paper-trading/          F&O open positions + journal + per-strategy stats
        scalper/                308-redirect → /in/strategies (legacy URL)
        strategy-backtest/      F&O backtest scaffold over /api/in/historical
        strategy-lab/           Conversational F&O backtester intake + roadmap
        heatmap/                Sector + stock heatmap (continuous color-mix tints)
        news/                   Top Moneycontrol + global market news (F&O /
                                sector impact tags, per-headline sentiment,
                                overall market sentiment + risk-on/off ratio)
        profile/                India-flavoured profile page (account,
                                data sources, API keys, alerts, sign-out).
                                Legacy /in/settings 308-redirects here.
        scanner/                Single-mode F&O scanner UI (India-only)
        watchlist/              Persistent F&O watchlist (zustand-persist, India-only)
        chart/[symbol]/         Per-symbol lightweight-charts deep-dive (India-only)
    api/auth/[...nextauth]/     Auth.js v5 credentials + JWT callbacks
    api/market/overview/        Aggregated REST endpoint, Redis-cached
    api/scalper/                signals, journal, journal/[id] (note + cancel),
                                backtest (5Y multi-strategy suite + scoring)
    api/strategy-lab/           strategies CRUD, backtest, live toggle
    api/ai-signals/             Crypto AI Signals feed (multi-confluence)
    api/in/                     Indian-market API surface (force-dynamic):
                                fno-list, health, historical, market-snapshot,
                                nifty-bias, option-chain, quote, scanner,
                                sector-stocks, msb-signals, feed/stream (SSE),
                                ai-signals (F&O AI multi-confluence engine),
                                news (Moneycontrol + global RSS sentiment feed)
    layout.tsx, not-found.tsx
  proxy.ts                      Next 16 proxy (ex-`middleware.ts`) — Auth.js gate
  components/
    ai-signals/                 AiSignalCard (rich per-signal card with TPs,
                                timing, AI rationale), AiSignalsBoard
                                (polling shell + direction/horizon filters),
                                AiMarketContextBanner (regime banner)
    auth/                       Sign-in / sign-up form (uses useActionState)
    best-time/                  BestTimeBanner (overview), BestTimeDashboard (/best-time)
    dashboard/                  Sidebar (market-aware), Topbar, MarketTickerBar,
                                MarketSwitcher (crypto ↔ india toggle), UserMenu, ...
    india/                      Indian-market UI (no cross-imports from crypto):
                                MsbDashboard (Overview), best-time/ (banner +
                                dashboard), heatmap/india-heatmap,
                                signals/india-signals-board, strategy/
                                (india-backtest-preview, india-strategy-lab-intake),
                                common/india-feature-preview (shared "live preview
                                + roadmap" shell), charts/price-chart,
                                options/option-chain-table, ticker/live-ticker,
                                ui/ (button/card/table shadcn primitives)
    scalper/                    LiveSignals, PaperTradeTable, ScalpSignalCard,
                                StatsPanel, StrategyPicker, StrategyProvider,
                                StrategyBacktestPanel, StrategyBacktestProvider,
                                StrategyScoreBadge
    strategy-lab/               StrategyForm, BacktestPanel, EquityCurveSpark,
                                TradeLog, SavedStrategiesSidebar
    profile/                    ProfileHeader (avatar / sign-out card) +
                                ProfileTabs (hash-routed Account / Data
                                sources / API keys / Alerts switcher)
    settings/                   SettingsForm, DataSourcesForm,
                                ApiKeysForm, AlertsManager — rendered
                                inside the profile page's tab panels
    ui/                         Card, Badge, Button, Input, Label, Skeleton, ...
    providers.tsx               QueryClientProvider
  features/
    ai-signals/                 Cross-market AI Signals engine
      engine.ts                 Pure helpers — compositeScore, classifyAction,
                                gradeFromConfidence, calibrateWinProbability,
                                buildTakeProfits, buildTradeLevels,
                                buildTimingWindow, buildReasons,
                                suggestPositionSizePct, pickHorizon,
                                roundToTick, composeSummary, invalidationLine
      crypto-builder.ts         getCryptoAiSignals() — 9-factor crypto stack
      india-builder.ts          getIndiaAiSignals() — 10-factor F&O stack
                                (incl. NSE option-chain + scanner agreement)
    auth/                       signup/login actions, session helpers
    best-time/                  IST window engine + types (pure, server-safe,
                                used by BestTimeBanner + BestTimeDashboard)
    settings/                   updateSettingsAction
    alerts/                     types, evaluator, channels, dispatch, queries
    backtesting/                SignalHistory ingestion + outcome evaluator
    notifications/              list / count / mark-read helpers
    overview/                   Server-side market overview aggregator
    futures/                    aggregate + liquidations rolling-buffer helper
    strategy-lab/               Conversational strategy parser + backtest engine + live paper-trader
    scalping/                   Multi-strategy scalper engine + journal
      engine.ts                 Facade — runs requested strategy modules per symbol
      fetch-signals.ts          Kline fetch + cached snapshot per timeframe
      indicators.ts             LuxAlgo UT Bot + SMC port (Wilder ATR, BOS / CHoCH)
      helpers.ts                Shared indicator pack (EMA, SMA, RSI, Bollinger,
                                VWAP / rolling VWAP, ATR, swings, equal-price cluster)
      paper-trader.ts           openPaperTrade() + resolveOpenTrades()
      journal.ts                listPaperTrades, listOpenTrades, getJournalStats
                                (per-symbol + per-strategy breakdowns)
      backtest.ts               5Y historical replay for any scalp module
      strategy-score.ts         0-100 score + grade + recommendation engine
      run-all-backtests.ts      In-process cached suite runner (BTC/ETH/SOL)
      backtest-summary-types.ts Shared wire format for /api/scalper/backtest
      types.ts                  ScalpStrategyId enum, parseTradeSource()
      strategies/               One module per strategy + UI catalog
        ut-smc.ts               UT Bot trailing stop + SMC structure filter
        vwap-sweep-trend.ts     Higher-TF trend + liquidity sweep + VWAP mean reversion
        news-momentum.ts        Volume + range explosion footprint
        range-scalp.ts          Bollinger + RSI + range-tightness filter
        ema-pullback.ts         9/20/50 EMA stack pullback continuation
        vwap-reversion.ts       Stretched-from-VWAP + RSI rolling off extreme
        orderflow-sweep.ts      Equal highs/lows sweep + volume spike + rejection
        fib-pullback.ts         1m impulse + 0.5–0.618 fib retrace continuation
        institutional-smc.ts    9-component AI SMC score (trend + VWAP + sweep
                                + BOS + FVG + volume + delta + kill zone)
        ai-institutional-pro.ts AI Institutional Pro v5 — hard gates (EMA
                                trend + HTF + RSI + cooldown) + 8-factor
                                confluence score with per-TF mode preset
        catalog.ts              Display metadata (label, description, badge, monogram)
    sentiment/, signals/, options/, heatmap/             (filled per phase)
    india/
      best-time/                NSE-anchored session engine (mirrors features/
                                best-time/engine.ts but with seven NSE-specific
                                windows — Pre-Open Auction, Opening Volatility,
                                Morning Trend, Midday Lull, Afternoon Trend,
                                Power Hour, Closing Auction — plus expiry-aware
                                day quality and a weekend "off" guard)
  services/
    brokers/
      types.ts, server-types.ts BrokerAdapter contract + server stream stub
      registry.ts               getServerBroker() — picks adapter from ACTIVE_BROKER
      client.ts                 getClientBroker() — browser-side WS factory
      shared.ts                 Universal pair-label helpers (server + client)
      binance/                  Binance adapter (REST + futures + WS shim)
      delta/                    Delta Exchange India adapter (REST + public WS)
    binance/  (rest.ts, ws.ts)  Legacy Binance REST + multi-stream WS client
    coingecko/                  Global market + per-coin market cap
    bybit/, deribit/, coinglass/                          (filled per phase)
    india/                      Indian-market backend (broker-agnostic):
      broker/                   MarketBroker contract + factory (yahoo / nse / groww)
      cache/                    Redis (ioredis) + in-memory fallback facade
      yahoo/, nse/, groww/      Broker adapters per data source
      scanner/engine.ts         Range-expansion + WR8 + bullish-trend scanner
      signals/                  Score + snapshotter (60s strong-signal cron)
      websocket/gateway.ts      SSE feed gateway (broker-polling fan-out)
  hooks/                        useBinanceTickers — wires WS → store
    india/                      useFetchPoll, useFeedStream, useLiveQuotes,
                                useOptionChain, useScanner — polling primitives
                                for the Indian surface
  store/                        Zustand stores (marketStore.ts)
    india/                      useIndia{Market,OptionChain,Scanner,Watchlist}Store
                                — namespaced + persist key `india-fno-watchlist`
  lib/
    auth.ts                     Auth.js v5 — Credentials + JWT
    crypto.ts                   AES-256-GCM helper for encrypting API keys
    env.ts                      zod-validated env (server + client schemas)
    redis.ts                    ioredis client + cached() + sorted-set ops
    prisma.ts                   Prisma 7 client factory (lazy, adapter-pg)
    constants.ts                TRACKED_SYMBOLS, REDIS_KEYS, CACHE_TTL_SECONDS
    utils.ts                    cn(), formatPrice(), formatPercent(), formatCompact()
    market-mode.ts              `useActiveMarket()` — derives "crypto" | "india"
                                from `usePathname()` (URL is source of truth)
    india/                      fno-symbols, sectors, INR-aware formatters
  types/market.ts               Single source of truth for Ticker, Signal, etc.
    india/                      market / options / scanner type packs
worker/
  src/
    index.ts                    Worker entrypoint, graceful shutdown, job registry
    config.ts                   Env-driven tunables (intervals, symbols)
    scheduler.ts                Non-overlapping recurring tick primitive
    db.ts, redis.ts, log.ts     Worker-local clients + structured logger
    jobs/
      liquidations.ts           Binance forceOrder@arr WS → Redis sorted set
      signal-ingest.ts          Periodically persists new signals to history
      signal-outcome.ts         Resolves open signals via 1m klines (target/stop/expired)
      alerts.ts                 Evaluates active alerts → channels (cooldown'd)
      strategy-lab.ts           Live forward-tests user-saved Strategy rows; fans out paper trades
      scalper.ts                Runs all 10 scalp strategies per tick, opens
                                PaperTrade rows tagged `${strategyId}:${tf}`,
                                resolves open trades via 1m klines
prisma/
  schema.prisma                 User, UserSetting, SignalHistory, Alert,
                                Notification, Strategy, StrategyBacktest,
                                StrategyPaperTrade, PaperTrade (+ enums)
prisma.config.ts                Prisma 7 datasource config (no url in schema)
docker-compose.yml              Postgres 17 + Redis 7 with healthchecks
tests/                          Vitest suite — see "Testing & TDD policy"
  setup/                        Shared test fixtures, jest-dom setup, Next mocks
  lib/                          Pure-utility tests (cn, formatPrice, market-mode, …)
  features/                     Engine tests (best-time, sentiment, scalping, …)
  components/                   UI / component render tests
  api/                          Next 16 Route Handler tests (POST/GET handlers)
  services/                     Service-layer tests (cache backends, brokers)
  hooks/                        React hook tests (useFetchPoll, …)
  stores/                       Zustand store tests
  pages/                        Page-level smoke + redirect tests
  worker/                       Worker tests — log, scheduler, config,
                                env-validation (redis/db/observability)
vitest.config.ts                Vitest configuration (jsdom env, aliases, coverage)
```

## Testing & TDD policy

> **TL;DR — write the failing test first, then write the code that makes it pass.**
> No PR is allowed to ship a new behaviour without a test that would have
> failed before the change.

### Tooling

- **Runner:** [Vitest 4](https://vitest.dev/) with the `jsdom` environment.
- **DOM assertions:** `@testing-library/react` + `@testing-library/jest-dom`.
- **User interactions:** `@testing-library/user-event` (preferred over
  raw `fireEvent`).
- **Coverage:** v8 provider, reports under `coverage/` (`text` + `html` + `lcov`).
- **Configuration:** `vitest.config.ts` at the repo root. The setup file
  `tests/setup/vitest.setup.ts` mocks `next/navigation`, `next/headers`,
  and aliases `next/link` to `tests/setup/next-link-shim.tsx` so component
  tests don't need to bootstrap Next's runtime.

### Layered test layout

The `tests/` tree mirrors the `src/` tree by **concern**, not by path.
Pick the directory that matches the kind of code under test, not the
folder it lives in:

| Folder              | Use for                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `tests/lib/`        | Pure utility functions (formatters, validators, math helpers)    |
| `tests/features/`   | Domain engines (`best-time`, `sentiment`, `scalping`, `strategy-lab`, …) |
| `tests/components/` | React components — UI primitives and light wrappers              |
| `tests/api/`        | Next.js Route Handlers (`src/app/api/**/route.ts`)               |
| `tests/services/`   | Service layer (cache backends, broker shared utils)              |
| `tests/hooks/`      | Custom React hooks                                               |
| `tests/stores/`     | Zustand stores                                                   |
| `tests/pages/`      | Page-component smoke renders, redirects, `not-found` flows       |
| `tests/worker/`     | Background worker (`worker/src/**`) — log, scheduler, config, env-validation paths |

Each layer has its own `npm run test:<layer>` script (see
[Available scripts](#available-scripts)) so you can iterate quickly on
a single slice.

### Auto-run wiring (tests run on every code change, automatically)

The suite is plumbed into four trigger points so a stale test result is
never the reason a regression slips through:

1. **`npm run build` blocks on a red suite.** A `prebuild` script runs
   `npm test` before `next build`. A failing test = a failing build.
2. **`npm run dev:tdd` watches every file save.** It runs `next dev`
   and `vitest --watch` in parallel via `concurrently`, so editing
   `src/**` re-runs only the affected tests instantly.
3. **`npm run check` is the pre-PR gate.** Chains `lint` + `typecheck`
   + full Vitest run. CI calls the same script.
4. **Cursor agent edits trigger the matching test slice.** A project
   hook at `.cursor/hooks.json` (with the script under
   `.cursor/hooks/run-related-tests.mjs`) maps each `afterFileEdit`
   event to its test slice (e.g. an edit under `src/features/**` runs
   `tests/features`, an edit under `src/app/api/**` runs `tests/api`,
   etc.) and surfaces the pass/fail summary back to the chat. A `stop`
   hook runs the full suite once the agent finishes its turn.

The Cursor hook is fire-and-forget — it never blocks the agent's tool
calls. Its only job is to surface the truth quickly so test failures
become impossible to miss.

### Mandatory TDD workflow

For **every** new feature, bug fix, or enhancement — no exceptions:

1. **Write the failing tests first.** Cover the happy path, the most
   common edge cases, and at least one explicit error / boundary case
   per public function or component prop. For API routes test the
   shape of the response and one validation failure. For components
   test the user-visible behaviour, not the internal state.
2. **Run the relevant suite and confirm every new test fails for the
   _right_ reason.** Use `npm run test:<layer>` to keep the loop tight.
   A test that passes accidentally (because the code already does the
   thing) is not a TDD test — adjust the assertion until it fails
   meaningfully before proceeding.
3. **Write the smallest implementation that turns the failing tests
   green.** Resist the urge to anticipate future requirements; cover
   them when their tests are written.
4. **Refactor with the green safety net.** Once the suite is green, you
   can simplify, rename, and reorganise — re-running `npm test` after
   each change.
5. **Run the full suite (`npm test`) before opening a PR.** It must be
   green locally on `main` head with the new tests included.

### What to test (concrete checklist)

- **Pure utility (`src/lib/**`):** every exported function gets a unit
  test covering at least one happy path, one boundary (empty / zero /
  negative), and one error case (`expect(() => fn()).toThrow()` or a
  return-value contract).
- **Domain engines (`src/features/**`):** test the public API of the
  engine, not its internals. Build candle / status / strategy fixtures
  with `tests/setup/fixtures.ts`. Assert engine outputs (signal counts,
  scores, verdicts) given fixed inputs.
- **Components (`src/components/**`):** render with `@testing-library/react`,
  assert what the user sees and how they can interact with it
  (`getByRole`, `getByText`). Mock external services (`next/link`,
  `framer-motion`, fetchers) only where they leak runtime requirements.
- **Route Handlers (`src/app/api/**/route.ts`):** import the handler,
  build a `Request` with `new Request(url, { method, body })`, await
  the handler, and assert on `response.status` + `await response.json()`.
  Cover at least one valid payload and one Zod validation failure.
- **Services (`src/services/**`):** test the public surface of caches /
  shared helpers in isolation. Don't hit the network or a real DB —
  if the code does, mock the underlying client.
- **Hooks (`src/hooks/**`):** wrap the hook in a tiny harness component
  inside the test, render it, and assert via the rendered DOM (or
  `act()` + state spies). Do **not** call hooks outside of a render.
- **Stores (`src/state/**`):** import the store factory, create a fresh
  instance per test, and assert on action transitions.
- **Pages (`src/app/**/page.tsx`):** smoke render to confirm imports
  resolve and the top-level structure renders without throwing. Verify
  `redirect()` / `notFound()` paths by asserting that the call throws
  the matching mocked sentinel error.
- **Worker (`worker/src/**`):** exercise pure / env-driven units —
  `log.ts` (level filtering + pretty/json format selection + child
  scopes), `scheduler.ts` (recurring-tick lifecycle with fake timers,
  no overlap, `stop()` semantics), `config.ts` (broker resolution +
  symbol-list parsing + interval overrides), and the env-validation
  branches of `redis.ts` / `db.ts` / `observability.ts`. Long-running
  IO modules (`jobs/**`, the bootstrapping `index.ts`) are excluded
  from coverage and verified at integration time.

### Adding a feature — example

```bash
# 1. Sketch the test cases first
$ touch tests/features/my-new-engine.test.ts
$ npm run test:features          # all new tests fail

# 2. Implement until the suite is green
$ ${EDITOR:-code} src/features/my-new-engine/index.ts
$ npm run test:features          # green

# 3. Final pass
$ npm test                       # full suite still green
```

### Don't (anti-patterns)

- ❌ Writing tests _after_ shipping the code (defeats the point of TDD).
- ❌ Asserting on private internals (state shape, internal helpers).
- ❌ Snapshot tests of large component trees — prefer targeted
  `getByText` / `getByRole` assertions.
- ❌ Tests that hit the network, a real DB, or a real broker. Mock the
  IO boundary; unit tests must run offline.
- ❌ Skipping (`it.skip`, `describe.skip`) without a TODO referencing
  the issue tracker.

## Architecture notes

- **Broker adapter (`src/services/brokers/`)**: every exchange-specific call
  goes through a `BrokerAdapter` (REST: tickers, klines, premium index, OI,
  long/short ratio, all-futures-tickers; WS: ticker + liquidation factories).
  The active broker is picked from `ACTIVE_BROKER` server-side and
  `NEXT_PUBLIC_ACTIVE_BROKER` browser-side — both default to **`delta`**
  (Delta Exchange India, `BTCUSD` / `ETHUSD` / `SOLUSD` perpetuals).
  Setting either to `binance` flips the entire stack to Binance USDT-perp
  pairs without touching call sites. Adapters publish a `capabilities` flag
  block (`liquidations`, `longShortRatio`, `openInterestHistory`) and the
  signal/heatmap/alert pipelines respect it — Delta India has no public
  liquidation feed, so the rolling buffer stays empty and the
  `liquidationImbalance` contribution drops out of the signal score without
  crashing.
- **Realtime path**: browser → active broker's public WS (Delta India
  `wss://public-socket.india.delta.exchange/` `ticker` channel, or Binance
  `wss://stream.binance.com/stream` `miniTicker`) → adapter WS client (auto
  reconnect w/ exponential backoff + jitter, heartbeat, intentional-close
  handling) → `useMarketStore` (Zustand) → React components.
- **REST path**: server-side route handlers call into the active broker
  adapter (Delta `/v2/tickers`, `/v2/history/candles`, `/v2/products`, or
  Binance `fapi.binance.com`) + CoinGecko + Alternative.me → zod-validate →
  `cached(key, ttl, loader)` writes to Redis → response with
  `Cache-Control: s-maxage=…, stale-while-revalidate=…`.
- **Sentiment / signal engines** are pure functions in `features/*/engine.ts`;
  inputs come from REST aggregators so they're easy to test and reason about.
- **AI Signals** (`/ai-signals`, `/in/ai-signals`) — a single
  cross-market engine (`features/ai-signals/engine.ts`) consumed by two
  market-specific builders. The engine is pure: it folds a list of
  weighted `AiConfluenceFactor`s into a composite score, classifies an
  action (`LONG` / `SHORT` / `BUY` / `SELL` / `WAIT`), grades the
  confidence (S → D), picks a horizon, builds an ATR-sized stop +
  tiered take-profit ladder (TP1/TP2/TP3 with 50%/30%/20% scale-outs),
  calibrates a [0.30, 0.85] win-probability via a logistic, and suggests
  a horizon-capped position size against a 1% risk budget. The crypto
  builder feeds it RSI / MACD / EMA / volume thrust / funding / OI / L/S
  / liquidation imbalance / Fear & Greed; the India builder feeds it
  daily SMA trend stack / RSI / momentum / volume / PCR (OI) / ATM IV /
  ΔPE-CE OI / max-pain pull / live-scanner agreement. Both engines force
  WAIT outside the active session via the Best-Time engine.
- **Server-side liquidation imbalance**: the worker subscribes to Binance
  futures `!forceOrder@arr`, filters to tracked symbols, and `ZADD`s each
  event into `liq:rolling:{PAIR}` (Redis sorted set, score = ts). The Next
  app reads the last 5 min via `getLiquidationImbalance(symbol)` and feeds it
  into `computeSignal()` (was previously hardcoded to `null`).
- **Auth.js v5**: Credentials provider + JWT sessions, no DB-session table.
  `src/proxy.ts` (Next 16's renamed `middleware.ts`) protects every non-public
  route via the `authorized` callback in `src/lib/auth.ts`. The single
  source of truth for "who can see what" is the `isPublicPath()` helper
  in the same file — anonymous visitors can only browse the four
  showroom pages (`/`, `/heatmap`, `/in/dashboard`, `/in/heatmap`) and
  the public market-data APIs under `/api/market`, `/api/sentiment`,
  `/api/signals`, `/api/futures` and `/api/in`. Everything else (alerts,
  notifications, scalper journal, strategy lab, profile / settings,
  options chain page, signals board, etc.) gets a 307 redirect to
  `/login` with the original URL in `?callbackUrl=`.
- **Backtesting**: the worker's `signal-ingest` job calls `getSignals()` on a
  cadence and persists new actionable signals into `SignalHistory` (30-min
  per-symbol dedup, HOLD skipped). `signal-outcome` walks open rows, fetches
  1m klines from `generatedAt` to now, and resolves them (HIT_TARGET /
  HIT_STOP / EXPIRED). Conservative tie-break: a candle touching both target
  and stop is recorded as a stop, never a fictional win.
- **Strategy Lab** (`/strategy-lab`): users describe a strategy in plain
  English. `features/strategy-lab/parser.ts` compiles the prompt into a
  small AST (`{ side, entry: { conditions, logic }, exit, risk, notional }`);
  recognised indicators are RSI / MACD line+signal+histogram / EMA / SMA /
  ATR / volume vs avg / N-bar percent change, and comparators include
  `>` / `<` / `crosses above` / `crosses below`. `features/strategy-lab/engine.ts`
  materialises every referenced indicator as a per-bar series, then walks
  the candles once: opens long/short trades on entry, closes on stop /
  target / explicit exit rule / max-hold, and produces win-rate, profit
  factor, max drawdown, annualised Sharpe, total return vs buy-and-hold,
  and a downsampled equity curve. The same parsed AST can be flipped on
  via `/strategy-lab/strategies/[id]/live` so the `strategy-lab` worker
  job opens paper trades on every fresh hourly bar and resolves them
  against 1m candles — same conservative tie-break (touch-both → stop)
  as the scalper.
- **Strategies + Paper Trading** (`/strategies` + `/paper-trading`):
  ten scalping strategies live side-by-side in
  `features/scalping/strategies/*.ts` — `UT_SMC` (UT Bot + SMC structure
  filter, the original LuxAlgo port), `VWAP_SWEEP_TREND` (higher-TF EMA50
  trend + liquidity sweep + VWAP mean reversion), `NEWS_MOMENTUM` (volume
  ≥ 2.8× avg + range ≥ 1.8× ATR breakout), `RANGE_SCALP` (Bollinger + RSI
  + range-tightness filter), `EMA_PULLBACK` (9/20/50 EMA stack pullback),
  `VWAP_REVERSION` (≥ 1.5× ATR stretch + RSI rolling off extreme),
  `ORDERFLOW_SWEEP` (equal-highs/lows sweep + volume spike + rejection),
  `FIB_PULLBACK` (1m impulse + 0.5–0.618 fib retrace continuation),
  `INSTITUTIONAL_SMC` (port of the Ultimate Institutional AI SMC indicator
  — 9-component AI score combining EMA20/50 trend, EMA200 HTF bias, VWAP,
  BOS, SSL/BSL liquidity sweep, FVG, volume spike, candle delta, and the
  London/NY kill zone; only fires when score ≥ 7 AND the four
  institutional preconditions — trend + VWAP + recent sweep + recent BOS
  — are all satisfied, so signals always come after a stop hunt and
  structure break, never on a fresh impulse candle), and
  `AI_INSTITUTIONAL_PRO` (port of the AI Institutional Buy/Sell System
  [Pro v5] Pine indicator — two-stage gating with **hard gates** that
  must all pass first — EMA20/50 trend + HTF EMA bias + RSI gate +
  per-direction cooldown — then an **8-factor confluence score** —
  VWAP, BOS, SSL/BSL sweep, FVG, order block, volume spike, kill zone,
  RSI side of 50 — has to clear the mode-preset minimum; preset adapts
  to the timeframe with Scalping (5m) defaults for 1m/5m and Intraday
  (15m) for 15m, with ATR-multiple TP/SL).
  Every module returns a `ScalpSignal` carrying `strategyId`, ATR-sized
  entry / stop / target, RR, confidence, and a rationale bullet list. The
  shared indicator pack (`features/scalping/helpers.ts`) provides EMA /
  SMA / RSI / Bollinger / rolling VWAP / ATR / swing / equal-price cluster
  primitives. The worker's `scalper` job runs every `WORKER_SCALPER_INTERVAL_MS`
  (default 30s), opens one `PaperTrade` per fresh signal tagged
  `source = "${strategyId}:${timeframe}"` so each strategy gets its own
  dedupe lane, then walks 1m klines on every OPEN row to resolve WIN /
  LOSS / EXPIRED. The UI ships a multi-select `StrategyPicker` backed by
  `useSyncExternalStore` against localStorage — selection drives the
  `?strategies=` query on `/api/scalper/signals` and `/api/scalper/journal`,
  filters the live feed (on `/strategies`) and journal (on
  `/paper-trading`), and the stats panel breaks results down per-symbol
  AND per-strategy. The same Zustand store backs both pages so toggling
  a strategy on either surface is reflected on the other. The legacy
  `/scalper` URL 308-redirects to `/strategies`.
- **Alerts**: `worker/src/jobs/alerts.ts` runs every `WORKER_ALERTS_INTERVAL_MS`,
  gathers state (`getFuturesOverview()`, `getAllLiquidationBuckets()`, latest
  two `SignalHistory.type` per symbol), evaluates every active `Alert`, and
  fires through channels. Each fire reserves a Redis `alert:cooldown:{id}` key
  before fan-out so concurrent worker instances can't double-trigger. Webhook
  POSTs include an HMAC-SHA256 `X-Crypto-Desk-Signature` when
  `ALERT_WEBHOOK_SIGNING_SECRET` is set; email uses the Resend HTTP API.
- **Best Time to Trade** (`/best-time` + Overview banner): `features/best-time/
  engine.ts` is a pure, IST-anchored module — it shifts `Date.getTime()` by
  the fixed +5:30 offset and reads via UTC getters so the result is identical
  in Node and the browser regardless of host timezone (no `toLocaleString`).
  A catalogue of six named windows (Golden Scalp Zone 7-10 PM, Volatility
  Breakout 6-8 PM, Prime Futures 6:30-11:30 PM, Swing Entries 8 PM-12 AM,
  Range Scalp 11:30 AM-3 PM, Worst Zone 2-7 AM) is resolved by overlap +
  priority, blended with a weekday quality multiplier (Tue/Wed/Thu = excellent,
  Sun = low, Mon = choppy), and surfaced as a 0-100 score with a verdict,
  countdown to window-end, and the next more-important window starting today.
  The Overview banner ticks every minute on a wall-clock boundary so all
  cards stay synchronised; the `/best-time` page adds a 24h IST timeline,
  per-window cards, a weekday table, a per-style "best window" matrix and a
  BTC spotlight (7 PM – 11 PM IST).
- **Dark-first theme** via Tailwind v4 `@theme inline` block in `globals.css`
  using OKLCH for perceptually-uniform color (bull / bear / neutral / per-coin).

## Next.js 16 conventions used here

- App Router only; no `pages/` directory.
- `params` and `searchParams` treated as `Promise` (when added).
- ESLint flat config (`eslint.config.mjs`); `next lint` removed.
- `middleware` renamed to `proxy` (not used yet — public WS data needs no proxy).
- `fetch` is uncached by default — explicit `cache: "no-store"` + Redis layer.
- Prisma 7 driver-adapter pattern (`PrismaPg` from `@prisma/adapter-pg`) — the
  `datasource.url` lives in `prisma.config.ts`, **not** `schema.prisma`.

## Switching brokers

The dashboard ships with **Delta Exchange India** as the default broker. To
flip everything (server REST, browser WS, worker liquidation subscriber) to
Binance instead, change one pair of env vars and restart:

```bash
# in .env.local
ACTIVE_BROKER=binance
NEXT_PUBLIC_ACTIVE_BROKER=binance
```

The active broker drives:

- the native pair string used everywhere (`BTCUSD` on Delta vs `BTCUSDT` on
  Binance) — see `TRACKED_SYMBOLS[i].brokers.{binance,delta}` in
  `src/lib/constants.ts`;
- the public WS endpoint the browser opens (Delta `ticker` channel or
  Binance `miniTicker`);
- which REST endpoints the route handlers + worker hit (Delta India
  `api.india.delta.exchange/v2` or Binance `api.binance.com` +
  `fapi.binance.com`);
- whether the worker's liquidation WS subscriber boots (Binance only; Delta
  India's public socket has no liquidation channel).

Capability gaps on Delta India are surfaced via the adapter's `capabilities`
flags — the signal engine, alerts, and heatmap all branch on those rather
than special-casing the broker id, so adding a third broker is purely a
matter of implementing the `BrokerAdapter` contract.

## Theming (dark / light / system)

The dashboard ships with a single, app-wide theme system that both surfaces
share. A three-segment toggle (Light · System · Dark) lives in the topbar
on every authenticated page, so the choice is one click away from anywhere.

- `src/components/theme-provider.tsx` — `<ThemeProvider>` wraps the app
  inside `src/components/providers.tsx`. It uses `useSyncExternalStore`
  to keep React in lockstep with `localStorage` (cross-tab sync via the
  `storage` event) and `window.matchMedia("(prefers-color-scheme: dark)")`
  (auto-flip when the user has selected "system"). The active resolved
  mode is published as a `.dark` class on `<html>`, `data-theme="dark|light"`,
  and `style.colorScheme`.
- `src/app/layout.tsx` injects a tiny inline `THEME_INIT_SCRIPT` in
  `<head>` so the right palette is applied **before** React hydrates —
  prevents the flash of incorrect theme on light-mode reloads.
- `src/app/globals.css` defines an OKLCH palette twice: once on `:root`
  (light) and once on `.dark` (dark). Every Tailwind utility resolves
  through `@theme inline` to the same set of CSS variables, so swapping
  the `.dark` class re-themes the entire UI without a single React
  re-render.
- Tailwind v4's `dark:` variant is opted in via
  `@custom-variant dark (&:where(.dark, .dark *))` so Indian-market
  components can express per-mode color tweaks (`text-emerald-700
  dark:text-emerald-400`) for badge legibility on tinted backgrounds.
- `src/components/india/charts/price-chart.tsx` listens to `useTheme()`
  and re-`applyOptions()`s the lightweight-charts canvas on every flip —
  the chart palette stays in lockstep with the rest of the UI without
  destroying / recreating the chart instance.
- `src/components/settings/settings-form.tsx` previews the theme live
  via `useTheme()` and persists the choice to `UserSetting.theme` on
  save (so a returning user gets their preference even on a fresh
  browser).

## Switching markets (Crypto ↔ Indian F&O)

The top of the sidebar carries a two-segment switcher. Crypto (default)
lands on `/` (the BTC/ETH/SOL overview); Indian Market lands on
`/in/dashboard` (NIFTY Pulse). The URL is the source of truth — the
sidebar renders crypto nav under `/*` and Indian nav under `/in/*`, and a
small `useActiveMarket()` helper in `src/lib/market-mode.ts` derives the
mode from `usePathname()` so deep links + browser back/forward always
"just work" with no extra persistence layer.

### Sidebar parity

Both markets expose the same ten core surfaces in the same order — so
flipping the switcher never relocates a feature in the user's mental
map. Each item routes to a market-aware page; market-specific extras
are appended below the shared core. Account-level preferences live on
the topbar avatar (`/profile`, `/in/profile`) so they don't compete
with the market surfaces for sidebar real estate.

Public (anonymous) visitors only see rows 1 and 10 — the two
"showroom" surfaces — and a `Sign in to unlock` CTA at the bottom of the
sidebar. Every other row is hidden from the nav and protected at the
proxy level (`src/lib/auth.ts` → `isPublicPath`), so direct URLs
redirect to `/login`. Rows below the table follow the same rule.

| #  | Crypto                                         | India (NSE F&O)                                       | Auth        |
| -- | ---------------------------------------------- | ----------------------------------------------------- | ----------- |
| 1  | Overview (`/`)                                 | Overview (`/in/dashboard`)                            | **Public**  |
| 2  | Best Time (`/best-time`)                       | Best Time (`/in/best-time`)                           | Protected   |
| 3  | Options (`/options`)                           | Options (`/in/options`)                               | Protected   |
| 4  | Signals (`/signals`)                           | Signals (`/in/signals`)                               | Protected   |
| 5  | AI Signals (`/ai-signals`)                     | AI Signals (`/in/ai-signals`)                         | Protected   |
| 6  | Strategies (`/strategies`)                     | Strategies (`/in/strategies`)                         | Protected   |
| 7  | Paper Trading (`/paper-trading`)               | Paper Trading (`/in/paper-trading`)                   | Protected   |
| 8  | Strategy Backtest (`/strategy-backtest`)       | Strategy Backtest (`/in/strategy-backtest`)           | Protected   |
| 9  | Strategy Lab (`/strategy-lab`)                 | Strategy Lab (`/in/strategy-lab`)                     | Protected   |
| 10 | Heatmap (`/heatmap`)                           | Heatmap (`/in/heatmap`)                               | **Public**  |
| +  | Futures (`/futures`) — crypto-only             | News / Scanner / Watchlist / Chart — India-only       | Protected   |
| ☰  | Profile (`/profile`) — via topbar avatar       | Profile (`/in/profile`) — via topbar avatar           | Protected   |

The Best Time, Signals, AI Signals, Strategies, Paper Trading, Strategy
Backtest, Strategy Lab and Heatmap surfaces are entirely separate
implementations under
`src/{app/(dashboard)/in,components/india,features/india}/*` — no
cross-imports from the crypto features, no shared stores, no shared
API routes. The AI Signals engine is the one cross-market module: the
shared `features/ai-signals/engine.ts` (pure, deterministic) is reused
by both `crypto-builder.ts` and `india-builder.ts`, but the data
fan-out, caches and signal counts stay market-scoped. The profile pages are the one exception: settings are
user-scoped (not market-scoped) so both `/profile` and `/in/profile`
render the same `SettingsForm`, `DataSourcesForm`, `ApiKeysForm` and
`AlertsManager` components, only with different copy.

### Indian-market env vars (all optional)

```bash
# Pick the data source. Falls back to ACTIVE_BROKER, then "yahoo".
INDIA_BROKER=yahoo        # yahoo | nse | groww | angel

# Angel One SmartAPI (optional) — when these four are set the `angel` adapter
# serves live quotes, intraday/daily candles, a polled live feed, and option
# chains directly from your broker account. Missing creds → transparent
# fallback to Yahoo (quotes/history) + NSE (option chain).
#
# These env vars apply to ALL users (worker + anonymous paths). Individual
# signed-in users can instead save their own Angel One key under
# Profile → API keys → "Angel One SmartAPI" (encrypted at rest with
# AES-256-GCM); the adapter prefers env creds, then falls back to the
# request user's stored key.
SMARTAPI_API_KEY=
SMARTAPI_CLIENT_CODE=
SMARTAPI_PIN=
SMARTAPI_TOTP_SECRET=    # the base32 secret shown when you enable TOTP 2FA

# Optional Redis prefix so India + Crypto don't share keys when sharing a
# Redis instance (defaults to `fno-pulse:`).
INDIA_REDIS_PREFIX=fno-pulse:

# Optional override for the /in/news RSS feed list. Comma-separated list of
# `url|source label|category` triples (category = india | global). When unset
# the News surface ships a default set of Moneycontrol India + global feeds.
INDIA_NEWS_FEEDS=

# Optional override for the legacy MSB scanner CSV the dashboard tails.
# When unset the API route scans a handful of sensible default locations,
# returning [] gracefully if none exist.
INDIA_MSB_CSV_PATH=/abs/path/to/msb_trades_ranked.csv
```

The Indian surface depends on `yahoo-finance2` (installed by default) and
shares the existing `REDIS_URL` if you've already configured one — when
absent, the cache transparently falls back to in-memory.

## Roadmap

- [x] **Phase 1** — Foundation, layout shell, Binance WS price feed, Market Overview
- [x] **Phase 2** — Futures analytics (funding, OI, L/S, liquidations) + Sentiment engine
- [x] **Phase 3** — Options analytics (Deribit chain, IV, max pain, PCR) + Signal engine
- [x] **Phase 4** — Alerts, backtesting, user auth
  - [x] Auth.js v5 (credentials + JWT), proxy gating, sign-up/in pages
  - [x] User-scoped Profile page (name, default pair, theme, API-key status), opened from the topbar avatar
  - [x] AES-256-GCM helper for encrypting exchange API keys at rest
  - [x] Separate Node worker (`worker:dev`) with graceful shutdown + scheduler
  - [x] Server-side liquidation WS subscriber + Redis rolling buffer; wired
        into the signal engine (`liquidationImbalance` was previously null)
  - [x] `SignalHistory` ingestion (deduped per symbol) + outcome tracker
        (HIT_TARGET / HIT_STOP / EXPIRED via 1m klines since `generatedAt`)
  - [x] Alerts evaluator (funding spike, OI breakout, price breakout,
        liquidation surge, signal change) with Redis-backed cooldown
  - [x] Channels: in-app `Notification`, HMAC-signed webhook, email via Resend
  - [x] Alerts CRUD API (`/api/alerts`) + Profile UI manager
  - [x] Notifications API (`/api/notifications`) + live bell with unread count
  - [x] Historical accuracy panel on the Signals page (win rate, avg P&L,
        per-symbol breakdown, recent closed signals)
- [x] **Heatmap page** — coin / sector grid + price-level liquidation heatmap from the rolling worker buffer
- [x] **Profile → API keys** — encrypted (AES-256-GCM) per-exchange submission form with masked previews and per-row deletion (opened from the topbar avatar)
- [x] **Worker observability** — structured JSON logs (toggle via `WORKER_LOG_FORMAT=json`) + optional Sentry (`SENTRY_DSN`) with breadcrumbs from every log line and clean shutdown flushing
- [x] **Strategy Lab** — conversational backtester. User describes a strategy in plain English ("Buy when RSI drops below 30, sell when it crosses above 70, stop 2%, target 5%"); the parser compiles it to a deterministic AST, the backtest engine walks 1W / 1M / 6M / 1Y / 5Y of historical candles, and the UI shows win-rate, max drawdown, profit factor, Sharpe, equity curve, and the full trade log. Saved strategies can be flipped to **live paper trading** — the worker evaluates them on every fresh hourly bar and books open / win / loss / expired trades to a per-strategy journal.
- [x] **Strategies + Paper Trading** — multi-strategy scalping desk
      with ten independent engines running in parallel, split across
      two sidebar surfaces (`/strategies` for picking + live signals,
      `/paper-trading` for open positions + journal + performance):
  - [x] `UT_SMC` — LuxAlgo UT Bot ATR trailing-stop + SMC structure (BOS / CHoCH) filter
  - [x] `VWAP_SWEEP_TREND` — higher-TF EMA50 trend + liquidity sweep + VWAP mean reversion
  - [x] `NEWS_MOMENTUM` — volume + range-expansion footprint of news / liquidation cascades
  - [x] `RANGE_SCALP` — Bollinger touches gated by a rolling-range-tightness check + RSI extremes
  - [x] `EMA_PULLBACK` — 9 / 20 / 50 EMA stack pullback continuation
  - [x] `VWAP_REVERSION` — stretched-from-VWAP + RSI rolling off extreme
  - [x] `ORDERFLOW_SWEEP` — equal-highs/lows sweep + volume spike + rejection candle
  - [x] `FIB_PULLBACK` — 1m impulse ≥ 3× ATR + retrace into the 0.5–0.618 fib zone, target the impulse extreme
  - [x] `INSTITUTIONAL_SMC` — port of the Ultimate Institutional AI SMC indicator: 9-component score (EMA20/50 trend, EMA200 HTF, VWAP, BOS, SSL/BSL sweep, FVG, volume spike, candle delta, kill zone) with mandatory institutional preconditions — only fires after a stop hunt + structure break, never on a fresh signal
  - [x] `AI_INSTITUTIONAL_PRO` — port of the AI Institutional Buy/Sell System [Pro v5] Pine indicator: two-stage gating (hard gates — EMA trend + HTF + RSI + per-direction cooldown — then an 8-factor confluence score: VWAP, BOS, SSL/BSL sweep, FVG, order block, volume spike, kill zone, RSI side of 50) with mode preset that adapts to the timeframe (Scalping defaults for 1m/5m, Intraday for 15m) and ATR-multiple TP/SL
  - [x] Multi-select strategy picker (one or many) persisted to
        localStorage via `useSyncExternalStore`; selection drives the
        live-signal feed and the journal filter
  - [x] Every paper trade tagged with the originating strategy
        (`PaperTrade.source = "${strategyId}:${timeframe}"`) — each
        strategy has its own dedupe lane so multiple strategies can hold
        open positions on the same symbol concurrently
  - [x] Worker `scalper` job runs every 30s, opens trades on fresh
        triggers, and resolves OPEN rows against 1m klines (WIN on
        target touch / LOSS on stop / EXPIRED after 6h)
  - [x] Performance panel — overall + per-symbol + per-strategy
        win-rate, profit factor, avg P&L %, and net $ totals
- [x] **Indian Market sidebar parity** — the India sidebar exposes the
      same ten core surfaces as crypto (Overview, Best Time, Options,
      Signals, AI Signals, Strategies, Paper Trading, Strategy
      Backtest, Strategy Lab, Heatmap) so users get the exact same
      mental map across markets. Each item routes to a market-aware
      page under `/in/*`.
  - [x] **NSE Best Time engine** (`features/india/best-time/engine.ts`)
        — pure, IST-anchored, mirrors the crypto engine's API but with
        seven NSE-specific windows (Pre-Open Auction 09:00–09:15,
        Opening Volatility 09:15–10:00, Morning Trend 10:00–11:30,
        Midday Lull 11:30–13:30, Afternoon Trend 13:30–15:00, Power
        Hour 15:00–15:30, Closing Auction 15:30–15:40), expiry-aware
        weekday quality, and a weekend "off" guard.
  - [x] **Unified F&O signals page** (`/in/signals`) — merges six
        existing scanner types (range-expansion, momentum, volume
        breakout, OI build-up, PCR, IV-spike) into one ranked feed
        with localStorage-persisted per-source filters.
  - [x] **NSE sector heatmap** (`/in/heatmap`) — sector pulse strip +
        per-sector grid of F&O constituents, fed by
        `/api/in/sector-stocks`. Tile saturation scales continuously
        with day % via inline `color-mix()` (Tailwind JIT can't
        synthesise arbitrary `color-mix` percentages from a template
        literal).
  - [x] **F&O Strategy Backtest scaffold** (`/in/strategy-backtest`) —
        live OHLCV fetch via `/api/in/historical` with index + top-stock
        picker and 5m → 1w timeframes, surfacing the exact bars the
        engine will replay plus ATR / hi-lo / avg-daily-% stats.
  - [x] **F&O Strategy Lab intake** (`/in/strategy-lab`) — free-form
        prompt with four NSE-specific templates (NIFTY ORB,
        BANKNIFTY VWAP reversion, expiry IV-crush straddle, F&O-stock
        EMA pullback), stop / target / lookback capture, local draft
        persistence.
  - [x] **F&O Strategies page** (`/in/strategies`) — full structural
        mirror of `/strategies` for NSE F&O. Eight-strategy picker
        (Range Expansion, Momentum, Volume Breakout, OI Build-up, PCR
        Extreme, IV Spike — derived from the existing NSE scanners —
        plus India Liquidity Edge, a liquidity-first quant framework
        ported from the ILE Pine indicator, and India Max-Pain Gravity,
        an option-positioning mean-reversion play carved from the same
        Pine framework), per-strategy 1m / 5m / 15m
        timeframe toggles, live signal feed served by
        `/api/in/scalper/signals` (cards in ₹ / NSE ticker form), and a
        "how the F&O strategies work" reference card. Replaces the
        legacy `/in/scalper` URL (308-redirects).
    - [ ] **India Liquidity Edge (ILE)** — port of the *India Liquidity
          Edge — Quant Framework* Pine indicator. A liquidity-first
          confluence engine purpose-built for NSE indices + F&O stocks
          that folds eight modules into a single 0–10 bull/bear score:
          (1) a **liquidity-sweep detector** that pools equal highs/lows
          over a lookback window and fires only when price sweeps the
          pool (stop hunt) AND closes back inside, gated by a volume
          spike / VIX > 14 / sweep-window confluence; (2) **OI walls +
          max-pain gravity** — CE/PE walls, a pinning-zone box, PCR
          classification, and a post-13:30 (or 14:00 on expiry) max-pain
          pull; (3) a **gap-fill engine** that flags gap-up / gap-down
          opens and takes the first-candle reversal back toward PDC with
          a 50%-of-gap invalidation; (4) **NSE session + expiry timing**
          (Trap Zone → Discovery → Prime Window → Trend Ride → Dead Zone
          → Close Rush → Closing Risk, plus an expiry-day gamma-blast
          window); (5) **India VIX regime + IV-crush + VIX divergence**;
          (6) a **confluence score engine** that sums sweep / wall
          proximity / PCR / gap / session / VIX / max-pain / volume /
          VWAP / PDC alignment into a 0–10 score (STRONG BUY/SELL ≥ 7);
          (7) **auto ATR-sized SL/TP** (0.25× ATR stop, 2.5× RR target);
          and (8) instrument presets (Auto ATR-scaled / Nifty /
          BankNifty / MidcapNifty / Custom) so every buffer scales to
          the underlying. Min-confluence threshold is user-tunable.
    - [ ] **India Max-Pain Gravity (IMPG)** — option-positioning
          mean-reversion strategy carved from the same *India Liquidity
          Edge — Quant Framework* Pine indicator. Where ILE folds all
          eight modules into a broad liquidity-sweep confluence score,
          IMPG isolates the dealer-positioning modules into a focused,
          fade-the-extreme play: (1) **max-pain gravity** — after 13:30
          IST (or 14:00 on expiry) fade price back toward the max-pain
          strike once it has drifted beyond the (ATR-scaled) pull
          buffer, since dealers pin spot to max pain into the close;
          (2) **OI-wall fade** — short rejections at the strongest CE
          wall / long rejections off the strongest PE floor when price
          is within the wall-proximity buffer, gated by PCR (> 1.4
          favours PE-floor longs, < 0.8 favours CE-wall shorts);
          (3) **pinning-zone mean reversion** inside the put-floor →
          call-ceiling box; (4) **gap-fill toward PDC** — first-candle
          reversal back to the previous-day close on a gap-up / gap-down
          open with a 50%-of-gap invalidation (event gaps flagged as
          less reliable); and (5) **expiry-day gamma awareness** — flags
          the 09:30–11:30 gamma-blast window and tightens to
          directional-options on expiry. Targets the max-pain strike /
          PDC with an ATR-sized stop, and reuses the same instrument
          presets (Auto ATR-scaled / Nifty / BankNifty / MidcapNifty /
          Custom) so every buffer scales to the underlying.
  - [x] **F&O Paper Trading page** (`/in/paper-trading`) — full
        structural mirror of `/paper-trading` for NSE F&O. Open
        positions table with live MTM (mark prices via `/api/in/quote`),
        server-paginated journal with status / symbol filters and
        in-place note editor, per-symbol + per-strategy performance
        panel. Backed by India-scoped journal helpers that filter the
        shared `PaperTrade` table on the canonical `in:` source prefix
        so India and crypto journals never collide. The symbol filter
        runs at the Prisma layer (against the `String`-typed column,
        served by the `PaperTrade_symbol_openedAt_idx` index) — see the
        `20260518050000_papertrade_symbol_string` migration. Cards stay
        empty until the F&O paper-trader worker books its first trade.
  - [x] **India-flavoured Profile** (`/in/profile`) — reuses the
        cross-market account / data-sources / API-keys / alerts
        components but reframes copy around NSE F&O concerns
        (India-broker selection, cookie-warmed NSE proxy,
        weekly-expiry alerts).
- [x] **PaperTrade.symbol schema migration** — flipped the column from
      `SymbolEnum` (BTC/ETH/SOL only) to a free-form `String` so India
      F&O tickers (NIFTY, BANKNIFTY, RELIANCE, …) can sit alongside
      crypto rows in the same table. Migration:
      `prisma/migrations/20260518050000_papertrade_symbol_string`. The
      India journal symbol filter now rides the Prisma equality path
      and the `PaperTrade_symbol_openedAt_idx` index — the previous
      in-memory workaround is gone.
- [x] **F&O paper-trader worker** — the `india-scalper` worker job
      (`worker/src/jobs/india-scalper.ts`) fans out across 1m / 5m / 15m
      every tick, books India paper trades into the shared `PaperTrade`
      table tagged with the `in:<id>:<tf>` source prefix the journal
      filters on, and resolves OPEN rows against 5m NSE candles. Trade
      levels are sized off a real intraday ATR (NSE 0.05-tick rounded via
      `roundToNseTick`) instead of the old synthetic 0.5%/1.0% band, fresh
      entries are skipped inside the expiry-day gamma cooldown (Thursday
      ≥ 14:30 IST), and the conservative touch-both → stop tie-break
      matches the crypto resolver. Pure sizing / resolution math lives in
      `paper-trader-core.ts`; the I/O orchestration in `paper-trader.ts`.
- [x] **Per-strategy score badge (blended)** — every India strategy chip
      carries a 0–100 score + A+…F grade via `IndiaStrategyScoreBadge`,
      blended from two sources (`score-board.ts`):
      - **Price strategies** (Range Expansion / Momentum / Volume
        Breakout) are scored from a **real 5-year daily-OHLCV backtest**
        (`backtest.ts` + `backtest-core.ts`): the scanner logic is ported
        to candle-fed modules (`strategies/price-modules.ts`), replayed
        bar-by-bar across a basket of liquid F&O large-caps, and the
        pooled trades summarised (win rate, profit factor, expectancy,
        max drawdown, Sharpe). The chip shows a **5Y** tag.
      - **Option-chain strategies** (PCR / IV / OI build-up / Liquidity
        Edge / Max-Pain Gravity) have no historical option-chain data, so
        they're scored from the **live paper-trade record** (the chip
        shows a **PT** tag).
      Both feed the one risk-aware `scoreIndiaStrategy` engine so the two
      sources share a single 0–100 scale; strategies with no data render a
      neutral "no trades yet" placeholder.
- [x] **NSE option-chain snapshot capture** — NSE serves only the live
      chain (no history endpoint), so the `india-oc-capture` worker job
      snapshots each F&O index's aggregated analytics (PCR, max-pain, ATM
      IV, OI walls, ΔOI, spot + day change) into the new
      `OptionChainSnapshot` table every 5 min during market hours
      (`isNseMarketOpenIST` gate; `option-chain-capture.ts` does the
      write, `getOptionChainHistory` / `getOptionChainSeries` read it back
      oldest-first). This builds the history the option-chain strategies
      need to be backtested.
- [x] **Option-chain replay backtester** — `option-chain-replay-core.ts`
      replays the captured snapshot series bar-by-bar: it reconstructs each
      of the five option-chain signals from a snapshot (reusing the exact
      `positioning-core` ILE/IMPG builders and the same PCR/IV/OI direction
      thresholds as `fetch-signals`, so there's **zero logic drift** vs the
      live lane), then resolves each trade against the forward spot path,
      force-closing flat at the IST day boundary. `option-chain-replay.ts`
      pools the resolved trades across all four F&O indices, summarises them
      and grades them on the **same** `scoreIndiaStrategy` scale. The
      blended `score-board` now promotes the 5 option-chain strategies from
      the live **PT** score to a true backtest score (the chip flips to
      **5Y**) — but only once enough real snapshots have accrued
      (`MIN_SNAPSHOTS` / `MIN_TRADES` guards); until then it cleanly falls
      back to the live paper-trade record.
- [x] **India News + sentiment** — a new `/in/news` surface that fans out
      across Moneycontrol India RSS feeds (top news / markets / business /
      economy / results) plus global business feeds, parses them with a
      dependency-free RSS parser (`services/india/news`), and runs each
      headline through a pure, deterministic bull/bear lexicon engine
      (`features/india/news/engine.ts`). Every headline is tagged with the
      F&O stocks / index underlyings / sectors it impacts (high / medium /
      low), and the impactful set is folded into an overall market sentiment
      (bullish / bearish / neutral) and a 0-100 risk-on / risk-off ratio.
      Feed URLs are env-overridable via `INDIA_NEWS_FEEDS`; live + Redis-cached
      (5-min TTL), no DB or worker job.

## Troubleshooting

**`Error: PrismaConfigEnvError: Missing required environment variable: DATABASE_URL`**
Copy `.env.example` to `.env.local`. The defaults match the docker-compose services.

**`[redis] REDIS_URL not set — using in-memory fallback`**
Either start Redis (`npm run docker:up`) or accept the in-memory cache for dev only.
The fallback is process-local and disappears on restart.

**`Connection refused (5432 / 6379)`**
Docker Desktop isn't running, or `docker compose up -d` was never run.
Run `docker compose ps` to check container health.

**`bash: fork: retry: Resource temporarily unavailable` / `STATUS_COMMITMENT_LIMIT (0xC000012D)` / dev server exits with code `127` right after `Compiling /...`**
Windows has run out of kernel commit memory and bash can't spawn `next` /
`tsx` any more. This is the OS, not the app — the dev server is being
killed before it can serve a single byte (so the browser sees
`ERR_CONNECTION_REFUSED` / `-102`).

Mitigations baked into this repo:

- `next.config.ts` already disables `experimental.preloadEntriesOnStart`
  and enables `experimental.turbopackFileSystemCacheForDev` so each dev
  startup is as lean as possible.
- `npm run worker:dev` runs the worker **without** `tsx watch` — no
  chokidar watcher, no restart child process. Use `npm run worker:watch`
  only when you actively need auto-restart.

If you still hit the fork wall:

1. Close other Electron apps / extra Cursor windows — each one ships
   ~100 helper `node.exe` processes.
2. Avoid running `npm run dev`, `npm run worker:dev`, **and**
   `npm run test:watch` (or `npm run dev:tdd`) concurrently on Windows.
3. As a last resort restart the machine to flush the commit pool, then
   start Docker → dev server → worker in that order.
