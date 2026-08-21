# Requirements Document

## Introduction

Phase 2 Expert Quant upgrades Alphaforge from "advanced retail" to "expert quant / prop desk" level for the Indian F&O market. It introduces streaming technical indicators, institutional chart plugins, real options analytics (greeks, GEX, IV surface), deep-learning forecasters, a VPIN order-flow indicator, an upgraded portfolio optimizer, an options strategy workbench, and an OpenAlgo-compatible live order adapter. All additions are strictly additive — no existing route, store, or worker job is modified in a breaking way, and every new capability degrades gracefully when the backing service is absent.

---

## Glossary

- **Alphaforge**: The Next.js 16 + Python FastAPI trading desk application.
- **Indicator_Adapter**: The `src/features/indicators/` TypeScript module that wraps `@debut/indicators` streaming classes.
- **Chart_Plugin**: A lightweight-charts v5 `IChartSeriesPlugin` implementation (Anchored VWAP or Volume Profile).
- **Greeks_Engine**: The `ml-service/src/greeks.py` Python module that computes Black-Scholes / Black-76 greeks and solves IV.
- **GEX_Engine**: The `ml-service/src/gex.py` Python module that computes Dealer Gamma Exposure.
- **Vol_Surface**: The `ml-service/src/vol_surface.py` Python module that fits an SVI implied-volatility surface.
- **VPIN_Engine**: The VPIN computation in `ml-service/src/volume.py`.
- **TFT_Forecaster**: The `ml-service/src/price_forecaster.py` Temporal Fusion Transformer model.
- **IV_Classifier**: The `ml-service/src/iv_regime_classifier.py` PatchTST model.
- **Portfolio_Optimizer**: The `ml-service/src/portfolio_optimizer.py` Riskfolio-Lib–backed module.
- **Workbench_Engine**: The `src/features/india/options-workbench/` TypeScript payoff engine.
- **OpenAlgo_Adapter**: The `src/services/india/broker/openalgo-adapter.ts` MarketBroker implementation.
- **ML_Service**: The Python FastAPI microservice running on port 8100.
- **NSE**: National Stock Exchange of India.
- **Black-76**: Options pricing model for European futures/index options.
- **Black-Scholes**: Options pricing model for European equity options.
- **GEX**: Dealer Gamma Exposure — the aggregate gamma position of market makers.
- **SVI**: Stochastic Volatility Inspired parametrisation for volatility surfaces.
- **VPIN**: Volume-synchronized Probability of Informed Trading.
- **TFT**: Temporal Fusion Transformer deep-learning forecasting model.
- **PatchTST**: Patch Time Series Transformer for classification tasks.
- **POC**: Point of Control — the price level with the highest traded volume in a session.
- **VAH**: Value Area High — upper boundary of the volume value area.
- **VAL**: Value Area Low — lower boundary of the volume value area.
- **HLC3**: (High + Low + Close) / 3 — typical price.
- **ATR**: Average True Range.
- **VWAP**: Volume-Weighted Average Price.

---

## Requirements

---

### Requirement 1: Streaming Indicator Library Migration

**User Story:** As an NSE F&O trader, I want the signal engine to use a battle-tested streaming indicator library, so that the indicators are accurate, fast, and can resume after a worker restart without recomputing history from scratch.

#### Acceptance Criteria

1. THE Indicator_Adapter SHALL replace the EMA, ATR, RSI, and Bollinger Bands implementations in `src/features/scalping/helpers.ts` with `@debut/indicators` streaming classes, producing output that matches the existing implementations to within 0.01% on any OHLCV series.
2. THE Indicator_Adapter SHALL add a `VolumeProfile` output (POC, VAH, VAL per session) with `tickSize` calibrated per NSE instrument (0.05 for stocks, 1 for NIFTY, 5 for BANKNIFTY).
3. THE Indicator_Adapter SHALL add a `SuperTrend` output (period=10, multiplier=3) as an additional indicator signal.
4. THE Indicator_Adapter SHALL expose `dumpState()` and `restoreState()` functions that serialise and restore complete indicator state for Redis persistence.
5. WHEN the worker restarts and restores indicator state from Redis, THE Indicator_Adapter SHALL produce output identical to a continuous run for all bars fed after restoration.
6. WHEN the worker restarts with a valid Redis state, THE Indicator_Adapter SHALL complete warm-up in 5 or fewer bars.
7. WHEN existing strategy tests in `tests/features/` are run after the migration, THE System SHALL pass all pre-existing tests without modification.

---

### Requirement 2: Lightweight-Charts v5 Chart Plugins

**User Story:** As an NSE F&O desk trader, I want Anchored VWAP and Volume Profile overlays on the price chart, so that I can see the same institutional reference levels that every prop desk uses.

#### Acceptance Criteria

1. THE Chart_Plugin for Anchored VWAP SHALL accumulate `Σ(HLC3 × volume) / Σvolume` from each of three anchor bars: the session open (09:15 IST), the daily open, and the weekly open, and render each as a distinct `LineSeries` overlay on the price chart.
2. THE Chart_Plugin for Volume Profile SHALL render the POC as an orange horizontal line and VAH/VAL as dashed horizontal lines, using the `VolumeProfile` output from the Indicator_Adapter.
3. WHEN the VWAP toolbar toggle is activated, THE Chart_Plugin SHALL display three VWAP lines (session, daily, weekly) on the chart simultaneously.
4. WHEN the Volume Profile toolbar toggle is activated, THE Chart_Plugin SHALL display the POC, VAH, and VAL horizontal lines on the chart.
5. WHEN the active chart timeframe changes, THE Chart_Plugin state SHALL persist across the timeframe change without destroying or recreating the chart instance.
6. THE Chart_Plugin SHALL re-apply colour options using `useTheme()` whenever the application theme toggles between light and dark.

---

### Requirement 3: Real Black-Scholes / Black-76 Greeks on the Option Chain

**User Story:** As an options trader, I want accurate per-strike greeks and implied volatility computed from live LTP, so that I can assess risk precisely rather than relying on synthesised or missing values.

#### Acceptance Criteria

1. THE Greeks_Engine SHALL compute delta, gamma, theta, vega, and rho for every strike using Black-76 for index options (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) and Black-Scholes for stock options.
2. THE Greeks_Engine SHALL solve implied volatility from market LTP using Newton-Raphson iteration with a `scipy.optimize.brentq` fallback for non-converging cases.
3. THE Greeks_Engine SHALL use the Indian 10-year G-Sec yield (~7.1%) as the risk-free rate and `trading_days_to_expiry / 252` as the time-to-expiry.
4. WHEN the ML_Service is reachable, THE `/api/in/option-chain` route SHALL call `POST /analytics/greeks` and return enriched greeks alongside the chain payload.
5. IF the ML_Service is unreachable, THEN THE `/api/in/option-chain` route SHALL return the chain using Angel One delta/gamma fallback fields without crashing or returning a 5xx error.
6. THE Greeks_Engine SHALL expose a `POST /analytics/greeks` endpoint on the ML_Service accepting a chain snapshot JSON body.

---

### Requirement 4: Dealer GEX Engine and Dashboard Panel

**User Story:** As a prop desk trader, I want to see Dealer Gamma Exposure by strike, so that I can identify where dealers are forced to hedge and anticipate whether the market will stabilise or trend.

#### Acceptance Criteria

1. THE GEX_Engine SHALL compute per-strike GEX as `gamma × OI × lot_size × spot²`, adding CE exposure and subtracting PE exposure, using the canonical NSE lot sizes (NIFTY=50, BANKNIFTY=15, FINNIFTY=40, MIDCPNIFTY=75).
2. THE GEX_Engine SHALL compute the Gamma Flip strike as the strike where the cumulative sum of per-strike GEX crosses zero.
3. THE GEX_Engine SHALL compute an expected daily move percentage from aggregate GEX.
4. WHEN gamma is unavailable from Angel One, THE GEX_Engine SHALL approximate gamma using the Greeks_Engine from Requirement 3.
5. THE `/api/in/gex` route SHALL cache GEX results in Redis for 5 minutes.
6. IF the ML_Service is unreachable, THEN THE `/api/in/gex` route SHALL return `{ available: false, reason: "ML service unreachable" }` with HTTP 200.
7. THE `gex-panel.tsx` component SHALL render a bar chart of per-strike GEX (green for positive/stabilising, red for negative/destabilising) with the Gamma Flip level highlighted and an expected daily move subtitle.

---

### Requirement 5: 3D Implied Volatility Surface and Term Structure

**User Story:** As an options trader, I want to see the full IV surface across strikes and expiries, so that I can identify vol smile shape, term structure, and arbitrage opportunities.

#### Acceptance Criteria

1. THE Vol_Surface SHALL fit an SVI parametrisation to each expiry's IV smile using `scipy.optimize.minimize`, producing a surface that is free of calendar spread arbitrage (variance non-decreasing in time).
2. THE Vol_Surface SHALL compute the vol term structure as ATM IV per expiry, sorted ascending by days-to-expiry.
3. THE `/api/in/vol-surface` route SHALL expose `GET /api/in/vol-surface?symbol=NIFTY` returning `VolSurfaceResponse` with per-expiry IV arrays, SVI parameters, and term structure.
4. IF the ML_Service is unreachable, THEN THE `/api/in/vol-surface` route SHALL return `{ available: false, reason: "ML service unreachable" }` with HTTP 200.
5. THE `vol-surface.tsx` component SHALL render an IV Smile 2D chart (one line per expiry), a Term Structure area chart, and a 3D Surface canvas toggle using a plain `<canvas>` with projection math.

---

### Requirement 6: TA-Lib Vectorised Feature Engineering

**User Story:** As a quant, I want the ML service's feature engineering to use vectorised C-backed indicator computations, so that batch scoring 200+ F&O stocks completes fast enough for real-time use on every tick.

#### Acceptance Criteria

1. THE System SHALL replace the pure-Python RSI, MACD, ADX, ATR, Bollinger Bands, EMA, StochRSI, CCI, MFI, and OBV loops in `ml-service/src/features/technical.py` with `talib.*` vectorised calls accepting numpy arrays.
2. THE System SHALL add candlestick pattern features `CDLENGULFING`, `CDLHAMMER`, and `CDLDOJI` (binary 0/1 per bar) and `HT_TRENDLINE` deviation to the feature set.
3. THE System SHALL add the six new candlestick pattern features and HT_TRENDLINE deviation to the `RANKING_FEATURES` list in `stock_ranker.py`.
4. WHEN batch-scoring 100 stocks, THE System SHALL complete feature engineering in less than 1 second.
5. THE System SHALL install the TA-Lib C library in the ML service Dockerfile via `apt-get install -y ta-lib`.
6. WHEN TA-Lib EMA(20) is run on a 1000-bar series, THE System SHALL produce output matching the existing EMA implementation to within 1e-6.

---

### Requirement 7: VPIN Toxic Order Flow Indicator

**User Story:** As an NSE F&O trader, I want to see a live VPIN (order flow toxicity) gauge on the dashboard, so that I can detect when informed institutional flow is present and adjust my strategy accordingly.

#### Acceptance Criteria

1. THE VPIN_Engine SHALL compute VPIN by classifying each 5-min bar's volume into buy/sell fractions using the tick rule (close > prev_close → 85% buy; close < prev_close → 85% sell; unchanged → 50/50), accumulating into fixed-size volume buckets, and computing `mean(|buy_vol − sell_vol| / bucket_size)` over the last 50 buckets.
2. THE VPIN_Engine SHALL return all VPIN values in the closed interval [0, 1].
3. WHEN all volume in a bucket is classified as buy, THE VPIN_Engine SHALL return a bucket VPIN of 1.0.
4. WHEN buy and sell classified volume in a bucket are equal, THE VPIN_Engine SHALL return a bucket VPIN of 0.0.
5. THE `/api/in/order-flow` route SHALL expose `GET /api/in/order-flow?symbol=NIFTY` cached for 2 minutes in Redis.
6. IF the ML_Service is unreachable, THEN THE `/api/in/order-flow` route SHALL return `{ available: false, reason: "ML service unreachable" }` with HTTP 200.
7. THE `order-flow-panel.tsx` component SHALL render a horizontal VPIN gauge (red = toxic ≥ 0.7, green = benign ≤ 0.3) with a sparkline of the last 20 bucket values and SHALL display the label "Toxic" when VPIN > 0.7.
8. THE VPIN_Engine output SHALL wire into the Market Regime model as a new `vpin_score` input feature.

---

### Requirement 8: Deep-Learning TFT Price Regime Forecaster

**User Story:** As an NSE F&O trader, I want a probabilistic 1-hour ahead price regime forecast shown on AI Signals, so that I can see whether the ML model agrees with the heuristic direction before taking a trade.

#### Acceptance Criteria

1. THE TFT_Forecaster SHALL accept a multivariate input of the last 60 × 5-min bars including OHLCV, VPIN, ATM IV, PCR, and OI build-up (5 history hours) and forecast the 1-hour ahead NIFTY/BANKNIFTY regime.
2. THE TFT_Forecaster SHALL use `darts.models.TFTModel` with `input_chunk_length=60`, `output_chunk_length=12`, `hidden_size=64`, and `num_heads=4`.
3. THE TFT_Forecaster SHALL return `{ regime: "bull" | "bear" | "flat", probability: float, q10: float, q90: float }` where `probability` ∈ [0, 1].
4. THE TFT_Forecaster SHALL expose a `POST /predict/price-regime` endpoint on the ML_Service.
5. WHEN the `buildMLContext()` function in `india-builder.ts` receives a TFT forecast whose regime disagrees with the heuristic direction, THE System SHALL apply a ±0.05 confidence delta to the AI signal.
6. WHEN the ML_Service is offline, THE AI Signals page SHALL display the TFT Forecast chip as grey/absent without throwing an error.
7. THE training data pipeline SHALL fetch 2 years of 5-min NIFTY bars via the Python yfinance client and save to `nifty_5m.npz`.

---

### Requirement 9: IV Regime Classifier (PatchTST)

**User Story:** As an options seller, I want to know whether IV is predicted to crush or spike in the next session, so that I can time straddle entries and avoid buying premium before a vol collapse.

#### Acceptance Criteria

1. THE IV_Classifier SHALL accept the last 20 days of daily `{ atm_iv, pcr, oi_change, vix, spot_change }` (5 features × 20 days) as input.
2. THE IV_Classifier SHALL use `tsai.models.PatchTST` with `n_layers=3`, `d_model=128`, `n_heads=4`, `patch_len=5` and output one of three classes: `CRUSH`, `STABLE`, or `SPIKE`.
3. THE IV_Classifier SHALL expose a `POST /predict/iv-regime` endpoint on the ML_Service.
4. WHEN `iv_regime == CRUSH`, THE India AI engine SHALL boost the IV factor confidence weight (sellers have edge).
5. WHEN `iv_regime == SPIKE`, THE India AI engine SHALL penalise the IV factor confidence weight (buyers have edge).
6. THE `/api/in/option-chain` route SHALL include an `iv_regime` field (which MAY be null when the model is untrained).
7. IF the ML_Service is unreachable, THEN THE `/api/in/option-chain` route SHALL return `iv_regime: null` without crashing.
8. THE `iv-regime-badge.tsx` component SHALL display "Crush" in green and "Spike" in red on the options page.

---

### Requirement 10: Riskfolio-Lib Portfolio Optimizer

**User Story:** As a quant portfolio manager, I want a production-grade portfolio optimizer with CVaR, maximum diversification, and factor model support, so that I can construct institutional-quality NSE F&O allocations beyond simple HRP.

#### Acceptance Criteria

1. THE Portfolio_Optimizer SHALL support four allocation methods: HRP (Hierarchical Risk Parity), CVaR-constrained MVO (alpha=0.05), Maximum Diversification, and Factor (NIFTY beta-neutral).
2. FOR ALL supported methods, THE Portfolio_Optimizer SHALL return weights that sum to exactly 1.0 (within 1e-6) with all individual weights ≥ 0.
3. THE Portfolio_Optimizer SHALL return risk metrics including volatility, CVaR, Sharpe ratio, and maximum drawdown alongside the weights.
4. THE CVaR method SHALL produce a lower portfolio CVaR than the HRP method when run on the same return series.
5. THE `/api/in/portfolio-optimizer` route SHALL accept symbol list and method, call the ML_Service, and return a `PortfolioAllocation` response.
6. IF the ML_Service is unreachable, THEN THE `/api/in/portfolio-optimizer` route SHALL return `{ available: false, reason: "ML service unreachable" }` with HTTP 200.
7. THE portfolio page at `/in/portfolio` SHALL render a symbol multi-select, method selector, efficient frontier scatter chart, allocation pie chart, and risk metrics table.

---

### Requirement 11: Options Strategy Workbench

**User Story:** As an NSE F&O options trader, I want a payoff diagram builder for multi-leg strategies, so that I can visualise risk/reward, break-even points, and net greeks before placing any trade.

#### Acceptance Criteria

1. THE Workbench_Engine SHALL compute the payoff at expiry for a Long Call as `max(0, S − K) − premium` for every spot price `S` in the provided range.
2. THE Workbench_Engine SHALL compute the maximum loss of a Straddle as `−(call_premium + put_premium)`, achieved at the ATM strike.
3. THE Workbench_Engine SHALL compute the payoff of an Iron Condor at the centre (between short strikes) as the net credit received.
4. THE Workbench_Engine SHALL support all twelve predefined strategies: Long Call, Short Call, Long Put, Short Put, Bull Call Spread, Bear Call Spread, Iron Condor, Straddle, Strangle, Butterfly, Jade Lizard, and custom multi-leg.
5. THE Workbench_Engine SHALL compute break-even points as spot prices where the expiry payoff crosses zero.
6. THE Workbench_Engine SHALL aggregate net greeks (delta, gamma, theta, vega) across all legs using the real greeks from Requirement 3.
7. WHEN the "Scan for best strikes" action is triggered, THE System SHALL scan the live chain from `/api/in/option-chain` and suggest leg strikes that maximise the profit zone relative to the GEX-implied expected move from Requirement 4.
8. THE `/in/options-workbench` page SHALL render a strategy picker, ATM auto-populate from the live chain, a payoff diagram using Recharts `LineChart` (payoff at expiry + payoff today), net greeks display, and break-even annotations.

---

### Requirement 12: OpenAlgo-Compatible Broker Adapter and Live Order Execution

**User Story:** As a live trader using any OpenAlgo-compatible Indian broker, I want to connect Alphaforge to my broker via a single env var, so that I can route live orders from the paper-trading signals I trust without switching applications.

#### Acceptance Criteria

1. THE OpenAlgo_Adapter SHALL implement the `MarketBroker` contract with `getQuote()`, `getHistorical()`, `placeOrder()`, `modifyOrder()`, and `cancelOrder()` methods, normalising responses to the existing Alphaforge broker shape.
2. WHEN `INDIA_BROKER=openalgo` is set, THE System SHALL route all market data and order calls through the OpenAlgo_Adapter using `OPENALGO_BASE_URL` and `OPENALGO_API_KEY`.
3. IF `LIVE_TRADING_ENABLED` is not set to `"true"`, THEN THE OpenAlgo_Adapter `placeOrder()` method SHALL throw an error without making any outbound HTTP request.
4. THE `OPENALGO_API_KEY` SHALL be stored encrypted at rest using the existing AES-256-GCM path in `src/lib/crypto.ts`, following the same pattern as Angel One keys.
5. WHEN a user initiates a live order from the paper-trading page, THE System SHALL present an order confirmation modal displaying signal details and the strategy's current paper-trade win rate before the order is placed.
6. WHEN a strategy's paper-trade win rate is below 50%, THE System SHALL surface a warning in the order confirmation modal before allowing the live order.
7. THE Profile page SHALL add a "Live Trading" tab showing broker connection status, account balance, and open order book.
8. THE System SHALL expose `placeOrder`, `modifyOrder`, and `cancelOrder` only to authenticated users and only when `LIVE_TRADING_ENABLED=true`.

---

### Requirement 13: Graceful Degradation

**User Story:** As an Alphaforge user without the ML service running, I want all existing features to continue working, so that my trading workflow is not interrupted when optional services are absent.

#### Acceptance Criteria

1. FOR ALL new Phase 2 API routes (`/api/in/gex`, `/api/in/vol-surface`, `/api/in/order-flow`, `/api/in/portfolio-optimizer`), WHEN the ML_Service is unreachable, THE System SHALL return HTTP 200 with `{ available: false, reason: string }` rather than a 5xx error.
2. THE System SHALL NOT modify any existing API route handler in a breaking way — all existing request/response contracts SHALL remain unchanged.
3. THE System SHALL NOT add mandatory dependencies to existing workers or jobs — all Phase 2 features SHALL be independently opt-in.
4. WHEN any Phase 2 UI component receives `data.available === false`, THE System SHALL render an `<UnavailableBadge>` placeholder without crashing or throwing a React error.

---

### Requirement 14: Test-Driven Development Compliance

**User Story:** As a developer maintaining Alphaforge, I want every Phase 2 feature to ship with complete test coverage, so that regressions are caught automatically and the TDD policy is enforced.

#### Acceptance Criteria

1. FOR ALL TypeScript changes, THE System SHALL include failing Vitest tests in the relevant `tests/` subdirectory written before the implementation, following the mandatory TDD workflow in `README.md`.
2. FOR ALL Python changes in `ml-service/src/`, THE System SHALL include `pytest` test files in `ml-service/tests/` written before the implementation.
3. WHEN `npm test` is run after all Phase 2 tasks are complete, THE System SHALL pass the full Vitest suite with no failing tests.
4. WHEN `npm run typecheck` is run, THE System SHALL produce zero TypeScript errors.
5. THE System SHALL NOT use `it.skip` or `describe.skip` in any new test without a TODO comment referencing the relevant issue.
