# AlphaForge — Change Log

---

## [Unreleased] — Institutional Intelligence Terminal (IIT) UI Overhaul

**Branch:** `feat/trading-ui-overhaul`
**Test coverage:** 1238/1238 Vitest tests · 0 TypeScript errors

Complete visual and architectural overhaul of every page and shell component under the IIT (Institutional Intelligence Terminal) design language — a precision-first, data-dense aesthetic. Purely frontend: no new API routes, no logic changes, all existing data flows and backend contracts preserved.

---

### Design System Foundation

- Full OKLCH color token system added to `globals.css` `@theme inline` block — no hardcoded hex/RGB in component files
- New semantic tokens: `--color-panel-bg`, `--color-panel-border`, `--color-data-positive`, `--color-data-negative`, `--color-data-neutral`, `--color-ai-accent`, `--color-regime-bull`, `--color-regime-bear`, `--color-regime-sideways`, `--color-regime-highvol`
- `--radius-panel` token (0.75rem) as the canonical Panel border-radius
- Spacing scale via Tailwind v4 CSS variables: `--space-1` through `--space-12`
- Three typographic roles: `--font-data` (tabular-nums monospace for prices), `--font-label` (small uppercase tracked for stat keys), `--font-body` (inheriting `--font-sans`)
- `data-density` attribute pattern: `compact` (32px rows), `default` (40px), `comfortable` (48px) — readable by any component without prop drilling
- `prefers-reduced-motion` global safety net applied across all animation-driven code
- 6 new CSS `@keyframes`: `price-flash-up`, `price-flash-down`, `breakout-pulse`, `vix-warning-pulse`, `celebration-pulse`, `shimmer-border`
- 4 Spring motion presets exported from `src/lib/motion-presets.ts`: `SPRING_FAST` (stiffness 600, damping 35), `SPRING_DEFAULT` (400/28), `SPRING_GENTLE` (240/24), `SPRING_MICRO` (800/40)
- `TRANSITION_STAGGER` helper: `stagger(count, baseDelay?)` returns the correct Framer Motion `transition` object for staggered list animations

---

### UIStore + RegimeContext

- New `useUIStore` (`src/store/uiStore.ts`) — Zustand v5, single store, typed interface:
  - Slices: `sidebarCollapsed`, `commandPaletteOpen`, `activeRegime`, `tableDensity`, `chartFullscreen`, `radarVisible`
  - Actions: `toggleSidebar`, `openCommandPalette`, `closeCommandPalette`, `setRegime`, `setDensity`, `setChartFullscreen`, `toggleRadar`
  - `sidebarCollapsed` persisted to `localStorage` key `af-ui-sidebar-collapsed`
  - `tableDensity` persisted to `localStorage` key `af-ui-table-density`
  - `commandPaletteOpen` blocks body scroll via `useEffect` toggling `document.body.style.overflow`
- `RegimeProvider` + `RegimeContext` (`src/lib/regime-context.tsx`) — wraps the `(dashboard)` layout, injects `--aurora-regime-a` CSS variable for regime-reactive aurora background with 1200ms CSS transition
- `RegimeSync` component — bridges `useIndiaMarketStore` → `UIStore.setRegime` on the India surface
- `CryptoRegimeSync` component — bridges crypto market store → `UIStore.setRegime` on the Crypto surface

---

### Shell Refactor — Sidebar

- Collapses to 56px icon-only rail, expands to 248px labeled view, animated with `SPRING_DEFAULT`
- 2px right-edge regime indicator strip (India market only): green (BULL), red (BEAR), neutral otherwise — reads from `useIndiaMarketStore`
- `FooterDataStrip`: active data source label, last-refresh timestamp, live connection quality dot (green/yellow/red) — replaces the old static footer text
- Shimmer `SignInNudge` CTA for unauthenticated users — `shimmer-border` CSS animation replaces the plain dashed border
- Nav group separator divider between primary market pages and analytics/tools pages
- Active nav item: 3px left-edge accent bar animated via Framer Motion `layoutId="sidebar-pill"`
- Floating tooltips on collapsed items appear within 120ms (no delay)
- Keyboard navigation: `ArrowUp`/`ArrowDown` to move, `Enter` to navigate, `Escape` to close tooltips — WCAG 2.1 AA compliant
- `useBreakpoint(1024)` hook: sidebar auto-collapses below 1024px viewport width (JS `window.innerWidth` observer, not a CSS media query)

---

### Shell Refactor — Topbar

- Height exactly 52px with `backdrop-blur-xl` frosted background (`--color-bg/85`) and 1px bottom border (`--color-panel-border`)
- `TopbarBreadcrumb`: derives `Market · Section` label from `usePathname()` (e.g. "India · AI Signals")
- `VixWarningChip`: rendered when India VIX > 25 using `--color-data-negative` background + `vix-warning-pulse` 2s border animation; disappears when VIX drops below 22
- `ThemeToggle`: three-segment pill (Light · System · Dark) with `layoutId="theme-pill"` sliding indicator + `SPRING_FAST` animation
- `CommandPalette` chip: shows `⌘K` shortcut with 8-second animated pulse on the `K` character (respects `prefers-reduced-motion`)
- All topbar elements have `aria-label` attributes; notification bell uses `aria-live="polite"`

---

### Shell Refactor — MarketTickerBar

- 36px frosted strip with `bg-[var(--color-bg-elevated)]/60` and 1px bottom border
- `NumberMorph` prices on every ticker chip
- Price flash on tick: 400ms CSS `price-flash-up`/`price-flash-down` animation, fades to transparent (not a persistent color)
- SENSEX chip added to India ticker strip (NIFTY 50, BANKNIFTY, FINNIFTY, India VIX, SENSEX)
- Crypto ticker auto-scroll pauses on hover, resumes immediately on mouse-leave
- "Market Closed" pill on the right edge when outside trading session hours
- Below 640px: static 2-chip strip (BTC + NIFTY or BTC + ETH) with no animation

---

### Trading Component Library (`src/components/trading/`)

- `SignalBadge.tsx`: LONG/SHORT/BUY/SELL/WAIT with IIT color tokens, optional icon, standardised sizing — replaces all ad-hoc badge implementations
- `ConfidenceBar.tsx`: 0–100 horizontal gradient fill (`--color-data-neutral` → `--color-data-positive`), optional numeric label, `data-testid="confidence-bar-fill"`
- `RegimeBadge.tsx`: BULL/BEAR/SIDEWAYS/HIGH_VOL/UNKNOWN with `--color-regime-*` tokens, icon, `SPRING_MICRO` entrance animation
- `NumberMorph.tsx`: Framer Motion `animate()` number interpolation, `durationFor()` magnitude-scaled timing (120ms < 1%, 240ms 1–10%, 360ms > 10%), props: `value`, `prefix?`, `suffix?`, `decimals?`, `className?`
- `StatGrid.tsx`: responsive CSS grid of stat cells (2/3/4 cols via `cols` prop), `--font-label` keys and `--font-data` values
- `PanelHeader.tsx`: 40px fixed row with title (left), optional icon, optional badge, optional right-aligned action slot
- `RiskMeter.tsx`: segmented bar (green 0–33, yellow 33–66, red 66–100), `data-active-segment` attribute, horizontal or vertical orientation
- `AiRadar.tsx`: TanStack Table v9, hover detail panels (200ms delay), multi-column sort, client-side symbol/sector filter, keyboard nav (`Tab`/`Enter`/`Escape`), density toggle

---

### Layout Primitives (`src/components/layout/`)

- `PageHeader.tsx`: `<h1>` title + optional subtitle + optional right-slot + optional `regime` prop (renders inline `RegimeBadge`), `mb-6` spacing
- `EmptyState.tsx`: centered, Lucide icon, heading, description, optional action button — replaces all raw "No data" text nodes
- `ErrorState.tsx`: centered, red-tinted icon, error message, "Retry" action that calls nearest TanStack Query `refetch()`
- `BentoGrid.tsx` + `BentoCell.tsx`: 12-column CSS grid, `data-bento-cell` attribute for mobile reflow, single-column stacked layout below 768px
- `PageTransition.tsx`: `SPRING_GENTLE` fade-from-below entrance wrapper for page default exports (not placed in the layout file)

---

### 3D Component Suite

- `MarketIntelligenceCore`: added `quality` prop — `low` (32×32 segments), `medium` (64×64, default), `high` (128×128); `useReducedMotion()` halts frame updates when `prefers-reduced-motion` is active
- `RiskSphere` (`src/components/3d/risk-sphere.tsx`): simplified R3F sphere with `MeshStandardMaterial`; color, scale, and opacity encode portfolio risk 0–100 (green → yellow → red); max 120×120px; used on Paper Trading stats panel
- `PortfolioGalaxy` (`src/components/3d/portfolio-galaxy.tsx`): R3F `Points` particle system, Fibonacci sphere distribution, particle size = position size, particle color = P&L sign (positive green, negative red), slow rotation responding to mouse via `useFrame`
- All 3D components use `next/dynamic` with `ssr: false` and skeleton loading states matching canvas dimensions

---

### Page Redesigns

#### Crypto Overview

- `BentoGrid` 12-column layout: Market Core (4×2 top-left), BTC card (4×1), ETH + SOL (2×1 each), global stats full-width strip
- `CryptoRegimeSync` bridges market store to `UIStore`
- `PageTransition` entrance + `PageHeader` with regime badge

#### India Overview

- Full client-side `BentoGrid`: Market Core (4×3 top-left), index strips (5×1 stacked center), Top 5 Stocks (3×3 right)
- `RegimeBanner` strip at top (full-width 28px, `--color-regime-*` background, human-readable context sentence)
- `IntersectionObserver` lazy-mount for 3D canvas — only mounts after parent Panel is visible
- VPIN `OrderFlowPanel` redesigned as 2-column widget (gauge arc + sparkline)
- MSB Signals section uses TanStack Table with `data-density="compact"` and `SPRING_MICRO` row entrance animations

#### AI Signals (Crypto + India)

- `PageTransition` + `PageHeader` on both pages
- Animated confidence ring: `motion.circle` arc fill using `SPRING_DEFAULT` on load, 50ms stagger between cards
- Hover expansion (> 300ms): SHAP factor breakdown, mini payoff diagram (when `signal.strike` available), invalidation criteria — collapses on mouse-leave with `SPRING_FAST`
- Stale overlay: frosted glass "Signal Expired" panel + "Refresh" action triggering manual refetch
- `NumberMorph` animates `confidenceScore` from 0 to actual value on initial load

#### India AI Signals + AiRadar

- `AiRadarSection` toggle (Show/Hide Radar button) below the existing `AiSignalsBoard`
- `signalToRadarRow` server-safe utility moved to `src/lib/signal-to-radar-row.ts` (no `"use client"` directive)

#### Options Chain

- `IvHeatDot`: green (IV < 20%), yellow (20–40%), red (> 40%), `data-testid` on each dot
- Max-pain strike background encoding via `--color-warning/20`; ATM strike via `--color-brand/20`
- `StatGrid` PCR strip above the chain table (PCR color-coded, max pain strike, ATM IV, IV regime badge)
- `layoutId="options-tab-pill"` on the Chain/IV Surface/GEX/Payoff tab selector with `SPRING_FAST` animation
- Greeks columns reveal via `AnimatePresence` column slide-in

#### Daily Picks

- `PanelHeader` bucket headers for all five sections
- `NumberMorph` P&L values (polling every 30s)
- `celebration-pulse` (800ms green border glow) on `TARGET_HIT` status change
- `vix-warning-pulse` (500ms red border pulse) on `STOP_HIT` status change
- Expiry Trades section: regime-reactive header border + `NumberMorph` countdown timer updating every second
- FnO Trend Scanner sections (Bullish/Bearish) collapsible via `details`/`summary` + animated chevron, collapsed by default
- `DailyPicksHistory` redesigned with TanStack Table, `data-density=compact`

#### Paper Trading

- `BentoGrid` stats row: total P&L (2 cols, `NumberMorph`, bull/bear colored), win rate arc gauge (1 col), `RiskSphere` (1 col)
- `data-density="compact"` throughout
- Double-confirm Close All: first click shows `Tooltip`, second click within 3 seconds executes
- `PnlLineChart` using lightweight-charts line series (consistent with existing chart library)
- Open Positions table: `NumberMorph` mark prices, `--color-data-positive` left-border on P&L ≥ +5% rows, `--color-data-negative` border on P&L ≤ -3% rows

---

### Bug Fixes

- **Hydration fix**: Added `fmtTime()` and `fmtDateTime()` to `src/lib/utils.ts` pinning `en-GB` locale to always produce `HH:MM:SS` format regardless of server/client timezone; replaced all bare `toLocaleTimeString()` / `toLocaleString()` calls across 21 files
- **Server/client boundary fix**: Moved `signalToRadarRow` to `src/lib/signal-to-radar-row.ts` — removed `"use client"` directive so the utility is server-safe
- **Canvas color fix**: `CHART_THEMES` in `price-chart.tsx` had `var(--fg-muted, #94a3b8)` in the `text` field — lightweight-charts canvas cannot parse CSS variables; replaced with literal hex `#94a3b8`

---

### New Tests

- 50 smoke tests for all layout primitives and trading components (`tests/components/`)
- `durationFor()` property tests with fast-check (500 runs) — validates `NumberMorph` magnitude-scaling contract
- All 1238 Vitest tests passing, 0 TypeScript errors

---

## [Unreleased] — FnO Intelligence & Paper Trading Engine

**Branch:** `feature/fno-bullish-trend-scanner`
**Test coverage:** 1101/1101 Vitest tests · 0 TypeScript errors

Major enhancement of the India F&O surface: Smart Money Concepts + UT Bot
Super Confluence indicator, FnO trend scanners with full level tracking,
unified signal table UI, intelligent auto paper-trading engine with daily ₹1L
budget, and a rich trade history & analytics page.

---

### FnO Bullish & Bearish Trend Scanner

- New Chartink-mirrored 14-condition screener on the Daily Picks page
- **Bullish conditions:** EMA(5) > SMA(20), WMA(10) > SMA(20), ADX DI+(14) > 20,
  ADX(14) > 20, Volume > 1L, MACD Line > 0, Close > prev/2d close,
  Close > SMA(50), Close > ₹150, DI+ > DI−, RSI > 50, MACD > Signal,
  SMA(20) > SMA(40)
- **Bearish conditions:** exact bearish mirror of all 14 conditions
- Results sorted by Chg% descending (bullish) / ascending (bearish) to match
  Chartink default
- ATR(14)-based entry/SL/TP1/TP2/TP3 levels on every hit (intraday profile:
  SL = 1.4×ATR, TP1 = 1.6×ATR, TP2 = 2.6×ATR, TP3 = 4.0×ATR)
- Results persisted to `FnoTrendScan` DB table (one row per tradeDate+scanType+symbol)
- Worker tracks TARGET_HIT / STOP_HIT / CLOSED every 60s during market hours
- `/api/in/fno-bullish-trend` and `/api/in/fno-bearish-trend` routes with cache-bust support
- EMA calculation seeded from SMA (TradingView/Chartink convention) for screener parity

### Super Confluence Engine (UT Bot + AI Neural + SMC + EMA 9/15/21)

- Port of the combined Pine Script "Super Confluence Engine" to TypeScript
- **UT Bot ATR Trailing Stop:** keyValue=1, atrPeriod=10 (LuxAlgo port)
- **AI Neural Trend Line:** HMA-smoothed adaptive trailing stop (speed=14, mult=2.0)
- **SMC Swing Structure:** BOS/CHoCH pivot bias (pivotLen=50)
- **EMA 9/15/21 stack:** 4th gate — all three must be in correct order
- Super Buy fires only when UT_buy AND aiDir==1 AND smcBias==1 AND ema9>ema15>ema21
- Score in [-1, 1]: full 4-way confluence = ±1.0, 3/4 = ±0.75, 2/4 = ±0.5
- `superConfluence` factor added to the India AI signal engine (weight 0.10)
- Chart overlay plugin: AI Neural Line (green/red), UT Bot trailing stop (dotted),
  SMC swing H/L lines (dashed), UT/Super Buy/Sell markers, EMA lines (amber shades)
- `🔥 SC` button added to the price chart toolbar

### Unified Signal Table UI

- `SignalTableRow` + `SignalTableHead` shared components for all India signal lists
- Click any row to expand inline detail panel (entry/SL/TP, metric, volume, note,
  TradingView link, Chart link, +Watchlist button, Paper Trade button)
- Applied to: F&O Scanner, India Signals board, MSB Dashboard (Range Expansion +
  MSB Signals), Watchlist, Daily Picks board, FnO Trend sections
- Entry/SL/TP1 columns visible directly in compact rows (no expand required)
- Daily Picks board: full table with Symbol/Dir/Grade/Status/P&L/Entry/SL/Target/Conf/Win%/R:R
- AI Signals board: Symbol/Action/Grade/LTP/Entry/SL/TP1/Conf/Win%/R:R/Horizon

### Intraday-Only Signal Filtering

- AI Signals board hard-locked to scalp+intraday horizon only
- Horizon dropdown removed — no swing/positional signals shown
- Market-closed state: shows last-session intraday signals (48h cache),
  falls back to planning signals with amber horizon badge when no snapshot exists
- Stale-while-revalidate: never returns fewer signals than last successful response
- Previous-session fallback in Daily Picks board when market is closed

### Paper Trading Enhancements

- New source IDs: `DAILY_PICK`, `AI_SIGNAL`, `SCANNER_HIT`, `FNO_TREND`
- `IndiaScalpTimeframe` extended with `"1d"` for manual signal-surface trades
- `POST /api/in/paper-trade` universal endpoint: market-hours guard (09:15–15:30 IST),
  expiry cooldown, duplicate check, symbol normalisation, risk gate
- `PaperTradeButton` component with idle/loading/success/error/closed states
- Paper Trade buttons on: Daily Picks expand panel, AI Signals expand panel,
  all SignalTableRow expand panels
- `FNO_TREND` `paperTradeStrategyId` on FnO trend scanner hits
- `POST /api/in/scalper/close-all`: force-closes all OPEN India trades at current price
- "Close All (N)" button in Open Positions card header
- EOD worker (`india-eod-squareoff`): closes all OPEN India trades at 15:30 IST

### Intelligent Auto Paper-Trading Engine

- Signal scoring: 35%×confidence + 25%×winProbability + 25%×grade + 15%×R:R
- Only signals scoring ≥ 0.52 are traded (eliminates low-conviction setups)
- Feeds from Daily Picks (DB) + AI Signals (intraday/scalp only)
- Daily ₹1,00,000 budget: max 5 positions × ₹20,000 notional each
- Risk gate: SL distance / entry ≤ 2.5% (no wide-stop gambles)
- No new entries after 14:45 IST; all positions closed at 15:30 IST
- `IndiaDaySession` table tracks daily budget utilisation and session P&L
- Worker job `india-auto-trader` runs every 60s during market hours
- `GET /api/in/paper-trade/analytics?range=1d|7d|15d|30d|6mo|1y|all`
- Analytics: equity curve, Sharpe ratio, consistency %, best/worst day, max drawdown

### Trade History Page (`/in/history`)

- New sidebar item "Trade History" (History icon) after Daily Picks
- "Past picks & outcomes" card removed from Daily Picks page
- Three source tabs: Daily Picks · Scalper Trades · FnO Trend Scanner
- Daily Picks tab: aggregate stats banner, bucket heat strip, day accordions (7/page),
  outcome/direction filters, 7d/14d/30d/60d range selector
- Scalper Trades tab: fetches `/api/in/scalper/journal`, strategy heat strip,
  per-trade inline detail with rationale + TradingView + Full Journal links
- FnO Trend Scanner tab: BULLISH/BEARISH/ALL sub-filter, per-day accordion,
  per-scan detail with all levels + ADX/RSI

### AI Signals Bug Fixes

- Fixed `horizonFilter is not defined` ReferenceError (stale dep in useMemo)
- Fixed blank board when market is closed (show last-session or planning signals)
- Fixed 29→4 signal drop: increased off-hours TTL to 5min, stale-while-revalidate,
  last-session snapshot stored during market hours (48h TTL)
- AI Signals board: shows market-closed banner with context when serving planning signals

### Worker Improvements

- `india-daily-picks` job: default interval reduced from 5min to 1min,
  `runOnStart: true` for immediate first tick
- New jobs wired: `india-fno-trend-track`, `india-eod-squareoff`, `india-auto-trader`
- `india-eod-squareoff`: closes all OPEN India trades at 15:30 IST with Yahoo prices
- `india-fno-trend-track`: tracks FnO trend scan TP1/SL resolution every 60s

### New DB Models

- `FnoTrendScan`: daily FnO trend scanner results with outcome tracking
- `IndiaDaySession`: daily auto-trading session (budget, P&L, win rate, drawdown)
- Migration: `20260821000000_fno_trend_scan` + `20260822000000_india_day_session`

### New Tests

- `tests/features/india-fno-trend-scanner.test.ts` — ScannerHit fields,
  ATR level arithmetic, EMA seeding convention, MACD streaming
- `tests/features/india-super-confluence.test.ts` — warmup guard, result shape,
  EMA 9/15/21 gate, partial score, barsSinceSignal
- `tests/features/india-auto-trader.test.ts` — signal scoring formula,
  budget arithmetic, analytics aggregation, range date calculation
- `tests/features/india-fno-trend-history.test.ts` — P&L direction math,
  outcome resolution, day summary aggregation
- `tests/api/in-paper-trade.test.ts` — market-hours guard, expiry cooldown,
  input validation, duplicate detection, symbol normalisation

---

## [Unreleased] — Phase 2: Expert Quant Upgrade

**Branch:** `feature/phase2-expert-quant`
**Scope:** ML service · TypeScript chart layer · New India pages · OpenAlgo adapter
**Test coverage:** 1084/1084 Vitest tests · 143/143 pytest tests · 0 TypeScript errors

Upgrades Alphaforge from "advanced retail" to expert quant / prop desk level
for the Indian F&O market. Twelve self-contained, TDD-driven increments — each
additive and degrade-safe; no existing route, store, or worker job is broken.

---


### Track A — Streaming Indicators + Chart Plugins

#### `src/features/indicators/index.ts` (new)

Streaming indicator adapter wrapping `@debut/indicators@2.0.1`.

- `streamIndicators(bars, config)` — batch mode; feeds all bars through streaming instances
- `createIndicators(config)` / `feedBar(handle, bar)` — stateful streaming mode (O(1) per bar)
- `dumpState(handle)` / `restoreState(state, config)` — Redis-serialisable snapshots; warm-start in ≤ 5 bars after worker restart
- `computeVolumeProfile(bars, {tickSize})` — POC/VAH/VAL with 70% value area; NSE tick calibration (0.05 stocks, 1 NIFTY, 5 BANKNIFTY)
- All outputs match existing `scalping/helpers.ts` ATR/RSI/EMA/Bollinger to within 0.01%

`worker/src/indicator-state.ts` — `saveIndicatorState` + `loadIndicatorState` wiring Redis persistence into both `scalper.ts` and `india-scalper.ts` jobs.

#### `src/components/india/charts/plugins/anchored-vwap.ts` (new)

`computeAnchoredVwap(bars, anchorIndex)` — exact `Σ(HLC3×vol)/Σvol` IEEE-754 arithmetic.
`AnchoredVwapPlugin` — three `LineSeries` overlays (session 09:15 IST, daily, weekly); `attach(chart, bars)` / `detach()` / `setTheme(palette)`.

#### `src/components/india/charts/plugins/volume-profile.ts` (new)

`getPocPrice(bars, {tickSize})` — tick-aligned POC via `computeVolumeProfile`.
`VolumeProfilePlugin` — POC (solid orange), VAH/VAL (dashed) as `series.createPriceLine()` overlays; `setTheme()` on theme flip.

#### `src/components/india/charts/price-chart.tsx` (modified)

- VWAP toolbar button (`aria-pressed`, amber palette) — calls `AnchoredVwapPlugin.attach()`
- Profile toolbar button (orange palette) — calls `VolumeProfilePlugin.attach()`
- Both plugins persist across timeframe changes via `updateData()` on new candles
- `useTheme()` propagates to both plugins on every theme toggle

---

### Track B — Python Options Analytics

#### `ml-service/src/greeks.py` (new)

Analytic Black-Scholes / Black-76 greeks engine.

- `compute_greeks_bs(spot, strike, r, t, sigma, flag)` — delta ∈ (0,1) for calls, ∈ (−1,0) for puts; gamma/vega > 0; theta < 0 — enforced via `_safe_cdf`/`_safe_pdf` using `scipy.special.log_ndtr` for deep-OTM numerical stability
- `solve_iv(ltp, spot, strike, r, t, flag)` — Newton-Raphson + `scipy.optimize.brentq` fallback; returns `None` for zero price or non-convergent inputs
- `compute_chain_greeks(chain_rows, spot, india_vix, expiry_dt)` — vectorised over all strikes; Black-76 for index options, Black-Scholes for stocks; `t = trading_days / 252`, `r = 0.071` (G-Sec)
- Exposed at `POST /analytics/greeks`

#### `ml-service/src/gex.py` (new)

Dealer Gamma Exposure engine.

- `compute_gex(chain_snapshot, spot, lot_size)` — CE sign −1 (dealers short calls), PE sign +1 (dealers short puts); cumulative zero-crossing gamma flip; expected move from `|aggregate_gex| / (spot² × total_oi × lot_size) × spot`
- `LOT_SIZES = {"NIFTY": 50, "BANKNIFTY": 15, "FINNIFTY": 40, "MIDCPNIFTY": 75}`
- Returns: `{strikes, gex_per_strike, aggregate_gex, gamma_flip, expected_move_pct, positive_gex_wall, negative_gex_wall}`
- Exposed at `POST /analytics/gex`

#### `ml-service/src/vol_surface.py` (new)

SVI implied volatility surface.

- `fit_svi(strikes, ivs, forward)` — L-BFGS-B minimisation; bounds: a∈[0,1], b∈[0,2], ρ∈(−0.999,0.999), m∈[−2,2], σ∈[0,2]; returns `{a,b,rho,m,sigma}`
- `build_iv_surface(snapshots_by_expiry)` — per-expiry `[{strike, iv}]` dicts
- `compute_term_structure(atm_ivs_by_expiry)` — sorted ascending by `days_to_expiry`
- Exposed at `POST /analytics/vol-surface`

#### `ml-service/src/iv_regime_classifier.py` (new)

Rule-based IV regime classifier (drop-in interface for future PatchTST).

- `IVClassifier.predict(data)` — input shape `[20, 5]` (`atm_iv, pcr, oi_change, vix, spot_change`); returns `"CRUSH" | "STABLE" | "SPIKE"`
- Heuristic: VIX trend < −1 pt + low realised vol → CRUSH; VIX trend > 1.5 pt + high realised vol → SPIKE
- Exposed at `POST /predict/iv-regime`

#### `src/app/api/in/option-chain/route.ts` (modified)

- Calls `POST http://localhost:8100/analytics/greeks` after broker fetch; merges enriched per-strike greeks (overwrites Angel One delta/gamma fallback)
- Calls `POST /predict/iv-regime`; adds `iv_regime: "CRUSH" | "STABLE" | "SPIKE" | null` to response
- Both calls wrapped in try/catch with 3s timeout; `iv_regime: null` and original greeks preserved on any failure

#### `src/app/api/in/gex/route.ts` (new)

`GET /api/in/gex?symbol=NIFTY` — calls ML service `POST /analytics/gex`; 5-min Redis cache; returns `{ available: false, reason }` on ML service failure.

#### `src/app/api/in/vol-surface/route.ts` (new)

`GET /api/in/vol-surface?symbol=NIFTY` — calls `GET /analytics/vol-surface`; 5-min Redis cache; graceful degradation.

#### `src/components/india/options/gex-panel.tsx` (new)

GEX bar chart (green = positive/stabilising, red = negative/destabilising), gamma flip dashed marker, expected move subtitle. `useGex()` hook with 5-min polling.

#### `src/components/india/options/vol-surface.tsx` (new)

IV Smile SVG chart (one polyline per expiry, `data-testid="expiry-line"`), Term Structure SVG area chart, optional 3D canvas toggle. `useVolSurface()` hook with 5-min polling. Added as "IV Surface" tab on `/in/options`.

#### `src/components/india/options/iv-regime-badge.tsx` (new)

`IvRegimeBadge({ivRegime})` — "Crush" green (`data-regime="CRUSH"`), "Spike" red (`data-regime="SPIKE"`), "Stable" amber; returns `null` when `ivRegime` is null/undefined.

#### `src/hooks/india/use-gex.ts` / `use-vol-surface.ts` (new)

Polling hooks wrapping the new API routes; follow the `use-order-flow` pattern.

---

### Track C — ML Service Upgrade

#### `ml-service/src/features/technical.py` (modified)

All pure-Python indicator loops replaced with `talib.*` C-backed vectorised calls:
- `compute_rsi` → `talib.RSI`; `compute_macd` → `talib.MACD`; `compute_adx` → `talib.ADX`; `compute_atr` → `talib.ATR`; `compute_bollinger_bands` → `talib.BBANDS`; `compute_ema_stack_score` → `talib.EMA` (5 periods); `compute_stochastic_rsi` → `talib.STOCHRSI`; `compute_cci` → `talib.CCI`; `compute_mfi` → `talib.MFI`; `compute_obv` → `talib.OBV`

New functions:
- `compute_cdl_engulfing(o,h,l,c)` → `talib.CDLENGULFING` (binary 0/1)
- `compute_cdl_hammer(o,h,l,c)` → `talib.CDLHAMMER` (binary)
- `compute_cdl_doji(o,h,l,c)` → `talib.CDLDOJI` (binary)
- `compute_ht_trendline_dev(close)` → `talib.HT_TRENDLINE` deviation `(close − HT) / HT`

#### `ml-service/src/features/engineer.py` (modified)

`RANKING_FEATURES` extended with: `cdl_engulfing`, `cdl_hammer`, `cdl_doji`, `ht_trendline_dev`, `macd_signal`, `obv_last`.
`REGIME_FEATURES` extended with: `vpin_score`.
`compute_stock_features()` wires all new candlestick + HT features.

#### `ml-service/src/features/volume.py` (modified)

New `compute_vpin(bars, bucket_size=50, n_buckets=50)`:
- Tick rule: `close > prev_close` → 85% buy; `close < prev_close` → 15% buy; equal → 50%
- Fractional bucket accumulation (volume apportioned across bucket boundaries)
- Returns `{"vpin_series": list[float], "current_vpin": float}` — all values ∈ [0,1]
- Exposed at `POST /analytics/vpin`

#### `ml-service/src/price_forecaster.py` (new)

Rule-based drop-in for TFT (darts).

- `PriceForecaster.predict(bars)` — input `[60, 9]` (OHLCV + VPIN + ATM IV + PCR + OI buildup); 10-bar close trend + VPIN + PCR + OI composite score → `{regime, probability, q10, q90}`
- Probability ∈ [0,1]; q90 ≥ q10 guaranteed
- Exposed at `POST /predict/price-regime`

#### `src/lib/india/ml-enhanced-context.ts` (modified)

`MLEnhancedContext` interface extended with `priceForecast: PriceForecastResult | null`.
`buildMLContext()` calls `POST /predict/price-regime` after regime+rankings; stores result in context; falls back to `priceForecast: null` on any failure or when ML is offline.
`buildFallbackContext()` sets `priceForecast: null`.

#### `src/app/api/in/order-flow/route.ts` (new)

`GET /api/in/order-flow?symbol=NIFTY` — calls ML service `POST /analytics/vpin`; 2-min Redis cache; returns `{symbol, vpin, bucketHistory, classification, available}`.

#### `src/components/india/dashboard/order-flow-panel.tsx` (new)

Horizontal VPIN gauge (`role="meter"`, `data-testid="vpin-gauge"`): red ≥ 0.7 (toxic), amber 0.3–0.7 (elevated), green < 0.3 (benign). SVG sparkline (`data-testid="vpin-sparkline"`). Placed on India Overview between Range Expansion and Top 5 Stocks.

#### `src/hooks/india/use-order-flow.ts` (new)

Polling hook; 2-min interval; `{data, isLoading, error}`.

---

### Track D — Standalone Features

#### `ml-service/src/models/portfolio_optimizer.py` (modified)

Upgraded from PyPortfolioOpt to Riskfolio-Lib 6.x. New public API (used by `/predict/portfolio-v2`):
- `hrp_allocation(returns_df)` — via `rp.HCPortfolio.optimization(model="HRP", codependence="pearson", rm="MV")`
- `cvar_allocation(returns_df, alpha=0.05)` — via `rp.Portfolio.optimization(model="Classic", rm="CVaR", obj="MinRisk")`
- Both return `{weights: dict, risk_metrics: {volatility, cvar, sharpe, max_dd}}`
- `_compute_risk_metrics()` — annualised vol, historical CVaR, annualised Sharpe, max drawdown
- Legacy `optimize()` preserved unchanged for `/predict/portfolio` backward compat

#### `src/app/api/in/portfolio-optimizer/route.ts` (new)

`POST /api/in/portfolio-optimizer` — accepts `{symbols, method}`; calls `/predict/portfolio-v2`; returns `PortfolioAllocation`; `{available: false, reason}` on ML service failure.

#### `src/app/(dashboard)/in/portfolio/page.tsx` (new)

Portfolio Optimizer page:
- Symbol multi-select from F&O universe (toggle chips)
- Method selector radio-group (HRP / CVaR / Max Diversification / Factor)
- Allocation pie chart (CSS `conic-gradient` + legend)
- Risk metrics table (Sharpe/CVaR/Volatility/Max DD with bull/bear badges)
- Efficient frontier SVG scatter chart
- `UnavailableBadge` when ML service offline

#### `src/features/india/options-workbench/payoff.ts` (new)

Pure TypeScript payoff engine:
- `computePayoff(legs, spotRange, premiums)` — CE: `q × (max(0,S−K) − p)`; PE: `q × (max(0,K−S) − p)`; break-evens via linear sign-crossing interpolation; `maxProfit` / `maxLoss`
- `aggregateGreeks(legs, greeksPerLeg)` — `net_greek += quantity × greek` per leg (short quantity naturally negates)
- Types exported: `OptionLeg`, `Greeks`, `StrategyAnalysis`

#### `src/app/(dashboard)/in/options-workbench/page.tsx` (new)

Options Strategy Workbench:
- 13-strategy picker (Long/Short Call, Long/Short Put, Bull/Bear Call Spread, Bear Put Spread, Iron Condor, Straddle, Strangle, Butterfly, Jade Lizard, Custom)
- ATM auto-populate from `/api/in/option-chain`; per-leg strike/premium auto-fills from chain LTPs
- SVG payoff diagram with filled green/red areas, yellow dashed break-even annotations, P&L axis labels
- Break-even list with profit-zone narrative
- Net greeks table (delta/gamma/theta/vega) from `aggregateGreeks()`
- "Scan for Best Strikes" — fetches `/api/in/gex` for expected move band; suggests Iron Condor / spread strikes accordingly

#### `src/services/india/broker/openalgo-adapter.ts` (new)

`OpenAlgoAdapter implements BrokerAdapter`:
- `id = "openalgo"`
- `getQuote(symbol)` → `GET {baseUrl}/api/v1/quotes` with `X-Api-Key` header; normalises to `Quote`
- `getHistorical(req)` → `GET /api/v1/historical`; normalises to `Candle[]` (unix seconds)
- `placeOrder(params)` → `POST /api/v1/placeorder`; **throws** `"Live trading is not enabled…"` before any `fetch()` call when `LIVE_TRADING_ENABLED !== "true"`
- `modifyOrder(id, params)` / `cancelOrder(id)` — same live-trading guard
- `getOptionChain()` — throws "not supported" (no OpenAlgo chain endpoint)
- `OPENALGO_API_KEY` expected to be AES-256-GCM decrypted before passing to constructor

#### `src/services/india/broker/factory.ts` (modified)

- Added `getOpenAlgoAdapter()` lazy factory (returns null when env vars absent)
- Added `case "openalgo"` in `getBroker()` and `getBrokerById()`

#### `src/features/settings/data-sources-shared.ts` (modified)

Added `"openalgo"` to `DataSourceId` union and a `DATA_SOURCES` entry with `implemented: true`.

#### `src/components/india/paper-trading/live-order-modal.tsx` (new)

Double-confirm live order modal:
- Signal details grid (symbol, direction badge, entry/stop/target in ₹)
- Paper-trade win rate percentage; `<Badge variant="warning" data-testid="win-rate-warning">` when < 50%
- Confirmation checkbox (`data-testid="confirm-checkbox"`, accessible label)
- "Place Real Order" button (`data-testid="place-order-btn"`) — disabled until checkbox checked; switches to danger variant when enabled
- `role="dialog"` + `aria-modal="true"` on root; backdrop click closes

#### `src/components/dashboard/sidebar.tsx` (modified)

Added to `INDIA_NAV`:
- `{ href: "/in/options-workbench", label: "Options Workbench", icon: TrendingUp }`
- `{ href: "/in/portfolio", label: "Portfolio Optimizer", icon: BarChart3 }`

---

### Graceful Degradation (all new routes)

All four new Phase 2 API routes (`/api/in/gex`, `/api/in/vol-surface`, `/api/in/order-flow`, `/api/in/portfolio-optimizer`) follow the contract:
- Network error, timeout, ML HTTP 500 → HTTP 200 with `{ available: false, reason: string }`
- Never returns a 5xx status
- Covered by `tests/api/graceful-degradation.test.ts` (25 tests, 4 suites)

---

### New Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@debut/indicators` | 2.0.1 (pinned) | Streaming TA library (npm) |
| `mibian` | 0.1.3 (pip) | Black-Scholes / Black-76 greeks (pure Python) |
| `TA-Lib` | 0.6.8 (pip) | Vectorised C indicator library |
| `Riskfolio-Lib` | 6.3.1 (pip) | HRP + CVaR portfolio optimiser |
| `darts` | 0.32.* (pip, optional) | TFT forecasting — commented out |
| `tsai` | 1.0.* (pip, optional) | PatchTST classifier — commented out |

---

### New Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENALGO_BASE_URL` | — | OpenAlgo broker REST base URL |
| `OPENALGO_API_KEY` | — | AES-256-GCM encrypted API key |
| `LIVE_TRADING_ENABLED` | unset | Must be exactly `"true"` to allow order placement |
| `ML_SERVICE_URL` | `http://localhost:8100` | ML microservice base URL |

---

### Files Changed (summary)

| Layer | New files | Modified files |
|---|---|---|
| TypeScript — indicators | `src/features/indicators/index.ts`, `worker/src/indicator-state.ts` | `worker/src/jobs/scalper.ts`, `worker/src/jobs/india-scalper.ts` |
| TypeScript — chart plugins | `plugins/anchored-vwap.ts`, `plugins/volume-profile.ts` | `charts/price-chart.tsx` |
| TypeScript — option chain | `api/in/gex/route.ts`, `api/in/vol-surface/route.ts` | `api/in/option-chain/route.ts` |
| TypeScript — order flow | `api/in/order-flow/route.ts`, `hooks/india/use-order-flow.ts`, `components/india/dashboard/order-flow-panel.tsx` | `components/india/msb-dashboard.tsx` |
| TypeScript — portfolio | `api/in/portfolio-optimizer/route.ts`, `in/portfolio/page.tsx` | — |
| TypeScript — workbench | `features/india/options-workbench/payoff.ts`, `in/options-workbench/page.tsx` | — |
| TypeScript — OpenAlgo | `services/india/broker/openalgo-adapter.ts`, `components/india/paper-trading/live-order-modal.tsx` | `services/india/broker/factory.ts`, `features/settings/data-sources-shared.ts`, `components/dashboard/sidebar.tsx` |
| TypeScript — IV classifier | `components/india/options/iv-regime-badge.tsx`, `hooks/india/use-gex.ts`, `hooks/india/use-vol-surface.ts` | — |
| TypeScript — ML context | — | `lib/india/ml-enhanced-context.ts` |
| TypeScript — GEX/Vol UI | `components/india/options/gex-panel.tsx`, `components/india/options/vol-surface.tsx` | `app/(dashboard)/in/options/page.tsx` |
| Python — greeks | `ml-service/src/greeks.py` | `ml-service/src/server.py` |
| Python — GEX | `ml-service/src/gex.py` | — |
| Python — vol surface | `ml-service/src/vol_surface.py` | — |
| Python — IV classifier | `ml-service/src/iv_regime_classifier.py` | — |
| Python — TA-Lib | — | `ml-service/src/features/technical.py`, `ml-service/src/features/engineer.py` |
| Python — VPIN | — | `ml-service/src/features/volume.py` |
| Python — TFT | `ml-service/src/price_forecaster.py` | — |
| Python — portfolio | — | `ml-service/src/models/portfolio_optimizer.py` |
| Config | — | `ml-service/requirements.txt`, `ml-service/Dockerfile` |

---

### Backward Compatibility

- No existing API route shape changed (all changes are additive fields or new routes)
- No existing Redux/Zustand store modified
- No existing worker job broken — indicator state persistence is fire-and-forget
- Legacy `/predict/portfolio` endpoint preserved unchanged; new `/predict/portfolio-v2` is the Riskfolio path
- ML service degrades gracefully at every consumer — `{ available: false }` rather than 503

---

## [Unreleased] — Top 5 Stocks for Tomorrow + TypeScript / Build Fixes

**Branch:** `feat/ml-decision-engine`
**Scope:** Indian Market dashboard · API · TypeScript config · Test setup

---

### 1. New feature — Top 5 Stocks for Tomorrow

A new post-market section on the Indian Market Overview dashboard
(`/in/dashboard`) that surfaces the five highest-conviction NSE F&O stocks to
watch for the next trading session, reviewed after market close.

#### `src/app/api/in/top-picks/route.ts` (new file)

`GET /api/in/top-picks?limit=5`

- Flattens the entire `SECTOR_STOCKS` universe (~130+ NSE F&O names) into a
  deduplicated symbol → primary-sector map (first sector listed per symbol wins).
- Fetches Yahoo Finance quotes for every symbol in parallel via `yahoo-finance2`.
- Scores each stock through `computeScore` + `classifySignal` from
  `src/services/india/signals/score.ts` — the same 8-factor quant model used by
  the sector-stocks route (SMA-50/200, intraday change, analyst target, RSI,
  ADX, relative volume, delivery %).
- Filters out any stock with no price data or an `N/A` signal.
- Sorts descending by score; upside% (to max of analyst target and 52-week high)
  is the tiebreaker.
- Returns the top N (default 5, configurable via `?limit=`).
- Response: `{ picks: TopPickRow[], universe: number, fetchedAt: string }`.
- `Cache-Control: no-store` — always fresh.

**`TopPickRow` shape:**

| Field | Type | Notes |
|---|---|---|
| `rank` | `number` | 1-based |
| `symbol` | `string` | NSE ticker |
| `shortName` | `string \| null` | Yahoo short/long name |
| `sector` | `string` | Primary sector from `SECTOR_STOCKS` |
| `price` | `number \| null` | Last traded price |
| `changePct` | `number \| null` | Day change % |
| `score` | `number` | −100 … +100 composite quant score |
| `signal` | `SignalLabel` | `"STRONG BUY"` … `"STRONG SELL"` |
| `upsidePct` | `number \| null` | % to max(analyst target, 52w-high) |
| `fromSma50Pct` | `number \| null` | % above/below 50-day SMA |
| `relativeVolume` | `number \| null` | Today vol ÷ 3-month avg vol |
| `targetMean` | `number \| null` | Analyst mean target price |

#### `src/components/india/msb-dashboard.tsx` (modified)

- Added `Star` to the lucide-react import list.
- Added `TopPickRow`, `TopPicksResponse` local types.
- Added `SIGNAL_GRADIENT` style map — maps each signal label to ring, badge
  and icon colour tokens.
- Added `TopPickCard` component — renders one ranked stock card with:
  - Absolute-positioned rank badge (top-right corner).
  - Directional icon (`ArrowUpRight` / `ArrowDownRight` / `Activity`) tinted
    by signal.
  - TradingView deep-link on the symbol ticker.
  - Signal badge (colour-coded bull/bear/neutral).
  - Metrics grid: price · day % · upside · vs SMA50 · relative volume · score
    pill (reuses existing `ScorePill`).
- Added `TopPicksSection` component — polls `GET /api/in/top-picks?limit=5`
  every 5 minutes, renders animated loading skeletons while in-flight, an
  error banner on failure, and a footer disclaimer. Placed between
  `<RangeExpansionSection />` and `<MsbSignalsSection />` in the dashboard
  render tree.

---

### 2. TypeScript / build fixes

Three pre-existing issues blocked `tsc --noEmit` (9 errors across 7 files)
and `next build`. All errors were in test infrastructure; no source or runtime
code was changed.

#### `tsconfig.json` — `target` raised from `ES2017` to `ES2018`

**Error fixed:** `TS1501: This regular expression flag is only available when
targeting 'es2018' or later.`

**Files affected:**
- `tests/worker/db.test.ts:37` — `/\.env\.example.*docker:up/s`
- `tests/worker/redis.test.ts:39` — `/docker:up.*\.env\.local/s`

The `s` (dotAll) regex flag requires ES2018. The worker's own
`worker/tsconfig.json` already targeted ES2022; this fix aligns the root
config. Safe — Next.js 16 requires Node 18+ which natively supports all
ES2018+ syntax.

#### `tsconfig.json` — `@worker/*` path alias added

**Error fixed:** `TS2307: Cannot find module '@worker/…' or its corresponding
type declarations.`

**Files affected:**
- `tests/worker/config.test.ts:13`
- `tests/worker/db.test.ts:15`
- `tests/worker/log.test.ts:26`
- `tests/worker/observability.test.ts:27`
- `tests/worker/redis.test.ts:17`
- `tests/worker/scheduler.test.ts:3`

`@worker/*` was defined in `worker/tsconfig.json` but absent from the root
`tsconfig.json`. The root config is what `tsc --noEmit` and `next build` use
to type-check the whole repo (including `tests/`). The Vitest bundler already
had the alias via `resolve.alias` in `vitest.config.ts` — this fix brings the
type-checker into alignment.

**Change:** Added `"@worker/*": ["./worker/src/*"]` to `paths` in
`tsconfig.json`.

#### `tests/setup/vitest.setup.ts` — redundant `NODE_ENV` assignment removed

**Error fixed:** `TS2540: Cannot assign to 'NODE_ENV' because it is a
read-only property.`

`process.env.NODE_ENV ??= "test"` (line 15) was both redundant and invalid:

- Redundant because `vitest.config.ts` already injects `NODE_ENV=test` via
  `test.env` before any module is evaluated in the worker VM.
- Invalid because TypeScript's `ProcessEnv` interface declares `NODE_ENV` as
  `readonly string | undefined`, making any direct assignment a type error.

**Fix:** Removed the line. A comment was added explaining that `NODE_ENV` is
set via `test.env` in `vitest.config.ts`.

---

### Files changed

| File | Change |
|---|---|
| `src/app/api/in/top-picks/route.ts` | **New** — `GET /api/in/top-picks` API route |
| `src/components/india/msb-dashboard.tsx` | **Modified** — `Star` import, `TopPickCard`, `TopPicksSection` |
| `tsconfig.json` | **Modified** — `target` ES2017→ES2018, `@worker/*` path alias added |
| `tests/setup/vitest.setup.ts` | **Modified** — removed `process.env.NODE_ENV ??= "test"` |

### Backward compatibility

- The new `/api/in/top-picks` route is purely additive.
- No existing API shapes, Redis keys, or DB schema changed.
- The `tsconfig.json` target bump is backward-compatible with all existing
  source — every browser/Node target we deploy to already supports ES2018.
- `tsc --noEmit` now exits 0. `next build` compiles successfully.

---

## [Unreleased] — Quant-Grade India Stock Selection Upgrade

**Branch:** `feat/ml-decision-engine`
**Scope:** ML service → AI signals engine → India builder → Daily Picks engine

This release significantly raises the bar for which Indian F&O stocks reach
the AI Signals board and Daily Picks buckets. The objective is higher
confidence, higher predictability, and a pipeline that filters stocks the
way a prop-desk quant would — not just by price/SMA position but by trend
conviction, institutional volume, derivatives positioning, and ML ranking.

---

### 1. `src/services/india/signals/score.ts` — 8-Factor Quant Score

**What changed:**
- Replaced the old 4-factor linear score (SMA50, SMA200, intraday change,
  analyst target — 100 pts total with equal 20-30 pt slots) with an
  8-factor weighted quant model.

**New factor breakdown (100 pts):**

| Factor | Weight | Signal |
|---|---|---|
| SMA-50 proximity | 15 pts | Medium-term trend anchor |
| SMA-200 proximity | 15 pts | Primary trend direction |
| Intraday change % | 20 pts | Today's tape read |
| Analyst target upside | 15 pts | Fundamental upside |
| RSI(14) | 10 pts | Momentum / overbought-oversold |
| ADX(14) | 8 pts | Trend conviction gate |
| Relative volume (20d avg) | 9 pts | Institutional participation |
| NSE delivery % | 8 pts | Conviction vs speculative activity |

**STRONG BUY / STRONG SELL thresholds** tightened from ±60 → **±55**
(a stock needs more factors aligned to earn the top label).

**Quant gate introduced:**
- ADX ≥ 20, relative volume ≥ 1.2×, delivery % ≥ 40% = passes gate
- Stocks that pass receive a **+5% score multiplier**
- `passesQuantGate()` exported for upstream consumers

---

### 2. `src/features/ai-signals/engine.ts` — Core Confidence Math Tightened

**Model version bumped:** `alphaforge-ai-v1` → **`alphaforge-ai-v2`**

**`compositeScore`:**
- Now detects which "hard" flow factors are available:
  `scanner`, `futuresScreen`, `volume`, `oiBuildup`, `dayChange`
- Each available flow factor contributes a **+0.08 max confidence bonus**
  (proportional to how many of the 5 are present)
- Formula: `magnitude × (0.52 + 0.48 × coverage) + flowBonus`
- Previously: `magnitude × (0.55 + 0.45 × coverage)` with no flow bonus

**`classifyAction` — WAIT threshold tightened:**
- Old: `minMagnitude = 0.18`
- New: `minMagnitude = 0.22`
- Signals with weaker composite scores now correctly stay WAIT rather than
  committing to a low-conviction direction.

**`gradeFromConfidence` — grade thresholds tightened:**

| Grade | Old | New |
|---|---|---|
| S | ≥ 0.85 | ≥ 0.82 |
| A | ≥ 0.72 | ≥ 0.68 |
| B | ≥ 0.58 | ≥ 0.54 |
| C | ≥ 0.42 | ≥ 0.38 |
| D | < 0.42 | < 0.38 |

**`calibrateWinProbability` — logistic offset tightened:**
- Offset: 0.35 → **0.38** — marginal signals now estimate ~47% win-rate
  (vs. an optimistic 50%) matching observed NSE F&O intraday outcomes.
- Cap range tightened: `[0.30, 0.85]` → **`[0.28, 0.82]`**

**`riskLevelFromConfidence` — "low risk" bar raised:**
- Old: confidence ≥ 0.62 AND alignedRatio ≥ 0.70 → low
- New: confidence ≥ **0.68** AND alignedRatio ≥ **0.72** → low

---

### 3. `src/features/ai-signals/india-builder.ts` — ML Integration + Quant Pre-Filter

**Major additions:**

#### Quant Pre-Filter
New `passesQuantPrefilter(symbol, dailies, isIndex)` function:
- Gates on ADX ≥ 18, relative volume ≥ 1.1×, ATR% ≥ 0.4%
- Stocks that **fail** the gate receive an **18% confidence haircut**
  (`confidence × 0.82`) — they still appear on the board but rank lower
- Index underlyings (NIFTY, BANKNIFTY, etc.) always pass
- `computeApproxAdx()` — Wilder ADX(14) computed purely from daily candles,
  no external dependency

#### ML Service Integration
New `buildStockFeaturesForML()` helper builds the minimal feature vector
(relative volume, ATR expansion, 5/10d momentum, EMA stack, RSI, ADX, gap%)
for every stock in the universe.

`computeIndiaUniverse()` now:
1. Calls `buildMLContext()` with all stock features in parallel with the
   existing Yahoo/NSE data fan-out
2. **Blends regime scores**: 65% heuristic (live index %) + 35% ML model
3. Builds an `mlRankMap` from the ML ranker's top-N output
4. Applies a **±0.06 confidence delta** per stock based on ML rank score:
   - Top-ranked stocks (score > 50): up to +0.06 boost
   - Bottom-ranked stocks (score < 50): up to −0.06 penalty
5. Passes `quantPrefilterPassed` and `mlRankBoost` into `buildIndiaSignal()`

#### Factor weight increases
- `futuresScreen` (Chartink-style institutional filter): **0.12 → 0.14**
- `scanner` (live scanner cross-reference): **0.08 → 0.10**
- `dayChange` (intraday demand): **0.13 → 0.14**

---

### 4. `src/features/india/daily-picks/engine.ts` — Higher Quality Floors

**`TAPE_HARD_FILTER_BIAS`:** 0.10 → **0.15**
- The counter-tape hard filter now only fires when the market has a
  genuinely meaningful directional lean, preventing over-filtering on
  borderline / flat days.

**`BUCKET_GATES` — per-bucket quality floors raised:**

| Bucket | Old condition | New condition |
|---|---|---|
| INDICES_SCALP | confidence ≥ 0.18 | confidence ≥ **0.20** |
| MOMENTUM | dayChange ≥ 0.2 | confidence ≥ **0.25** + dayChange ≥ **0.3** |
| SCALPING | RR ≥ 1.4 + dayChange ≥ 0.25 | confidence ≥ **0.22** + RR ≥ **1.5** + dayChange ≥ **0.30** |
| POTENTIAL | confidence ≥ 0.2 + breakout ≥ 0.2 | confidence ≥ **0.28** + breakout ≥ **0.25** |

**`bucketScores` — `futuresScreen` weight raised across all buckets:**

| Bucket | Old screen weight | New screen weight |
|---|---|---|
| MOMENTUM | 0.20 | **0.26** |
| SCALPING | 0.12 | **0.20** |
| POTENTIAL | 0.10 | **0.16** |
| INDICES_SCALP | 0.08 | **0.12** |

---

### 5. `ml-service/src/models/stock_ranker.py` — India-Tuned Ranking

**`_compute_heuristic_score` — component weight rebalancing:**

| Component | Old weight | New weight | Key change |
|---|---|---|---|
| Momentum | 0.25 | 0.22 | Slight reduction |
| Volume | 0.18 | 0.16 | Delivery % added as sub-factor (×0.08) |
| Breakout | 0.20 | 0.18 | `higher_highs_lows` weight raised 0.20→**0.26** |
| Derivatives | **0.17** | **0.22** | Biggest increase — key NSE predictor |
| Mean reversion | 0.10 | 0.10 | Unchanged |
| Relative strength | 0.10 | **0.12** | `sector_relative_strength` added |

**Within derivatives component:**
- OI build-up: 0.30 → **0.34**
- PCR score: 0.25 → **0.26**
- OI wall score: 0.20 → unchanged
- Max-pain distance: 0.15 → **0.12**

**NSE delivery % added to volume component** (×0.08 sub-weight) — filters
high-volume intraday punting from genuine institutional accumulation.

**New `sector_relative_strength` factor** in relative-strength component —
measures the stock's 20-day return vs. the average 20-day return of sector
peers, surfacing leaders within their sector rather than just vs. NIFTY.

**`_extract_top_factors`:** updated factor map includes:
- `Higher Highs/Lows` (×12, new)
- `RS vs Sector` (×40, new)
- `OI Build-up` weight raised ×12 → **×14**
- `PCR` weight raised ×10 → **×12**
- `OI Wall` weight raised ×8 → **×10**
- `Delivery %` divisor tightened /5 → **/4**

---

### 6. `ml-service/src/models/market_regime.py` — Sharper Regime Detection

**Heuristic fallback tightened throughout.** All previous thresholds were
calibrated to broad global market data; these are tuned to NSE patterns.

**New inputs wired into regime scoring:**
- `put_call_ratio` (PCR) — high put buying signals panic/bearish bias;
  PCR 1.2–1.6 adds to STRONG_BULL (heavy PE writing = bullish hedging)
- `nifty_oi_delta_skew_norm` — large OI skew magnitude adds to VOLATILE
- `pct_above_sma20` — majority above near-term MA adds to STRONG_BULL
- `pct_above_sma200` — majority below long-term MA adds to BEAR
- `rotation_score` — healthy sector rotation adds to BULL

**Key threshold changes:**

| Signal | Old | New | Direction |
|---|---|---|---|
| CRASH VIX | > 28 | > **30** (full), > 26 (partial) | Tighter |
| CRASH ad_ratio | < −0.60 | < **−0.65** | Tighter |
| BEAR nifty_change | < −1.0 | < **−1.2** | Tighter |
| BEAR VIX | > 18 | > **20** | Tighter |
| VOLATILE VIX | > 20 | > **22** | Tighter |
| STRONG_BULL nifty_change | > 1.0 | > **1.2** | Tighter |
| STRONG_BULL VIX | < 15 | < **13** (full), < 15 (partial) | Tighter |
| BULL nifty_change | > 0.3 | > **0.4** | Tighter |
| SIDEWAYS nifty_change | < 0.5 | < **0.4** | Tighter |
| SIDEWAYS ADX | < 20 | < **18** | Tighter |

---

### 7. `ml-service/src/features/engineer.py` — Feature Set Expansion

**`RANKING_FEATURES`** extended with:
- `sector_relative_strength` — stock RS vs. sector peers (new)

**`compute_stock_features`** — sector RS computation added:
- Computes the stock's 20-day return relative to the average 20-day return
  of all available sector peers
- Value of 1.0 = in-line with sector; > 1.0 = outperforming the sector
- Stored as `features["sector_relative_strength"]`
- Falls back to 1.0 when no sector peer data is available

---

### Files Changed

| File | Lines | Summary |
|---|---|---|
| `src/services/india/signals/score.ts` | +149 / −57 | 8-factor quant score |
| `src/features/ai-signals/engine.ts` | +75 / −38 | Tightened confidence math |
| `src/features/ai-signals/india-builder.ts` | +323 / −52 | ML integration + quant pre-filter |
| `src/features/india/daily-picks/engine.ts` | +70 / −38 | Higher bucket quality floors |
| `ml-service/src/models/stock_ranker.py` | +97 / −68 | India-tuned ranking weights |
| `ml-service/src/models/market_regime.py` | +163 / −108 | Sharper regime heuristic |
| `ml-service/src/features/engineer.py` | +28 / −8 | sector_relative_strength feature |

---

### Backward Compatibility

- The API surface (`/api/in/ai-signals`, `/api/in/daily-picks`,
  `/api/in/ml-predictions`) is unchanged — same response shapes.
- The ML service endpoints are unchanged; `sector_relative_strength` is an
  additive feature (defaults to 1.0 when sector data is missing).
- Redis cache keys are unaffected; existing cached entries will continue to
  serve until their TTL expires (60s for signals, 7d for signal records).
- `AI_MODEL_VERSION` bumped to `alphaforge-ai-v2` — the frontend can use
  this to display which engine generated a signal.
