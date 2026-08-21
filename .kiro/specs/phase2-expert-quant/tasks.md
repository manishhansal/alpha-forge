# Implementation Plan: phase2-expert-quant

## Overview

Twelve incremental tasks that upgrade Alphaforge to expert-quant / prop-desk level for the Indian F&O market. Each task is independently testable and degrade-safe. TypeScript changes land in `src/`; Python changes land in `ml-service/src/`. TDD is mandatory — write failing tests first, then implement.

Track A (Tasks 1→2), Track B (Tasks 3→4→5, 9 branches off 3), Track C (Tasks 6→7→8), and Track D (Tasks 10, 11, 12) can run in parallel after their prerequisites.

---

## Tasks

- [x] 1. Replace hand-rolled indicator helpers with @debut/indicators

  Install `@debut/indicators` at an exact pinned version. Create `src/features/indicators/` adapter layer that wraps streaming classes and exposes the same interface consumed by India strategies.

  - [x] 1.1 Write failing tests for the indicator adapter
    - Create `tests/features/indicators/stream-indicators.test.ts`
    - Test ATR output matches existing `helpers.ts` Wilder ATR to within 0.01% on a 200-bar OHLCV fixture
    - Test RSI output matches existing helpers RSI to within 0.01%
    - Test EMA output matches existing helpers EMA to within 0.01%
    - Test Bollinger Bands upper/mid/lower match existing helpers to within 0.01%
    - Create `tests/features/indicators/volume-profile.test.ts`
    - Test POC is the price row with the highest cumulative volume across all session bars
    - Test VAH ≥ POC ≥ VAL holds for all valid session inputs
    - Create `tests/features/indicators/state-serialisation.test.ts`
    - Test `dumpState` then `restoreState` then continue produces identical output to a continuous run
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 1.2 Implement streaming indicator adapter
    - `npm install @debut/indicators` (pin the exact version)
    - Create `src/features/indicators/index.ts` with `streamIndicators(bars, config) → IndicatorOutput`
    - Wrap `EMA`, `ATR` (Wilder's SMMA), `RSI`, `BollingerBands`, `SuperTrend(10,3)`, `VolumeProfile` from `@debut/indicators`
    - Calibrate `VolumeProfile` tickSize: 0.05 for stocks, 1 for NIFTY, 5 for BANKNIFTY
    - Implement `dumpState(indicators): SerializedState` and `restoreState(state): ActiveIndicators`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.3 Migrate helpers.ts to use the adapter
    - Replace `ema()`, `atr()`, `rsi()`, `bollinger()` in `src/features/scalping/helpers.ts` with calls to `streamIndicators`
    - Migrate `src/features/india/scalping/` helpers similarly
    - Wire `dumpState`/`restoreState` into the worker's indicator lifecycle (save to Redis on worker shutdown, restore on startup)
    - Confirm all existing `tests/features/` tests remain green
    - _Requirements: 1.1, 1.6, 1.7_

  - [ ]* 1.4 Write property test for indicator warm-start round-trip
    - **Property 1: Indicator warm-start round-trip**
    - Use `fast-check` to generate random OHLCV sequences; for each: run to midpoint, dump state, restore, continue; verify outputs match continuous run
    - **Validates: Requirements 1.4, 1.5**

  - [ ]* 1.5 Write property test for ATR compatibility
    - **Property 2: ATR compatibility**
    - Use `fast-check` to generate valid OHLCV sequences of ≥ 30 bars; compare new ATR to helpers.ts ATR; assert within 0.01%
    - **Validates: Requirements 1.1**

  - [ ]* 1.6 Write property test for Volume Profile POC invariant
    - **Property 3: Volume Profile POC invariant**
    - Use `fast-check` to generate random session bars; assert POC equals `argmax` over price buckets
    - **Validates: Requirements 1.2, 2.2**

- [x] 2. Lightweight-charts v5 plugins — Anchored VWAP + Volume Profile

  Add two institutional chart tools as `IChartSeriesPlugin` implementations on the existing price chart. Read `node_modules/next/dist/docs/` before writing plugin code.

  - [x] 2.1 Write failing tests for the chart plugins
    - Create `tests/features/indicators/anchored-vwap.test.ts`
    - Test VWAP from 10 synthetic bars = `Σ(HLC3×vol) / Σvol` computed manually — exact equality
    - Test VWAP with anchor at bar 0 vs bar 5 produces different values for the same current bar
    - Create `tests/features/indicators/volume-profile-plugin.test.ts`
    - Test POC line renders at the price row with the highest volume in the chart data
    - _Requirements: 2.1, 2.2_

  - [x] 2.2 Implement Anchored VWAP plugin
    - Read `node_modules/next/dist/docs/` lightweight-charts v5 plugin API
    - Create `src/components/india/charts/plugins/anchored-vwap.ts`
    - Accumulate `Σ(HLC3 × volume) / Σvolume` from each anchor (session open 09:15 IST, daily open, weekly open)
    - Render as three `LineSeries` overlays with distinct colors; toggled by toolbar
    - _Requirements: 2.1, 2.3_

  - [x] 2.3 Implement Volume Profile plugin
    - Create `src/components/india/charts/plugins/volume-profile.ts`
    - Render POC (orange), VAH/VAL (dashed) as horizontal lines using `VolumeProfile` output from Task 1
    - Add toolbar toggle; persist on timeframe change
    - _Requirements: 2.2, 2.4_

  - [x] 2.4 Integrate plugins into price-chart.tsx
    - Import both plugins into `src/components/india/charts/price-chart.tsx`
    - Wire `useTheme()` palette changes to `plugin.applyOptions()` on every theme toggle
    - Add toolbar buttons above the chart to toggle each plugin independently
    - _Requirements: 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.5 Write property test for Anchored VWAP correctness
    - **Property 4: Anchored VWAP correctness**
    - Use `fast-check` to generate bar sequences; assert VWAP = `Σ(HLC3×vol)/Σvol` for every bar
    - **Validates: Requirements 2.1**

- [x] 3. Checkpoint — Indicator and chart layer complete
  - Ensure all tests in `tests/features/indicators/` and `tests/components/india/charts/` pass. Run `npm run test:features` and `npm run test:components`. Ask the user if questions arise.

- [x] 4. Python — real BS/Black-76 greeks on the option chain

  Install `mibian==0.1.3`. Create `greeks.py` with vectorised per-strike greek computation and IV solver. Wire into `/api/in/option-chain` with a graceful fallback.

  - [x] 4.1 Write failing Python tests for the greeks engine
    - Create `ml-service/tests/test_greeks.py`
    - Test `compute_greeks_bs` on known ATM NIFTY inputs: delta ≈ 0.50 ± 0.05, gamma > 0, theta < 0, vega > 0
    - Test call delta ∈ (0, 1) for any positive (spot, strike, t, sigma)
    - Test put delta ∈ (−1, 0) for any positive (spot, strike, t, sigma)
    - Test IV solver round-trip: `black76(F, K, r, t, solve_iv(LTP, F, K, r, t, flag), flag)` ≈ LTP within 0.001
    - _Requirements: 3.1, 3.2_

  - [x] 4.2 Write failing TypeScript tests for the option-chain route degradation
    - Create / extend `tests/api/option-chain.test.ts`
    - Test that when ML service mock returns a network error, the route returns HTTP 200 with the chain (no crash)
    - Test that `iv_regime` field is present in response and is null when ML service is down
    - _Requirements: 3.5, 9.7_

  - [x] 4.3 Implement greeks.py and ML service endpoint
    - `pip install mibian==0.1.3` (add to `ml-service/requirements.txt`)
    - Create `ml-service/src/greeks.py`:
      - `compute_greeks_bs(spot, strike, r, t, sigma, flag)` — mibian Black-Scholes
      - `black76(F, strike, r, t, sigma, flag)` — Black-76 for index options
      - `solve_iv_newton(market_price, F_or_spot, strike, r, t, flag)` — Newton-Raphson + brentq fallback
      - `compute_chain_greeks(chain_rows, spot, india_vix, expiry_dt)` — vectorised
    - Add `POST /analytics/greeks` endpoint to `ml-service/src/server.py`
    - _Requirements: 3.1, 3.2, 3.3, 3.6_

  - [x] 4.4 Wire greeks into /api/in/option-chain route
    - Extend `src/app/api/in/option-chain/route.ts` to call `POST /analytics/greeks` when ML service is available
    - Fall back to Angel One delta/gamma fields if call fails (no crash, no 5xx)
    - Add `iv_regime` field to response (null until Task 9 is implemented)
    - _Requirements: 3.4, 3.5, 9.6_

  - [ ]* 4.5 Write property test for Greeks sign invariants
    - **Property 5: Greeks sign invariants**
    - Use `hypothesis` to generate valid (spot, strike, t, sigma) combos; assert delta/gamma/theta/vega signs
    - **Validates: Requirements 3.1, 3.2**

- [x] 5. Dealer GEX engine + /api/in/gex + GEX Dashboard panel

  Create `gex.py` using the greeks from Task 4. Wire into a new API route and `gex-panel.tsx` component.

  - [x] 5.1 Write failing tests for the GEX engine
    - Create `ml-service/tests/test_gex.py`
    - Test: given all-positive gammas on CE side, aggregate GEX is negative (dealers short calls → negative)
    - Test: gamma flip is within `[min_strike, max_strike]` of the input chain
    - Test: `expected_move_pct > 0` for any valid chain snapshot
    - Test: `Σ gex_per_strike == aggregate_gex` to within 1e-6
    - Create `tests/api/gex.test.ts`
    - Test route returns `{ available: false }` (HTTP 200) when ML service mock throws
    - Create `tests/components/india/gex-panel.test.ts`
    - Test panel renders bar chart and shows gamma flip label
    - _Requirements: 4.1, 4.2, 4.3, 4.6, 4.7_

  - [x] 5.2 Implement gex.py and ML service endpoint
    - Create `ml-service/src/gex.py` implementing `compute_gex(chain_snapshot, spot, lot_size)`
    - Use LOT_SIZES dict: NIFTY=50, BANKNIFTY=15, FINNIFTY=40, MIDCPNIFTY=75
    - When gamma is absent, call `greeks.py` to compute it from Black-76
    - Add `POST /analytics/gex` endpoint to `server.py`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 5.3 Implement /api/in/gex route
    - Create `src/app/api/in/gex/route.ts`
    - Call ML service, cache 5 min in Redis
    - Return `{ available: false }` on any ML service failure
    - _Requirements: 4.5, 4.6_

  - [x] 5.4 Implement gex-panel.tsx component
    - Create `src/components/india/options/gex-panel.tsx`
    - Render a bar chart of per-strike GEX (green = positive, red = negative)
    - Highlight Gamma Flip level with a dashed horizontal line
    - Show subtitle: "Expected daily move: ±X% (±N pts)"
    - Wire into the `/in/options` page as a new "GEX" tab panel
    - _Requirements: 4.7_

  - [ ]* 5.5 Write property test for GEX aggregate consistency
    - **Property 6: GEX aggregate consistency**
    - Use `hypothesis` to generate random chain snapshots; assert `Σ per-strike gex == aggregate_gex` within 1e-6
    - **Validates: Requirements 4.1**

- [x] 6. 3D Implied Volatility Surface + IV Term Structure

  Create `vol_surface.py` using the IV solver from Task 4. Add `/api/in/vol-surface` route and `vol-surface.tsx` component.

  - [x] 6.1 Write failing tests for the IV surface
    - Create `ml-service/tests/test_vol_surface.py`
    - Test SVI fit produces no calendar spread arbitrage: ATM variance of near expiry ≤ far expiry
    - Test `compute_term_structure` returns expiries sorted ascending by days-to-expiry
    - Create `tests/api/vol-surface.test.ts`
    - Test route returns `{ available: false }` (HTTP 200) when ML service is down
    - Create `tests/components/india/vol-surface.test.ts`
    - Test component renders without crash and shows the correct number of expiry lines
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 6.2 Implement vol_surface.py and ML service endpoint
    - Create `ml-service/src/vol_surface.py`:
      - `build_iv_surface(snapshots_by_expiry)` — solve IV per strike using Task 4's Newton solver
      - `fit_svi(strikes, ivs, forward)` — `scipy.optimize.minimize` SVI fit (no QuantLib dependency)
      - `compute_term_structure(atm_ivs_by_expiry)` — sorted by days-to-expiry
    - Add `GET /analytics/vol-surface` endpoint to `server.py`
    - _Requirements: 5.1, 5.2_

  - [x] 6.3 Implement /api/in/vol-surface route and vol-surface.tsx component
    - Create `src/app/api/in/vol-surface/route.ts` (5-min Redis cache, `{ available: false }` on failure)
    - Create `src/components/india/options/vol-surface.tsx`:
      - 2D IV Smile chart (Recharts `LineChart`, one line per expiry, IV vs strike)
      - Term Structure area chart
      - 3D Surface `<canvas>` toggle with simple projection math
    - Wire into `/in/options` as a new "IV Surface" tab panel
    - _Requirements: 5.3, 5.4, 5.5_

  - [ ]* 6.4 Write property test for IV surface no-calendar-arbitrage
    - **Property 12: IV surface no-calendar-arbitrage**
    - Use `hypothesis` to generate multi-expiry IV snapshots; run SVI fit; assert ATM variance non-decreasing
    - **Validates: Requirements 5.1**

- [x] 7. Checkpoint — Options analytics layer complete
  - Ensure `ml-service/tests/test_greeks.py`, `test_gex.py`, `test_vol_surface.py` all pass. Run `npm run test:api` and `npm run test:components`. Ask the user if questions arise.

- [x] 8. TA-Lib vectorised feature engineering in the ML service

  Replace pure-Python indicator loops in `technical.py` with TA-Lib C-backed vectorised calls. Add candlestick pattern features.

  - [x] 8.1 Write failing Python tests for TA-Lib migration
    - Create `ml-service/tests/test_technical.py` (extend existing)
    - Test `talib.EMA(close, 20)` matches existing EMA implementation to within 1e-6 on 1000-bar synthetic series
    - Test `talib.RSI(close, 14)` matches existing RSI to within 0.01%
    - Test `talib.ATR(high, low, close, 14)` matches existing ATR to within 0.01%
    - Create `ml-service/tests/test_talib_perf.py`
    - Test scoring 100 stocks completes in < 1 second
    - _Requirements: 6.1, 6.4, 6.6_

  - [x] 8.2 Implement TA-Lib migration in technical.py
    - Update `ml-service/Dockerfile`: add `RUN apt-get install -y ta-lib`
    - Refactor `ml-service/src/features/technical.py`:
      - Replace RSI, MACD, ADX, ATR, BBANDS, EMA, STOCHRSI, CCI, MFI, OBV with `talib.*` calls
      - Add `talib.CDLENGULFING`, `talib.CDLHAMMER`, `talib.CDLDOJI` (binary features)
      - Add `talib.HT_TRENDLINE` deviation feature
    - Update `RANKING_FEATURES` in `stock_ranker.py` to include the 6 new candle pattern features + HT_TRENDLINE deviation
    - _Requirements: 6.1, 6.2, 6.3, 6.5_

  - [ ]* 8.3 Write property test for TA-Lib EMA equivalence
    - **Property 14: TA-Lib EMA equivalence**
    - Use `hypothesis` to generate price series ≥ 50 bars; compare `talib.EMA(close, 20)` to old EMA; assert within 1e-6
    - **Validates: Requirements 6.1, 6.6**

- [x] 9. VPIN toxic order flow indicator + order flow panel

  Extend `volume.py` with VPIN computation. Create `/api/in/order-flow` route and `order-flow-panel.tsx` component.

  - [x] 9.1 Write failing tests for VPIN
    - Create `ml-service/tests/test_vpin.py`
    - Test: all-buy bars → VPIN bucket value = 1.0
    - Test: exactly equal buy/sell → VPIN bucket value = 0.0
    - Test: alternating buy/sell → VPIN ≈ 0 (low toxicity)
    - Test: all VPIN values ∈ [0, 1] for any valid bar sequence
    - Create `tests/api/order-flow.test.ts`
    - Test route returns `{ available: false }` (HTTP 200) when ML service mock throws
    - Create `tests/components/india/order-flow-panel.test.ts`
    - Test panel renders gauge and sparkline; shows "Toxic" label when VPIN > 0.7
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7_

  - [x] 9.2 Implement VPIN in volume.py and ML service endpoint
    - Extend `ml-service/src/features/volume.py` with `compute_vpin(bars, bucket_size=50, n_buckets=50)`
    - Tick rule: close > prev_close → 85% buy; close < prev_close → 85% sell; equal → 50/50
    - Wire `vpin_score` as a new input feature into the Market Regime model (`market_regime.py`)
    - Add `GET /analytics/vpin?symbol=NIFTY` endpoint to `server.py`
    - _Requirements: 7.1, 7.2, 7.8_

  - [x] 9.3 Implement /api/in/order-flow route and order-flow-panel.tsx component
    - Create `src/app/api/in/order-flow/route.ts` (2-min Redis cache, `{ available: false }` on failure)
    - Create `src/components/india/dashboard/order-flow-panel.tsx`:
      - Horizontal gauge bar (red ≥ 0.7 = toxic, amber 0.3–0.7 = elevated, green < 0.3 = benign)
      - Sparkline of last 20 VPIN bucket values
      - "Toxic" / "Elevated" / "Benign" label
    - Place the panel on the India Overview dashboard between Range Expansion and Top 5 Stocks sections
    - _Requirements: 7.5, 7.6, 7.7_

  - [ ]* 9.4 Write property tests for VPIN invariants
    - **Property 7: VPIN bounds invariant** — `hypothesis` over bar sequences; all values ∈ [0, 1]
    - **Property 8: VPIN extreme cases** — all-buy bucket → 1.0; equal-split bucket → 0.0
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

- [x] 10. Deep-learning TFT price regime forecaster

  Install `darts==0.32.*`. Create `price_forecaster.py` with TFT model. Wire into `buildMLContext()` in `india-builder.ts`.

  - [x] 10.1 Write failing tests for the TFT forecaster
    - Create `ml-service/tests/test_price_forecaster.py`
    - Test model loads without error
    - Test model accepts 60-bar multivariate input and returns `{regime, probability, q10, q90}`
    - Test `probability ∈ [0, 1]`
    - Test regime is one of `"bull" | "bear" | "flat"`
    - Create `tests/features/india/india-builder.test.ts` (extend)
    - Test `buildMLContext()` includes `priceForecast` field
    - Test when TFT regime disagrees with heuristic direction, AI signal confidence changes by ±0.05
    - _Requirements: 8.1, 8.2, 8.3, 8.5_

  - [x] 10.2 Implement price_forecaster.py and ML service endpoint
    - `pip install darts==0.32.*` (add to `ml-service/requirements.txt`)
    - Create `ml-service/src/price_forecaster.py`:
      - `TFTModel(input_chunk_length=60, output_chunk_length=12, hidden_size=64, num_heads=4)`
      - Input: OHLCV + VPIN + ATM IV + PCR + OI build-up (5 hours of 5-min bars)
      - Output: `{regime, probability, q10, q90}`
    - Add `POST /predict/price-regime` endpoint to `server.py`
    - Update `data_pipeline.py` to fetch 2 years of 5-min NIFTY bars via yfinance → `nifty_5m.npz`
    - _Requirements: 8.1, 8.2, 8.4, 8.7_

  - [x] 10.3 Wire TFT forecast into india-builder.ts
    - Extend `buildMLContext()` in `src/features/ai-signals/india-builder.ts` to call `/predict/price-regime`
    - Apply ±0.05 confidence delta to `sessionQuality` factor when TFT regime aligns or opposes heuristic direction
    - Show TFT Forecast chip on `/in/ai-signals` banner (grey when ML service offline)
    - _Requirements: 8.5, 8.6_

- [x] 11. IV Regime Classifier — PatchTST

  Install `tsai==1.0.*`. Create `iv_regime_classifier.py`. Wire into `/api/in/option-chain` and AI engine.

  - [x] 11.1 Write failing tests for the IV classifier
    - Create `ml-service/tests/test_iv_classifier.py`
    - Test model loads without error
    - Test model accepts 5×20 input shape
    - Test output is one of `CRUSH | STABLE | SPIKE`
    - Extend `tests/api/option-chain.test.ts`
    - Test route returns `iv_regime` field (may be null when model untrained)
    - Create `tests/components/india/iv-regime-badge.test.ts`
    - Test badge shows "Crush" in green when `iv_regime == "CRUSH"`
    - Test badge shows "Spike" in red when `iv_regime == "SPIKE"`
    - _Requirements: 9.1, 9.6, 9.8_

  - [x] 11.2 Implement iv_regime_classifier.py and ML service endpoint
    - `pip install tsai==1.0.*` (add to `ml-service/requirements.txt`)
    - Create `ml-service/src/iv_regime_classifier.py`:
      - Input: 20 days × 5 features (`atm_iv`, `pcr`, `oi_change`, `vix`, `spot_change`)
      - Model: `PatchTST(n_layers=3, d_model=128, n_heads=4, patch_len=5)`
      - Labels: CRUSH / STABLE / SPIKE
    - Add `POST /predict/iv-regime` endpoint to `server.py`
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 11.3 Wire IV classifier into option chain and AI engine
    - Extend `/api/in/option-chain` to include `iv_regime` field from `/predict/iv-regime` (null when unavailable)
    - Extend `india-builder.ts` India AI engine: boost IV factor weight on CRUSH, penalise on SPIKE (±0.05 delta)
    - Add `iv-regime-badge.tsx` component on the `/in/options` page above the chain table
    - _Requirements: 9.4, 9.5, 9.6, 9.7, 9.8_

- [x] 12. Upgrade portfolio optimizer to Riskfolio-Lib

  Replace PyPortfolioOpt HRP with Riskfolio-Lib. Add CVaR, max diversification, and factor allocation methods. Create `/in/portfolio` page.

  - [x] 12.1 Write failing tests for the portfolio optimizer
    - Create `ml-service/tests/test_portfolio_optimizer.py` (extend existing)
    - Test HRP weights sum to 1.0 within 1e-6 and all weights ≥ 0
    - Test CVaR weights sum to 1.0 within 1e-6 and all weights ≥ 0
    - Test CVaR portfolio CVaR < HRP portfolio CVaR for the same return series
    - Create `tests/api/portfolio.test.ts`
    - Test route accepts symbols + method, returns valid `PortfolioAllocation` shape
    - Test route returns `{ available: false }` (HTTP 200) when ML service mock throws
    - Create `tests/pages/india/portfolio.test.ts`
    - Test page renders without crash
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6, 10.7_

  - [x] 12.2 Implement Riskfolio-Lib portfolio optimizer
    - `pip install Riskfolio-Lib==6.*` (add to `ml-service/requirements.txt`; keep PyPortfolioOpt as fallback)
    - Refactor `ml-service/src/models/portfolio_optimizer.py`:
      - `hrp_allocation(returns)` — via Riskfolio-Lib
      - `cvar_allocation(returns, alpha=0.05)` — CVaR-constrained MVO
      - `max_diversification(returns)` — maximum diversification portfolio
      - `factor_allocation(returns, factor_returns)` — NIFTY beta-neutral
    - All methods return `{weights: dict, risk_metrics: {volatility, cvar, sharpe, max_dd}}`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 12.3 Implement /api/in/portfolio-optimizer route and /in/portfolio page
    - Create `src/app/api/in/portfolio-optimizer/route.ts` (`{ available: false }` on ML service failure)
    - Create `src/app/(dashboard)/in/portfolio/page.tsx`:
      - Symbol multi-select from F&O universe
      - Method selector (HRP / CVaR / Max Diversification / Factor)
      - Efficient frontier Recharts scatter chart (risk vs return)
      - Allocation pie chart
      - Risk metrics table (Sharpe, CVaR, Max Drawdown, Volatility)
    - _Requirements: 10.5, 10.6, 10.7_

  - [ ]* 12.4 Write property test for portfolio weights sum-to-one
    - **Property 10: Portfolio weights sum-to-one**
    - Use `hypothesis` to generate return series; assert weights sum to 1.0 ± 1e-6 and all weights ≥ 0 for all methods
    - **Validates: Requirements 10.1, 10.2**

- [x] 13. Checkpoint — ML deep-learning and portfolio layer complete
  - Run `ml-service/tests/` pytest suite and `npm run test:api`. Ensure all forecaster and portfolio tests pass. Ask the user if questions arise.

- [x] 14. Options strategy workbench — payoff diagrams + multi-leg builder

  Pure TypeScript payoff engine. New `/in/options-workbench` page with Recharts payoff diagrams and live chain integration.

  - [x] 14.1 Write failing tests for the payoff engine
    - Create `tests/features/india/options-workbench/payoff.test.ts`
    - Test Long Call payoff at expiry = `max(0, S − K) − premium` for 20 spot values
    - Test Short Call payoff at expiry = `premium − max(0, S − K)` for 20 spot values
    - Test Straddle max loss = `−(call_premium + put_premium)` at ATM (exact)
    - Test Iron Condor payoff at centre = net credit received (exact)
    - Test Long Put payoff at expiry = `max(0, K − S) − premium` for 20 spot values
    - Test Bull Call Spread: max profit = `(K_long − K_short) − net_debit`; max loss = net_debit
    - Test break-even count: Long Call → 1, Straddle → 2, Iron Condor → 2
    - Create `tests/features/india/options-workbench/greeks-aggregator.test.ts`
    - Test that net delta of a delta-neutral Long/Short leg combination is ≈ 0 (within 0.05)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 14.2 Implement payoff engine and greeks aggregator
    - Create `src/features/india/options-workbench/payoff.ts`:
      - `computePayoff(legs, spotRange, currentGreeks): StrategyAnalysis`
      - Payoff at expiry: `leg.quantity × (intrinsic − leg.premium)` per leg
      - Payoff today: `leg.quantity × (bsPrice(spot, leg) − leg.premium)` per leg
      - Break-evens: spots where expiry payoff crosses zero (linear interpolation)
    - Create `src/features/india/options-workbench/strategies.ts`:
      - Predefined leg templates for all 12 strategies (Long/Short Call, Long/Short Put, Bull/Bear Call Spread, Iron Condor, Straddle, Strangle, Butterfly, Jade Lizard)
    - Create `src/features/india/options-workbench/greeks-aggregator.ts`
    - Create `src/features/india/options-workbench/engine.ts` combining payoff + greeks into `StrategyAnalysis`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_

  - [x] 14.3 Implement /in/options-workbench page
    - Create `src/app/(dashboard)/in/options-workbench/page.tsx`:
      - Strategy picker dropdown + custom leg builder
      - ATM auto-populate from `/api/in/option-chain`
      - Recharts `LineChart` with two series: payoff at expiry + payoff today
      - Net greeks display (portfolio delta, gamma, theta, vega)
      - Break-even annotations
      - "Scan for best strikes" button (calls chain API, filters by GEX expected move)
    - Add "Options Workbench" to the India sidebar nav
    - _Requirements: 11.7, 11.8_

  - [ ]* 14.4 Write property tests for payoff correctness
    - **Property 9: Payoff at expiry correctness**
    - Use `fast-check` to generate (strike, premium, spot) combos; verify Long Call, Straddle, Iron Condor formulas hold exactly
    - **Validates: Requirements 11.1, 11.2, 11.3**

- [x] 15. OpenAlgo-compatible broker adapter + live order execution scaffold

  Implement `OpenAlgoAdapter` implementing `MarketBroker`. Complete Angel One live order scaffold. Add confirmation modal and Profile live trading tab.

  - [x] 15.1 Write failing tests for the OpenAlgo adapter
    - Create `tests/services/india/openalgo-adapter.test.ts`
    - Mock HTTP responses for quotes/historical/order endpoints
    - Test quote response is normalised to `Quote` shape (all required fields present)
    - Test historical response is normalised to `OHLCV[]` shape
    - Test order response is normalised to `OrderResult` shape
    - Test that `placeOrder()` throws when `LIVE_TRADING_ENABLED` is not set to `"true"` and makes zero outbound HTTP calls
    - Test that `placeOrder()` makes exactly one POST request when `LIVE_TRADING_ENABLED=true`
    - Create `tests/components/india/live-order-modal.test.ts`
    - Test modal renders signal details and paper-trade win rate
    - Test "Place Real Order" button is disabled until user confirms
    - Test warning is shown when strategy win rate < 50%
    - _Requirements: 12.1, 12.2, 12.3, 12.5, 12.6_

  - [x] 15.2 Implement OpenAlgo adapter
    - Create `src/services/india/broker/openalgo-adapter.ts` implementing `MarketBroker`:
      - `getQuote(symbol)` → `GET {OPENALGO_BASE_URL}/api/v1/quotes`
      - `getHistorical(symbol, interval, from, to)` → `GET /api/v1/historical`
      - `placeOrder(params)` → `POST /api/v1/placeorder` (throws if `LIVE_TRADING_ENABLED !== "true"`)
      - Auth: `X-Api-Key: {decrypted OPENALGO_API_KEY}` header
    - Register adapter in `src/services/india/broker/registry.ts` under `INDIA_BROKER=openalgo`
    - Store `OPENALGO_API_KEY` encrypted at rest via `src/lib/crypto.ts` AES-256-GCM path
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 15.3 Implement order confirmation modal and live trading UI
    - Create `src/components/india/paper-trading/live-order-modal.tsx`:
      - Signal details, current paper-trade win rate for the strategy
      - Warning banner when win rate < 50%
      - Explicit double-confirm "Place Real Order" button
    - Add "Go Live" button to each strategy row on `/in/paper-trading` (only when `LIVE_TRADING_ENABLED=true` and `INDIA_BROKER=openalgo`)
    - Add "Live Trading" tab to the India Profile page showing broker connection status, account balance, open order book
    - _Requirements: 12.5, 12.6, 12.7, 12.8_

  - [ ]* 15.4 Write property test for live trading guard
    - **Property 11: Live trading guard**
    - Use `fast-check` to generate any `OrderParams`; assert that when `LIVE_TRADING_ENABLED` is absent, `placeOrder` always throws and makes zero HTTP calls
    - **Validates: Requirements 12.3, 12.8**

  - [ ]* 15.5 Write property test for OpenAlgo response normalisation
    - **Property 15: OpenAlgo response normalisation**
    - Use `fast-check` to generate arbitrary valid broker response objects; assert all normalised fields conform to the `MarketBroker` contract types
    - **Validates: Requirements 12.1, 12.2**

- [x] 16. Verify graceful degradation universality
  - Write `tests/api/graceful-degradation.test.ts` covering all new Phase 2 routes (`/api/in/gex`, `/api/in/vol-surface`, `/api/in/order-flow`, `/api/in/portfolio-optimizer`)
  - For each route: mock the ML service to throw a network error; assert HTTP 200 with `{ available: false }` and no 5xx
  - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [ ]* 16.1 Write property test for graceful degradation universality
    - **Property 13: Graceful degradation universality**
    - Parameterise over the four new routes; for each failure mode (connection refused, timeout, 500), assert HTTP 200 + `available: false`
    - **Validates: Requirements 3.5, 4.6, 5.4, 7.6, 13.1**

- [x] 17. Final checkpoint — complete spec integration
  - Run `npm test` (full Vitest suite) — must be green
  - Run `npm run typecheck` — zero TypeScript errors
  - Run `ml-service/tests/` pytest suite — all tests pass
  - Run `npm run lint` — no lint errors
  - Ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Core property tests are strongly recommended.
- All new Python packages must be pinned to exact versions: `mibian==0.1.3`, `darts==0.32.*`, `tsai==1.0.*`, `TA-Lib==0.6.*`, `Riskfolio-Lib==6.*`
- TypeScript: `@debut/indicators` must be pinned at an exact version after install
- **TDD is mandatory**: write failing tests in the `1.x` sub-task of each feature group _before_ writing the implementation in `1.2`, etc.
- Read `node_modules/next/dist/docs/` before writing any lightweight-charts v5 plugin code (Task 2)
- All new API routes are Auth.js protected (inherit from the existing `src/proxy.ts` gate)
- The `LIVE_TRADING_ENABLED=true` env var must be explicitly set — it is not present in `.env.example` by default

---

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1", "4.2", "8.1", "9.1", "12.1"] },
    { "id": 1, "tasks": ["1.2", "4.3"] },
    { "id": 2, "tasks": ["1.3", "2.1", "4.4", "5.1", "6.1", "8.2", "9.2"] },
    { "id": 3, "tasks": ["1.4", "1.5", "1.6", "2.2", "5.2", "6.2", "8.3", "9.3", "9.4", "10.1", "11.1", "14.1"] },
    { "id": 4, "tasks": ["2.3", "5.3", "5.4", "6.3", "10.2", "11.2", "12.2"] },
    { "id": 5, "tasks": ["2.4", "2.5", "5.5", "6.4", "10.3", "11.3", "12.3", "12.4"] },
    { "id": 6, "tasks": ["14.2", "15.1"] },
    { "id": 7, "tasks": ["14.3", "14.4", "15.2", "16.1"] },
    { "id": 8, "tasks": ["15.3", "15.4", "15.5"] }
  ]
}
```
