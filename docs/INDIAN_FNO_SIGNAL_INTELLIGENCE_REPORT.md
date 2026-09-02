# AlphaForge — Indian F&O Signal Intelligence Report

**Document:** Phase 43–45 Final Signal Intelligence Report  
**Milestone:** Professional Indian F&O Signal Intelligence Engine  
**Generated:** 2026-09-02  
**Prepared by:** Chief Quantitative Researcher / Principal Quant Engineer / Indian F&O Market Microstructure Specialist  

---

## Executive Summary

This report documents the complete Signal Intelligence Engine built across Phases 1–45. The primary purpose was not to add more indicators, but to build **measurement infrastructure** that can answer definitively:

- What was the actual Indian F&O universe?
- Which strategy generated each signal?
- How many genuine opportunities existed vs. captured vs. missed?
- Does ML independently improve strategy outcomes?
- Are paper trades faithful representations of signal performance?

**Current system status:** All infrastructure is built and tested. Live production metrics are pending sufficient OOS trade history. No strategy has been promoted to LIVE_CANDIDATE status — this requires evidence, not assumption.

---

## 1. Universe Coverage

**Implementation:** `src/lib/signal-intelligence/fno-universe.ts`

### F&O Universe Composition

| Category | Count |
|----------|-------|
| NIFTY Index | 1 |
| BANKNIFTY Index | 1 |
| FINNIFTY Index | 1 |
| MIDCPNIFTY Index | 1 |
| F&O Stocks (NSE eligible) | ~200+ |
| **Total Active** | **~204+** |

### Coverage Requirements

A signal session report is **INVALID** when:
- Universe coverage < 80% of expected instruments were evaluated
- Coverage snapshot not recorded for the session
- Data quality level is MISSING or STALE

### Known Gaps

- Lot sizes are not yet populated from live instrument master (requires Angel One or Upstox session)
- Dynamic liquidity filtering (ADTV threshold) is a static inclusion by default
- SENSEX not yet included (BSE instruments require separate provider)

---

## 2. Data Quality

**Implementation:** `DataQualityMetadata` in `src/lib/signal-intelligence/types.ts`

### Data Quality Levels

| Level | Meaning | Action |
|-------|---------|--------|
| COMPLETE | All required fields present and fresh | Normal operation |
| PARTIAL | Some optional fields missing | Signal proceeds with reduced confidence |
| STALE | Data older than acceptable threshold | Signal flagged; confidence penalty applied |
| MISSING | Required data absent | Signal REJECTED |
| ESTIMATED | Values interpolated | Marked in attribution |

### Provider Priority (unchanged)

AngelOne (1) → Upstox (2) → NSE (3) → Yahoo (4)

---

## 3. Signal Source Distribution

**Implementation:** `src/lib/signal-intelligence/signal-source-registry.ts`

### Reporting Buckets

| Bucket | Sources | Leaderboard Eligible |
|--------|---------|----------------------|
| OFFICIAL_STRATEGIES | 9 India F&O strategies | **YES** |
| SCANNER | SCANNER_HIT, FNO_TREND | No |
| MANUAL | DAILY_PICK, AI_SIGNAL | No |
| ML | ML_REGIME, ML_STOCK_RANKER | No |
| BASELINE | TECHNICAL_BASELINE | No (research only) |
| FALLBACK | LEGACY sources | No |
| **UNKNOWN** | **Unregistered sources** | **ERROR — investigate** |

### Critical Rule — Generic Signal Masking (Phase 2 Regression Fixed)

The following source IDs are now **explicitly classified as non-strategy**:
- `technical`, `generic`, `fallback`, `heuristic`, `baseline`
- `AI_SIGNAL` → MANUAL (not STRATEGY)
- `TECHNICAL_BASELINE` → RESEARCH_ONLY (never in production)

**Regression test:** `tests/lib/signal-intelligence/signal-source-registry.test.ts`

---

## 4. Signal Quality Vector

**Implementation:** `src/lib/signal-intelligence/signal-quality-vector.ts`

Each signal now carries a 14-component quality vector instead of a single confidence score:

| Component | Weight | Description |
|-----------|--------|-------------|
| marketContext | 10% | NIFTY/BANKNIFTY/breadth alignment |
| regimeFit | 10% | Strategy-declared regime compatibility |
| mtfAlignment | 8% | Daily → 1H → 15m → 5m alignment |
| structureQuality | 8% | BOS/CHoCH/FVG market structure |
| momentumQuality | 8% | ROC/RSI/ADX/EMA slope |
| volumeQuality | 10% | RVOL, time-of-day adjusted |
| volatilityFit | 6% | ATR percentile, VIX regime |
| liquidityQuality | 10% | Spread, depth, execution quality |
| derivativesConfirmation | 10% | PCR, OI, max pain alignment |
| relativeStrength | 6% | vs NIFTY and sector |
| mlProbability | 5% | Calibrated ML model output |
| expectedValue | 5% | EV = P(win)×E[win] − P(loss)×E[loss] − costs |
| executionQuality | 2% | Time-of-day prior |
| dataQuality | 2% | Data completeness and freshness |

---

## 5. Signal Recall

**Status:** `NOT_INDEPENDENTLY_VALIDATED` — requires historical candle replay pipeline.

**Documented Limitation:**  
The recall engine (`src/lib/signal-intelligence/signal-lifecycle.ts`) uses a 20% conservative miss-rate estimate as a baseline. True independent recall requires the backtest event engine running against historical 5-min candles for each strategy.

**Action Required:** Deploy the backtesting event engine for each strategy against 90 days of historical NSE data to compute true recall.

---

## 6. Signal Precision

Computed in `src/lib/signal-quality/engine.ts` (existing 20-phase engine).

### Definition
- **True Positive (TP):** Signal fired → target reached before stop
- **False Positive (FP):** Signal fired → stop reached before target
- Tie-break rule: candle touches both SL and TP → SL wins (conservative)

---

## 7. False Positive Rate & Miss Rate

- FP Rate = FP / (FP + TN) — requires TN count from independent opportunity detector
- Miss Rate = 20% conservative estimate (baseline) until independent detector deployed

**Note:** These metrics are marked `NOT_INDEPENDENTLY_VALIDATED` in all recall reports.

---

## 8. Duplicate Rate

**Implementation:** `src/lib/signal-intelligence/conflict-resolver.ts` — `clusterSignals()`

### Known Correlation Groups

| Cluster | Strategies | Reason |
|---------|-----------|--------|
| BREAKOUT_GROUP | OPENING_BREAKOUT + MOMENTUM + VOLUME_BREAKOUT | Same price breakout |
| OPTIONS_FLOW_GROUP | LIQUIDITY_EDGE + MAX_PAIN_GRAVITY + PCR_EXTREME | Same option chain data |
| OI_SIGNALS_GROUP | OI_BUILDUP + LIQUIDITY_EDGE | OI is input to ILE |

**Deduplication:** Clustered signals produce ONE paper trade (the highest-scoring representative), not multiple.

---

## 9. Risk Approval Rate

**Implementation:** `src/lib/risk/portfolio-risk.ts` (existing PortfolioRiskEngine)

Pre-trade gate: kill switch → drawdown → VaR → exposure → correlation → budget → sizing

---

## 10. Paper Execution Rate

**Implementation:** `src/lib/signal-intelligence/paper-trading-fidelity.ts`

### Realistic Execution Model (Phase 37 Fix)

Previous system: paper fill = candle close price  
New system: fill = mid + half-spread + market impact + latency drift

### Funnel Stages

```
OPPORTUNITIES_DETECTED
    ↓ (strategy detection rate)
SIGNALS_GENERATED
    ↓ (validation pass rate)
SIGNALS_QUALIFIED
    ↓ (risk approval rate)
RISK_APPROVED
    ↓ (execution rate)
PAPER_ORDERS_PLACED → FILLED
    ↓
WINNERS / LOSERS
```

---

## 11. P&L Reconciliation

Every paper trade is independently reconcilable via:
1. `PaperTrade` DB row with entry/SL/target/exitPrice
2. `SignalIntelligenceRecord` with full quality vector at signal time
3. `SignalLifecycleEvent` chain from DETECTED → EXITED

---

## 12. Regime Performance

Regime is inferred from:
- India VIX (primary)
- NIFTY % change
- Advance/Decline ratio

Regimes: STRONG_BULL / BULL / SIDEWAYS / VOLATILE / BEAR / CRASH / EXPIRY_DAY / HIGH_VOL / LOW_VOL

Per-strategy regime performance is tracked in the existing Signal Quality Engine (Phase 14).

---

## 13. Time-of-Day Performance

**Implementation:** `getTODBucket()` in signal-quality-vector.ts

| Bucket | Recommendation | Prior Score |
|--------|---------------|-------------|
| 09:15–09:20 | CAUTION | 0.65 |
| 09:20–09:30 | TRADE | 0.75 |
| 09:30–10:00 | TRADE | 0.80 |
| 10:00–11:00 | TRADE | 0.75 |
| 11:00–12:00 | CAUTION | 0.65 |
| 12:00–13:00 | CAUTION | 0.55 |
| 13:00–14:00 | CAUTION | 0.60 |
| 14:00–15:00 | TRADE | 0.70 |
| 15:00–15:20 | CAUTION | 0.55 |
| 15:20–15:30 | AVOID | 0.40 |

---

## 14. Instrument Performance

Tracked per instrument via `InstrumentQualityRow` in signal quality engine.

Preferred instruments: high RVOL, low spread, strong sector trend, OI buildup present.

---

## 15. Sector Performance

**Implementation:** `src/lib/india/sectors.ts` — 11 sectors tracked  
Sector relative strength computed against NIFTY.

---

## 16. Options Flow Performance

**Implementation:** `src/lib/signal-intelligence/derivatives-intelligence.ts`

### Critical Rule
Options flow is classified as:
- `OBSERVATION` — raw OI/PCR data
- `INFERENCE` — single data point supporting a direction
- `HIGH_CONFIDENCE_INFERENCE` — multiple confirming signals

**OI alone NEVER qualifies as HIGH_CONFIDENCE_INFERENCE.** Smart-money claims from OI require confirmation from at least one independent source.

---

## 17. ML Incremental Value

**Implementation:** `MLContribution` in signal quality engine

### Current Status

ML is evaluated across four layers:

| Layer | Description |
|-------|-------------|
| STRATEGY_ONLY | Base strategy without any ML |
| STRATEGY_PLUS_ML | + Stock Ranker confidence boost |
| STRATEGY_PLUS_META | + Meta-layer ensemble |
| STRATEGY_PLUS_ML_PLUS_RISK | + Risk predictor filtering |

**Known limitation (RCA from prior validation):**  
The TFT price forecaster receives `last_60_bars` data now (Bug 3 fixed) but no production caller currently supplies real 60-bar OHLCV arrays. Infrastructure ready; data pipeline integration incomplete.

### ML Promotion Rule (Phase 24)

ML only influences live decisions when it demonstrates:
1. OOS improvement over base strategy
2. Cost-adjusted improvement (not just gross return)
3. Calibration (Brier score < 0.25)
4. Stability (no drift > 2σ over 50-trade window)

---

## 18. Signal Calibration

**Implementation:** `computeExpectedValue()` with logistic calibration shrinkage

Raw strategy confidence ≠ win probability.  
Calibration applied: 35% shrinkage toward base rate 0.5.  
Replace with per-strategy Platt calibration curves once ≥ 50 OOS trades available per strategy.

---

## 19. Opportunity Clustering

**Implementation:** `src/lib/signal-intelligence/conflict-resolver.ts`

Three strategies firing on the same NIFTY breakout = ONE opportunity, not three confirmations.

Cluster confidence = geometric mean of member confidences (not sum).

---

## 20. Signal Attribution

Every resolved trade has a `SignalAttributionRecord` linking:
- Which features were present at signal time
- Which filters contributed (risk, ML, volume)
- Which model version was used
- What regime existed
- Which data provider supplied data

---

## 21. Strategy Correlation

Jaccard similarity of instrument sets used in signal quality engine (Phase 13).

High correlation pairs (>60% instrument overlap) are flagged as non-independent evidence.

---

## 22. Signal Decay

**Implementation:** `detectSignalDecay()` in signal-lifecycle.ts

States: HEALTHY → WATCH → DEGRADED → CRITICAL → DISABLED

**Important:** Decay detection requires minimum 10 resolved trades. No demotion on small samples. Rolling windows: 20, 50, 100, 250 trades.

---

## 23. Execution Quality

**New metrics (Phase 37):**
- Fill price includes spread + market impact + latency drift
- EOD square-off flagged as approximate
- Execution quality: REALISTIC / OPTIMISTIC / PESSIMISTIC

---

## 24. Opportunity Clustering & Anti-Double-Counting

See Section 19. The `OpportunityCluster` DB model persists all cluster events for audit.

---

## Phase 44 — Strategy Scorecard

**Implementation:** `src/lib/signal-intelligence/strategy-scorecard.ts`

### Required Evidence for Each Status

| Status | Requirements |
|--------|-------------|
| RESEARCH | Concept only — no evidence |
| PROMISING | ≥ 10 trades, precision ≥ 45% |
| VALIDATED | OOS validated, ≥ 20 trades, positive expectancy |
| PAPER_CANDIDATE | ≥ 20 trades, precision ≥ 55%, positive EV |
| LIVE_CANDIDATE | All 8 production gates passed |
| DEGRADED | Decay detected (DEGRADED or CRITICAL state) |
| DISABLED | Kill switch triggered |
| INSUFFICIENT_EVIDENCE | < 10 resolved trades |

### Current Strategy Status (as of 2026-09-02)

All 9 official strategies are currently `INSUFFICIENT_EVIDENCE` or `RESEARCH` — insufficient OOS trade history for promotion. This is the correct state. Do not promote strategies without evidence.

---

## Phase 45 — Production Guard

**Implementation:** `evaluateProductionGates()` in strategy-scorecard.ts

### 8 Required Gates for LIVE_CANDIDATE

1. **MINIMUM_SAMPLE_SIZE** — ≥ 30 resolved trades
2. **OUT_OF_SAMPLE_VALIDATION** — OOS period validated
3. **WALK_FORWARD_VALIDATION** — Walk-forward stable
4. **COST_SENSITIVITY** — Profitable at 2× base cost
5. **REGIME_COVERAGE** — ≥ 3 distinct market regimes
6. **CALIBRATION** — Brier score < 0.25
7. **PAPER_TRADING_EVIDENCE** — ≥ 10 paper sessions
8. **EXECUTION_QUALITY** — Quality score ≥ 0.70

**Positive backtest P&L alone does NOT satisfy any gate.**

---

## New API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/in/signal-audit?date=YYYY-MM-DD` | Today's signal audit report |
| `GET /api/in/universe-coverage?date=YYYY-MM-DD` | F&O universe coverage snapshot |
| `GET /api/in/signal-quality?window=30` | 20-phase signal quality report (existing) |

---

## New Database Models

| Model | Purpose |
|-------|---------|
| `signal_lifecycle_event` | Full signal state machine audit trail |
| `universe_coverage_snapshot` | Per-session F&O universe coverage |
| `opportunity_cluster` | Anti-double-counting cluster records |
| `signal_intelligence_record` | Enriched signal taxonomy envelope |

---

## Known Remaining Limitations

1. **Independent recall detector** — requires full historical candle replay pipeline per strategy. Currently returns `NOT_INDEPENDENTLY_VALIDATED`.

2. **TFT price forecaster** — `last_60_bars` plumbed but no production caller supplies real OHLCV arrays yet.

3. **True OI freshness** — OI timestamps from Yahoo are approximate. Angel One provides real-time OI when configured.

4. **Scanner still uses legacy providers** — `src/services/india/scanner/engine.ts` imports from `yahoo`, `nse`, `angel` singletons directly (not through ProviderRegistry). Failover/circuit-breaker not applied to scanner signals. (Documented in SYSTEM_VERIFICATION_REPORT.md §9 Limitation 2.)

5. **Calibration curves** — Per-strategy Platt calibration requires ≥ 50 OOS trades each. Current implementation uses a global 35% shrinkage constant.

---

## Final Engineering Rule (Enforced)

> **NO DATA = NO CLAIM**  
> **NO OOS EVIDENCE = NO PROMOTION**  
> **NO CALIBRATION = NO TRUST IN PROBABILITY**  
> **NO LIQUIDITY = NO TRADE**  
> **NO RISK APPROVAL = NO EXECUTION**

AlphaForge now prefers **NO TRADE** over **LOW-QUALITY TRADE**.

---

*End of Report*
