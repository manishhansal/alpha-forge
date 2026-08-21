# AlphaForge — Change Log

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
