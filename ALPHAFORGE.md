# ALPHAFORGE.md

```md
# Alphaforge — Project Context

## Project Overview
Build a professional **multi-market** trading desk focused on:

- **Crypto** (default) — BTC · ETH · SOL
- **Indian Market** (NSE F&O) — NIFTY 50 / BANKNIFTY / FINNIFTY + F&O stocks

A top-of-sidebar Market Switcher toggles between the two surfaces. The
URL is the source of truth (`/` = crypto, `/in/*` = Indian), so deep
links and browser back/forward always land in the right mode. A
three-way **theme toggle** (Light · System · Dark) sits in the topbar
and works identically across both markets — driven by a single
`<ThemeProvider>` that uses `useSyncExternalStore` to mirror
`localStorage` + `prefers-color-scheme`, plus a pre-hydration inline
script in `app/layout.tsx` so light-mode users never see a flash of
dark.

The dashboard should provide:

### Crypto surface
- Live market overview
- Best-time-to-trade indicator (IST, anchored to Indian retail traders)
- Market sentiment analysis
- Futures data
- Options chain data
- Open interest tracking
- Funding rates
- Long/Short ratio
- Liquidation heatmaps
- Buy/Sell/Long/Short trade suggestions
- TradingView-like charts
- Delta Exchange inspired UI/UX

### Indian Market surface (`/in/*`)

The India sidebar mirrors the crypto sidebar one-for-one — the same ten
core surfaces (Overview, Best Time, Options, Signals, AI Signals,
Strategies, Paper Trading, Strategy Backtest, Strategy Lab, Heatmap)
live in both markets, each routed to `/in/*` so the data and UI are
scoped to NSE F&O. Crypto-only items (Futures) and India-only items
(Scanner, Watchlist, Chart) are appended as extras under the shared
core. Account-level preferences (settings, data sources, API keys,
alerts, sign-out) live on the consolidated Profile page (`/profile`,
`/in/profile`), opened by clicking the user avatar in the top-right of
the topbar.

- **Overview / Market Pulse** (`/in/dashboard`) — NIFTY indices hero
  strip with 3D tilt, sectoral heatmap (bullish→bearish), MSB–OB
  intraday signals table, range-expansion (WR8 + bullish-trend) scanner
  section, sector drill-down modal with sortable F&O constituents
  (price, day %, vs SMA50, upside, downside, score, signal, held-for).
- **Best Time** (`/in/best-time`) — NSE-anchored session guide. Seven
  windows (Pre-Open Auction 09:00–09:15, Opening Volatility 09:15–10:00,
  Morning Trend 10:00–11:30, Midday Lull 11:30–13:30, Afternoon Trend
  13:30–15:00, Power Hour 15:00–15:30, Closing Auction 15:30–15:40),
  weekday quality (Tue/Wed = ideal, Thu = weekly expiry warning,
  Sat/Sun = closed), 09:00–16:00 IST timeline with a live "now" cursor,
  per-style matrix and a NIFTY/BANKNIFTY focus card. Forces "off"
  outside trading hours and on weekends.
- **Options / Option Chain** (`/in/options`) — live NSE option chain
  with PCR, max-pain, ATM ±5 strikes, IV per strike, OI heat.
- **Signals** (`/in/signals`) — unified F&O signal feed merging all six
  scanner types from `/api/in/scanner` (range-expansion, momentum,
  volume breakout, OI build-up, PCR, IV-spike) into a single ranked
  board. Per-source filter strip persisted to localStorage; rows ranked
  by absolute metric magnitude across sources. Each row supports
  Add-to-Watchlist + chart drill-down. Pinned with the India Best-Time
  banner so signal context is always visible.
- **AI Signals** (`/in/ai-signals`) — multi-confluence AI engine on top
  of the F&O surface. Pulls daily trend (SMA 20/50/200 + RSI + momentum),
  option-chain positioning (PCR, ATM IV, ΔPE-CE OI, max-pain) from the
  live NSE chain, and cross-references the existing scanners. Publishes
  a confidence-scored trade plan per index + F&O leader (NIFTY,
  BANKNIFTY, FINNIFTY, MIDCPNIFTY + RELIANCE, HDFCBANK, TCS) with the
  nearest ATM strike, tiered TP ladder, ATR-sized stop, position-sizing
  %, and a live entry/exit timing window. Forces WAIT outside NSE
  session hours.
- **Strategies** (`/in/strategies`) — full structural mirror of the
  crypto Strategies page. Best-Time banner pinned to the active NSE
  window, a nine-strategy picker (Range Expansion, Momentum, Volume
  Breakout, OI Build-up, PCR Extreme, IV Spike — each derived from the
  existing NSE scanners — plus India Liquidity Edge, a liquidity-first
  quant framework ported from the ILE Pine indicator, India
  Max-Pain Gravity, an option-positioning mean-reversion play carved
  from the same Pine framework, and Opening Breakout, the first 5-min
  candle opening-range break entered on the retest), per-strategy
  1m / 5m / 15m timeframe toggles,
  a live multi-timeframe signal feed served by `/api/in/scalper/signals`
  (cards in ₹ / NSE ticker form), and a "how the F&O strategies work"
  reference card. Replaces the legacy `/in/scalper` URL (308-redirects
  to `/in/strategies`).
- **Paper Trading** (`/in/paper-trading`) — full structural mirror of
  the crypto Paper Trading page. Best-Time banner, F&O open-positions
  table with live MTM (mark prices via `/api/in/quote`), server-
  paginated journal with status / symbol filters and in-place note
  editor, and per-symbol + per-strategy performance panel. Backed by
  India-scoped journal helpers (`getIndia*` in
  `src/features/india/scalping/journal.ts`) that filter the shared
  `PaperTrade` table on the canonical `in:` source prefix so India and
  crypto journals never collide. The `india-scalper` worker job now fills
  the journal: it books each signal with ATR-sized SL/TP (NSE 0.05-tick
  rounded), an expiry-day gamma cooldown (Thursday ≥ 14:30 IST), and 5m
  NSE-candle resolution — so the cards populate as soon as the worker
  runs against a live session.
- **Strategy Backtest** (`/in/strategy-backtest`) — live OHLCV scaffold
  against `/api/in/historical` with a selectable underlying (NIFTY,
  BANKNIFTY, FINNIFTY, MIDCPNIFTY + top F&O stocks) and timeframe
  (5m → 1w). Surfaces the exact bars the engine will replay plus quick
  stats (avg daily %, ATR/close %, hi/lo). Roadmap covers retargeting
  the strategy modules, tick-size rounding, and the score+grade engine
  drop-in.
- **Strategy Lab** (`/in/strategy-lab`) — conversational F&O intake.
  Free-form prompt with four NSE-specific templates (NIFTY ORB,
  BANKNIFTY VWAP reversion, expiry IV-crush straddle, F&O-stock EMA
  pullback), underlying + lookback + timeframe + stop/target capture.
  Roadmap describes the F&O-aware AST parser (IV ATM, India VIX, OI
  ΔBUILDUP, expiry-day tokens), NSE backtest pipeline, per-user table,
  and worker forward-test.
- **Heatmap** (`/in/heatmap`) — sector + stock-level grid across all 11
  F&O sectors, fed by `/api/in/sector-stocks`. Tiles tinted by day %
  using inline `color-mix()` so saturation scales continuously (Tailwind
  JIT can't synthesise arbitrary `color-mix` percentages from a template
  literal). Sector pulse strip across the top, sectors sorted by average
  move, click-through to per-symbol charts.
- **Profile** (`/in/profile`, opened from the topbar avatar) — same
  Account / Data sources / API keys / Alerts tabs as the crypto
  `/profile` page (settings are user-scoped, not market-scoped) but
  with copy reframed around NSE F&O concerns: India-broker selection
  (Yahoo / NSE proxy / Groww), the cookie-warmed NSE proxy, and
  weekly-expiry alert templates. Tabs are hash-routed
  (`/in/profile#api-keys`) for deep-linking. The legacy `/in/settings`
  URL 308-redirects here.

#### India-specific extras (kept under the shared core)

- **Daily Picks** (`/in/daily-picks`) — the day's standout F&O signals
  distilled into the **top three per bucket**: *Indices Scalping* (institutional
  index plays on OI build-up + PCR + max-pain), *Highly Momentum* (strongest
  aligned trend + 5-day momentum + volume thrust), *Highly Scalping*
  (cleanest intraday setups — expected range, sharp R:R, scanner agreement,
  short horizon) and *Highly Potential* (highest conviction + win-probability
  + blended payoff). Each pick carries entry, stop loss, target, **can move
  upto** (stretch target), **can expect** (% move to the stretch), the **time
  it appeared** on the board and **how long it took to take profit/loss**, plus
  the logic for why it sits in its bucket. Picks are **frozen** once per IST
  trading day (`IndiaDailyPick` table, one row per
  `tradeDate × bucket × rank`) so entry/stop/target never move under the
  user, then **tracked live** against the latest mark — current P&L and
  progress-to-target update every refresh, resolving to TARGET_HIT /
  STOP_HIT and **CLOSED** (squared off) at the 15:30 IST close. Every past
  trading day's picks + outcomes are archived to a queryable history. Indices
  feed only the indices bucket and stocks the other three, and a symbol only
  ever appears once, so all picks are distinct. DB-resilient: degrades to
  ephemeral live picks when Postgres is unreachable.
- **News** (`/in/news`) — top market news pulled from fresh Indian market
  RSS feeds (Economic Times Markets / Stocks / Economy, with Moneycontrol
  as a best-effort extra) plus global business feeds (WSJ), filtered to the
  last few days so only the latest news surfaces. Each headline is tagged
  with the F&O stocks /
  index underlyings / sectors it impacts (high / medium / low) and scored
  for bull/bear sentiment via a deterministic lexicon engine; the
  impactful set is folded into an overall market sentiment (bullish /
  bearish / neutral) and a 0-100 risk-on / risk-off ratio shown in a
  banner above an India / Global filterable feed. Live + Redis-cached.
- **Scanner** (`/in/scanner`) — single-mode scanner UI driven directly
  by `/api/in/scanner` (range-expansion default). Same data the unified
  Signals page consumes; different UX for users who want one source at
  a time.
- **Watchlist** (`/in/watchlist`) — persistent F&O watchlist (Zustand
  persist key `india-fno-watchlist`).
- **Chart** (`/in/chart/[symbol]`) — per-symbol lightweight-charts
  deep-dive with intraday / daily toggles.

---

# Tech Stack

## Frontend
- Next.js (App Router)
- TypeScript
- TailwindCSS
- Shadcn UI
- Zustand (state management)
- React Query / TanStack Query
- Framer Motion
- Recharts / Lightweight Charts

## Backend
- Next.js API routes OR separate Express server
- TypeScript
- Redis caching
- WebSocket support

## Database
- PostgreSQL
- Prisma ORM

## Realtime Data
- Binance WebSocket
- Bybit API
- Deribit API
- CoinGlass API
- Alternative.me Fear & Greed API

## Indian-market data sources
- **yahoo-finance2** (default) — quotes, historical OHLCV, fundamentals
- **NSE direct** (`/api/option-chain-indices`, `/option-chain-equities`)
  — cookie-warmed, rate-limited proxy for full option chains
- **Groww REST** (optional, opt-in via `INDIA_BROKER=groww`)
- Selectable per-deployment via `INDIA_BROKER=yahoo|nse|groww` (falls
  back to `ACTIVE_BROKER`, then `yahoo`).

---

# Core Features

## 0. Market Switcher (Crypto ↔ Indian F&O)

A two-segment toggle sits at the very top of the sidebar — Crypto (BTC ·
ETH · SOL) or Indian Market (NSE F&O). Selecting a segment navigates to
that market's landing route (`/` or `/in/dashboard`); the sidebar then
re-renders its nav from one of two static `NavItem[]` arrays. The active
market is derived from `usePathname()` via
`useActiveMarket()` in `src/lib/market-mode.ts` — the URL is the source
of truth, so deep links, browser back/forward, and shareable URLs all
land in the right mode with zero extra persistence.

Both surfaces share the same `(dashboard)` layout (LiveStreamMount +
Topbar + MarketTickerBar + main content), so notifications, the
connection pill, and the user menu work identically across markets.
The user-menu avatar in the topbar is a market-aware Link — clicking
it on a `/in/*` route opens `/in/profile`, otherwise `/profile`.

### Folder partitioning

To keep both markets isolated, the Indian code lives under sibling
`india/` directories — there is no cross-import between markets and no
namespace collisions:

- `src/app/(dashboard)/in/*` — pages (one route per item in the India
  sidebar: `dashboard`, `best-time`, `options`, `signals`, `ai-signals`,
  `strategies`, `paper-trading`, `strategy-backtest`, `strategy-lab`,
  `heatmap`, plus the India-specific `scanner`, `watchlist`,
  `chart/[symbol]`, plus the topbar-anchored `profile`; the legacy
  `settings` route 308-redirects to `profile`, and the legacy `scalper`
  route 308-redirects to `strategies`)
- `src/app/api/in/*` — API routes
- `src/components/india/*` — UI:
  - `best-time/` — `india-best-time-banner`, `india-best-time-dashboard`
  - `heatmap/india-heatmap`
  - `signals/india-signals-board`
  - `strategy/india-backtest-preview`, `india-strategy-lab-intake`
  - `common/india-feature-preview` (shared "live preview + roadmap" shell)
  - `msb-dashboard`, `charts/price-chart`, `options/option-chain-table`,
    `ticker/live-ticker`
  - `ui/*` — India-flavoured shadcn primitives (button / card / table)
- `src/services/india/*` — broker adapters, cache, scanner, signals
- `src/features/india/*` — pure engines:
  - `best-time/engine.ts` — NSE-anchored window catalogue + scoring
    (mirrors `features/best-time/engine.ts` but with seven NSE-specific
    sessions, expiry-aware day quality, weekend "off" enforcement)
- `src/store/india/*` — Zustand stores (prefixed `useIndia…Store`)
- `src/hooks/india/*` — `useFetchPoll`, `useFeedStream`, `useLiveQuotes`,
  `useOptionChain`, `useScanner`
- `src/types/india/*`, `src/lib/india/*`

Globals that *would* collide across markets (Redis prefix, broker env
var, `globalThis.__cacheInstance`) are renamed in the India surface
(`INDIA_REDIS_PREFIX`, `INDIA_BROKER`, `__indiaCacheInstance`, …).

#### Sidebar nav parity (`src/components/dashboard/sidebar.tsx`)

The sidebar exposes two static `NavItem[]` arrays — `CRYPTO_NAV` and
`INDIA_NAV` — and `useActiveMarket()` (URL-derived) picks which one
renders. Both arrays start with the same ten core items in the same
order so the user's mental map carries across the market switcher;
market-specific extras live below the shared core. Account-level
preferences are intentionally absent from the sidebar — they live on
the topbar avatar (`/profile`, `/in/profile`).

Each `NavItem` carries an optional `public: true` flag. Only the two
"showroom" items (Overview + Heatmap, per market) set it, so anonymous
visitors see a deliberately thin sidebar with just those two rows and a
`Sign in to unlock` CTA. Every other row is hidden from the UI for
unauthenticated users *and* protected at the proxy level
(`src/lib/auth.ts → isPublicPath`), so direct URLs redirect to
`/login?callbackUrl=…`.

| #  | Crypto                                  | India                                       | Auth        |
| -- | --------------------------------------- | ------------------------------------------- | ----------- |
| 1  | Overview (`/`)                          | Overview (`/in/dashboard`)                  | **Public**  |
| 2  | Best Time (`/best-time`)                | Best Time (`/in/best-time`)                 | Protected   |
| 3  | Options (`/options`)                    | Options (`/in/options`)                     | Protected   |
| 4  | Signals (`/signals`)                    | Signals (`/in/signals`)                     | Protected   |
| 5  | AI Signals (`/ai-signals`)              | AI Signals (`/in/ai-signals`)               | Protected   |
| 6  | Strategies (`/strategies`)              | Strategies (`/in/strategies`)               | Protected   |
| 7  | Paper Trading (`/paper-trading`)        | Paper Trading (`/in/paper-trading`)         | Protected   |
| 8  | Strategy Backtest (`/strategy-backtest`)| Strategy Backtest (`/in/strategy-backtest`) | Protected   |
| 9  | Strategy Lab (`/strategy-lab`)          | Strategy Lab (`/in/strategy-lab`)           | Protected   |
| 10 | Heatmap (`/heatmap`)                    | Heatmap (`/in/heatmap`)                     | **Public**  |
| +  | Futures (crypto-only)                   | Daily Picks / News / Scanner / Watchlist / Chart (India-only) | Protected   |
| ☰  | Profile (topbar avatar → `/profile`)    | Profile (topbar avatar → `/in/profile`)     | Protected   |

The "Strategies" surface owns the live strategy picker + signal feed
(the *configuration* half of the old Scalper page), while "Paper
Trading" owns the open positions table, the journal and the
per-strategy + per-symbol performance breakdown (the *outcome* half).
The split lets the user pick strategies and audit results on dedicated
surfaces while still sharing the same strategy filter via the Zustand
store. The legacy `/scalper` and `/in/scalper` URLs 308-redirect to
their respective `/strategies` counterparts.

The nav is `overflow-y-auto` so the longer India list (13 items)
doesn't overflow on short viewports.

## 1. Market Overview
Display:
- BTC price
- ETH price
- SOL price
- 24h change
- Volume
- Market cap
- Dominance

## 1a. Best Time to Trade (IST)
A pure, IST-anchored engine + UI that tells the user whether *right now* is a
good moment to trade BTC / ETH / SOL — based on liquidity, volatility and
when global institutional flow actually shows up.

### Windows (all IST)
| Window                | Hours          | Quality   | Best for                                     |
| --------------------- | -------------- | --------- | -------------------------------------------- |
| Worst Zone            | 02:00 – 07:00  | Avoid     | Skip unless FOMC / CPI / ETF news            |
| Range Scalp Window    | 11:30 – 15:00  | Moderate  | VWAP / S-R / range trading                   |
| Volatility Breakout   | 18:00 – 20:00  | Ideal     | Breakouts, momentum entries, news reactions  |
| Prime Futures Window  | 18:30 – 23:30  | Ideal     | Futures + scalping + momentum                |
| Golden Scalp Zone     | 19:00 – 22:00  | Ideal     | 1m / 5m / futures scalping (peak liquidity)  |
| Swing Entry Window    | 20:00 – 00:00  | Good      | Scaling into multi-day positions             |

When several windows overlap, the highest-priority one wins
(Golden > Breakout > Prime > Swing > Range > Worst). Day-of-week quality
modulates the score (Tue/Wed/Thu = excellent, Fri = good-but-volatile,
Sun = low liquidity, Mon = often choppy).

### Engine
- `src/features/best-time/engine.ts` — pure functions, IST-shifted via the
  fixed +5:30 offset (no `toLocaleString`, no host-timezone dependence),
  so server + client always agree.
- `getBestTimeStatus(at?)` returns the active window, composite score,
  verdict, overlapping windows, and the next upgrade with a minute-precise
  countdown.

### UI surface
1. **Overview banner** (between the search bar and the BTC / ETH / SOL
   cards) — current window, verdict, day quality, ends-in / next-window
   countdowns, and a radial quality dial. Recomputes every minute on a
   wall-clock boundary so all banners tick in unison.
2. **Best Time tab** (dedicated `/best-time` page) — full breakdown:
   hero status card, 24h IST timeline visualisation with a "now" cursor,
   per-window cards with insight + suited styles, best-days table,
   per-style "best window" matrix, and a BTC spotlight (7-11 PM IST).

## 2. Market Sentiment
Analyze:
- Fear & Greed Index
- Funding rate
- Open interest trend
- Liquidation data
- Long vs short ratio
- Social sentiment (optional)

Return:
- Bullish
- Bearish
- Neutral

## 3. Futures Dashboard
Show:
- Funding rates
- OI changes
- Volume spikes
- Liquidation clusters
- Top gainers/losers

## 4. Options Dashboard
Show:
- Put/Call ratio
- Max pain
- Implied volatility
- Expiry-wise OI
- Strike-wise data

## 5. Trading Suggestions Engine
Generate:
- LONG
- SHORT
- BUY
- SELL
- HOLD

Signals should be based on:
- RSI
- MACD
- EMA crossover
- Funding rate
- Open interest
- Volume breakout
- Liquidation imbalance
- Fear & Greed index

Each signal should include:
- Confidence score
- Risk level
- Suggested entry
- Stop loss
- Target

## 5a. AI Signals (multi-confluence intelligence)

A dedicated **AI Signals** surface lives on both markets — crypto
(`/ai-signals`) and Indian F&O (`/in/ai-signals`) — that goes beyond the
single-line "BUY/SELL/HOLD" of the legacy Signals page. Each AI signal is
a complete, confidence-scored trade plan.

### What every signal contains
- **Action** — `LONG` / `SHORT` / `BUY` / `SELL` / `WAIT` (WAIT forces no
  trade when outside the active session or when the read is inconclusive).
- **Confidence score** — 0–100 with a letter **grade** (S / A / B / C / D)
  scaled by both directional magnitude AND the share of factors that
  were actually available.
- **Calibrated win probability** — TP1-before-SL probability mapped via a
  logistic curve to a sane [0.30, 0.85] range so no signal ever pretends
  to be "almost certain".
- **Entry zone** — point entry plus a tight ±0.25×ATR zone where filling
  is acceptable.
- **Strike** — nearest tradeable instrument anchor (rounded crypto futures
  level, or the nearest ATM option strike from the live NSE chain).
- **Tiered take-profit ladder** — TP1 / TP2 / TP3 at horizon-appropriate
  ATR multiples (e.g. intraday 1.6× / 2.6× / 4.0×) with scale-out
  allocations of 50% / 30% / 20%.
- **ATR-sized stop loss** with explicit invalidation-criteria line
  ("Setup invalidates on a 15m close below 98 500.00 — exit immediately").
- **Risk:Reward** — both TP1-vs-SL and blended (allocation-weighted across
  all three TPs).
- **Position sizing %** — assumes a 1% per-trade risk budget against the
  ATR-based stop, scaled by confidence, capped per horizon so a hair-thin
  stop can never recommend a leverage-up.
- **Time horizon** — `scalp` (30m) / `intraday` (1-4h) / `swing` (1-3d) /
  `positional` (1-2w) — picked from the active session × derivative
  share × score magnitude.
- **Timing window** — `enterBy` (next 15m) + `exitBy` (horizon-appropriate)
  with a live UI countdown that flips to a "Stale" badge once it expires.
- **AI rationale** — top 6 confluence factors as human-readable rows with
  category chips (Tech / Deriv / Sent / Macro / News / Flow / Chart) and a
  bull-vs-bear count.

### Crypto AI engine (`/api/ai-signals`)

Fans out across the same data sources we already ship for BTC / ETH / SOL,
folded into a 9-factor confluence stack:

1. RSI(14)
2. MACD histogram
3. EMA 20/50 spread
4. Volume thrust (current vs 20-bar avg)
5. Funding rate (inverted — crowded longs paying = contrarian short)
6. OI 1h Δ
7. Long/short ratio (inverted)
8. Liquidation imbalance (short liquidations = bullish flush)
9. Fear & Greed (inverted — extreme greed = contrarian fade)

Plus a session-quality bonus driven by the IST Best-Time engine — outside
the active window every signal forces WAIT. The hero banner above the grid
publishes a market **regime** read (`risk-on` / `risk-off` / `mixed` /
`compressed`) with a one-line headline + bullets summarising the regime
inputs (avg funding, OI 1h, F&G classification).

### India F&O AI engine (`/api/in/ai-signals`)

Covers NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY + the three
highest-liquidity F&O stock leaders. Same `AiSignal` shape so the rich
`<AiSignalCard>` renders 1:1, but with an India-specific confluence stack:

1. Daily SMA 20/50/200 trend stack
2. Daily RSI(14)
3. 5-day momentum
4. Volume thrust vs 20-day avg
5. **PCR (OI)** — heavy PE writing = bullish, heavy CE writing = bearish
6. **ATM IV** — inverted, since elevated IV crushes options after the move
7. **OI build-up** — ΔPE OI − ΔCE OI from the live NSE option chain
8. **Max-pain pull** — distance from spot to max-pain strike
9. **Scanner agreement** — cross-references the six existing F&O scanners
   (momentum / volume / range-expansion / OI build-up / PCR / IV-spike)
   so a strong AI long agrees with what the live multi-scanner board shows
10. NSE session quality — forces WAIT outside 09:15–15:30 IST and on
    weekends / weekly-expiry warning days

Strike suggestions come from the live NSE option chain — every non-WAIT
signal carries the nearest ATM strike so the user knows exactly which
contract to touch on. Prices and stops are rounded to NSE-appropriate tick
sizes (0.05 INR on stocks, 1 / 5 on indices depending on price band).

### Engine architecture

- `src/types/ai-signals.ts` — shared `AiSignal`, `AiSignalsResponse`,
  `AiMarketContext` types (cross-market).
- `src/features/ai-signals/engine.ts` — pure, deterministic helpers
  (compositeScore, classifyAction, gradeFromConfidence,
  calibrateWinProbability, buildTakeProfits, buildTradeLevels,
  buildTimingWindow, buildReasons, suggestPositionSizePct, …). No I/O.
- `src/features/ai-signals/crypto-builder.ts` — `getCryptoAiSignals()`
  fans out broker klines + futures aggregate + fear-greed + liquidations
  + best-time and folds into the shared engine. Cached via Redis at the
  `signals` TTL.
- `src/features/ai-signals/india-builder.ts` — `getIndiaAiSignals()`
  fans out Yahoo quotes + historical OHLCV + NSE option chain + the
  india scanner cache + the India best-time engine. Cached via the
  shared india-cache facade (Redis + in-process fallback).

UI components live in `src/components/ai-signals/`:
- `ai-signal-card.tsx` — the rich per-signal card (renders identically
  for both markets, just swaps `$` for `₹` on India)
- `ai-signals-board.tsx` — client polling shell with direction / horizon
  filters (persisted to localStorage) and manual refresh
- `ai-market-context-banner.tsx` — regime banner above the grid

## 5b. Daily Picks (India F&O — top 3 per bucket, frozen + live-tracked)

A dedicated **Daily Picks** surface on the Indian F&O market
(`/in/daily-picks`) that answers "what should I actually look at today?" by
distilling the whole signal pool down to the **top three signals in each of
five buckets**:

- **Indices Scalping** — institutional index plays on NIFTY / BANKNIFTY /
  FINNIFTY / MIDCPNIFTY: heavy option-chain **OI build-up** with **PCR** and
  **max-pain** positioning confirming intraday demand and the broad tape. Fed
  only from the index underlyings, so this section is always pure index scalps.
- **Opening Breakout** — the **first 5-min candle (9:15–9:19:59 IST)**
  opening-range breakout, sourced from the dedicated Opening Breakout strategy.
  Entry is on the **retest** of the broken level (the resistance→support flip),
  stop below the breakout candle, target **2R**, with **PCR / OI / max-pain**
  confirmation layered in. Freezes *lazily* — the picks only appear once the
  opening candle has broken and retested (typically 9:30+), and can be an index
  or a stock.
- **Highly Momentum Stocks** — the strongest directional names: the daily
  SMA trend stack, 5-day momentum and volume thrust all pushing the same way.
- **Highly Scalping Stocks** — the cleanest intraday setups: enough expected
  range, a sharp risk:reward, live scanner agreement and a short
  (scalp / intraday) horizon.
- **Highly Potential Stocks** — the highest-conviction, biggest-payoff
  trades, ranked by confidence, calibrated win-probability and blended R:R.

### What every pick contains
- **Entry**, **stop loss** and **target** (realistic first target / TP1).
- **Can move upto** — the stretch target (TP3) on a clean run.
- **Can expect** — the % move from entry to the stretch target.
- **Logic** — a human-readable "why it's here" line built from the signal's
  top confluence reasons, framed for the bucket it landed in.
- **Timing** — the **time the signal appeared on the board** (IST, frozen at
  selection time) and, once resolved, **how long it took to take profit or
  loss** (`resolvedAt - generatedAt`, e.g. "Target hit in 1h 15m"). While a
  pick is live the card shows how long it's been running.
- **Live tracking** — current P&L vs the frozen entry (direction-aware for
  LONG vs SHORT), **achieved-till-now** (best progress toward target so far)
  and a status that resolves OPEN → TARGET_HIT / STOP_HIT as price moves, then
  **CLOSED** (squared off) at the 15:30 IST close if neither level was touched.

### How it works
- **Intraday-only.** Every candidate is pinned to an `intraday` horizon and
  its stop/target are sized off a fraction of the daily ATR (a same-session
  move, not a multi-day swing) — Daily Picks is a day-trading product. No
  position is carried overnight: once a trade date's 15:30 IST session ends,
  any pick still OPEN is **force-squared-off at its last mark** (status
  `CLOSED`), regardless of P&L, both on the live board and across the history
  (`squareOffPick` + `isNseSessionEndedForDateIST`).
- **No pre-market freeze.** The builder will not freeze picks before
  **09:15 IST** — without real opening-session prices, anything captured at
  e.g. 00:12 (when the IST trade date rolls over) would just lock in last
  evening's closes and live-track stale levels all day. Pre-market requests
  return an empty board with the "waiting for open" empty state. If stale
  pre-market rows already exist in `IndiaDailyPick` for today (e.g. from an
  off-hours cron in a previous run), they're **auto-evicted on the first
  post-open request** and immediately re-frozen against fresh opening
  candidates (`nseOpenMsForDateIST` + `generatedAt < openMs` filter).
- **Institutional confluence stack.** Beyond the technical/derivatives reads,
  the signal now weights the factors a desk actually trades on: **intraday
  demand** (the day's move), **support/resistance breakout confirmed by
  volume**, **OI build-up**, the **broad market tape** (so single names lean
  *with* the index, not against it) and **news flow** (per-symbol headline
  sentiment). The 1-year SMA trend is de-emphasised for intraday.
- **Futures-segment screen.** Every candidate is also run through the
  Chartink-style institutional screen and the result feeds both the signal's
  direction/confidence and the per-bucket ranking (`computeFuturesScreen` →
  `futuresScreen` factor → `bucketScores`). A name scores highest when it
  satisfies all seven conditions: today's range is the **widest of the last 8
  sessions** (range expansion), an **up candle closing above the prior close**,
  a **bullish weekly and monthly** candle, **prior-session volume > 10k**
  (liquidity) and a **20 > 50 > 200 SMA stack**. The exact bearish mirror ranks
  shorts in a down market, so the screen lifts momentum, scalping and potential
  picks alike toward the cleanest desk setups.
- **Tape alignment.** In a strongly trending market, picks whose direction
  fights the tape are demoted (`marketAlignment`), so a bullish session yields
  longs — not shorts on names that merely look weak on the daily chart.
- **Index scalps are scored on derivatives positioning.** The Indices-Scalping
  bucket leans heaviest on **OI build-up** (the option writers' footprint),
  then **PCR** and **max-pain** confirmation, intraday momentum, expected range
  and a short horizon — the inputs an index desk actually trades. Indices feed
  *only* this bucket and stocks feed Momentum / Scalping / Potential
  (`isIndexSignal` partition), so the index section never crowds out a stock
  pick and vice-versa.
- **Opening Breakout is externally sourced.** Unlike the other buckets (ranked
  from the AI candidate universe), the `OPENING_BREAKOUT` bucket is fed straight
  from the Opening Breakout strategy's top signals (`getIndiaOpeningBreakoutSignals`
  → `dailyPickFromScalpSignal`). Because the setup needs the first 5-min candle
  to break *and* retest, the bucket **freezes lazily** the first time signals
  exist for the day rather than at the morning's first request, then live-tracks
  and squares off at 15:30 like every other pick. Its "appeared on board" time is
  the **retest instant** (the strategy's trigger), not the freeze time.
- The candidate pool is the India AI universe (four F&O indices + AI leaders)
  layered with a broad high-liquidity F&O stock set (~30 names), so the board
  always has enough *distinct*, directional names to fill the buckets (a symbol
  only ever appears in one bucket — round-robin by best-fit). Option chains are
  fetched for every index so the OI / PCR / max-pain reads are first-party.
- Picks are **frozen once per IST trading day** into the `IndiaDailyPick`
  table (one row per `tradeDate × bucket × rank`) so entry / stop / target
  never drift under the user. Every subsequent request **live-tracks** the
  frozen picks against the latest mark and persists the updated P&L /
  progress / outcome in place.
- An `india-daily-picks` **worker job** (`worker/src/jobs/india-daily-picks.ts`,
  default 5-min cadence, market-hours-gated) calls the same freeze-or-track
  path so the day's picks are frozen at the open and tracked to the close even
  if nobody opens the page — guaranteeing a complete daily history. Both the
  worker and the on-read path are idempotent (unique constraint +
  `skipDuplicates`), so they can't double-freeze.
- A **history** archives every past trading day's picks with their final
  outcome and the day's win rate, so the board is an auditable track record.
- The whole feature is **DB-resilient**: when Postgres is unreachable it
  degrades to ephemeral, still-live picks instead of hard-failing.

### Engine architecture
- `src/features/india/daily-picks/engine.ts` — pure, deterministic helpers
  (bucketScores, selectDailyPicks, pickFromSignal, trackPick, groupDailyPicks,
  istDateKey). No I/O.
- `src/features/india/daily-picks/builder.ts` — `getIndiaDailyPicks()`
  (freeze-or-track) and `getIndiaDailyPicksHistory()`, fed by
  `getIndiaDailyPickCandidates()` in the AI india-builder. Cached + DB-backed.
- API: `/api/in/daily-picks` (today's board) and
  `/api/in/daily-picks/history` (past days). UI in
  `src/components/india/daily-picks/` (board / card / history).
- Worker: `worker/src/jobs/india-daily-picks.ts` (cadence in
  `workerConfig.indiaDailyPicks`, env `WORKER_INDIA_DAILY_PICKS_INTERVAL_MS`)
  freezes + tracks automatically during NSE hours.

## 5c. Expiry-day index trades (Gamma Blast / Hero Zero)

An **expiry-only** section on the Daily Picks page that surfaces the two
desk playbooks for index option-buying on the actual expiry session — and
shows **nothing on any other day**:

- **Gamma Blast** — buy the ATM option in the trend direction. With one
  expiry session of theta left, ATM gamma is maximal, so a clean directional
  push expands the premium fast. ~2.2× target, ~50% hard stop.
- **Hero / Zero** — buy a cheap far-OTM option (3 strikes out): a binary
  lottery on a sharp move — multiplies into a "hero" or expires at "zero".
  ~5× target, stop at 0.

Coverage + detection:
- **NIFTY** (NSE) — expiry is read **from the live option chain** (its nearest
  expiry resolving to today is authoritative; handles holiday shifts). Premiums
  use real chain LTPs.
- **SENSEX** (BSE) — premiums come from the **live BSE option chain** synthesised
  by the Angel One adapter (the BFO scrip subset + FULL-mode quoting), with the
  chain's nearest expiry resolving to today as the authoritative gate. To avoid
  the rate-limited per-strike quoting on non-expiry days, the chain fetch is
  cheap-gated behind the fixed weekly weekday (**Thursday**, post-Sep-2025 SEBI
  realignment; NIFTY = Tuesday). When Angel One isn't configured (or the chain
  is unreachable) it falls back to a spot + India VIX Black-Scholes ATM estimate.
- Direction (CE vs PE) is taken from the index's intraday bias.

Engine/IO/UI:
- `src/features/india/expiry-trades/engine.ts` — pure (expiry parsing, weekday,
  premium estimate, strike math, trade assembly).
- `src/features/india/expiry-trades/builder.ts` — `getIndiaExpiryTrades()`
  (chain-or-estimate, resilient, cached).
- API: `/api/in/expiry-trades`. UI:
  `src/components/india/daily-picks/expiry-trades-section.tsx` (self-hides off
  expiry; live-polls). Rendered on `/in/daily-picks` only when it's an expiry
  day. Strictly defined-risk; the UI carries a prominent risk banner.

## 6. Alerts System
Create alerts for:
- Funding spike
- OI breakout
- Price breakout
- Liquidation surge
- Signal change

## 7. Strategy Lab (conversational backtester)
Let users describe a strategy in plain English and execute it deterministically.

Inputs:
- Free-form prompt (e.g. "Buy when RSI drops below 30 and sell when RSI
  crosses above 70. Stop 2%, take profit 5%.")
- Symbol: BTC / ETH / SOL
- Period: 1 week / 1 month / 6 months / 1 year / 5 years

Pipeline:
1. **Parse** — turn the prompt into a structured rule set with explicit
   indicators (RSI, MACD line/signal/histogram, EMA, SMA, ATR, volume,
   N-bar % change), comparators (>, <, crosses above, crosses below), and
   risk parameters (stop %, target %, ATR multiples, max-hold bars).
2. **Backtest** — fetch historical klines for the chosen window/interval,
   evaluate the rule per bar, simulate one open position at a time with
   intra-bar SL/TP resolution.
3. **Stats** — return win rate, total / avg / largest win-loss %,
   profit factor, max drawdown, annualised Sharpe, buy-and-hold benchmark,
   net P&L on a fixed notional, plus a downsampled equity curve and the
   full trade log.
4. **Save** — persist the prompt + parsed AST per user.
5. **Apply live** — the worker evaluates every active strategy on each
   fresh closed bar and opens paper trades that resolve against 1m candles
   (same tie-break rules as the scalper).

## 7a. Strategy Backtest (5-year scoring + recommendations)
A dedicated read-only tab that takes every scalping strategy and runs it
against **five years** of historical 4h candles on BTC / ETH / SOL with a
**$10,000** starting equity and **$10,000** per-trade notional. The runner:

1. Fetches once per symbol via the active broker adapter
   (`fetchKlinesRange` on a 4h interval — ~10,950 closed bars / symbol).
2. Walks each candle and feeds a trailing 256-bar window (or `warmup × 2`,
   whichever is larger) into the live strategy module's `run()` function.
   Signals whose `triggeredAt` matches the current closeTime open a paper
   trade with the strategy's own ATR-sized stop / target.
3. Resolves each trade by walking forward through subsequent bars
   (WIN on target touch, LOSS on stop touch, EXPIRED after `maxHoldBars`,
   EOD on the last bar) — same tie-break rules as the live paper-trader.
4. Produces per-symbol stats (win rate, profit factor, max DD, Sharpe, net
   P&L, equity curve) and a cross-symbol aggregate.

A scoring engine (`strategy-score.ts`) then collapses the aggregate into a
**0-100 score** weighting six dimensions — win rate (25%), profit factor
(20%), alpha over buy & hold (20%), max drawdown (15%), Sharpe (10%) and
statistical significance / trade count (10%) — and maps the result to a
letter grade (A+ / A / B / C / D / F) and one of four recommendations:
**Highly recommended**, **Recommended**, **Use with caution**, **Not
recommended**.

The full suite is computed once per process and cached for 24h
(in-memory, keyed by active broker id). The dedicated `/strategy-backtest`
page renders a leaderboard sorted by score with sparkline equity curves
per strategy, while the Strategies page's strategy picker shows the
same score badge next to every strategy chip so users can immediately
tell which strategies have a proven edge.

## 8. Strategies + Paper Trading (multi-strategy paper-trading engine)
A live strategy desk that runs **ten independent strategies** in parallel
on 1m / 5m / 15m closed bars. Every fresh signal opens a paper trade tagged
with the strategy that produced it, and the journal aggregates win-rate +
P&L both per-symbol and per-strategy.

The surface is split across two sidebar items:

- **Strategies** (`/strategies`, `/in/strategies`) — the *configuration*
  half: multi-select strategy picker, live multi-timeframe signal feed,
  and the strategy reference card. This is where users decide which
  strategies they want to subscribe to.
- **Paper Trading** (`/paper-trading`, `/in/paper-trading`) — the
  *outcome* half: live MTM open positions table, server-paginated
  journal (10 rows / page) and per-strategy + per-symbol performance
  breakdown. This is where users audit how their selected strategies
  are performing.

Users can pick **one or many** strategies from the picker — the selection
is persisted to localStorage and filters both the live signal feed and the
journal. The worker keeps producing trades for every strategy in the
background so the journal stays a transparent track record regardless of
the user's filter. The strategy filter is shared via the same
`StrategyProvider` Zustand store, so toggling a strategy on one page is
reflected on the other.

### Strategies
1. **UT Bot + SMC** — LuxAlgo UT Bot ATR trailing-stop flips confirmed by a
   Smart Money Concepts structure bias (BOS / CHoCH on a short pivot
   length). ATR(10), sensitivity 1, SMC pivot 5. 1×/2× ATR stop/target.
2. **VWAP Sweep + Trend** — EMA50 trend filter, then waits for a liquidity
   sweep of the prior 20-bar swing while price is stretched ≥ 0.8× ATR
   away from a rolling-window VWAP. Enters on the rejection candle; target
   is VWAP itself.
3. **News Momentum** — aggressive breakout. Fires on volume ≥ 2.8× the
   20-bar average + range ≥ 1.8× ATR + decisive body in the trade
   direction + SMA20 drift filter. Models the footprint of ETF news, Fed
   prints, liquidation cascades, exchange listings.
4. **Range Scalp** — Bollinger touches filtered by a rolling-range
   tightness check (≤ 4.5× ATR width) so the engine only fires when the
   market is *not* trending. RSI oversold/overbought + rejection close;
   target is the Bollinger mid-band.
5. **EMA Pullback** — 9 / 20 / 50 EMA stack + rising EMA50 slope. Prior
   bar pulls back into the 9-20 zone, current bar prints a confirmation
   candle in the trend direction. Classic 2:1 RR.
6. **VWAP Reversion** — pure mean-reversion. Fires when price is ≥ 1.5×
   ATR stretched from rolling VWAP AND RSI rolls off an extreme. Target =
   VWAP, stop = 1× ATR.
7. **Orderflow Sweep** — equal swing highs/lows cluster detection. Current
   bar wicks through the cluster on ≥ 1.8× volume then closes back inside
   (rejection). A proxy for the stop-hunt / liquidation-cluster sweeps
   professional desks engineer.
8. **Fib Pullback (1m)** — the textbook 1-minute Fibonacci impulse-pullback
   scalp. Detects an impulse swing ≥ 3× ATR within the last 12 closed bars,
   waits for the retrace to tag the 0.5-0.618 fib zone (without breaking
   0.786), and fires a continuation entry on a confirmation candle that
   reclaims the 0.5 fib. Long after an up impulse, short after a down
   impulse; target is the impulse extreme (0.0 fib).
9. **Institutional AI SMC** — port of the *Ultimate Institutional AI SMC
   System* Pine indicator. Aggregates **nine** institutional components
   into a 0-9 AI score:
   1. EMA20 vs EMA50 trend
   2. HTF bias (EMA200 on the same series — same-timeframe HTF proxy)
   3. VWAP side (rolling 96-bar)
   4. SSL / BSL liquidity sweep within the last 6 bars
   5. Bullish / bearish BOS within the last 6 bars (close crosses the
      most-recent confirmed pivot extreme, swing length 5)
   6. Fresh 3-candle Fair Value Gap within the last 6 bars
   7. Volume spike (≥ 1.5× the 20-bar average) in the trade direction
   8. Candle delta (close vs open)
   9. London or New York kill zone (UTC 7-10 and 13-16)

   The signal only fires when the score reaches 7 **and** the four
   institutional preconditions are *all* satisfied — bull/bear trend +
   VWAP side + recent sweep + recent BOS — so we never enter on a fresh
   impulse candle. A retest filter then rejects bars that have already
   extended away from the EMA20 (the workflow's "wait for retest, don't
   FOMO" rule). Stop sits one quarter-ATR beyond the actual sweep wick
   ("SL below the liquidity sweep low / above the bearish OB high");
   target is 2× ATR from entry. Confidence scales with the score, kill
   zone alignment, HTF agreement, FVG presence, and risk-reward.
10. **AI Institutional Pro v5** — port of the *AI Institutional
    Buy/Sell System [Pro v5]* Pine indicator. Two-stage gating: a set of
    **hard gates** must all pass before scoring even runs, then an
    **8-factor confluence score** has to clear the mode-preset minimum:

    Hard gates (all required):
    1. EMA20 vs EMA50 trend in the trade direction
    2. HTF EMA bias aligned (same-series EMA200 proxy for the Pine HTF
       EMA50 security request)
    3. RSI(14) not pinned in the opposite extreme (BUY blocked above
       `rsiOB`, SELL blocked below `rsiOS`)
    4. Per-direction cooldown — no rapid-fire same-direction signals

    Confluence score (8 components, ≥ `minScore` to fire):
    1. VWAP side (rolling 96-bar)
    2. BOS — close crosses the most-recent confirmed swing extreme
       (pivot length 5, same crossover semantics as Pine)
    3. SSL / BSL liquidity sweep on the current bar (low pierces and
       closes back above prior bar low, or mirror for short)
    4. Fresh 3-candle Fair Value Gap within the last 6 bars
    5. Order block — engulfing close vs prior body
       (`prev bear & close > prev high` / mirror)
    6. Volume spike ≥ `volMult × 20-bar avg` in the trade direction
    7. Kill zone — London 12:30-14:30 IST or NY 18:00-21:00 IST
       (07:00-09:00 and 12:30-15:30 UTC)
    8. RSI on the trade side of 50

    Mode preset adapts to the timeframe (mirroring the Pine dropdown):

    | TF      | vol× | minSc | cool | TP×  | SL×  | rsiOB | rsiOS |
    | ------- | ---- | ----- | ---- | ---- | ---- | ----- | ----- |
    | 1m / 5m | 1.5  | 6     | 10   | 2.0  | 1.0  | 60    | 40    |
    | 15m     | 1.4  | 6     |  8   | 2.5  | 1.0  | 62    | 38    |

    Entry is the trigger bar close; TP / SL are ATR multiples per the
    preset. Confidence scales with score-over-threshold, kill-zone
    alignment, HTF agreement, FVG / volume presence, and risk-reward.

### Engine + journal
- Strategy modules live in `src/features/scalping/strategies/*.ts` and
  share an indicator pack (EMA / SMA / RSI / Bollinger / VWAP / ATR /
  swing / cluster detection) in `src/features/scalping/helpers.ts`.
- Every signal carries `strategyId` so the UI can render a strategy chip
  on the card and the journal row. Each paper trade's `source` column is
  `${strategyId}:${timeframe}` so the dedupe key isolates strategies — two
  strategies can hold open positions on the same symbol at the same time
  without colliding.
- Trade resolution walks 1m klines from `openedAt` to now: WIN on target
  touch, LOSS on stop touch, EXPIRED after 6h with no fill. Conservative
  tie-break: a candle that touches both is recorded as a stop.
- Performance panel breaks results down by symbol AND by strategy.

---

# Dashboard UI Structure

## Layout
- Left sidebar navigation
- Top navbar
- Responsive trading layout
- Dark mode by default

## Pages

### Home
- Best Time to Trade banner (IST window + verdict + countdowns)
- Market summary
- Sentiment overview
- Quick signals

### Best Time
- Hero status card (active window, verdict, IST clock, day quality, score)
- 24h IST trading map (timeline with a "now" cursor)
- Per-window cards with insight + suited styles
- Best days of the week table
- Best window by trading style matrix
- BTC spotlight (7 PM – 11 PM IST)

### Futures
- OI charts
- Funding charts
- Liquidation data

### Options
- Options chain
- IV charts
- PCR analysis

### Signals
- AI trade suggestions
- Historical accuracy

### AI Signals
- Multi-confluence intelligence per symbol (9 weighted factors)
- Confidence score (0–100) + letter grade (S / A / B / C / D)
- Calibrated win-probability + position-sizing %
- Tiered take-profit ladder (TP1 / TP2 / TP3) with scale-out allocations
- ATR-sized stop with explicit invalidation criteria
- Live timing window (when to enter, when to exit, live countdown)
- AI rationale with categorised confluence chips (Tech / Deriv / Sent /
  Macro / News / Flow)
- Market-regime banner (Risk-on / Risk-off / Mixed / Compressed)
- Filters by direction (Bullish / Bearish / Wait) and horizon (Scalp /
  Intraday / Swing / Positional), persisted to localStorage

### Heatmap
- Sector performance
- Coin heatmap

### Strategy Lab
- Conversational prompt input
- Backtest controls (symbol, period 1W/1M/6M/1Y/5Y)
- Stats panel (win rate, drawdown, Sharpe, profit factor, P&L)
- Equity curve sparkline
- Trade log
- Saved strategies sidebar with live paper-trading toggle

### Strategy Backtest
- Five-year backtest of every scalp strategy on BTC / ETH / SOL with
  $10,000 starting equity.
- Score (0-100) + letter grade + recommendation per strategy.
- Per-strategy card: net P&L, win rate, profit factor, max drawdown,
  Sharpe, total return vs buy & hold, trade count, equity-curve
  sparkline.
- Aggregate "ALL symbols" view + per-symbol toggle.
- Leaderboard sorted by score so the strongest strategies surface first.
- Same score chip is rendered on each strategy card in the Strategies
  page picker — users can mix strategies based on backtest performance,
  not vibes.

### Strategies (`/strategies`)
The *configuration* half of the engine — picking which strategies fire and
watching the live signal feed:

- Multi-select strategy picker (10 strategies, mix one or many) with the
  5-year backtest score badge on every chip.
- Live signal feed with **multi-select** 1m / 5m / 15m timeframe filter
  (signals from all selected timeframes are merged and shown together).
- "How the strategies work" reference card describing each engine's
  trigger conditions, ATR-sized stop/target, and resolution rules.

### Paper Trading (`/paper-trading`)
The *outcome* half of the engine — open positions, journal and per-
strategy performance breakdown stacked on a single page:

- **Open positions** — live MTM table with strategy chip per row, mark
  price, P&L %, P&L $, and a cancel action.
- **Journal** — full trade history (strategy chip, status, entry / exit,
  P&L %, P&L $, free-form notes; filter by symbol, status, and the active
  strategy selection). The history table is **server-paginated** at 10
  rows per page — `/api/scalper/journal` accepts `limit` + `offset` and
  returns `{ items, open, total, limit, offset }`. The frontend never
  slices client-side; it just renders whatever the server returns and
  uses `total` to compute the page count.
- **Performance panel** — overall win rate / profit factor + per-symbol
  AND per-strategy breakdowns.

Journal data (open trades + history + mark prices) is fetched once by a
shared `JournalDataProvider` so the polling rate stays flat. The
strategy filter is shared with `/strategies` via the same
`StrategyProvider` Zustand store, so toggling a strategy on either page
is reflected on the other. A monotonic request-id check throws away
stale responses if the user rapidly changes pages or filters before
earlier requests resolve.

### Profile (`/profile`, opened from the topbar avatar)
- Identity header (avatar, name, email, member-since, default-pair and
  API-key status badges, sign-out button)
- Hash-routed tab strip — `#account`, `#data-sources`, `#api-keys`,
  `#alerts` — so each section is shareable / deep-linkable
- Account tab — display name, default trading pair, live theme preview
- Data sources tab — primary + fallback broker picker per market
- API keys tab — AES-256-GCM encrypted per-exchange entries
- Alerts tab — funding spike, OI breakout, price breakout, liquidation
  surge, signal change (with cooldown per rule)
- Legacy `/settings` URL 308-redirects here

## India Pages (`/in/*`)

The India sidebar mirrors the crypto sidebar so each item has a direct
counterpart. Each page is fully market-aware — no cross-imports from
the crypto features, no shared stores, no shared API routes.

### Overview / Market Pulse (`/in/dashboard`)
- NIFTY indices hero strip with 3D tilt
- Sectoral heatmap (bullish → bearish)
- MSB–OB intraday signals table
- Range-expansion (WR8 + bullish-trend) scanner section
- Sector drill-down modal with sortable F&O constituents

### Best Time (`/in/best-time`)
- Hero status card (active NSE window, verdict, IST clock, day quality, score)
- 09:00–16:00 IST session map with a live "now" cursor
- Seven session windows (Pre-Open / Opening Volatility / Morning Trend /
  Midday Lull / Afternoon Trend / Power Hour / Closing Auction)
- Best days of the week table (Tue/Wed = ideal, Thu = expiry warning,
  Fri = good-but-volatile, Sat/Sun = closed)
- Best window by trading style matrix
- NIFTY / BANKNIFTY focus card (weekly-expiry awareness + Power Hour spotlight)

### Options (`/in/options`)
- Live NSE option chain with PCR, max-pain, ATM ±5 strikes
- IV per strike, OI heat
- Index + stock symbol picker with quick-select chips

### Signals (`/in/signals`)
- Unified F&O signal feed merging six scanner types
  (range-expansion, momentum, volume breakout, OI build-up, PCR, IV-spike)
- Per-source filter chips (toggle on/off, persisted to localStorage)
- Rows ranked by absolute metric magnitude across sources
- Each row supports Add-to-Watchlist + chart drill-down
- Pinned with the India Best-Time banner

### AI Signals (`/in/ai-signals`)
- Multi-confluence AI signal per F&O index + leader (NIFTY / BANKNIFTY /
  FINNIFTY / MIDCPNIFTY + RELIANCE / HDFCBANK / TCS)
- Daily trend stack (SMA 20/50/200 + RSI + momentum + volume thrust)
- Option-chain positioning — PCR, ATM IV, ΔPE-CE OI build-up, max-pain pull
  from the live NSE option chain
- Cross-references the existing F&O scanners (momentum, volume,
  range-expansion, OI build-up) so AI direction agrees with the
  multi-scanner board
- Strike suggestion (nearest ATM from the live chain) on every non-WAIT
  signal, INR-rounded tick sizes on entries / stops / TPs
- Forces WAIT outside 09:15–15:30 IST and on weekends / weekly-expiry
  warning days via the India Best-Time engine

### Strategies (`/in/strategies`)
- Full structural mirror of the crypto Strategies page — same picker
  layout, same signal-card layout, same "how the strategies work"
  reference card. India-scoped data.
- India Best-Time banner pinning the active NSE window
- Eight-strategy picker — Range Expansion, Momentum, Volume Breakout, OI
  Build-up, PCR Extreme, IV Spike — each backed by the corresponding
  NSE scanner from `/api/in/scanner` — plus **India Liquidity Edge
  (ILE)**, a liquidity-first quant framework ported from the *India
  Liquidity Edge — Quant Framework* Pine indicator, and **India
  Max-Pain Gravity (IMPG)**, an option-positioning mean-reversion play
  carved from the same Pine framework (both detailed below)
- Per-strategy 1m / 5m / 15m timeframe toggles (selection persisted to
  `localStorage` under the `india-scalper:strategy-timeframes:v1` key,
  fully isolated from crypto)
- Live signal feed via `/api/in/scalper/signals` — multi-timeframe
  fan-out, ₹ price formatting, NSE ticker as the card header, kind
  chip (LONG_BUILDUP / GAINER / BULL_VOLUME etc.) instead of the
  crypto SMC ✓/✗ badge
- Synthetic 0.5% stop / 1.0% target band per signal (2:1 RR) until the
  proper F&O paper-trader lands with ATR-sized sizing
- **India Liquidity Edge (ILE)** strategy — port of the *India
  Liquidity Edge — Quant Framework* Pine indicator. Unlike the six
  scanner-derived strategies, ILE is a self-contained liquidity-first
  confluence engine for NSE indices + F&O stocks that folds eight
  modules into a single 0–10 bull/bear score:
  1. **Liquidity-sweep detector** — pools equal swing highs/lows (pivot
     legs, equal-H/L tolerance) over a lookback window, then fires only
     when price sweeps a pool by the sweep buffer (stop hunt) AND closes
     back inside, gated by a volume spike / VIX > 14 / sweep-window
     (10:00–11:30 or 14:30–15:15 IST) confluence filter.
  2. **OI walls + max-pain gravity** — CE/PE walls (strongest two each)
     from the live NSE option chain, a put-floor→call-ceiling pinning
     zone, PCR classification (>1.4 bullish / <0.8 bearish), and a
     post-13:30 (or 14:00 on expiry) max-pain pull when price drifts
     beyond the buffer.
  3. **Gap-fill engine** — flags gap-up / gap-down opens vs PDC, takes
     the first-candle reversal back toward PDC with a 50%-of-gap
     invalidation, and distinguishes event gaps (fill less reliably)
     from sentiment gaps.
  4. **NSE session + expiry timing** — Trap Zone → Discovery → Prime
     Window → Trend Ride → Dead Zone → Close Rush → Closing Risk, plus
     an expiry-day (Nifty weekly Thu / BNF weekly Wed / monthly)
     gamma-blast window (09:30–11:30) and a close countdown.
  5. **India VIX regime + IV-crush + VIX divergence** — Low / Normal /
     Elevated / Fear regime tint, IV-rank vs 52-week range, pre-event
     IV-crush target (VIX × 0.72), and hidden weakness/strength on
     price-vs-VIX divergence.
  6. **Confluence score engine** — sums sweep / wall proximity / PCR /
     gap / Prime-window / VIX / max-pain side / volume / VWAP side /
     PDC side into a 0–10 score; STRONG BUY/SELL at ≥ 7, BUY/SELL at the
     user-tunable min-confluence threshold.
  7. **Auto ATR-sized SL/TP** — 0.25× ATR stop, 2.5× RR target on every
     fired signal (and a PDC-targeted SL/TP on gap-fill setups).
  8. **Instrument presets** — Auto (ATR-scaled, works for any F&O
     stock) / Nifty / BankNifty / MidcapNifty / Custom (manual), so the
     tolerance, sweep, proximity, max-pain and gap buffers all scale to
     the underlying.
- **India Max-Pain Gravity (IMPG)** strategy — a second port from the
  same *India Liquidity Edge — Quant Framework* Pine indicator, but
  intentionally distinct from ILE. Where ILE folds all eight Pine
  modules into a broad liquidity-sweep confluence score, IMPG isolates
  the **dealer-positioning** modules into a focused, fade-the-extreme
  mean-reversion play for NSE indices + F&O stocks:
  1. **Max-pain gravity** — the headline trigger. After 13:30 IST (or
     14:00 on expiry day) it fades price back toward the max-pain
     strike once spot has drifted beyond the (ATR-scaled) max-pain pull
     buffer, on the thesis that dealers pin the underlying to max pain
     into the close. The buffer is dropped on expiry-day override.
  2. **OI-wall fade** — short rejections at the strongest CE wall and
     long rejections off the strongest PE floor when price is within
     the wall-proximity buffer, gated by PCR (> 1.4 favours PE-floor
     longs, < 0.8 favours CE-wall shorts) — CE/PE walls (strongest two
     each) come from the live NSE option chain.
  3. **Pinning-zone mean reversion** — inside the put-floor →
     call-ceiling box, fade the edges back toward the centre.
  4. **Gap-fill toward PDC** — first-candle reversal back to the
     previous-day close on a gap-up / gap-down open with a 50%-of-gap
     invalidation, distinguishing event gaps (fill less reliably) from
     sentiment gaps.
  5. **Expiry-day gamma awareness** — flags the 09:30–11:30 gamma-blast
     window and tightens to directional-options only on expiry (Nifty
     weekly Thu / BNF weekly Wed / monthly).
  6. **Auto ATR-sized SL with a positioning target** — the max-pain
     strike (gravity / wall fades) or PDC (gap fills) is the natural
     target, with an ATR-sized stop beyond the rejection wick.
  7. **Instrument presets** — reuses ILE's Auto (ATR-scaled) / Nifty /
     BankNifty / MidcapNifty / Custom presets so the wall-proximity,
     max-pain and gap buffers all scale to the underlying.
- **Opening Breakout (ORB)** strategy — the **first 5-min candle
  (9:15–9:19:59 IST) opening-range breakout**, tuned for Indian markets.
  Unlike the scanner / positioning strategies, it runs on **live 5-min
  candles** (Yahoo) fanned out across the F&O indices + liquid leaders,
  with an NSE option chain layered in for confirmation
  (`opening-breakout-core.ts` pure builder + `opening-breakout.ts` IO):
  1. **Opening range** — the 9:15 candle's high/low frames the day's
     first battle. A later 5-min candle that **closes** beyond the range
     confirms the winner (bullish above / bearish below).
  2. **Retest entry (non-negotiable)** — entry is on the **retest** of
     the broken level (resistance→support flip, or the mirror), the
     highest-probability, lowest-risk point of the setup. A breakout that
     hasn't retested yet is flagged `confirmed: false`.
  3. **2R geometry** — stop below the breakout candle's low (above its
     high for shorts), target = **2× the stop distance**, with a 3R
     stretch target carried for the Daily Picks "can move upto".
  4. **Option-chain confirmation** — PCR / OI / max-pain are projected
     onto the trade direction (put-writing support for longs, call-writing
     resistance for shorts, max-pain pull), nudging confidence up or down.
  5. **India-specific sizing** — sub-0.1% opening ranges (false-move
     traps) and >0.7% gap-driven ranges (SGX/global cues) down-weight
     confidence; rationale reminds operators to trade **ATM / 1-strike
     ITM** to dodge the post-9:30 IV crush.
  Its **top three signals** also seed the new Opening Breakout bucket on
  the Daily Picks board.
- Legacy `/in/scalper` URL 308-redirects here

### Paper Trading (`/in/paper-trading`)
- Full structural mirror of the crypto Paper Trading page — same
  three-card layout (open positions → journal → stats), same column
  set, same in-place note editor, same server-paginated journal.
  India-scoped data.
- India Best-Time banner pinning the active NSE window
- F&O open-positions card with live MTM ticks (mark prices polled from
  `/api/in/quote?symbols=…` so we only pay for symbols currently in
  open trades)
- Server-paginated F&O journal (10 rows / page via the shared
  `INDIA_JOURNAL_PAGE_SIZE` constant) with free-form symbol filter
  (NSE F&O is too large for a fixed dropdown), status filter, ₹ P&L,
  per-row notes
- Per-symbol + per-strategy performance panel (Total / Win rate / Net
  P&L / Profit factor headline tiles, then the same breakdown tables
  as crypto)
- Strategy filter shared with `/in/strategies` via
  `<IndiaStrategyProvider>` — toggling a strategy on either page is
  reflected on the other
- Every read filters the shared `PaperTrade` Postgres table on the
  canonical `in:` source prefix, so India and crypto journals stay
  fully isolated even though they live in the same table. The
  `symbol` column is now a free-form `String` (migration
  `20260518050000_papertrade_symbol_string`), so the journal symbol
  filter rides the Prisma equality path and the
  `PaperTrade_symbol_openedAt_idx` index instead of being applied
  in-memory. The `india-scalper` worker books trades into the journal
  with ATR-sized SL/TP (NSE 0.05-tick rounded), an expiry-day gamma
  cooldown (Thursday ≥ 14:30 IST) and 5m NSE-candle resolution. Each
  strategy chip on the Strategies page carries a 0–100 score + A+…F grade
  (`score-board.ts` → `IndiaStrategyScoreBadge`) blended from two sources:
  the 3 price strategies (Range Expansion / Momentum / Volume Breakout)
  are scored from a real 5-year daily-OHLCV backtest (`backtest.ts` +
  `backtest-core.ts`, scanner logic ported to candle-fed modules in
  `strategies/price-modules.ts`) and tagged **5Y**; the 5 option-chain
  strategies (PCR / IV / OI build-up / Liquidity Edge / Max-Pain Gravity)
  have no historical option-chain feed, so they're scored from the live
  paper-trade record and tagged **PT**. Both run through the one
  risk-aware `scoreIndiaStrategy` engine (win rate, profit factor,
  expectancy, sample size + drawdown / Sharpe when available). To make the
  option-chain 5 backtestable, the `india-oc-capture` worker snapshots each
  F&O index's chain analytics into `OptionChainSnapshot` every 5 min during
  market hours (`option-chain-capture.ts`, gated by `isNseMarketOpenIST`) —
  NSE has no history API, so this accrues the series the replay engine
  scores off. That replay engine (`option-chain-replay-core.ts` +
  `option-chain-replay.ts`) walks the captured snapshot series bar-by-bar,
  reconstructing each of the 5 option-chain signals from a snapshot (it
  reuses the exact `positioning-core` ILE/IMPG builders and the same
  PCR/IV/OI direction thresholds as the live `fetch-signals`, so there is no
  logic drift) and resolves trades against the forward spot path, flat at
  the IST day boundary. Pooled across the four indices and graded on the
  same `scoreIndiaStrategy` scale, it promotes those 5 strategies from the
  **PT** badge to a true **5Y** backtest score once enough snapshots accrue
  (`MIN_SNAPSHOTS` / `MIN_TRADES` guards); until then the board falls back
  to the live paper-trade record.

### Strategy Backtest (`/in/strategy-backtest`)
- Underlying picker (NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY + top F&O stocks)
- Multi-timeframe selector (5m / 15m / 1h / 1d / 1w) with default lookback per TF
- Live OHLCV fetch via `/api/in/historical` showing the exact bars the
  engine will replay
- Quick stats (avg daily %, ATR/close %, hi/lo, candle count)
- Roadmap describing strategy-module retargeting + scoring drop-in

### Strategy Lab (`/in/strategy-lab`)
- Free-form prompt input with four NSE-specific templates (NIFTY ORB,
  BANKNIFTY VWAP reversion, expiry IV-crush straddle, F&O-stock EMA pullback)
- Underlying + lookback (1W → 5Y) + timeframe (5m / 15m / 1h / 1d) +
  stop / target capture
- Local draft persistence; roadmap describes the F&O-aware AST parser
  (IV ATM / India VIX / OI ΔBUILDUP / expiry-day tokens)

### Heatmap (`/in/heatmap`)
- Sector pulse strip across the top (sectors sorted by average move)
- Per-sector grid of F&O constituents
- Tiles tinted by day % using inline `color-mix()` for continuous saturation
- Click-through to per-symbol charts
- Refresh-all button on top of automatic per-sector loads

### Profile (`/in/profile`, opened from the topbar avatar)
- Same Account / Data sources / API keys / Alerts tabs as the crypto
  `/profile` page (settings are user-scoped, not market-scoped)
- Copy reframed around NSE F&O concerns: India-broker selection
  (Yahoo / NSE proxy / Groww), cookie-warmed NSE proxy, weekly-expiry
  alert templates
- Legacy `/in/settings` URL 308-redirects here

### India-only extras

- **Daily Picks** (`/in/daily-picks`) — top-3-per-bucket board (Indices
  Scalping / Opening Breakout / Highly Momentum / Highly Scalping / Highly
  Potential) with entry, stop, target,
  "can move upto" + "can expect" and per-pick logic, frozen per IST trading
  day and live-tracked (P&L + progress-to-target → TARGET_HIT / STOP_HIT)
  with a queryable daily history. Served by `/api/in/daily-picks` (+
  `/history`); pure engine in `features/india/daily-picks/engine.ts`,
  freeze/track/history I/O in `…/builder.ts`, persistence via the
  `IndiaDailyPick` table.
- **News** (`/in/news`) — Moneycontrol India + global business RSS feeds,
  parsed and enriched with per-headline bull/bear sentiment and F&O
  stock / sector / index impact tags, plus an overall market-sentiment +
  risk-on / risk-off ratio banner. Served by `/api/in/news`
  (`services/india/news` scraper + `features/india/news/engine.ts` pure
  engine); feed URLs are env-overridable via `INDIA_NEWS_FEEDS`.
- **Scanner** (`/in/scanner`) — single-mode scanner UI driven directly
  by `/api/in/scanner` (range-expansion default).
- **Watchlist** (`/in/watchlist`) — persistent F&O watchlist (Zustand
  persist key `india-fno-watchlist`).
- **Chart** (`/in/chart/[symbol]`) — per-symbol lightweight-charts
  deep-dive with intraday / daily toggles.

---

# Folder Structure

```txt
src/
 ├── app/
 │    ├── (dashboard)/
 │    │   ├── page.tsx              Crypto Overview
 │    │   ├── best-time/, options/, signals/, ai-signals/,
 │    │   │   strategies/, paper-trading/, strategy-backtest/,
 │    │   │   strategy-lab/, heatmap/, futures/
 │    │   │                        Crypto pages (one per sidebar item)
 │    │   ├── scalper/             308-redirect to /strategies (legacy)
 │    │   ├── profile/             Consolidated profile (topbar avatar)
 │    │   ├── settings/            308-redirect → /profile (legacy)
 │    │   └── in/                   India route group — full sidebar parity
 │    │       ├── dashboard/        Overview (Market Pulse)
 │    │       ├── best-time/        NSE-anchored session guide
 │    │       ├── options/          NSE option chain
 │    │       ├── signals/          Unified F&O signal board
 │    │       ├── ai-signals/       AI multi-confluence F&O signals
 │    │       ├── strategies/       Live F&O signal feed + picker + how-it-works
 │    │       ├── paper-trading/    F&O open positions + journal + per-strategy stats
 │    │       ├── scalper/          308-redirect to /in/strategies (legacy)
 │    │       ├── strategy-backtest/ OHLCV scaffold + roadmap
 │    │       ├── strategy-lab/     F&O prompt intake + roadmap
 │    │       ├── heatmap/          Sector + stock heatmap
 │    │       ├── profile/         India-flavoured profile (topbar avatar)
 │    │       ├── settings/        308-redirect → /in/profile (legacy)
 │    │       ├── daily-picks/      Top-3-per-bucket picks + live tracking + history (India-only)
 │    │       ├── news/             Moneycontrol + global news (India-only)
 │    │       ├── scanner/          (India-only)
 │    │       ├── watchlist/        (India-only)
 │    │       └── chart/[symbol]/   (India-only)
 │    └── api/
 │        ├── in/                   India API surface
 │        └── …                     Crypto API surface
 │
 ├── components/
 │    ├── ai-signals/     ai-signal-card (rich per-signal card),
 │    │                   ai-signals-board (polling shell with filters),
 │    │                   ai-market-context-banner (regime banner)
 │    ├── best-time/      best-time-banner, best-time-dashboard
 │    ├── charts/
 │    ├── dashboard/      sidebar (market-aware), market-switcher, topbar, …
 │    ├── scalper/         Shared building blocks for the Strategies +
 │    │                    Paper Trading surfaces: scalper-tabs (legacy
 │    │                    3-tab shell, kept for back-compat), live-signals,
 │    │                    scalp-signal-card, open-positions-card,
 │    │                    journal-card, journal-data-context,
 │    │                    journal-shared, strategy-picker, strategy-context,
 │    │                    stats-panel, strategy-backtest-panel,
 │    │                    strategy-backtest-context, strategy-score-badge
 │    ├── strategy-lab/
 │    ├── profile/        profile-header (avatar/sign-out card),
 │    │                   profile-tabs (hash-routed tab switcher)
 │    ├── settings/       settings-form, data-sources-form,
 │    │                   api-keys-form, alerts-manager — rendered
 │    │                   inside the profile page's tab panels
 │    ├── india/          India UI (no cross-imports from crypto):
 │    │   ├── best-time/   india-best-time-banner, india-best-time-dashboard
 │    │   ├── daily-picks/ daily-picks-board (live poller), daily-pick-card,
 │    │   │                daily-picks-history (per-day outcomes table)
 │    │   ├── heatmap/     india-heatmap (continuous color-mix tints)
 │    │   ├── signals/     india-signals-board (multi-source poller)
 │    │   ├── strategies/  Mirrors crypto components/scalper for the F&O
 │    │   │                Strategies page: strategy-context (Indian
 │    │   │                StrategyProvider), strategy-picker, live-signals,
 │    │   │                india-scalp-signal-card (₹ + NSE ticker)
 │    │   ├── paper-trading/ Mirrors crypto Paper Trading components:
 │    │   │                journal-data-context (India journal poller +
 │    │   │                /api/in/quote MTM), open-positions-card,
 │    │   │                journal-card, stats-panel, journal-shared
 │    │   ├── strategy/    india-backtest-preview, india-strategy-lab-intake
 │    │   ├── common/      india-feature-preview (shared roadmap shell)
 │    │   ├── msb-dashboard, charts/price-chart, options/option-chain-table,
 │    │   │   ticker/live-ticker, ticker/india-ticker-bar
 │    │   └── ui/          India-flavoured shadcn primitives (button/card/table)
 │    └── ui/
 │
 ├── features/
 │    ├── ai-signals/     Cross-market AI engine (engine.ts) + crypto
 │    │                   builder + india builder (multi-confluence
 │    │                   scoring, grading, sizing, timing)
 │    ├── best-time/      Crypto IST window engine + types
 │    ├── futures/
 │    ├── options/
 │    ├── sentiment/
 │    ├── signals/
 │    ├── scalping/        engine, fetch-signals, paper-trader, journal,
 │    │                    backtest (5Y historical replay),
 │    │                    strategy-score (0-100 + grade + rec),
 │    │                    run-all-backtests (in-process cached suite)
 │    │   └── strategies/  ut-smc, vwap-sweep-trend, news-momentum,
 │    │                    range-scalp, ema-pullback, vwap-reversion,
 │    │                    orderflow-sweep, fib-pullback,
 │    │                    institutional-smc, ai-institutional-pro +
 │    │                    catalog
 │    ├── strategy-lab/
 │    ├── heatmap/
 │    └── india/
 │        ├── best-time/   NSE-anchored session engine (mirrors features/
 │        │                best-time/engine.ts but with seven NSE windows,
 │        │                expiry-aware day quality, weekend "off" guard)
 │        ├── daily-picks/ Pure engine (bucket scoring, top-3 selection,
 │        │                level extraction, live P&L / progress tracking) +
 │        │                builder (freeze-per-day + track + history, backed
 │        │                by the IndiaDailyPick table, DB-resilient)
 │        ├── news/        Pure news engine — bull/bear lexicon scoring,
 │        │                F&O stock / sector / index impact tagging,
 │        │                market sentiment + risk-on/off ratio aggregation
 │        └── scalping/    Structural mirror of features/scalping for the
 │                         F&O surface: types (IndiaScalpSignal,
 │                         IndiaPaperTradeStatus + `in:<id>:<tf>` source
 │                         helpers), strategies/catalog (eight entries —
 │                         Range Expansion, Momentum, Volume Breakout, OI
 │                         Build-up, PCR Extreme, IV Spike, India
 │                         Liquidity Edge, India Max-Pain Gravity),
 │                         fetch-signals
 │                         (wraps services/india/scanner/engine into
 │                         IndiaScalpSignal cards), journal (in:-prefixed
 │                         queries against the shared PaperTrade table —
 │                         segregation boundary between markets),
 │                         journal-constants
 │
 ├── services/
 │    ├── binance/
 │    ├── bybit/
 │    ├── deribit/
 │    ├── coinglass/
 │    └── india/           Yahoo / NSE / Groww broker adapters, cache,
 │                         scanner, signals, news (RSS), websocket gateway
 │
 ├── hooks/
 │    └── india/           useFetchPoll, useFeedStream, useLiveQuotes,
 │                         useOptionChain, useScanner
 ├── store/
 │    └── india/           useIndia{Market,OptionChain,Scanner,Watchlist}Store
 ├── lib/
 │    └── india/           fno-symbols, sectors, INR-aware formatters
 ├── utils/
 ├── prisma/
 └── types/
      └── india/           market / options / scanner type packs
```

---

# API Suggestions

## Free APIs
- Binance API
- Bybit API
- Alternative.me API
- CoinGecko API

## Paid APIs (optional)
- CoinGlass
- CryptoQuant
- Santiment
- Glassnode

---

# Redis Usage
Use Redis for:
- Caching API responses
- WebSocket snapshots
- Rate limit protection
- Market aggregation

---

# Performance Goals
- Fast dashboard loading
- Realtime updates
- Optimized websocket handling
- SSR where needed
- Edge-ready APIs

---

# Design Inspiration
- Delta Exchange
- Binance Futures
- TradingView
- CoinGlass

---

# Development Priorities

## Phase 1
- Setup project
- Market overview
- Realtime price websocket

## Phase 2
- Futures analytics
- Sentiment engine

## Phase 3
- Options analytics
- AI trading signals

## Phase 4
- Alerts
- Backtesting
- User auth

---

# Testing & TDD policy (mandatory)

> **Test-Driven Development is non-negotiable.** Every new feature, bug
> fix, or enhancement **must** start with failing test cases that
> describe the desired behaviour, then move on to the implementation
> that turns them green. Code without a corresponding test will not
> pass review.

## Tooling

- **Runner:** Vitest 4 with the `jsdom` environment.
- **DOM assertions:** `@testing-library/react` + `@testing-library/jest-dom`.
- **User interactions:** `@testing-library/user-event`.
- **Coverage:** v8 provider — `text`, `html`, `lcov` outputs in `coverage/`.
- **Setup:** `vitest.config.ts` at the repo root; shared mocks in
  `tests/setup/vitest.setup.ts`. `next/link` is aliased to
  `tests/setup/next-link-shim.tsx`; `next/navigation` and `next/headers`
  are mocked so route components and pages can render without the
  Next runtime.

## Layered test layout (one folder per concern)

```
tests/
  setup/         Shared Vitest setup + fixtures (candles, status, ...)
  lib/           Pure utility tests (formatters, validators, math)
  features/      Domain engines (best-time, sentiment, scalping,
                 strategy-lab parser, strategy-score, ...)
  components/    React component tests (UI primitives + light wrappers)
  api/           Next 16 Route Handler tests (POST/GET handlers)
  services/      Service layer (cache backends, broker shared utils)
  hooks/         Custom React hook tests
  stores/        Zustand store tests
  pages/         Page-level smoke / redirect / not-found tests
  worker/        Background worker — log/scheduler/config/env paths
```

Each layer has a per-slice npm script (`test:lib`, `test:features`,
`test:components`, `test:api`, `test:services`, `test:hooks`,
`test:stores`, `test:pages`) so you can iterate on the slice you're
changing without paying for the rest of the suite.

## Required scripts (already in `package.json`)

| Script                  | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `npm test`              | Full suite, no watcher (the default in CI)             |
| `npm run test:watch`    | Vitest watcher                                         |
| `npm run test:ui`       | Vitest browser UI                                      |
| `npm run test:coverage` | Coverage report (v8) → `coverage/`                     |
| `npm run test:<layer>`  | Per-layer slice (lib/features/components/api/...)      |
| `npm run test:ci`       | CI run with JUnit XML at `test-results/junit.xml`      |

## Auto-run wiring (tests run on every code change, automatically)

The suite is plumbed into four trigger points so a stale test result
is never the reason a regression slips through:

1. **`npm run build` blocks on a red suite.** A `prebuild` script
   runs `npm test` before `next build`. Failing tests = failing build.
2. **`npm run dev:tdd` watches every file save.** Runs `next dev` and
   `vitest --watch` in parallel via `concurrently`, so editing under
   `src/**` re-runs only the affected tests instantly.
3. **`npm run check` is the pre-PR gate.** Chains `lint` +
   `typecheck` + full Vitest run.
4. **Cursor agent edits trigger the matching test slice.** A project
   hook at `.cursor/hooks.json` maps each `afterFileEdit` event to
   its slice and surfaces the pass/fail summary back to the chat.
   A `stop` hook runs the full suite when the agent finishes its
   turn.

## Mandatory TDD workflow — for every change

1. **Write the failing test cases first.** Cover the happy path, the
   most common edge cases, and at least one explicit error / boundary
   case per public function or component prop.
2. **Run them and confirm they fail for the _right_ reason** — not
   because of a syntax error or a missing import. Use the per-layer
   script to keep the loop tight.
3. **Write the smallest possible implementation that turns the failing
   tests green.** Don't anticipate future requirements.
4. **Refactor under the green safety net.** Re-run the suite after
   every change.
5. **Run the full suite (`npm test`) before opening a PR** — or just
   `npm run check` for the lint + typecheck + tests trio.

## What to test (concrete checklist by layer)

- **`tests/lib/`** — every exported function gets at least: one happy
  path, one boundary (empty / zero / negative), one explicit error or
  return-value contract.
- **`tests/features/`** — test the engine's public API only; build
  candle / status / strategy fixtures via `tests/setup/fixtures.ts`;
  assert engine output (signal counts, scores, verdicts) given fixed
  inputs.
- **`tests/components/`** — assert what the user sees and how they
  interact (`getByRole`, `getByText`, `userEvent`). Mock external
  systems (`framer-motion`, fetchers, `getBestTimeStatus`) only when
  they leak runtime requirements.
- **`tests/api/`** — import the handler, build a `Request` with
  `new Request(url, { method, body })`, await the handler, assert on
  `response.status` + `await response.json()`. Always cover at least
  one valid payload and one Zod / validation failure.
- **`tests/services/`** — exercise the public surface of caches and
  shared helpers in isolation. Never hit a real network or DB; mock
  the underlying client.
- **`tests/hooks/`** — wrap the hook in a tiny harness component
  inside the test, render it, and assert via the rendered DOM.
- **`tests/stores/`** — create a fresh store per test; assert on
  action transitions and selector outputs.
- **`tests/pages/`** — smoke render to confirm the page composes its
  imports and renders without throwing. For `redirect()` / `notFound()`
  paths assert that the call throws the matching mocked sentinel
  error.
- **`tests/worker/`** — exercise pure / env-driven worker units in
  isolation: `log.ts` (level filtering + pretty/json format), 
  `scheduler.ts` (recurring-tick lifecycle with fake timers, no
  overlap, `stop()` semantics), `config.ts` (broker resolution +
  symbol parsing + interval overrides), and the env-validation
  branches of `redis.ts` / `db.ts` / `observability.ts`. Long-running
  IO modules (`worker/src/jobs/**`, `worker/src/index.ts`) are
  excluded from coverage and verified at integration time.

## Adding a feature — example

```bash
# 1. Sketch the test cases first (RED).
$ touch tests/features/my-new-engine.test.ts
$ npm run test:features          # all new tests fail

# 2. Implement until the suite is green (GREEN).
$ ${EDITOR:-code} src/features/my-new-engine/index.ts
$ npm run test:features          # green

# 3. Refactor + final pass (REFACTOR).
$ npm test                       # full suite still green
```

## Don't (anti-patterns — automatic review block)

- ❌ Writing tests after shipping the code.
- ❌ Asserting on private internals (state shape, helper internals).
- ❌ Snapshot tests of large component trees — prefer targeted
  `getByText` / `getByRole` assertions.
- ❌ Tests that hit the network, a real DB, or a real broker.
- ❌ `it.skip` / `describe.skip` without a TODO referencing the issue
  tracker.

---

# Coding Standards
- Strict TypeScript
- Reusable components
- Feature-based architecture
- Clean code
- TDD-first (see "Testing & TDD policy" above) — failing test cases
  before any implementation
- Use server actions where useful
- Avoid unnecessary rerenders

---

# Important Notes
- Never hardcode secrets
- Use environment variables
- Handle API rate limits
- Add retry mechanism
- Use websocket reconnection strategy
- Use skeleton loaders
- Mobile responsive UI required
```

---

# .cursorignore

```txt
# dependencies
node_modules
.pnp
.pnp.js

# next
.next
out
build

# logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# env
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# cache
.cache
.turbo
.vercel

# coverage
coverage
.nyc_output

# prisma generated
prisma/generated

# uploads
uploads
public/uploads

# redis dumps
dump.rdb

# IDE
.vscode
.idea

# OS
.DS_Store
Thumbs.db

# temp
*.tmp
*.temp

# generated files
*.generated.ts
*.generated.js

# test artifacts
playwright-report
test-results

# lock files
package-lock.json
yarn.lock
pnpm-lock.yaml
```

---

# .cursor/rules/frontend.mdc

```md
# Frontend Rules

## General
- Use TypeScript everywhere
- Use functional React components only
- Use App Router
- Prefer server components where possible
- Use client components only when needed

## Styling
- Use TailwindCSS
- Use Shadcn UI
- Dark mode first
- Use responsive design

## State Management
- Use Zustand for global state
- Use TanStack Query for server state

## Charts
- Use Lightweight Charts or Recharts
- Charts should support realtime updates

## Performance
- Lazy load heavy components
- Avoid unnecessary rerenders
- Memoize expensive calculations

## Folder Structure
- Keep feature-based architecture
- Reusable UI in components/ui

## Naming
- PascalCase for components
- camelCase for variables/functions
- kebab-case for folders
```

---

# .cursor/rules/backend.mdc

```md
# Backend Rules

## API
- Use REST + WebSocket
- Use typed responses
- Use Zod validation

## Security
- Never expose secrets
- Validate all inputs
- Use rate limiting

## Database
- Use Prisma ORM
- Use migrations properly
- Avoid N+1 queries

## Redis
- Cache expensive API calls
- Store websocket snapshots

## Error Handling
- Standard error response format
- Add retry logic
- Add logging

## Performance
- Use parallel API fetching
- Avoid blocking operations
```

---

# .cursor/rules/trading-engine.mdc

```md
# Trading Engine Rules

## Signal Logic
Trade suggestions should be based on:
- RSI
- MACD
- EMA crossover
- Funding rate
- Open interest trend
- Long/Short ratio
- Volume breakout
- Liquidation imbalance

## Risk Management
Every signal must include:
- Entry price
- Stop loss
- Target
- Risk reward ratio
- Confidence score

## Signal Types
- LONG
- SHORT
- BUY
- SELL
- HOLD

## Signal Confidence
Use weighted scoring system:
- Technical indicators
- Sentiment indicators
- Derivatives data

## Data Freshness
- Futures data refresh every few seconds
- Sentiment every minute
- Options every minute
```

---

# .cursor/rules/code-quality.mdc

```md
# Code Quality Rules

## Standards
- Strict TypeScript
- No any type unless unavoidable
- Use ESLint + Prettier

## Components
- Keep components small
- Reusable logic via hooks
- Avoid duplicate code

## Async
- Use async/await
- Handle loading and errors properly

## Naming
- Clear naming conventions
- No abbreviations unless common

## Git
- Small commits
- Clear commit messages

## Documentation
- Add comments for complex logic
- Keep README updated
```

---

# Suggested Environment Variables

```env
NEXT_PUBLIC_BINANCE_WS=
NEXT_PUBLIC_BYBIT_WS=
COINGLASS_API_KEY=
DERIBIT_CLIENT_ID=
DERIBIT_SECRET=
DATABASE_URL=
REDIS_URL=
NEXT_PUBLIC_APP_URL=
```

---

# Recommended Packages

```bash
npm install zustand @tanstack/react-query axios zod prisma @prisma/client ioredis lightweight-charts framer-motion react-hook-form lucide-react
```

