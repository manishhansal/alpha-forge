# Phase 3N — Current-Branch Audit

**Branch:** `refactor/improve-ml-service`
**Phase:** 3N — Indian Market Paper-Trading Validation & Production-Readiness Gate
**Nature:** VALIDATION phase. No new predictive model. The purpose is to determine
whether the end-to-end stack is trustworthy against real Indian-market data, and to
add the paper-trading + evidence + readiness-gate layer that lets that judgement be
made honestly and reproducibly.

This audit traces actual call paths (not filenames) across `ml-service/src`, the
`data-service/` microservice, and the Next.js app (`src/`), and records what is real
vs stub, what is paper-safe, where the gaps are, and — critically — what can and
cannot be validated **in this environment**.

---

## 0. Environment reality (determines what "evidence" is possible)

Verified directly (`python3` + imports):

| Dependency | State | Consequence |
|-----------|-------|-------------|
| Python | 3.14.6 | ok |
| numpy / scipy / pandas / httpx / fastapi / pydantic | **present** | decision/shadow/execution/portfolio runnable |
| talib / torch / sklearn | **ABSENT** | `server.py`, `models.market_regime`, `src/validation` (sklearn) fail import — heavy model inference not runnable here |
| yfinance | **ABSENT** | Tier-3 fallback provider not runnable here |
| sqlalchemy | **ABSENT** | Tier-2 PostgreSQL provider not runnable here |
| `DATA_SERVICE_URL` | **unset** | Tier-0 Scrapling data-service not reachable |
| Network to Angel One / Upstox / NSE / BSE / Yahoo | **unavailable** | Tier-1/Tier-3 live acquisition not reachable |

**Direct consequence for §10 / §22 / §57:** a genuine "latest Indian-market trading
session" run producing `REAL_MARKET_DATA` **cannot be performed in this environment** —
every acquisition tier is either credential-gated, network-gated, or has an absent
dependency. Phase 3N must therefore validate the stack's *correctness, safety, PIT
discipline, and evidence machinery* on `SYNTHETIC_DATA` / `REPLAY_DATA` (clearly tagged),
and report the real-market economic question as **`INSUFFICIENT_EVIDENCE` /
`EVIDENCE_LIMITED`** rather than fabricating a session. Fabricating a session would itself
be a §64 hard-stop violation ("fabricated historical data", "paper results contaminated
by synthetic data").

---

## 1. Provider / data-acquisition layer

The acquisition layer spans three codebases, loosely wired over HTTP:

### 1a. Next.js app `src/lib/market-data/` (TypeScript) — authoritative provider hierarchy
- `types.ts`: `ProviderId = "scrapling" | "angel_one" | "upstox" | "yahoo"`;
  `PROVIDER_PRIORITY = [scrapling, angel_one, upstox, yahoo]`. Explicit comment:
  **"There is NO 'nse' provider. Direct NSE data acquisition is prohibited in production."**
- `registry.ts` `bootstrapRegistry()`: registers scrapling (priority 0, enabled only if
  `DATA_SERVICE_URL` set), angel_one (1), upstox (2), yahoo (3). Failover via
  `failover.ts` `withFailover()`.
- **This exactly matches the Phase 3N required hierarchy** (Tier 0 Data Service → Tier 1
  Angel One → Tier 2 Upstox → Tier 3 Yahoo). No new NSE scraper needed or present in the
  production layer. ✔ constraint §2 satisfied by existing code.

### 1b. `data-service/` (Python/FastAPI, port 8200) — the designated NSE tier
- `scrapers/historical.py`: real NSE Bhavcopy (`_fetch_nse_daily` from
  `nsearchives.nseindia.com`), BSE Bhavcopy, NSE/BSE intraday charting. This is the
  **designated data-service tier** where NSE acquisition legitimately lives. Do NOT
  reintroduce NSE elsewhere.
- `brokers/upstox_client.py`: read-only Upstox v2 market-data client (quotes, historical
  candles). Token from `UPSTOX_ANALYTICS_TOKEN`/`UPSTOX_ACCESS_TOKEN`, **server-side only**;
  docstring: "No token is ever exposed to the browser." NO order-placement methods.
- No Angel One client in Python — Angel One is TypeScript-only.

### 1c. `ml-service/src/training/market_data_client.py` (Python) — ML acquisition client
- Real 4-tier chain in `MarketDataClient.get_ohlcv()`: Tier 0 `ScraplingDataClient`
  (→ data-service) → Tier 1 `AlphaForgeAPIClient` (→ Next.js `/api/in/*`, i.e. Angel/Upstox
  normalized) → Tier 2 `PostgreSQLDataClient` → Tier 3 `YFinanceFallbackClient`.
- Row-level `DataQuality` tagging (GOOD/STALE/INVALID/SUSPICIOUS) + `filter_quality()`.

### 1d. Canonical provider contract
- `data-service/src/core/schemas_v2.py` (version "2.0.0") is the **richest existing
  provider contract**: `DataSource` enum, `DataProvenance` (`dataObservationId`,
  `source`, `sourceVersion`, `eventTimeMs`/`receivedAtMs`/`availableAtMs`,
  `normalizationVersion`, `isFallback`, `fallbackReason`), `ProviderHealthV2`
  (status/availability/circuit state), `DataQualityGate` (`signalEngineAllowed`),
  `CandleV2` (OHLC invariant validators), `OptionChainSnapshotV2`, `InstrumentV2`
  (with `activeFrom`/`activeTo` PIT validity), `DataGapEvent`.
- **Gap:** the required Phase 3N field *names* (`provider_version`, `snapshot_id`,
  `source_status`, `schema_version`) exist only as camelCase near-equivalents, and the
  contract is **not uniformly enforced** — the TS `types.ts` canonical types carry only
  `provider` + `fetchedAt`, so full provenance is not propagated to the ML/UI layer.
- **Gap (GATE-001, pre-existing):** `DataQualityGate` exists (`gate_router.py`) but is
  **not called by the TS signal engine** — the contract is defined but not wired
  end-to-end.

**Phase 3N action (Task 2):** rather than duplicate any of this, add a thin canonical
**provider-response contract + fallback-classification** module in ml-service that
normalizes onto the existing `schemas_v2` concepts and records every fallback event with
explicit states (PRIMARY/FALLBACK/PARTIAL/STALE/INVALID/UNAVAILABLE). No new NSE scraper.
No silent provider merge.

---

## 2. PIT / data-quality infrastructure (`ml-service/src/data/`) — REAL, reusable

All modules here are point-in-time metadata stores (no network calls; return
`DATA_UNAVAILABLE`-style sentinels rather than fabricating):

- `point_in_time.py`: `PointInTimeRecord.is_available_at(t)` — the core PIT primitive.
- `corporate_actions.py`: `CorporateActionRecord.was_known_at/was_available_at`.
- `fno_eligibility.py`: `FnOEligibilityRecord.was_eligible_on`, `FnOBanRecord`, `BanStatus`.
- `historical_universe.py`: `UniverseMembership`, `AvailabilityValue` (is_known/true/false).
- `instrument_master.py`: `HistoricalInstrumentRecord`, `LotSizeStatus` (OK /
  DATA_UNAVAILABLE / APPROXIMATE). **Gap:** no complete historical lot-size DB —
  `KNOWN_LOT_SIZE_CHANGES` is a hand-maintained partial table; returns APPROXIMATE/UNAVAILABLE
  where unknown (correct fail-closed behaviour, but limits F&O historical accuracy).
- `data_quality.py`, `dataset_version.py`, `lineage.py`: reporting / provenance stores.
- `execution/market_calendar.py` `NSECalendar`: built-in NSE holidays 2020-2027,
  session hours (09:15–15:30 IST), monthly/weekly expiry, `is_trading_day` returns
  `INSUFFICIENT_EVIDENCE` for uncovered years and `DATA_APPROXIMATE` otherwise. Reusable
  for §11 market-calendar validation.

**Phase 3N action (Task 3):** build the data-quality + PIT *validation* layer as a thin
orchestrator over these existing stores + `NSECalendar`, adding OHLCV-quality checks and a
no-lookahead asserter. Do not duplicate the stores.

---

## 3. Execution subsystem (`ml-service/src/execution/`) — REAL

- `cost_model.py`: full date-versioned Indian cost stack — equity (brokerage cap ₹20,
  STT delivery 0.1%/intraday 0.025% sell, exchange 0.0000345, GST 18%, SEBI, stamp
  0.015% buy) and F&O (futures/options STT on notional/premium, pre-2023 vs post-2023-10-01
  schedules). `CostScheduleRegistry.get_equity_schedule(trade_date)` is **PIT-correct**
  (never applies a future schedule to a historical trade). ✔ §31.
- `slippage.py`: `FixedBPS`, `SpreadProxy` (OBSERVED bid-ask → Level A; HL-range proxy →
  Level C), `VolatilityParticipation`/`MarketImpact` (parametric, explicitly Level C,
  "NOT empirically calibrated"). Every estimate carries `spread_status` + `data_evidence`.
  ✔ §32 — proxy is never presented as observed.
- `fill_engine.py`: handles NEXT_OPEN/NEXT_BAR/NEXT_VWAP/STOP/LIMIT/SAME_CLOSE; **gaps**
  (STOP gap-through vs intrabar), **circuits** (`_check_circuit_limits` on price bands),
  **partial fills / liquidity** (ADV participation cap), **F&O ban** (rejects new
  positions), **expiry** (rejects expired), SAME_CLOSE look-ahead guard. ✔ §29/§30.
- `backtest_engine.py`: the ONE Phase 3G simulator (`BacktestEngine`, `BacktestConfig`,
  `BacktestResult.pnl_reconciled`).
- `position_accounting.py`: `TradeAccountingLedger`, `Position`, `PortfolioState`,
  `TurnoverStats` — real position/PnL/turnover accounting.

---

## 4. Shadow subsystem (`ml-service/src/shadow/`) — REAL (Phase 3M), NO broker

- `ShadowExecutionEngine.execute(...)` calls `assert_not_live(mode)` first, only executes
  `EXECUTION_PLANNED` decisions, records via idempotent append-only `ShadowLedger`, and
  reaches the Phase 3G simulator through `rl.SimulatorBridge` (no second simulator).
- `ShadowOrder.__post_init__` also calls `assert_not_live`. `ShadowMode` = RESEARCH/SHADOW/PAPER
  (no LIVE). Reconciliation errors are `None` when inputs absent (never fabricated).
- **Gap for Phase 3N:** shadow is a single-decision executor. There is **no session-level
  paper-trading engine** (multi-order lifecycle CREATED→...→CLOSED, restart recovery,
  session manifest, end-of-day reconciliation). This is the main net-new Phase 3N work
  (Tasks 5–6), built by orchestrating the existing shadow + execution + decision contracts.

---

## 5. Decision subsystem (`ml-service/src/decision/`) — REAL (Phase 3M)

- `DecisionPipeline.evaluate(PipelineInputs, ...)` — 12-stage fail-closed orchestrator;
  `normalize_mode` rejects LIVE at entry. `DecisionState` machine has SHADOW_EXECUTED /
  PAPER_EXECUTED but **no LIVE_EXECUTED**. `set_state` enforces valid transitions.
- `provenance.py`: `assert_not_live`, `LIVE_MODE_TOKENS`, `ALLOWED_DEPLOYMENT_MODES =
  {RESEARCH, SHADOW, PAPER}`, `ReplayManifest.replay_id` (deterministic),
  `DecisionProvenance.is_valid` (requires manifest + data_snapshot_id + feature_version).
- **Observation:** `PipelineInputs` is a bundle of *pre-computed* predictor outputs — the
  pipeline sequences + gates, it does not itself run talib-broken models. This is what
  keeps decision/shadow import-clean and is the correct integration seam for Phase 3N.

---

## 6. Portfolio subsystem (`ml-service/src/portfolio/`) — REAL

`eligibility.py` (liquidity ADV/price, F&O ban, staleness, calibrated-prob required,
negative-EV), `constraints.py` (weight bounds, exposure feasibility), `risk_model.py`
(Ledoit-Wolf/OAS covariance, CVaR — real math), `sizing.py` (fractional Kelly, inverse-vol,
vol-targeting, risk-budget). ABSTAIN/INSUFFICIENT_EVIDENCE never become ELIGIBLE. Portfolio
overrides model conviction on constraint breach. ✔ §33.

---

## 7. Lifecycle subsystem (`ml-service/src/lifecycle/`) — REAL, human-gated

- `promotion.py` `PromotionOrchestrator.promote(...)`: fail-closed; if the gate outcome is
  `HUMAN_APPROVAL_REQUIRED` it writes an intent marker and **does not auto-promote** — a
  human must call `confirm_promotion(...)`. `gates.py` `PromotionPolicy.high_impact_requires_human=True`.
- `monitoring/model_registry.py`: on DEGRADED/DISABLED it emits a `RetrainingRecommendation`
  + alert; **never auto-retrains** (human ack via endpoint). ✔ §3 / §J.

---

## 8. Live-broker & secret-exposure audit (constraint §3, §42, §J)

- **No reachable live-broker order path** anywhere in ml-service. Searched
  place_order/submit_order/cancel_order/modify_order/SmartConnect/kiteconnect/angelbroking/
  zerodha/broker_api/live_order. Every hit is one of: (a) read-only historical DATA source
  naming (Angel/Upstox as data feeds), (b) test-file *forbidden-token* guardrail lists, or
  (c) the LIVE fail-closed guards themselves. Live mode is rejected at three independent
  choke points (pipeline entry, shadow order construction, shadow engine execute).
- **No frontend secret exposure.** `NEXT_PUBLIC_.*(TOKEN|SECRET|KEY|PASSWORD)` search →
  zero matches. All broker secrets read server-side via non-public `process.env.*`
  (`src/lib/env.ts`, `src/services/india/angelone/index.ts`, upstox providers/OAuth routes).
  data-service Upstox token server-side only; CORS locked to localhost:3000.

---

## 9. Signal families (constraint §18–§21) — to be enumerated in Task 4

Signal-producing components exist across `ml-service/src` (gex.py, greeks.py,
iv_regime_classifier.py, price_forecaster.py, ranking/, meta/, models/, rl/) and the
Next.js `src/features/ai-signals/` + `src/services/india/scanner/`. Phase 3N Task 4 will
enumerate them by searching the repo (not assuming names), define the canonical signal
aggregation contract, and route conflict resolution through the existing DecisionPipeline
rather than a new voting scheme.

---

## 10. Audit conclusions → Phase 3N plan

| Area | State | Phase 3N action |
|------|-------|-----------------|
| Provider hierarchy | correct in TS layer; contract rich but not uniformly enforced | Task 2: canonical provider-contract + fallback-classification (reuse schemas_v2), no new NSE scraper |
| PIT stores | real + reusable | Task 3: thin validation layer over them + no-lookahead asserter |
| Execution (cost/fill/slippage) | real, PIT-correct, evidence-tagged | reuse as-is |
| Shadow (single decision) | real, no broker | Task 5–6: build session-level paper engine on top |
| Decision pipeline | real, fail-closed, LIVE forbidden | reuse as integration seam |
| Portfolio / lifecycle | real, human-gated | reuse; confirm no auto-promote/retrain |
| Live-order path | none reachable | confirm + regression-test |
| Frontend secrets | none exposed | confirm + audit-test |
| **Real Indian-market session** | **not reachable in this env** | **report INSUFFICIENT_EVIDENCE honestly; validate on tagged SYNTHETIC/REPLAY** |

**Overriding rule for the rest of Phase 3N:** build the paper/evidence/gate machinery so
that the readiness decision is *honest*. Because no real-market data tier is reachable
here, the final economic-readiness verdict will be evidence-limited. Correctness, safety,
PIT discipline, idempotency, recovery, and the gate logic themselves ARE fully validatable
and will be tested on clearly-tagged synthetic/replay data.
