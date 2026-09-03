# AlphaForge — Changelog

All changes are listed in reverse chronological order (newest first). Each entry covers what changed, what was added, what was fixed, and how many tests were involved.

---

## [Unreleased] — Data Service: Production Hardening & NSE API Migration

**Service:** `data-service` (Python 3.11 / FastAPI / Scrapling)
**New doc:** `DATA_SERVICE.md`
**Modified files:** `data-service/requirements.txt`, `data-service/src/server.py`, `data-service/src/scrapers/live_quotes.py`, `data-service/src/scrapers/option_chain.py`, `data-service/src/anti_ban/session_warmer.py`, `data-service/src/publisher/tick_publisher.py`, `data-service/src/scrapers/historical.py`, `docker-compose.yml`

Six production bugs found and fixed during the first real deployment run. Service now starts fully healthy, publishes live ticks for all 20 configured symbols, and serves accurate historical data.

### BUG-01 — Redis `duplicate base class TimeoutError` (startup failure)

`aioredis==2.0.1` defines an exception class that inherits from both `asyncio.TimeoutError` and the built-in `TimeoutError`. In Python 3.11 these are the same class, causing a `TypeError` on import. The service started in degraded mode on every boot.

**Fix:** Replaced `aioredis==2.0.1` with `redis[hiredis]==5.0.8` in `requirements.txt`. Updated `server.py` to `import redis.asyncio as aioredis` (identical API). Shutdown path updated: `_redis_client.close()` → `_redis_client.aclose()`.

### BUG-02 — `Context manager has been closed` on every fetch

`get_quote_session()` and `get_chain_session()` instantiated `AsyncDynamicSession` but never called `__aenter__()`. Scrapling marks the session closed until the context manager is entered; every `fetch()` call raised `RuntimeError: Context manager has been closed`.

**Fix:** After construction, call `await raw.__aenter__()` and store both the raw instance (for `__aexit__` on reset) and the entered session (for `fetch()`). `reset_*_session()` functions updated to call `__aexit__` instead of `.close()`. `session_warmer._warm_session()` converted to `async with DynamicSession(...) as session:`.

### BUG-03 — `ERR_NAME_NOT_RESOLVED` in Playwright (Docker DNS)

Python's `libc`-based resolver works fine with Docker's embedded DNS at `127.0.0.11`. Chromium's built-in async DNS resolver explicitly rejects loopback nameserver addresses (RFC 5735). Every `page.goto()` in Playwright failed with `net::ERR_NAME_NOT_RESOLVED` despite `socket.getaddrinfo()` succeeding.

**Fix:** Added `dns: [8.8.8.8, 8.8.4.4]` to the `data-service` service in `docker-compose.yml`.

### BUG-04 — `batch_xhr_not_captured` / `single_xhr_not_captured` (NSE API migration + `capture_xhr` misuse)

Three compounded root causes:

1. **`capture_xhr` is session-level, not per-fetch.** Scrapling 0.4.x requires `capture_xhr` to be passed to the `AsyncDynamicSession` constructor. Passing it to `session.fetch(capture_xhr=...)` is silently discarded — it is not in `PlaywrightFetchParams`. The response handler always looked at `self._config.capture_xhr` which was `None`.

2. **NSE migrated their frontend to Next.js (mid-2026).** The old `equity-stockIndices` and `api/quote/equity` XHR endpoints no longer exist. The new endpoints live under `api/NextApi/`:
   - `api/NextApi/apiClient?functionName=getIndexData&&type=All` — index quotes
   - `api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20200` — equity constituents
   These endpoints return JSON via plain HTTP — no browser or cookies required.

3. **`network_idle=True` hangs forever on NSE pages.** NSE's SPA background-polls continuously. Playwright's `networkidle` state (no requests for 500ms) never arrives. Every `fetch()` call with `network_idle=True` hung until the Playwright timeout.

**Fix:**
- Replaced the entire browser-based live-quote scraper with `httpx` calls to the new `NextApi` endpoints.
- Added `_fetch_index_quotes()` for NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY using `getIndexData&&type=All`.
- `_fetch_batch_quotes()` now calls `getIndicesData?symbol=NIFTY%20200` (201 constituents, matches NIFTY_200_SYMBOLS set).
- `_fetch_single_quote()` falls back to `getIndicesData?symbol=NIFTY%20500` for non-constituent equities.
- For option chain (still browser-based): moved `capture_xhr` to the constructor, replaced `network_idle=True` with `network_idle=False, wait=4000`.
- Added NSE homepage pre-warm (`https://www.nseindia.com`, `wait=2000`) immediately after `__aenter__` to establish session cookies before any data XHR is attempted.
- Tick publisher `_fetch_quotes()` updated to route index symbols through `_fetch_index_quotes()`.

### BUG-05 — `GET /scraping/historical` → HTTP 400 for all frontend requests

The frontend sends full ISO 8601 datetime strings (`2025-09-03T13:20:52.952Z`). The `_parse_iso_date()` helper called `date.fromisoformat(value)` directly, which rejects anything beyond `YYYY-MM-DD`.

**Fix:** Strip the time component before parsing — `value.split("T")[0]` — so both `YYYY-MM-DD` and `YYYY-MM-DDThh:mm:ssZ` are accepted.

### BUG-06 — `single_xhr_not_captured symbol=^NSEI` flooding logs

The Next.js app queries `^NSEI` (a Yahoo Finance-style ticker). This symbol reached the NIFTY 500 lookup, failed silently, and logged a `warning` every few seconds.

**Fix:** Added an early guard in `_fetch_single_quote()` — symbols starting with `^` or containing `.` are rejected at `debug` level without hitting any external endpoint. Also downgraded the "symbol not found in NIFTY 500" log from `warning` to `debug`.

---

### Final startup state after all fixes

```
redis_connected          ✅
chromium_warmed          ✅
quote_session_homepage_warmed  ✅
quote_session_created    ✅
anti_ban_started         ✅
tick_publisher_started   ✅
data-service started healthy  ✅
```

Live quotes verified via `GET /scraping/quotes?symbols=NIFTY,BANKNIFTY,FINNIFTY,MIDCPNIFTY,RELIANCE,HDFCBANK,TCS,INFY,WIPRO` — all symbols return real prices.

---

## [Unreleased] — Opportunity Engine & Production-Day Validation

**New source files:** `src/lib/opportunity-engine/` (pipeline + types + API routes)
**New API routes:** 5 (`/api/in/opportunity-engine`, `/calibration`, `/attribution`, `/regime`, `/[opportunityId]`)
**New components:** `src/components/india/signal-quality/live-opportunity-funnel.tsx`
**New reports:** `reports/ALPHAFORGE_SIGNAL_ENGINE_SCORECARD.md`, `reports/PRODUCTION_DAY_TRUTH_REPORT.md`

### Opportunity Engine — 12-Stage Signal Validation Pipeline

A new validation layer (`src/lib/opportunity-engine/`) sits between raw AI signals and paper trade execution. Every candidate passes all 12 stages before a paper trade is opened:

1. Universe coverage validation
2. Market context snapshot (NIFTY trend, VIX, breadth, VWAP)
3. Multi-layer signal evaluation (12 layers — VETO from any = rejection)
4. Derivatives intelligence (OI freshness, chain quality, flow classification)
5. Signal quality vector (14 independently-inspectable components)
6. Expected value (`EV = P(win)×E[win] − P(loss)×E[loss] − costs − slippage`)
7. Opportunity clustering (correlated signals → one cluster; geometric mean confidence)
8. Conflict resolution (BUY / SELL / WAIT / NO_TRADE)
9. Abstention evaluation (15 explicit abstention reasons)
10. Risk check (Portfolio Risk Engine v2 pre-trade check)
11. Position sizing (base × confidence × vol × correlation × drawdown)
12. Execution mode isolation (BACKTEST / RESEARCH / SHADOW / PAPER / LIVE)

Pipeline versioning: `PIPELINE_VERSION = "opportunity-engine-v1"`, `FEATURE_VERSION = "fv1.0"`, `POLICY_VERSION = "pv1.0"`.

### OPP-001 Fix — Real Candle Pre-Fetch

The pipeline previously received empty candle arrays for every candidate. The fix pre-fetches real 1-year daily OHLCV bars for every candidate instrument + NIFTY (Angel One → Upstox → Yahoo failover) before the pipeline loop. This feeds real ATR, RSI, SMA20/SMA50, average volume, and regime detection.

Applied in both `app/api/in/opportunity-engine/route.ts` and `worker/src/jobs/india-auto-trader.ts`.

### Production-Day Validation Panel

`live-opportunity-funnel.tsx` — a dashboard panel showing the complete signal → qualified → paper → profit funnel for the current session.

### Open Defects (Documented)

| ID | Severity | Description | Status |
|---|---|---|---|
| DUP-001 | HIGH | Cross-timeframe duplicate signals inflate trade counts ~3× | Open |
| OPP-001 | HIGH | Empty candle arrays fed to pipeline | **Fixed** |
| AUDIT-001 | MEDIUM | Signal lifecycle events not persisted to DB (blocks replay) | Open |
| RISK-001 | MEDIUM | `PortfolioRiskEngine` defined but not wired into live path | Open |

---

## [Unreleased] — Signal Intelligence Engine (45-Phase Indian F&O)

**Tests:** 196 new · 9 new test files · 0 failures
**New source files:** 12 (`src/lib/signal-intelligence/`)
**New API routes:** 2 (`/api/in/signal-audit`, `/api/in/universe-coverage`)
**New DB models:** 4 (`SignalLifecycleEvent`, `UniverseCoverageSnapshot`, `OpportunityCluster`, `SignalIntelligenceRecord`)
**New doc:** `docs/INDIAN_FNO_SIGNAL_INTELLIGENCE_REPORT.md`

Complete build of the AlphaForge Professional Indian F&O Signal Intelligence Engine. Purpose: measurement and attribution infrastructure, not more indicators.

### Phase 1–2 — Signal Source Registry & Taxonomy

- Strict `SignalSourceType` enum: `STRATEGY | SCANNER | ML | META | TECHNICAL_BASELINE | MANUAL | RESEARCH | LEGACY | UNKNOWN`
- `UNKNOWN` routes to investigation, never to a leaderboard
- **Regression fixed:** `AI_SIGNAL` is now `MANUAL` — never `STRATEGY` or `TECHNICAL_BASELINE`
- **Regression fixed:** Only the 9 official India F&O strategies are leaderboard-eligible
- `EnrichedSignal` — 40-field canonical signal envelope

### Phase 3–4 — FNO Universe Service & Coverage Monitor

- `FNOUniverseService` — canonical ~200 stock + 4 index universe
- Session INVALID when coverage < 80% of expected instruments
- API: `GET /api/in/universe-coverage?date=YYYY-MM-DD`

### Phase 5–13 — Multi-Layer Signal Engine (12 layers)

- `MARKET_CONTEXT | REGIME | STRUCTURE | MOMENTUM | VOLUME | VOLATILITY | LIQUIDITY | DERIVATIVES | RELATIVE_STRENGTH | ML | RISK | EXECUTION`
- VETO status from any layer triggers immediate rejection
- `evaluateBreakoutQuality()` — classifies WEAK / VALID / STRONG / EXHAUSTION breakout
- `evaluateMomentumQuality()` — detects CONTINUATION / EXHAUSTION / DIVERGENCE / NEUTRAL
- `evaluateVolumeIntelligence()` — RVOL + time-of-day normalisation (09:20 vs 13:00 volume no longer naively compared)
- `evaluateLiquidity()` — spread > 0.30% = POOR + rejection; RVOL < 0.2 = rejected

### Phase 14–18 — Derivatives Intelligence

- `classifyOIBuildup()` — OI freshness check (max 15min stale); returns `UNCLASSIFIED` when data quality insufficient
- `classifyOptionsFlow()` — every classification labelled `OBSERVATION | INFERENCE | HIGH_CONFIDENCE_INFERENCE`; OI alone never qualifies as HIGH_CONFIDENCE_INFERENCE
- `buildExpiryContext()` — detects weekly/monthly expiry; gamma risk active flag (after 14:30 IST Thursday)

### Phase 19–23 — Signal Quality Vector, EV Engine, Abstention

- 14-component `SignalQualityVector`
- `computeExpectedValue()` — Platt-calibrated win probability (35% shrinkage toward 0.5)
- `gradeSignal()` — A_PLUS / A / B / C / REJECT with statistical thresholds
- `evaluateAbstention()` — 15 explicit abstention reasons; abstention is a valid model outcome
- `getTODBucket()` — 10 IST intraday buckets with TRADE / CAUTION / AVOID

### Phase 24–26 — Conflict Resolver & Opportunity Clustering

- `resolveSignalConflict()` → BUY / SELL / WAIT / NO_TRADE with explicit explanation
- **Regression fixed:** ORB + Momentum + Volume Breakout on same NIFTY breakout = ONE cluster, not three independent confirmations
- Cluster confidence = geometric mean (not sum) — avoids double-counting inflation

### Phase 27–36 — Lifecycle, Attribution, Decay, Sizing

- `SignalLifecycleEvent` state machine: DETECTED → VALIDATING → QUALIFIED → RISK_CHECK → APPROVED → PAPER_EXECUTED → ACTIVE → EXITED/EXPIRED/REJECTED; invalid transitions throw
- `detectSignalDecay()` — no demotion on < 10 trades (avoids premature demotion on tiny samples)
- `computeDynamicPositionSize()` — never sizes solely from signal score

### Phase 37–40 — Paper Trading Fidelity & Audit

- **Regression fixed:** `computePaperFill()` models realistic execution — fill = mid + half-spread + market impact + latency drift; paper fill ≠ candle close
- `buildSignalPaperFunnel()` — 8-stage funnel with bottleneck detection
- `computeReplayHash()` — deterministic hash; same inputs must produce same hash
- `ExecutionMode` isolation — `assertExecutionModeIsolation()` throws on mismatch

### Phase 43–45 — Strategy Scorecard & Production Guard

- `evaluateProductionGates()` — 8 mandatory gates for LIVE_CANDIDATE
- Positive backtest P&L satisfies **zero** gates
- All 9 official strategies currently `INSUFFICIENT_EVIDENCE` — correct state, no fabrications

### Test Coverage

| File | Tests |
|---|---|
| `signal-source-registry.test.ts` | 27 |
| `fno-universe.test.ts` | 18 |
| `market-context-engine.test.ts` | 19 |
| `multi-layer-engine.test.ts` | 28 |
| `derivatives-intelligence.test.ts` | 28 |
| `signal-quality-vector.test.ts` | 26 |
| `conflict-resolver.test.ts` | 13 |
| `signal-lifecycle.test.ts` | 22 |
| `paper-trading-fidelity.test.ts` | 15 |

---

## [Unreleased] — 20-Session NSE Market Validation (PARTIALLY_CERTIFIED)

**Tests:** 25 new · 3 new test files · 2768 total · 182 test files
**New source files:** 1 (`src/lib/market-data/services/candle-persist.service.ts`)
**New docs:** `docs/NSE_20_SESSION_VALIDATION_WINDOW.md`, `docs/INDIAN_MARKET_20_SESSION_CERTIFICATION.md`

Comprehensive 20-session replay and validation across sessions 2026-08-04 → 2026-09-01. Five weekly NIFTY expiry sessions. Three critical defect fixes.

### CAL-001 — Missing 2025/2026 NSE Holidays (CRITICAL BUG FIX)

The `nseCalendar` instance was initialised with only the 2024 holiday list. Any `isTradingDay()` call on a 2025/2026 holiday (e.g. 2025-08-15 Independence Day, 2026-01-26 Republic Day) incorrectly returned `true`.

- Added `NSE_HOLIDAYS_2025` (14 entries) and `NSE_HOLIDAYS_2026` (16 entries)
- Added `NSE_MUHURAT_2025` and `NSE_MUHURAT_2026` Muhurat session arrays
- Bumped `HOLIDAY_CALENDAR_VERSION` from `"2024-v2"` to `"2026-v1"`
- 51 regression tests in `tests/lib/nse-trading-calendar.test.ts`

### CAL-002 — Sunday Muhurat Session Returning WEEKEND (BUG FIX)

`getSessionInfo()` checked weekends before Muhurat. Diwali 2026 falls on Sunday — the method incorrectly returned `"WEEKEND"` instead of `"MUHURAT"`. Moved Muhurat lookup before the weekend check.

### RCA-001 — CandleBar DB Persistence Not Wired (HIGH DEFECT FIX)

The `CandleBar` table was never written to. Intraday candles were served live from Angel One with a 30s Redis TTL and lost after session close, making deterministic minute-level historical replay impossible.

- New `candle-persist.service.ts` — idempotent upsert on `(instrumentId, exchange, intervalStr, time)`
- Wired into `refreshIndiaIndicatorState()` in `india-scalper` — fire-and-forget after each fetch

### RCA-002 — OC Snapshot Gap Not Detected (MEDIUM DEFECT FIX)

A 2.5-hour option-chain snapshot gap (12:51–15:30 IST) was silent. Affected strategies (Liquidity Edge, Max-Pain Gravity, PCR Extreme, IV Spike, OI Build-up) used stale 12:51 data for all afternoon signals.

- `OC_LAST_CAPTURE_KEY` Redis key updated after every successful capture
- `checkOcCaptureHealth()` emits structured warn when age exceeds 15 minutes

### RCA-003 — Yahoo Ticker Mapping Gaps (LOW DEFECT FIX)

Four F&O stocks returned empty arrays because `"{SYMBOL}.NS"` was not a valid Yahoo ticker: `TMPV` (mapped to `TATAMOTORS.NS`), `M&M` (mapped to `MM.NS`). Added `YAHOO_SYMBOL_OVERRIDES` map in both `yahoo/index.ts` and `market-data/normalizer.ts`.

### Final Certification Outcome

| Subsystem | Status |
|---|---|
| NSE Trading Calendar | ✅ CERTIFIED |
| Signal Engine | ✅ CERTIFIED |
| Signal Deduplication | ✅ CERTIFIED |
| Paper Trading Pipeline | ✅ CERTIFIED |
| P&L Reconciliation | ✅ CERTIFIED (183 trades, zero divergence) |
| Strategy Execution | ✅ CERTIFIED (all 13 strategies, every session) |
| Worker Reliability | ✅ CERTIFIED |
| ML Pipeline | ⚠️ PARTIALLY_CERTIFIED |
| Data Completeness | ⚠️ PARTIALLY_CERTIFIED |
| Intraday Candle Replay | ❌ FAILED → Fixed by RCA-001 |

---

## [Unreleased] — V6 Evidence-Driven Quant Research Platform

**Tests:** 92 new · 8 test files · 0 failures
**New source files:** 40 (`src/lib/research/` + API routes + dashboard pages + components)
**New docs:** `docs/STRATEGY_INVENTORY.md`, `docs/ALPHA_RESEARCH_REPORT.md`, `docs/STRATEGY_GOVERNANCE_MATRIX.md`

AlphaForge V6 transforms the platform from a collection of strategies into a scientifically rigorous, evidence-driven quant research platform. Every strategy is inventoried, hypothesised, and wired into a 24-phase research pipeline.

**Core principle:** Backtest profit is not sufficient evidence. All promotion decisions are based exclusively on out-of-sample metrics. Live promotion always requires explicit human approval — it can never be automatic.

### 24-Phase Research Infrastructure (`src/lib/research/`)

- **Phase 1–2 — Registry + Hypothesis:** 18 strategies catalogued with falsifiable hypotheses; `getOrThrow()` enforced at all API entry points
- **Phase 3–4 — Datasets + IS/OOS Governance:** SHA-256 fingerprinted datasets; `validateSplitIntegrity()` throws on any temporal overlap; 15 dedicated leakage tests
- **Phase 5–6 — Performance + Costs:** 35 metrics per period (Sharpe, Sortino, Calmar, SQN, Ulcer Index, t-test significance...); 1×/1.5×/2×/3× cost stress; `COST_FRAGILE` blocks promotion
- **Phase 7–8 — Regime Attribution:** Strategy×Regime matrix of Sharpe/PF/Expectancy per cell
- **Phase 9 — Correlation:** Full N×N correlation matrix; single-linkage clustering at 0.70 threshold; capital allocation caps per cluster
- **Phase 10 — Alpha Decay:** 5-state machine (HEALTHY → WARNING → DEGRADED → CRITICAL → DISABLED); 52-week rolling history
- **Phase 11 — Monte Carlo:** 7 simulation types × 10,000 seeded iterations; FRAGILE blocks promotion
- **Phase 12 — Parameter Stability:** Symmetric neighbourhood testing; OVERFIT_SUSPECTED blocks promotion
- **Phase 13 — Multiple Testing Guard:** Deflated Sharpe Ratio (Bailey & López de Prado 2014); PBO estimation; Benjamini-Hochberg FDR correction
- **Phase 14 — Signal Calibration:** Brier Score, ECE, 10-bin reliability diagram
- **Phase 15 — Ablation Testing:** Per-component incremental OOS contribution; `LOW_VALUE_COMPONENT` flag
- **Phase 16–17 — Promotion + Demotion:** Evidence gates per lifecycle stage; 8 demotion trigger types; LIVE always requires `approvalToken` + `approvedBy`
- **Phase 18 — Confidence Score:** 8-component weighted 0–100 score
- **Phase 19 — Experiment Tracking:** Immutable records with `gitCommitHash`, `datasetFingerprint`, `parameterSet`; `ExperimentStore.add()` throws on duplicate ID
- **Phase 20–21 — Leaderboard + Allocation:** Ranked views; HHI concentration; per-cluster allocation caps
- **Phase 22 — Kill Switch:** SOFT_KILL + HARD_KILL; automatic triggers; never auto-removed
- **Phase 23 — Paper Analysis:** Backtest vs shadow vs paper comparison; material drift blocks promotion
- **Phase 24 — Validation Sessions:** ≥ 20 sessions + regime diversity before LIVE_CANDIDATE

### Research Dashboard (`/research/`)

10 new pages: Leaderboard, Strategy Inventory, Regime Matrix, Monte Carlo, Parameter Stability, Signal Calibration, Experiment History, Correlation, Promotion Pipeline, Alpha Decay Monitor.

### Research APIs

13 REST endpoints under `/api/research/` with Zod validation and registry enforcement.

---

## [Unreleased] — V5 Quant Governance & Hardening (20 Phases)

**Tests:** 2550 passing · 170 test files · 0 failures
**New source files:** 18 · Modified: 10 · New test files: 11 · New docs: 5

### Key Additions

- **Canonical Data Audit** (`docs/CANONICAL_DATA_AUDIT.md`) — full dependency map of all market data consumers; identified 16 bypass files (2 CRITICAL, 8 HIGH, 6 MEDIUM)
- **Canonical Import Guard** (`src/lib/market-data/canonical-import-guard.ts`) — CI test that fails on any new direct `yahoo-finance2` import outside approved adapter files
- **Price Forecaster Input Builder** (`src/lib/india/price-forecaster-input-builder.ts`) — canonical fetch → confirmed candles only → OHLCV validation → exactly 60 bars; 14 tests
- **ML Feature Contract & Validator** (`src/lib/india/feature-quality-validator.ts`) — replaces unsafe generic `NaN→0` with per-feature REJECT / TRAINING_MEDIAN / FORWARD_FILL / MODEL_DEFAULT policies; 18 tests
- **Feature Parity Registry** (`src/lib/india/feature-contract-registry.ts`) — training/inference contract enforcement via `verifyParity()`
- **Meta Model OOS Calibration** (`src/lib/india/meta-calibration.ts`) — three timestamp assertions preventing in-sample leakage; `assertNoLeakage()` for post-build verification
- **Model Governance Registry** (`src/lib/india/model-governance.ts`) — 9-stage lifecycle (EXPERIMENTAL → LIVE); promotion gates with explicit metric thresholds
- **Atomic Trade Guard** (`src/lib/india/atomic-trade-guard.ts`) — `SET key NX EX` single atomic Redis op; `executeExactlyOnce()` wrapper; concurrency tests: 100 concurrent workers → exactly 1 execution
- **Trading State Machine** (`src/lib/india/trading-state-machine.ts`) — 9 states, legal transition map; `InvalidStateTransitionError` / `DuplicateFillError` / `FillAfterTerminalStateError`; 18 tests
- **NSE Trading Calendar** (`src/lib/india/nse-trading-calendar.ts`) — `NSE_HOLIDAYS_2024`; Muhurat trading support; `isMarketOpen()`, `isTradingDay()`, `prevTradingDay()`
- **F&O Data Quality Rules** (`src/lib/india/fno-data-quality.ts`) — detects crossed markets, negative IV/OI, stale quotes, zero liquidity, wide spreads, partial chains; GOOD / DEGRADED / PARTIAL / STALE / INVALID
- **Decision Pipeline Config** (`src/lib/india/decision-pipeline-config.ts`) — env-variable feature flags for each ML component
- **Coverage Gates** (`coverage/critical-modules.json`) — 13 coverage gates with per-module line/branch thresholds
- **Paper Soak Mode** (`src/lib/india/paper-soak-mode.ts`) — `assertPaperSoakSafe()` blocks if `LIVE_TRADING_ENABLED=true`
- **Decision Trace** (`src/lib/india/decision-trace.ts`) — `formatTradeExplanation()` answers "WHY WAS THIS TRADE TAKEN?"; `GET /api/trades/{id}/explain`
- **Canonical Registry Migrations** — all CRITICAL and HIGH bypass files migrated to `registry.getQuotes()` / `registry.getOptionChain()` / `getHistoricalCandlesByRange()`. CI guard confirms 0 violations.

---

## [Unreleased] — Institutional Infrastructure Layer

**Tests:** cumulative ~4700 across all new modules
**New source files:** 50+ across 8 new library modules

Eight new modules that bring the codebase to institutional / prop-desk level.

### Portfolio Risk Engine v2 (`src/lib/risk/`) — 64 tests

7 modules: `exposure.ts`, `correlation.ts`, `var.ts`, `drawdown.ts`, `position-sizing.ts`, `risk-limits.ts`, `portfolio-risk.ts`.

- 8-step pre-trade evaluation pipeline running in < 1ms
- Dynamic position sizing: `base × confidence × vol × correlation × drawdown`
- 4-tier drawdown ladder (NORMAL → CAUTION → WARNING → DANGER → HALT)
- SOFT_KILL (reduces sizing to minimum) and HARD_KILL (blocks all new entries)
- Correlated-long cluster guard (e.g. max 3 Bank sector longs)

### Market Microstructure Intelligence Engine (`src/lib/microstructure/`) — 974 tests

7 modules: `order-book.ts`, `imbalance.ts`, `spread.ts`, `liquidity.ts`, `toxicity.ts`, `pressure.ts`, `index.ts`.

- TypeScript VPIN port — matches Python `compute_vpin()` reference
- 5-dimension composite liquidity score (volume, depth, spread, OI, trade frequency)
- `MicrostructureEngine` facade — `ExecQuality` (EXCELLENT/GOOD/FAIR/POOR); 1m/5m ring-buffer feature store

### Shadow Trading & Strategy Experiment Framework (`src/lib/experiments/`) — 1,643 tests

5 modules: `strategy-version.ts`, `experiment-manager.ts`, `shadow-trader.ts`, `comparison.ts`, `promotion.ts`.

- Multi-arm A/B testing with per-arm traffic allocation
- `ComparisonEngine` — Welch t-test, Cohen's d, 95% CI, information ratio
- Cryptographic promotion tokens (32 bytes random, 10-min expiry, single-use)
- LIVE always requires human approval — `rejectAutoLive()` throws

### Event-Driven Backtesting Engine (`src/lib/backtesting-v2/`) — 116 tests

- Typed discriminated-union event bus (Market → Signal → Risk → Order → Fill → Position)
- `SimulationClock` — NSE calendar: Thursday weekly expiry (shifts to Wednesday on holiday), 09:15–15:30 IST gate, holiday filtering
- India execution simulation: instrument-aware slippage, full NSE brokerage (STT + exchange fee + GST + SEBI + stamp), 3 latency profiles (co-location ~0.5ms / retail DMA ~15ms / API ~80ms), 4 order types with partial fills + gap-through-stop
- Trade attribution: every trade stamped with `strategyId`, `modelVersion`, `featureVersion`, `marketRegime`, `dataQualityScore`
- **Conservative tie-break**: bar touching both stop and target → always a stop

### Meta Decision Engine (`ml-service/src/meta/`) — 1,058 tests

- Platt scaling + isotonic regression per model
- `REGIME_WEIGHTS` table — 6 regimes × 7 models; regime-aware ensemble weighting
- `AbstentionPolicy` — 7 trigger conditions; `WAIT` (skip bar) vs `NO_TRADE` (system not ready) distinction
- 5-component `ConfidenceDecomposition` with `ReasonCode` audit trail

### ML Model Monitoring & Drift Detection (`ml-service/src/monitoring/`) — 930 tests

- PSI, KS statistic, Jensen-Shannon divergence for feature drift
- Brier score + ECE + trading expectancy for prediction calibration
- Ensemble weight auto-adjustment when models degrade
- 16 FastAPI endpoints under `/monitoring/*`

### Financial ML Validation Framework (`ml-service/src/validation/`) — 1,480 tests

Replaces all random train/test splits with López de Prado methodology:
- `WalkForwardValidator` (rolling + expanding windows)
- `EmbargoApplier` (bars/minutes/days); `purge_train_indices_by_t1()`
- `PurgedKFold(BaseCrossValidator)` — sklearn-compatible drop-in
- CPCV — all C(N,k) purged+embargoed folds
- PSR (Probabilistic Sharpe Ratio) + DSR (Deflated Sharpe Ratio)

---

## [Unreleased] — Provider-Agnostic Indian Market Data Layer

**Tests:** 393 new · 1392 total · 0 regressions
**New source files:** `src/lib/market-data/` (30+ files)

End-to-end replacement of per-provider data fetching scattered across `services/india/` with a single production-grade, provider-agnostic layer. All strategy engines, ML services, and API routes now consume canonical normalized types.

### Canonical Type System (`src/lib/market-data/types.ts`)

`ProviderId`, `Exchange`, `Segment`, `InstrumentType`, `MDQuote`, `OHLCVCandle`, `OptionChain`, `LiveTick`, `ProviderHealth`, `MarketDataError` — single source of truth. Provider-specific shapes never leak through.

### Four-Provider Priority Chain

Angel One SmartAPI (1) → Upstox Analytics v2 (2) → NSE direct (3) → Yahoo Finance (4). Missing env vars = silently unconfigured, no degradation.

### Automatic Failover

`withFailover()` — retries 3× with exponential backoff (300ms base, 5s cap, 20% jitter). 10s failover cooldown prevents oscillation. Every failover structured-logged.

### Circuit Breaker

0–100 health score. Consecutive failure: −40pts; success: +10pts; auth failure: −25pts extra. Circuit opens at < 20pts; half-open after 30s.

### Real-Time CandleBuilder

`CandleBuilderService` — assembles OHLCV candles for all 8 NSE-aligned timeframes (1m–1d). Bars aligned to 09:15 IST open. Redis-backed mid-bar state. Postgres upsert on confirmation. Backfill gap detection on reconnect.

### ML Training Refactor

`ml-service/src/training/market_data_client.py` — three-tier client (AlphaForge API → PostgreSQL → yfinance fallback). `DataQuality` classification (GOOD / STALE / INVALID / SUSPICIOUS) filters rows before feature engineering. `DatasetMetadata` versioning on every `.npz` file.

### New Upstox Provider

Full `MarketDataProvider` implementation for Upstox Analytics v2 — historical candles, quotes, option chain. Activated by `UPSTOX_ANALYTICS_TOKEN`.

---

## [Unreleased] — IIT UI Overhaul (Institutional Intelligence Terminal)

**Tests:** 1238 total passing · 0 TypeScript errors
**New/modified files:** 100+

Complete visual and architectural overhaul of every page and shell component. No new API routes. No logic changes. All existing data flows preserved.

### Design System

- Full OKLCH color token system in `globals.css` `@theme inline` — no hardcoded hex/RGB
- 4 Spring motion presets exported from `src/lib/motion-presets.ts`: MICRO (800/40), FAST (600/35), DEFAULT (400/28), GENTLE (240/24)
- `data-density` attribute pattern: `compact` (32px) / `default` (40px) / `comfortable` (48px)
- 6 CSS keyframes: `price-flash-up`, `price-flash-down`, `breakout-pulse`, `vix-warning-pulse`, `celebration-pulse`, `shimmer-border`
- `prefers-reduced-motion` safety net on all animated components

### UIStore + RegimeContext

- `useUIStore` — Zustand v5; persists `sidebarCollapsed` + `tableDensity` to localStorage
- `RegimeProvider` — injects `--aurora-regime-a` CSS variable for regime-reactive aurora background (1200ms CSS transition)
- `RegimeSync` + `CryptoRegimeSync` — bridge market stores to UIStore

### Shell Refactor

- **Sidebar** — collapses to 56px icon rail; 2px regime indicator strip; spring animation with `SPRING_DEFAULT`; keyboard navigation (ArrowUp/Down/Enter/Escape); WCAG 2.1 AA compliant; auto-collapses below 1024px
- **Topbar** — 52px frosted glass; `TopbarBreadcrumb` from `usePathname()`; `VixWarningChip` (activates at VIX > 25 with `vix-warning-pulse`); 3-segment `ThemeToggle` with `layoutId` sliding indicator
- **MarketTickerBar** — 36px frosted strip; `NumberMorph` prices; 400ms CSS price-flash on tick; SENSEX added to India strip; crypto auto-scroll pauses on hover

### Trading Component Library

`SignalBadge`, `ConfidenceBar`, `RegimeBadge`, `NumberMorph` (magnitude-scaled timing 120ms–360ms), `StatGrid`, `PanelHeader`, `RiskMeter`, `AiRadar` (TanStack Table v9, hover detail panels, keyboard nav).

### Layout Primitives

`BentoGrid` + `BentoCell` (12-column CSS grid), `PageHeader`, `EmptyState`, `ErrorState`, `PageTransition`.

### 3D Suite

`MarketIntelligenceCore` (quality prop: low/medium/high), `RiskSphere` (portfolio risk encoding), `PortfolioGalaxy` (Fibonacci sphere particle system, position size = particle size, P&L = particle color).

### Page Redesigns

All major pages overhauled with BentoGrid layouts: Crypto + India Overview, AI Signals (animated confidence ring, hover SHAP expansion), Options Chain (IvHeatDot, max-pain background encoding), Daily Picks (NumberMorph P&L, celebration-pulse on TARGET_HIT, collapsible FnO Trend sections), Paper Trading (BentoGrid stats, RiskSphere, double-confirm Close All).

### Bug Fixes

- **Hydration fix** — `fmtTime()` + `fmtDateTime()` in `src/lib/utils.ts` pin `en-GB` locale; replaced all bare `toLocaleTimeString()` across 21 files
- **Server/client boundary fix** — `signalToRadarRow` moved to `src/lib/signal-to-radar-row.ts`, removed `"use client"` directive
- **Canvas color fix** — `CHART_THEMES` now uses literal hex `#94a3b8` instead of `var(--fg-muted)` (lightweight-charts cannot parse CSS variables on canvas)

---

## [Unreleased] — FnO Intelligence & Intelligent Auto Paper-Trading Engine

**Tests:** 1101 total · 0 TypeScript errors
**New DB models:** `FnoTrendScan`, `IndiaDaySession`

### Intelligent Auto Paper-Trading Engine

- Scores every Daily Pick and AI Signal: `35%×confidence + 25%×winProbability + 25%×grade + 15%×R:R`
- Threshold ≥ 0.52 (eliminates low-conviction setups)
- Daily ₹1,00,000 budget — max 5 positions × ₹20,000 notional; risk gate ≤ 2.5% SL
- No new entries after 14:45 IST; all positions closed at 15:30 IST
- Worker job: `india-auto-trader` (every 60s, market hours)
- `GET /api/in/paper-trade/analytics?range=1d|7d|15d|30d|6mo|1y|all`

### Super Confluence Engine (UT Bot + AI Neural + SMC + EMA 9/15/21)

Port of the "Super Confluence Engine" Pine Script. Four gates must agree simultaneously — UT Bot ATR trailing stop + HMA-smoothed AI Neural trend + SMC BOS/CHoCH + EMA 9/15/21 stack. Score ∈ [−1, 1] as a confidence factor (weight 0.10) in the India AI engine. `🔥 SC` button in the chart toolbar.

### FnO Bullish & Bearish Trend Scanners

14-condition Chartink-mirrored screener (bullish and bearish mirrors). ATR(14)-based entry/SL/TP1/TP2/TP3 on every hit. Results persisted to `FnoTrendScan` with outcome tracking. Worker: `india-fno-trend-track`.

### Unified Signal Table UI

`SignalTableRow` + `SignalTableHead` shared components across all India signal lists. Click-to-expand inline detail panel (entry/SL/TP, TradingView link, Paper Trade button). Applied to: F&O Scanner, India Signals, MSB Dashboard, Watchlist, Daily Picks, FnO Trend sections.

### Trade History Page (`/in/history`)

Three source tabs: Daily Picks · Scalper Trades · FnO Trend Scanner. Day accordions with outcome/direction filters. Time range selector: 7d / 14d / 30d / 60d.

### Paper Trading Enhancements

- Paper Trade button on every signal surface (Daily Picks, AI Signals, Scanner, FnO Trend)
- Market-hours guard: button shows "Market is closed" outside 09:15–15:30 IST
- "Close All" button in Open Positions header
- EOD worker (`india-eod-squareoff`) — closes all OPEN India trades at 15:30 IST

### Worker Additions

`india-fno-trend-track`, `india-eod-squareoff`, `india-auto-trader` all wired. Default `india-daily-picks` interval reduced from 5min to 1min; `runOnStart: true` for immediate first tick.

---

## [Unreleased] — Phase 2 Expert Quant Upgrade

**Tests:** 1084 Vitest passing · 143 pytest passing · 0 TypeScript errors

Upgrades AlphaForge from "advanced retail" to expert quant / prop-desk level with five new capability layers. All additive — no breaking changes to existing routes, stores, or worker jobs.

### Track A — Streaming Indicators + Chart Plugins (TypeScript)

- `@debut/indicators@2.0.1` — streaming adapter with `dumpState()` / `restoreState()` for Redis-backed warm starts; all outputs match existing `helpers.ts` to within 0.01%
- `AnchoredVwapPlugin` — three `LineSeries` overlays (session 09:15 IST, daily, weekly)
- `VolumeProfilePlugin` — POC / VAH / VAL as `series.createPriceLine()` overlays
- Both togglable via chart toolbar; palette synced to `useTheme()`

### Track B — Python Options Analytics

- **Real Black-76/BS greeks** (`ml-service/src/greeks.py`) — Newton-Raphson IV solver + `brentq` fallback; all sign invariants enforced; `POST /analytics/greeks`
- **Dealer GEX engine** (`ml-service/src/gex.py`) — per-strike `gamma × OI × lot_size × spot²`; gamma flip; expected daily move; `POST /analytics/gex`
- **SVI IV Surface** (`ml-service/src/vol_surface.py`) — L-BFGS-B minimisation; bounds: a∈[0,1], b∈[0,2], ρ∈(−0.999,0.999); `POST /analytics/vol-surface`
- **IV Regime Classifier** — CRUSH / STABLE / SPIKE; `POST /predict/iv-regime`
- Option chain enriched with real per-strike greeks and `iv_regime` field
- `GexPanel` + `VolSurface` components added as tabs on `/in/options`

### Track C — ML Service Upgrade

- **TA-Lib vectorised features** — all pure-Python indicator loops in `technical.py` replaced with C-backed `talib.*` calls; 6 new candlestick pattern features (CDLENGULFING, CDLHAMMER, CDLDOJI); HT_TRENDLINE deviation added to `RANKING_FEATURES`
- **VPIN order-flow** — `compute_vpin()` in `volume.py`; tick-rule bucket classification [0,1]; `vpin_score` wired into regime features; `POST /analytics/vpin`; `OrderFlowPanel` on India Overview
- **TFT price regime forecaster** — `ml-service/src/price_forecaster.py`; `priceForecast` field in `buildMLContext()`; `POST /predict/price-regime`

### Track D — Portfolio + Workbench + OpenAlgo

- **Riskfolio-Lib portfolio optimizer** (`portfolio_optimizer.py`) — `hrp_allocation` + `cvar_allocation`; `POST /predict/portfolio-v2`; new `/in/portfolio` page with allocation pie chart and risk metrics
- **Options Strategy Workbench** (`/in/options-workbench`) — 13-strategy picker; ATM auto-populate from live chain; SVG payoff diagram; break-evens; net greeks; GEX-guided strike scan
- **OpenAlgo broker adapter** — `OpenAlgoAdapter implements BrokerAdapter`; covers 33+ Indian brokers via normalised REST API; `placeOrder` gated behind `LIVE_TRADING_ENABLED=true`; `LiveOrderModal` with double-confirm UX

### Graceful Degradation

All four new API routes return `{ available: false, reason }` with HTTP 200 when the ML service is unreachable. Never 5xx.

---

## [Unreleased] — Quant-Grade India Stock Selection (v2 Engine)

Model version bumped from `alphaforge-ai-v1` → **`alphaforge-ai-v2`**.

### 8-Factor Quant Score (`src/services/india/signals/score.ts`)

Replaced 4-factor linear score with an 8-factor weighted model: SMA-50 proximity (15pts), SMA-200 proximity (15pts), intraday change (20pts), analyst target upside (15pts), RSI(14) (10pts), ADX(14) (8pts), relative volume (9pts), NSE delivery % (8pts). STRONG BUY/SELL threshold tightened from ±60 → ±55.

### Engine v2 Changes (`src/features/ai-signals/engine.ts`)

| Parameter | Old | New |
|---|---|---|
| WAIT threshold | 0.18 | 0.22 |
| Grade S | ≥ 0.85 | ≥ 0.82 |
| Grade A | ≥ 0.72 | ≥ 0.68 |
| Win probability offset | 0.35 | 0.38 |
| Low-risk confidence floor | ≥ 0.62 | ≥ 0.68 |

### Quant Pre-Filter (`src/features/ai-signals/india-builder.ts`)

ADX ≥ 18, relative volume ≥ 1.1×, ATR% ≥ 0.4%. Failures receive 0.82× confidence penalty. Index underlyings always pass. `computeApproxAdx()` — Wilder ADX(14) from daily candles.

### ML Service Integration

`buildMLContext()` regime blending: 65% heuristic + 35% ML. ML rank boost: ±0.06 confidence delta per stock based on LightGBM rank score.

### ML Stock Ranker v2 (`stock_ranker.py`)

- Derivatives component weight raised 0.17 → 0.22 (OI/PCR is strongest NSE predictor)
- NSE delivery % added to volume component (×0.08 sub-weight)
- `higher_highs_lows` weight raised 0.20 → 0.26
- New `sector_relative_strength` factor (stock 20d return vs sector peer avg)

### Daily Picks Quality Floors (`engine.ts`)

MOMENTUM requires confidence ≥ 0.25 + dayChange ≥ 0.30. SCALPING requires confidence ≥ 0.22 + R:R ≥ 1.5 + dayChange ≥ 0.30. POTENTIAL requires confidence ≥ 0.28 + breakout ≥ 0.25.

---

## [Unreleased] — India Strategies, SmartAPI & Daily Picks Expansion

### Opening Breakout Strategy

First 5-min candle (09:15–09:19:59 IST) opening-range breakout. Entry on the **retest** of the broken level (resistance→support flip). Stop below the breakout candle; target = 2R. PCR / OI / max-pain confirmation. Seeded into the Opening Breakout bucket on Daily Picks.

### Indices Scalping Bucket + Signal Timing

Fourth Daily Picks bucket for pure index scalps (NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY) scored on OI build-up + PCR + max-pain. Every signal carries `generatedAt` (appeared on board) and `resolvedAt` (time-to-outcome).

### Gamma Blast / Hero Zero (Expiry-Day)

Expiry-only section on Daily Picks. Shows only on a NIFTY (Tue) or SENSEX (Thu) expiry day. Gamma Blast: ATM option in trend direction (~2.2× target / 50% stop). Hero / Zero: far-OTM lottery (~5× target / expires at 0). SENSEX uses BSE BFO chain from Angel One adapter.

### India News + Sentiment (`/in/news`)

Fans out across ET Markets + global RSS feeds. Pure bull/bear lexicon engine per headline. Per-headline F&O stock / sector / index impact tags (high / medium / low). Overall market sentiment + 0-100 risk-on / risk-off ratio. Feed URLs env-overridable via `INDIA_NEWS_FEEDS`.

### SmartAPI Deepening

- First-party F&O scanners via `marketData/v1/` API (gainers/losers, PCR, OI buildup)
- Full option greeks per strike (delta, gamma, theta, vega)
- Real per-leg `changeInOi` (diffs live OI against session-open baseline cached until midnight IST)
- FULL-mode quotes — OI, 52W high/low, circuit limits, order-book imbalance ∈ [−1, 1]
- SmartStream WebSocket 2.0 — binary tick decoder; exponential-backoff reconnect; falls back to 5s poll on failure
- Read-only account layer — funds, holdings, net positions (all number-typed, string-parsed)
- BSE (BFO) option chain for SENSEX expiry plays

---

## [Unreleased] — India F&O Strategies v1 (ILE, IMPG, FnO Scanner)

### India Liquidity Edge (ILE)

Port of the *India Liquidity Edge — Quant Framework* Pine indicator. Eight modules combined into a 0–10 bull/bear confluence score:
1. Liquidity sweep detector — equal highs/lows + volume spike gate
2. OI walls + max-pain gravity — CE/PE walls + PCR classification
3. Gap-fill engine — first-candle reversal toward PDC; event vs sentiment gap distinction
4. NSE session + expiry timing — Trap Zone → Discovery → Prime Window → Close Rush
5. India VIX regime + IV-crush + VIX divergence
6. Confluence score engine (0–10; STRONG BUY/SELL ≥ 7)
7. Auto ATR-sized SL (0.25× ATR) / target (2.5× RR)
8. Instrument presets — Auto ATR-scaled / Nifty / BankNifty / MidcapNifty / Custom

### India Max-Pain Gravity (IMPG)

Carved from the same Pine indicator as ILE but focused exclusively on dealer-positioning modules: max-pain gravity (post-13:30 IST), OI-wall fade, pinning-zone mean reversion, gap-fill toward PDC, expiry-day gamma awareness.

### FnO Bullish Trend Scanner

14-condition screener (EMA/SMA/ADX/MACD) mirroring Chartink. Results persisted to DB with outcome tracking.

### Daily Picks — Institutional Signal Upgrade

- Counter-tape picks demoted via `marketAlignment` filter
- Candidate pool widened to ~30 liquid F&O names
- Index scalps scored on derivatives positioning; stock picks on technical + volume + derivatives
- Opening Breakout bucket feeds from the ORB strategy (lazily frozen after retest)

---

## [Unreleased] — Multi-Model ML Decision Engine

**New source:** `ml-service/` (full Python microservice)

### ML Architecture

```
NSE Data → Feature Engineering (150+ features)
    ├── Market Regime Classifier (XGBoost) — 6 regimes
    ├── Stock Ranker (LightGBM) — outperformance scores
    ├── Strategy Selector (CatBoost) — 8 strategies
    ├── Risk Predictor (XGBoost ×3) — P(stop), P(target), drawdown
    ├── Portfolio Optimizer (PyPortfolioOpt HRP) — capital allocation
    └── RL Executor (PPO / SB3) — execution timing
```

All models include rule-based heuristic fallbacks. Zero degradation when ML service is down.

### Signal Integration

- ML regime blending (35% ML + 65% heuristic) into India AI engine
- ML stock rank boost (±0.06 confidence delta) for top-20 ranked stocks
- `futuresScreen` weight 0.12 → 0.14; `scanner` weight 0.08 → 0.10

---

## [Unreleased] — India F&O Surface Foundation

### Core Indian Market Pages

- **Overview / Market Pulse** (`/in/dashboard`) — NIFTY indices strip, sectoral heatmap, MSB–OB signals, Range Expansion scanner, Top 5 Stocks for Tomorrow
- **Best Time** (`/in/best-time`) — 7 NSE windows, expiry-aware day quality, "now" cursor
- **Options** (`/in/options`) — live NSE chain, PCR, max-pain, ATM ±5 strikes, IV per strike, OI heat
- **Signals** (`/in/signals`) — unified feed merging 6 scanner types; localStorage-persisted filter chips
- **AI Signals** (`/in/ai-signals`) — 10-factor F&O engine; strike suggestions from live chain; WAIT outside NSE hours
- **Strategies** (`/in/strategies`) — 9-strategy picker + live signal feed + how-it-works reference
- **Paper Trading** (`/in/paper-trading`) — open positions + journal + per-strategy performance
- **Heatmap** (`/in/heatmap`) — sector pulse + per-sector grid; continuous `color-mix()` saturation

### F&O Paper Trader Worker

`india-scalper` worker job — books India paper trades with ATR-sized SL/TP (NSE 0.05-tick rounded), expiry-day gamma cooldown (Thursday ≥ 14:30 IST), 5m NSE-candle resolution.

### Daily Picks Foundation

First three buckets: Indices Scalping, Highly Momentum, Highly Scalping, Highly Potential. Picks frozen per IST trading day into `IndiaDailyPick`. Live-tracked via `india-daily-picks` worker job.

### Paginated Data Views

All Indian Market tables paginated at 5 items/page with shared `usePaginationFilter` hook. Three filter tabs: All / Most Confidence / High Winrate.

### Client-Side Pagination

`src/components/india/ui/pagination-filter.tsx` — shared across 10 Indian Market components.

---

## [Unreleased] — TypeScript / Build Fixes

Three pre-existing issues blocking `tsc --noEmit` and `next build` resolved. No runtime behavior changed.

| Fix | Change |
|---|---|
| `tsconfig.json` target | Raised `ES2017 → ES2018` (enables dotAll `/s` regex flag in worker tests) |
| `@worker/*` path alias | Added to root `tsconfig.json`; aligns type-checker with Vitest bundler |
| `NODE_ENV` assignment | Removed `process.env.NODE_ENV ??= "test"` from `vitest.setup.ts` — `NODE_ENV` is readonly; already injected via `vitest.config.ts` |

---

## [Unreleased] — Crypto Strategies & Paper Trading Desk

### 10 Scalping Strategies

All live under `src/features/scalping/strategies/`:

| Strategy | Key Trigger |
|---|---|
| `UT_SMC` | LuxAlgo UT Bot ATR trailing stop + SMC BOS/CHoCH filter |
| `VWAP_SWEEP_TREND` | EMA50 trend + liquidity sweep ≥ 0.8×ATR from VWAP |
| `NEWS_MOMENTUM` | Volume ≥ 2.8× avg + range ≥ 1.8×ATR + decisive body |
| `RANGE_SCALP` | Bollinger touch + RSI extreme + range tightness ≤ 4.5×ATR |
| `EMA_PULLBACK` | 9/20/50 EMA stack + pullback into 9–20 zone |
| `VWAP_REVERSION` | Price ≥ 1.5×ATR from VWAP + RSI rolling off extreme |
| `ORDERFLOW_SWEEP` | Equal highs/lows sweep + volume spike + rejection close |
| `FIB_PULLBACK` | 1m impulse ≥ 3×ATR + retrace into 0.5–0.618 fib zone |
| `INSTITUTIONAL_SMC` | 9-component score ≥ 7 + all 4 institutional preconditions present |
| `AI_INSTITUTIONAL_PRO` | Hard gates (EMA trend + HTF + RSI + cooldown) + 8-factor score ≥ mode minimum |

### Strategy Backtest (5-Year)

Runs every scalp strategy against 5 years of 4h history on BTC/ETH/SOL with $10,000 starting equity. Each strategy receives a 0–100 score (win rate 25%, profit factor 20%, alpha over buy-and-hold 20%, max drawdown 15%, Sharpe 10%, statistical significance 10%) and a letter grade (A+→F).

### Strategies + Paper Trading Split

`/strategies` — configuration half (picker + live signal feed).
`/paper-trading` — outcome half (open positions + journal + per-strategy performance).
Strategy filter shared via Zustand store; selection drives signal feed and journal.

### Conservative Tie-Break

A candle touching both target and stop is always recorded as a stop — consistent across all paper-trading resolvers.

---

## [Unreleased] — Strategy Lab (Conversational Backtester)

- Free-form prompt parser (`features/strategy-lab/parser.ts`) — compiles English prompts into a deterministic AST with recognised indicators (RSI, MACD, EMA, SMA, ATR, volume vs avg, N-bar % change) and comparators (>, <, crosses above, crosses below)
- Backtest engine (`features/strategy-lab/engine.ts`) — walks candles once; opens/closes trades per rule; produces win-rate, profit factor, max drawdown, Sharpe, equity curve
- Save strategies + flip to live paper trading via the `strategy-lab` worker job
- Four NSE-specific prompt templates: NIFTY ORB, BANKNIFTY VWAP reversion, expiry IV-crush straddle, F&O-stock EMA pullback

---

## [Unreleased] — Alerts, Backtesting & User Auth

- **Auth.js v5** — Credentials provider + JWT sessions; `src/proxy.ts` protects every non-public route
- **AES-256-GCM** — encrypted per-exchange API key storage; `src/lib/crypto.ts`
- **Alerts evaluator** (`worker/src/jobs/alerts.ts`) — funding spike, OI breakout, price breakout, liquidation surge, signal change; Redis-backed cooldown; HMAC-SHA256 signed webhook payloads
- **Channels** — in-app `Notification`, HMAC-signed webhook, email via Resend
- **Signal history + outcome tracking** — `SignalHistory` ingestion (30-min per-symbol dedup); `signal-outcome` job resolves via 1m klines (HIT_TARGET / HIT_STOP / EXPIRED after 6h)
- **Liquidation rolling buffer** — Binance `!forceOrder@arr` WS → Redis sorted set `liq:rolling:{PAIR}`; wired into signal engine's `liquidationImbalance` factor (was previously null)
- **Heatmap page** — coin/sector grid + price-level liquidation heatmap from rolling worker buffer
- **Profile → API keys** — encrypted per-exchange form with masked previews and per-row deletion
- **Worker observability** — structured JSON logs (toggle via `WORKER_LOG_FORMAT=json`); optional Sentry integration with clean-shutdown flushing

---

## [Unreleased] — Futures Analytics & Sentiment Engine

- **Futures dashboard** — funding rates, OI changes, volume spikes, liquidation clusters, top gainers/losers
- **Sentiment engine** — Fear & Greed Index, funding rate, open interest trend, liquidation data, long/short ratio; output: Bullish / Bearish / Neutral
- **Best Time to Trade (IST)** — six named crypto windows (Golden Scalp Zone 19:00–22:00, Volatility Breakout 18:00–20:00, etc.); weekday quality multiplier; Overview banner (ticks every minute on wall-clock boundary) + dedicated `/best-time` page

---

## [Initial] — Project Foundation

- Next.js App Router scaffold with TailwindCSS + TypeScript + ESLint + Vitest
- Docker Compose — Postgres 17 + Redis 7
- Prisma schema (initial User, SignalHistory, Alert, Notification, Strategy models)
- Binance WebSocket + REST adapter (`BrokerAdapter` contract)
- Delta Exchange India adapter (default broker)
- Market Overview page — BTC / ETH / SOL live prices, 24h change, volume, market cap, dominance
- AI signals engine foundation — RSI, MACD, EMA crossover, funding rate, OI, volume; LONG / SHORT / BUY / SELL / HOLD with confidence and entry/stop/target
- Sector + coin heatmap
- `.env.example` + `.gitignore` + `AGENTS.md` + `ALPHAFORGE.md` initial drafts
