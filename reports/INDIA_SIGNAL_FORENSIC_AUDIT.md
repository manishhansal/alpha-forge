# INDIA SIGNAL FORENSIC AUDIT

**Scope:** Complete Indian-market signal-generation pipeline (market data → outcome).
**Mode:** Read-only forensic audit. **No production logic was changed.**
**Date:** 2026-09-08
**Author:** Lead Quantitative Engineer (audit pass)

---

## ⚠️ Read this first — methodology and honesty boundary

This audit is a **static/structural** forensic pass over the source tree plus a **test-suite baseline run**. Every claim below is grounded in specific files and functions.

Sections **A, B, C, D** of the brief ask for *realized* statistics — win rate, expectancy, profit factor, Brier score, ECE, calibration slope, monotonicity, per-grade P&L, per-strategy Sharpe/Sortino, etc. **These cannot be produced from source code alone.** They require the resolved `PaperTrade` / `IndiaDailyPick` outcome rows from the production database, which are not present in this workspace (no populated DB dump beyond `dump.rdb` Redis state and a couple of small JSON ledgers in `reports/`).

Rather than fabricate numbers (explicitly forbidden by the brief), for A–D this report documents:

1. **The exact formula/measurement code** that *would* produce each metric, and where it lives.
2. **Whether that measurement is even wired to real outcomes** (in several cases it is not, or is fed fabricated proxy inputs).
3. **The structural reason the metric is unlikely to be monotonic/calibrated**, derived from the scoring code itself.
4. **The exact query/harness required** to compute the real numbers (see §19, Tests required).

Where a metric depends on data I could not access, it is labelled **`NOT MEASURABLE FROM SOURCE — requires outcome DB`**. This is a deliberate refusal to invent evidence.

---

## 1. Executive Summary

AlphaForge's Indian signal system is a large, carefully-commented codebase with genuinely strong *scaffolding* (provider failover, data-quality gates, walk-forward validation, triple-barrier labelling, Platt/isotonic calibrators, purged K-fold). **The problem is not missing machinery — it is that the rigorous machinery is largely disconnected from the live decision path, and the live path scores signals by heuristic confluence dressed up as probability.**

Top-level findings, ranked by impact:

1. **"Probability" is a hard-coded transform of a heuristic confidence, not a calibrated probability.** Both `expected-value-engine.ts` (`calibrateProbability`, linear shrinkage toward a literal base rate, clamped to [0.30, 0.82]) and `engine.ts` (`calibrateWinProbability`, a fixed logistic `1/(1+e^{-6(x-0.38)})`) manufacture win-probabilities from confluence scores. No trade outcomes feed either. The comments claim these "match observed F&O win-rates"; the code contains only literals.

2. **The ML service returns uncalibrated softmax, and the India AI path barely uses ML at all.** In `ml-service`, the fitted Platt/isotonic `CalibrationStore` and the meta EV/abstention engines exist but are **never called by `server.py`** — inference returns raw `predict_proba`. On the TS side, the India AI builder uses ML only as a ±0.06 confidence "rank boost" and a 35% regime tilt; the auto-trader passes `mlProbability: null` into the opportunity pipeline, so ML contributes at most 5% to a soft quality score and **never** to EV or the win-probability.

3. **Signal "quality" is confluence, not profitability.** The live `UnifiedIndiaSignal.qualityScore` is literally `confidence × 100`. The genuinely empirical engine (`src/lib/signal-quality/engine.ts`, which reads real `PaperTrade` outcomes and computes Brier/ECE/expectancy/monotonicity) is a **backward-looking report** — it never gates or ranks a live signal. The most sophisticated scorer, `signal-intelligence/signal-quality-vector.ts`, is **dead code** (exported only from the barrel, never consumed).

4. **At least five conflicting grade ladders** exist for the same S/A/B/C/D(/F) letters, with different thresholds (AI: S≥0.82; Daily Picks: S≥0.85; Signal Center scanner: S≥90/100; opportunity-engine tiers A_PLUS…REJECT; signal-center aggregator ordering). A grade "S" is not a single, comparable thing.

5. **RSI/ATR/EMA are re-implemented 4+ times** across files with independent code; PCR/max-pain are computed two different ways (raw vs `chain.analytics`).

6. **A real intra-bar look-ahead hazard in the India AI daily features:** during market hours the builder computes RSI(14), 20-day breakout, "widest range in 8 sessions", momentum and volume-thrust off `dailies.at(-1)` — the **in-progress, not-yet-closed** daily candle. There is no `slice(0,-1)`. This is not future leakage into training, but it means any evaluation treating these picks as decided on *completed* daily data overstates edge.

7. **Costs/slippage are frequently zeroed.** The Python EV engine defaults `cost = 0.0` when a `CostModel` is not injected; the India paper-trade resolver applies **no** cost or slippage at all (WIN fills exactly at target, LOSS exactly at stop); the TS EV cost model sets `marketImpact = 0` and `latencyFactor = 0` by default.

8. **Data-quality scaffolding is strong and should be preserved.** Provider lineage is correctly `scrapling (data-service) → angel_one → upstox → yahoo`; no direct NSE access exists in the TS market-data layer; circuit breakers, staleness gates, and cross-provider reconciliation are real. Two divergent stale-threshold tables and a discarded candle-provenance field are the main blemishes.

**The objective — fewer but statistically superior signals — is currently unmeasurable by the system itself**, because the empirical loop (outcomes → calibration → ranking) is not closed. The single highest-leverage change is to **close that loop**: fit calibration on realized outcomes, feed calibrated probability into EV, and gate/grade on that — *before* touching any threshold.

**Baseline test status:** TS 3131/3131 pass. Python 1748 pass / 19 fail / 3 uncollectable — all 19 failures verified to be **stale tests or missing optional deps**, not logic regressions (details in §19).

---

## 2. Architecture Map

Two largely independent "brains" exist. Understanding this split is essential.

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                  MARKET DATA LAYER (TS)                   │
                          │  registry → withFailover → providers                      │
                          │  scrapling(0) → angel_one(1) → upstox(2) → yahoo(3)        │
                          │  reconciliation.service (quality envelope, gates)         │
                          │  gate-client (Python DataQualityGate, fail-closed)        │
                          └─────────────────────────────────────────────────────────┘
                                     │ normalized OHLCV / quotes / option chain
        ┌────────────────────────────┴───────────────────────────────────────────────┐
        ▼                                                                              ▼
┌───────────────────────────────┐                          ┌──────────────────────────────────────┐
│  INDIA AI / STRATEGY (TS)      │                          │   ML SERVICE (Python, FastAPI :8100)   │
│  features/ai-signals/          │   ml-client (±0.06 boost │   regime / ranker / strategy / risk    │
│    india-builder → engine      │◄── + 35% regime tilt) ───│   returns RAW softmax (uncalibrated)   │
│  features/india/daily-picks/   │                          │   meta/{calibration,ev,abstention}     │
│  features/india/scalping/ ORB  │                          │     = IMPLEMENTED BUT NOT WIRED         │
│  services/india/scanner        │                          │   validation/{walk_forward,purged_kf}  │
└───────────────────────────────┘                          └──────────────────────────────────────┘
        │ AiSignal / DailyPick / ScannerHit
        ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  TWO PARALLEL DOWNSTREAM STACKS                                                         │
│                                                                                        │
│  (a) LIVE decision path:  auto-trader → runOpportunityPipeline (opportunity-engine)    │
│         → hard gates → EV → soft penalties → quality tier → sizing → PaperTrade         │
│                                                                                        │
│  (b) DISPLAY/aggregation: signal-center route → UnifiedIndiaSignal → aggregator        │
│         (clusters, top-opportunities)   [qualityScore = confidence*100]                │
│                                                                                        │
│  DEAD CODE (exported, never consumed): signal-intelligence/{multi-layer-engine,        │
│  signal-quality-vector, conflict-resolver.resolveSignalConflict, evaluateAbstention}   │
│                                                                                        │
│  REPORT-ONLY (empirical, reads outcomes, never gates): signal-quality/engine.ts        │
└──────────────────────────────────────────────────────────────────────────────────────┘
        │ PaperTrade rows (source "in:...")
        ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  OUTCOME TRACKING (TS worker jobs)                                                     │
│  resolveIndiaOpenTrades (india-scalper job) → WIN/LOSS/EXPIRED, pnlPct (NO costs)      │
│  india-daily-picks job → IndiaDailyPick TARGET_HIT/STOP_HIT                             │
│  india-eod-squareoff  +  finaliseAutoTradingSession  (TWO overlapping EOD closers)     │
│  signal-outcome.ts = CRYPTO ONLY (SignalHistory, SymbolEnum BTC/ETH/SOL)               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### The 27 named stages → source-of-truth map

| # | Stage | Source file(s) | Key symbol |
|---|-------|----------------|------------|
| 1 | Market data | `src/lib/market-data/{registry,failover,provider}.ts`, `providers/*` | `withFailover`, `bootstrapRegistry` |
| 2 | Data normalization | `src/lib/market-data/normalizer.ts` | `normaliseCandlesFrom*`, `utcToIst` |
| 3 | Feature engineering | `src/features/ai-signals/india-builder.ts`, `src/features/signals/indicators.ts`, `src/features/indicators/index.ts` | `dailyRsi/dailyAtr/breakoutScore/computeFuturesScreen` |
| 4 | India AI signal builder | `src/features/ai-signals/india-builder.ts` + `engine.ts` | `computeIndiaUniverse`, `buildIndiaSignal` |
| 5 | Scanner signals | `src/services/india/scanner/engine.ts`, `worker/src/jobs/india-scanner.ts` | `runScanner` |
| 6 | Daily Picks | `src/features/india/daily-picks/{builder,engine}.ts` | `buildDailyPicks`, `selectDailyPicks` |
| 7 | F&O Trend signals | `src/features/india/fno-trend-history/service.ts` | `snapshotFnoTrendScan` |
| 8 | AI Signals | `src/features/ai-signals/{engine,india-builder}.ts` | `getIndiaAiSignals` |
| 9 | Option-chain intelligence | `src/lib/signal-intelligence/derivatives-intelligence.ts`, `src/features/options/compute.ts` | `buildOptionChainIntelligence` |
| 10 | OI/PCR/max-pain logic | same as 9 + `chain.analytics` in market-data services | `classifyOIBuildup`, `maxPain` |
| 11 | Multi-Layer Signal Intelligence | `src/lib/signal-intelligence/multi-layer-engine.ts` | `aggregateLayerResults` **(dead)** |
| 12 | Signal Quality Vector | `src/lib/signal-intelligence/signal-quality-vector.ts` | `buildSignalQualityVector` **(dead)** |
| 13 | Expected Value Engine | `src/lib/opportunity-engine/expected-value-engine.ts`; `ml-service/src/meta/ev_engine.py` | `computeFullEV` **(live)**, `ExpectedValueCalculator` **(unwired)** |
| 14 | Probability Calibration | `src/lib/opportunity-engine/probability-calibration.ts`; `ml-service/src/meta/calibration.py` | `computeCalibrationReport` **(report-only)**, `CalibrationStore` **(unwired)** |
| 15 | Opportunity Engine | `src/lib/opportunity-engine/pipeline.ts` | `runOpportunityPipeline` **(live)** |
| 16 | Meta Decision Engine | `pipeline.ts` Stage 12 cascade (live); `ml-service/src/decision/pipeline.py` (unwired) | decision cascade |
| 17 | Abstention engine | `signal-quality-vector.ts:evaluateAbstention` (dead); `ml-service/src/meta/abstention.py` (unwired); pipeline tier D/REJECT (live) | — |
| 18 | Risk engine | `src/lib/risk/*`, `position-sizing-engine.ts` | `checkRiskBudget`, `computePositionSize` |
| 19 | Signal grading | `engine.ts`, `daily-picks/engine.ts`, `signal-center/route.ts`, `probability-calibration.ts` | 5 ladders (see §5) |
| 20 | Signal Center aggregation | `src/app/api/in/signal-center/route.ts`, `src/lib/india-signal-center/aggregator.ts` | `buildSignalCenterResponse`, `clusterSignals` |
| 21 | Paper-trading outcome tracking | `src/features/india/scalping/paper-trader.ts` | `resolveIndiaOpenTrades` |
| 22 | Signal outcome persistence | `worker/src/jobs/signal-outcome.ts` **(crypto only)**; `IndiaDailyPick` + `PaperTrade` (india) | `resolveIndiaOpenTrades` |
| 23 | ML training pipeline | `ml-service/src/training/{train_all,data_pipeline}.py` | `train_all`, `build_*_training_data` |
| 24 | Walk-forward validation | `ml-service/src/validation/walk_forward.py` | `WalkForwardValidator` **(used)** |
| 25 | Purged K-fold / CPCV | `ml-service/src/validation/{purged_kfold,combinatorial_cv,embargo}.py` | `PurgedKFold` **(imported, not called in training)** |
| 26 | Model monitoring | `ml-service/src/monitoring/{drift_detector,feature_monitor,performance_monitor}.py` | drift/perf monitors |
| 27 | Signal Quality UI/API | `src/app/api/in/signal-quality/route.ts` → `signal-quality/engine.ts`; `signal-center/route.ts` | report endpoints |

---

## 3. Signal Lineage Map (complete runtime path, per-stage I/O)

Below is the actual data flow for the **live India auto-trading path** (the one that produces `PaperTrade` outcomes). Each stage lists: source · function · inputs · outputs · transforms · hard-coded thresholds · fallback/missing/stale behavior · leakage notes.

### Stage 1 — Market Data
- **File/fn:** `market-data/registry.ts:bootstrapRegistry`, `failover.ts:withFailover`, `providers/{scrapling,angel-one,upstox,yahoo}.ts`.
- **In:** symbol/exchange/interval/range. **Out:** `MDQuote`, `OHLCVCandle[]`, `OptionChain`, each carrying `provider` + `fetchedAt` (candles do **not** carry provider — `normaliseCandlesFromAngel` does `void provider`).
- **Order (confirmed):** `scrapling(0, enabled only if DATA_SERVICE_URL set) → angel_one(1) → upstox(2) → yahoo(3)`.
- **Thresholds:** `RETRY_COUNT=3`, `FAILOVER_COOLDOWN_MS=10_000`, backoff ladder `[1,2,4,8,16,30,60]s`, circuit `CIRCUIT_OPEN_THRESHOLD=20`, `DEGRADED_THRESHOLD=60`.
- **Missing/stale:** empty arrays / null sentinels (never fabricates prices); Angel candle `volume ?? 0` (only benign zero-fill). `evaluateSignalGate` blocks STALE/INVALID for all non-UI consumers.
- **Leakage:** none in acquisition; IST↔UTC handled correctly (no DST — India has none).

### Stage 2 — Normalization
- **File/fn:** `normalizer.ts`. Candle `time` = **open** time (UTC sec). `snapToNseInterval` floors to session-anchored buckets (no forward assignment).
- **Leakage:** expiry parsed as midnight-UTC (`Date.UTC`) not IST-EOD — minor same-day-expiry comparison risk.

### Stage 3 — Feature engineering (India daily)
- **File/fn:** `india-builder.ts` — `dailyRsi(14)`, `dailyAtr(14)`, `computeApproxAdx(14)`, `sma(20/50/200)`, `breakoutScore(lookback 20)`, `computeFuturesScreen`, momentum 5d/10d, volume-thrust (last / 20-day avg).
- **In:** 1y daily candles + quote + option chain analytics. **Out:** factor set.
- **⚠️ Leakage hazard:** all use `dailies.at(-1)` = the **live, forming** bar during market hours. `macd_histogram` hard-coded `0` in the ML feature vector.
- **Fabrication:** `dailyAtr(...) ?? price*0.012` synthesizes ATR when missing.

### Stage 4 — India AI signal builder
- **File/fn:** `india-builder.ts:buildIndiaSignal` → `engine.ts:{indiaFactors, compositeScore, classifyAction, calibrateWinProbability, gradeFromConfidence}`.
- **Transforms:** `confidence = clamp(|score|·(0.52+0.48·coverage)+flowBonus, 0, 0.98)`; quant-prefilter fail → `×0.82`; ML rank boost `+[-0.06,0.06]`; grade `gradeFromConfidence` (S≥0.82); `winProbability = calibrateWinProbability(|score|, confidence)` (fixed logistic).
- **Out:** `AiSignal` {entry, stopLoss, takeProfits[3], grade, confidence, winProbability, positionSizingPct}.

### Stage 5 — Scanner signals
- **File/fn:** `services/india/scanner/engine.ts:runScanner` for `momentum|oi-buildup|pcr|iv-spike|volume-breakout|range-expansion`.
- **Out:** hits with a 0–100 `metric`; direction inferred from scanner type/OI-kind.

### Stage 6 — Daily Picks
- **File/fn:** `daily-picks/engine.ts:{buildDailyPicks, bucketScores, BUCKET_GATES}`; `builder.ts:{getIndiaDailyPicks, freezeAndTrack, trackPick}`.
- **Transforms:** bucket-weighted composites (MOMENTUM/SCALPING/POTENTIAL/INDICES_SCALP), tape filters, its **own** `gradeFromConfidence` (S≥0.85).
- **Freeze:** entry locked at selection; `trackPick` compares later marks only (no forward peek in tracker; leakage is upstream in features).

### Stage 7 — F&O Trend signals
- **File/fn:** `fno-trend-history/service.ts:{snapshotFnoTrendScan, trackOpenFnoTrendScans}`. Parses ADX/RSI out of a `metricLabel` regex → unmatched yields `0` (silent data loss). Live-quote tracking only (no look-ahead).

### Stage 8 — AI Signals (aggregate)
- **File/fn:** `india-builder.ts:getIndiaAiSignals` — caches last-session snapshot; dynamic TTL.

### Stage 9/10 — Option-chain / OI / PCR / max-pain
- **File/fn (interpretation):** `derivatives-intelligence.ts:{classifyOIBuildup, buildOptionChainIntelligence, classifyOptionsFlow}`.
- **File/fn (raw math):** `features/options/compute.ts:maxPain` (`argmin_K Σ payoff·OI`), `atmIv`, `pcrOi=putOi/callOi`. India path consumes pre-computed `chain.analytics.*` instead — **two definitions of the same concept**.
- **Thresholds:** OI freshness 15 min; PCR bull/bear 1.3/0.7 (factor) vs 1.2/0.8 (flow) vs 1.1/0.8/0.9/1.2 (ORB); price ±0.1%, OI ±1%/3%. `MAX_PAIN` explicitly labelled *contextual, not a target*. Discipline note: `classifyOptionsFlow` always warns OI flow is "observation, not smart money".
- **Stale:** Thursday-weekly-expiry is **hard-coded** (`buildExpiryContext`) — stale after NSE moved NIFTY expiry off Thursday.

### Stage 11 — Multi-Layer Signal Intelligence **(DEAD CODE)**
- `multi-layer-engine.ts:aggregateLayerResults` (12 layers, weights sum to 1.0, VETO logic). 6 of 12 layers have no `evaluate*` implementation. Never called outside the barrel.

### Stage 12 — Signal Quality Vector **(DEAD CODE)**
- `signal-quality-vector.ts:buildSignalQualityVector` — 14 dims, hard-coded composite weights (ML 5%, EV 5%, 90% heuristic confluence). Never consumed.

### Stage 13 — Expected Value Engine **(LIVE)**
- `expected-value-engine.ts:computeFullEV`. `grossEV = pWin·expectedWinPct − pLoss·expectedLossPct`, `netEV = grossEV − totalCostPct`.
- `pWin = calibrateProbability(rawConfidence, strategyId, baseRate)` = **linear shrinkage**, clamp [0.30,0.82]. `expectedWinPct = (0.6·rewardPct1 + 0.4·rewardPct2)·targetCaptureRate·maxWinPct`. `expectedLossPct = riskPct`.
- Cost model `DEFAULT_NSE_FNO_COST_MODEL`: brokerage ₹40, STT 0.000125, exch 0.00053, GST 0.18, SEBI 1e-6, stamp 3e-5, halfSpread 0.0003, **marketImpact 0, latencyFactor 0** (⇒ slippage 0 by default). `notionalINR = capital·0.02`.

### Stage 14 — Probability Calibration
- **TS live:** the empirical branch of `probability-calibration.ts:gradeOpportunityTier` is bypassed — pipeline passes `calibrationReport = null`, so only hard-coded prior thresholds run. `computeCalibrationReport` (Brier/ECE/Wilson/monotonicity) is **report-only**.
- **Python:** `meta/calibration.py:CalibrationStore` (Platt via sklearn `LogisticRegression(C=1e6)`, isotonic) is correct and persistable but **never fit/saved/loaded in production**; `server.py` returns raw `predict_proba`.

### Stage 15 — Opportunity pipeline **(LIVE orchestrator)**
- `pipeline.ts:runOpportunityPipeline`. Stage order: 0 data-valid → 1 regime → 2 detection → 3 MTF → 4 rel-strength/sector → 5 levels → 6 EV → 7 hard gates (failFast=false) → 8 soft penalties → 9 quality score → 10 tier → 11 sizing → 12 decision.
- Quality score weights (sum≈1): structure .12, momentum .10, volScore .10, volatility .08, liquidity .12, regime .12, MTF .10, relStrength .08, sector .08, **ML .05**, EV .05. `mlScore = mlProbability ?? 0.5`.

### Stage 16 — Meta decision **(LIVE = Stage-12 cascade)**
- Precedence: hard rejection → REJECT; drawdown halt (DD≥20%) → REJECT; tier D/REJECT → **ABSTAIN**; MTF conflict → WAIT; A_PLUS → STRONG_BUY; A/B → BUY; else WATCH. `shouldTrade = (STRONG_BUY|BUY) && sizeINR>0`.
- The India `decision-pipeline-config.ts` flags (`enableMetaCalibration` default true, etc.) and `decision-trace.ts` are **not referenced by `pipeline.ts`** — separate/unwired subsystem.

### Stage 17 — Abstention
- Live: only via tier D/REJECT. `evaluateAbstention` (rich, dead) and Python `abstention.py` (rich, unwired) exist but do not gate.

### Stage 18 — Risk engine
- `hard-gate-engine.ts` (minRR 1.5, maxSpread 0.5%, minNetEV 0, maxExposure 85%, maxOpenRisk 8%, dailyLoss 3%, maxSL 4%, minVolRatio 0.15). `position-sizing-engine.ts` multiplicative multipliers + caps. `risk/risk-limits.ts` (maxTradeRisk 2%, hard-kill daily 4%). Note pipeline pins `existingCorrelation:null` → correlation gate never fires; `isMarketOpen:true` always.

### Stage 19 — Grading → see §5 (five ladders).

### Stage 20 — Signal Center aggregation
- `signal-center/route.ts` builds `UnifiedIndiaSignal` from AI + 6 scanners + Daily Picks. `qualityScore = confidenceScore ?? round(confidence·100)`; `dataQualityScore` hard-coded 80/75. `aggregator.ts:clusterSignals` groups `symbol:direction:floor(t/30min)`; cluster grade = best member grade; cluster quality = mean.
- Regime/NIFTY/VIX in the response are `TODO`-stubbed to `null`/`UNKNOWN`.

### Stage 21/22 — Paper-trade outcome + persistence
- `scalping/paper-trader.ts:resolveIndiaOpenTrades` (india-scalper job): touch-both = **LOSS** (conservative), 6h `INDIA_MAX_TRADE_AGE_MS` → EXPIRED, **no cost/slippage**, `pnlPct` + `pnlUsd` (currency INR) → `PaperTrade`.
- EOD: `india-eod-squareoff.ts` (Redis-locked) **and** `auto-trader.ts:finaliseAutoTradingSession` both close OPEN→EXPIRED — overlapping.
- `signal-outcome.ts` resolves **crypto** `SignalHistory` only (`SymbolEnum` = BTC/ETH/SOL).

### Stage 23–26 — ML training / validation / monitoring — see §8, §9, §10.

### Stage 27 — Signal Quality UI/API
- `api/in/signal-quality/route.ts` → `signal-quality/engine.ts` (20-phase empirical report). `api/in/signal-center/route.ts` (display). Report-only.

---

## 4. Current Scoring Formulas (verbatim from code)

**India AI composite** (`engine.ts:compositeScore`):
```
score      = Σ(factor.score · weight) / Σ(usedWeight)         // only available factors count
confidence = clamp(|score| · (0.52 + 0.48·coverage) + flowBonus, 0, 0.98)
flowBonus  = min(flowAvailable/5, 1) · 0.08
```
Factor weights (`indiaFactors`): dayChange .14, breakout .13, marketRegime .12, futuresScreen .14, oiBuildup .10, scanner .10, superConfluence .10, news .08, trend .08, momentum .08, volume .08, pcr .08, maxPain .05, rsi .05, ivAtm .04, session .04. `OI_KIND_SCORE`: LONG_BUILDUP +1, SHORT_COVERING +0.6, SHORT_BUILDUP −1, LONG_UNWINDING −0.6.

**India AI confidence adjustments** (`india-builder.ts:buildIndiaSignal`):
```
penalised          = prefilterPassed ? rawConfidence : rawConfidence · 0.82
boostedConfidence  = clamp(penalised + mlBoost, 0, 0.98)      // mlBoost ∈ [-0.06, 0.06]
```

**Opportunity-engine quality score** (`pipeline.ts` Stage 9): weighted sum listed in §3 Stage 15, minus `softPenalties.totalScoreReduction` (capped 0.60).

**Signal Center quality** (`signal-center/route.ts`): `qualityScore = confidenceScore ?? round(confidence·100)` (AI/pick); `= clamp(|hit.metric|,0,100)` (scanner).

**Multi-layer composite** (dead, `multi-layer-engine.ts`): `Σ(layer.score·weight)/Σweight` over contributing non-VETO layers; weights MARKET_CONTEXT .12 / VOLUME .12 / others… (differs from the vector's weights — conflict).

**Signal Quality Vector composite** (dead, `signal-quality-vector.ts`): 14-term weighted sum, ML 0.05, EV 0.05, rest heuristic.

## 5. Current Grade Formulas (all five ladders)

| Ladder | File | Thresholds | Basis |
|--------|------|-----------|-------|
| AI signals | `ai-signals/engine.ts:gradeFromConfidence` | S≥0.82, A≥0.68, B≥0.54, C≥0.38, else D | confidence |
| Daily Picks | `india/daily-picks/engine.ts:gradeFromConfidence` | **S≥0.85**, A≥0.70, B≥0.55, C≥0.40, else D | confidence |
| Signal Center scanner | `signal-center/route.ts:strengthToGrade` | S≥90, A≥80, B≥70, C≥60, D≥50, else **F** | 0–100 metric |
| Opportunity tiers | `opportunity-engine/probability-calibration.ts:gradeOpportunityTier` | A_PLUS: netEV>0.5 & q>0.75 & liq>0.7 & regime>0.6; A/B/C/D/REJECT… | EV+quality+liq |
| Signal quality report | `signal-quality/engine.ts` grade validation | S:85 A:75 B:60 C:45 D:0 (on a different 0–100) | report |

Aggregator ordering (`aggregator.ts`): `GRADE_ORDER {S:6,A:5,B:4,C:3,D:2,F:1}` — treats letters from *any* ladder as comparable. **They are not.**

## 6. Current Probability Formulas

**TS #1 — `expected-value-engine.ts:calibrateProbability`:**
```
calibrated = rawConfidence · shrinkage + baseRate · (1 − shrinkage)   // shrinkage per-strategy ~0.55–0.62
return clamp(calibrated, 0.30, 0.82)
```
No logistic despite the name; parameters are literals in `STRATEGY_CALIBRATION`.

**TS #2 — `ai-signals/engine.ts:calibrateWinProbability`:**
```
logistic   = 1 / (1 + e^{−6·(x − 0.38)})          // x = |scoreMagnitude|
calibrated = 0.5 + (logistic − 0.5)·0.7
conviction = 0.82 + 0.18·confidence
return clamp(calibrated · conviction, 0.28, 0.82)
```

**TS #3 — ORB:** `winProbability = clamp(0.42 + confidence·0.4, 0, 1)` (`daily-picks/engine.ts`).

**TS #4 — signal-quality-vector (dead):** `calibrateWinProbability` shrinkage 0.65, clamp [0.30,0.80].

**Python — served:** raw `model.predict_proba(...)` softmax (`market_regime.py:_predict_ml`). No calibrator applied. The Platt/isotonic in `meta/calibration.py` is correct but unwired.

**Conclusion:** every live "probability" is a hand-tuned function of a heuristic confidence, clamped to a narrow band. None is fit to realized outcomes on the live path.

## 7. Current Signal Quality Formula

- **Live (`UnifiedIndiaSignal.qualityScore`)**: `= confidence × 100` (or scanner metric). **Pure heuristic passthrough.**
- **Opportunity-engine `qualityScore`**: weighted confluence (§3 Stage 15). Heuristic; ML 5%, EV 5%.
- **Empirical (`signal-quality/engine.ts`, report-only)**: 100-pt blend — `precision·20 + recall·10 + expectancy·20 + costRobustness·10 + calibration·10 + regimeConsistency·10 + sampleSize·5 + drawdown·10 + paperExec·5`. Precision/expectancy/calibration are **real** (from `PaperTrade`); recall/F1/MFE-MAE/filter-ablation/ML-contribution are **fabricated proxies** (e.g. `estimatedMissed = round(captured·0.2)`, `MFE = |pnl|·1.05`). This blend is never fed back to live ranking.

## 8. Current ML Contribution

- **India AI path:** ML enters as (a) regime tilt `blendedRegime = 0.65·heuristic + 0.35·mlRegime` (only if `mlAvailable`), and (b) per-stock rank boost `clamp((rankScore−50)/50, −0.1, 0.1)·0.6 ∈ [−0.06,0.06]`. `winProbability` never uses ML. `MLRiskResponse.prob_target_hit` and TFT `priceForecast.probability` are computed but **discarded**.
- **Opportunity/auto-trader path:** `mlProbability: null` is passed in ⇒ `mlScore` defaults to 0.5 and contributes 5% to a soft score; `mlUncertain` never fires; ML never touches EV or pWin.
- **Python service:** four tree models (regime XGB, ranker LGBM, strategy CatBoost, risk XGB×3) return uncalibrated softmax. Meta calibration/EV/abstention/decision engines are implemented but not invoked by `server.py`.
- **Net ML influence on a live India trade:** at most a ±0.06 confidence nudge + a 35% regime-score tilt. Effectively a tie-breaker, not a decision-maker.

## 9. Leakage Audit

**Training (Python) — mostly clean:**
- Feature/label temporal separation is correct: features `[i−lookback : i+1]`, labels `[i+1 : i+1+horizon]` (`data_pipeline.py`).
- **No scaler leakage** — tree models, no global `StandardScaler.fit_transform`. (Genuine strength.)
- Triple-barrier ATR is trailing-only (`labels/triple_barrier.py`).
- Walk-forward invariants asserted (`train_end<val_start<test_start`).

**Training — residual risks:**
- **Overlapping fixed-horizon labels are not t1-purged in training.** `PurgedKFold`/`build_t1_series`/CPCV are **imported but never called** in `train_all.py`; only a bar-count `EmbargoApplier` runs. Adjacent labels share `horizon−1` bars.
- `LABEL_VERSION` advertises "triple-barrier" but regime/ranker/strategy actually use **fixed-horizon** labels; only risk uses barriers.
- The structural leakage checker (`check_structural_leakage`) is not enforced on the array-build happy path; its "center_rolling_suspect" check is name-based only.

**Inference / rule engine (TS) — one real hazard:**
- **Intra-bar look-ahead:** India AI daily features read `dailies.at(-1)` = the forming bar during market hours (RSI, breakout, "widest range in 8", momentum, volume-thrust). No `slice(0,-1)`. Not training leakage, but inflates apparent edge in any daily-close-based evaluation.
- Data-quality gate and reconciliation correctly reject future-timestamped ticks (`FUTURE_TOLERANCE_MS=5_000`).
- Reconciliation treats a field missing on one provider as MATCH — a silently-dropped OI/field won't be flagged (data-integrity gap, not look-ahead).

**Verdict:** No catastrophic train/test leakage in the ML training path; the biggest realized-edge distortion is the intra-bar daily feature and the un-purged overlapping labels.

## 10. Calibration Audit

**What is measurable from source:** the *code paths*, not the numbers.

- **Live calibration = none fit to outcomes.** Both TS probability functions are static; the empirical `gradeOpportunityTier` branch is bypassed (`null` report); Python serves uncalibrated softmax; `CalibrationStore` never fit/loaded.
- **Calibration measurement code exists and is correct:** `probability-calibration.ts:computeCalibrationReport` computes bins, Wilson CIs, Brier, ECE, MCE, reliability curve, monotonicity; `signal-quality/engine.ts` Phase 7/8 computes Brier + ECE from real `PaperTrade.meta.confidence` vs `status==WIN`. These are report endpoints only.
- **Confidence buckets 50–55 … 80–85 predicted-vs-realized, Brier, ECE, slope, intercept, reliability curve, sample count:** **NOT MEASURABLE FROM SOURCE — requires outcome DB.** The harness to compute them already exists (`engine.ts` Phase 7 / `computeCalibrationReport`); it just needs to be run against production `PaperTrade` rows. See §19.
- **Structural expectation:** because live confidence is clamped to ~[0.28, 0.82] and never fit to outcomes, calibration is *a priori* unlikely to be well-calibrated — predicted probabilities are compressed and anchored by literals, not data. Expect systematic mis-calibration (likely overconfidence at the top band, given the "conviction" multiplier). This is a hypothesis to be confirmed by running the harness, not a measured result.

---

## 11. Strategy Profitability Audit

**Status: NOT MEASURABLE FROM SOURCE — requires the resolved `PaperTrade` / `IndiaDailyPick` outcome tables.**

The requested per-strategy metrics — total/executed/rejected/abstained signals, win/loss rate, expectancy, profit factor, avg winner/loser, avg R, Sharpe, Sortino, max drawdown, cost-/slippage-adjusted P&L, and breakdowns by regime / time-of-day / instrument / long-short / grade — are computed by `signal-quality/engine.ts` (Phases 4, 5, 9, 10, 14) from resolved outcomes. Without a populated DB, real numbers cannot be produced, and per the brief I will not fabricate them.

**What the code lets us say structurally:**
- Executed vs generated vs rejected vs abstained *is* tracked live: `computeSignalStats` in `aggregator.ts` and `IndiaDaySession` aggregates (`wins/losses/expired/winRate/maxDrawdownPct`). So counts are recoverable per day.
- **P&L is optimistic:** the resolver applies **no** costs/slippage; WIN fills exactly at target, LOSS exactly at stop. Any reported profit factor / expectancy from `PaperTrade` is therefore an *upper bound*. The `signal-quality` report re-applies a flat `BASE_COST_BPS=5` cost-adjustment, but that is a crude round-trip constant, not the real F&O cost stack.
- **Sharpe/Sortino:** `signal-quality/stats.ts` has the helpers, but trade-level returns lack holding-time normalization and there is no risk-free adjustment — treat any Sharpe as a rough ratio, not an annualized figure.
- **Regime/time-of-day breakdowns exist** (Phase 10 + `TOD_BUCKETS`) but time-of-day priors are hard-coded, not learned.
- **Instrument/long-short breakdowns exist** (Phase 5 `ForwardReturnDistribution` splits LONG/SHORT).

**Harness to produce the real table:** call `buildSignalQualityReport()` (the function behind `/api/in/signal-quality`) against production, export `precisionResults`, `forwardReturns`, `gradeValidation`, `regimeBreakdown`. See §19.

## 12. Grade Profitability Audit

**Status: NOT MEASURABLE FROM SOURCE — requires outcome DB.** The monotonicity checker exists (`engine.ts:buildGradeValidation`): it computes per-grade `signalCount, winRate, avgExpectancy, profitFactor, avgForwardReturn, avgRMultiple` and flags `orderingBreaches` when a higher grade underperforms a lower one by >0.02, emitting `GRADE_SYSTEM_USEFUL / WEAKLY_USEFUL / NOT_USEFUL`.

**Structural reason to expect grade profitability is NOT monotonic today:**
1. Grades derive from **confidence**, which is a heuristic confluence magnitude, not fit to outcomes.
2. Signals from **different ladders** (AI S≥0.82 vs Pick S≥0.85 vs scanner metric≥90) are merged and compared as if the letter "S" meant the same thing.
3. The aggregator assigns a cluster the **best** member grade, inflating grades on clustered opportunities.
Given these, monotonic win-rate/expectancy across A+→REJECT would be a coincidence, not a design property. Confirm by running `buildGradeValidation` on real data.

Requested columns (`grade, sample_count, win_rate, profit_factor, expectancy, average_R, median_R, max_drawdown, net_return, cost_adjusted_return, regime_breakdown`): the report harness produces all except `median_R` and per-grade `max_drawdown`/`net_return`, which need a small addition (see §19).

## 13. Quality-Score Monotonicity Audit

**Status: NOT MEASURABLE FROM SOURCE — requires outcome DB.** The bucket machinery exists: `engine.ts` builds score buckets `[0–20, 20–40, 40–60, 60–70, 70–80, 80–90, 90–100]` with win rate / expectancy / profit factor per bucket, and `probability-calibration.ts` checks monotonicity with a 0.05 tolerance.

**Structural reason to expect the requested 40–50 … 90–100 buckets are NOT monotonic today:** the live `qualityScore = confidence·100`, and confidence is the same heuristic magnitude that grades derive from — so this reduces to the grade-monotonicity question. Since quality is not fit to outcomes and is 90%+ confluence, monotonic win-rate/expectancy/profit-factor/net-P&L/risk-adjusted-return across quality bands is not guaranteed by construction. The `signal-quality-vector` (which would at least combine EV) is dead code, so the *live* quality score is even less outcome-linked than the dead one.

## 14. Data-Quality Audit

**Strengths (preserve these):**
- Provider lineage `scrapling→angel_one→upstox→yahoo` confirmed in `bootstrapRegistry`. **No direct NSE data acquisition** in the TS market-data layer (only the empty `nse.ts` removal stub; NSE_EQ/NSE_FO exchange identifiers are legitimate). AGENTS no-NSE rule upheld.
- Provenance on quotes/chains/ticks (`provider` + `fetchedAt`), quality envelope (`source`, `qualityScore`, `validationStatus`).
- Staleness gates block STALE/INVALID for signal/ML/execution consumers; UI-only stale display.
- Candle validation (positive finite OHLC, high≥low, bounds, duplicate/ascending timestamps).
- Cross-provider reconciliation with per-category divergence tolerances (INDEX 0.10%, STOCK 0.50%, FUTURE 0.30%, OPTION 2.00%); outlier detection (ATR + %move + vol-adjusted); Python `DataQualityGate` fails **closed**.
- Circuit breakers with escalating half-open backoff; capability-aware circuits.

**Weaknesses / detections:**
- **Two divergent stale-threshold tables:** `health.ts:STALE_THRESHOLDS_MS` (quote implied via intraday 60s) vs `reconciliation.service.ts:DEFAULT_STALE_THRESHOLDS_MS` (QUOTE 10s); option-chain **cache TTL 15s** but **stale threshold 30s** — a chain can be served up to 15s stale but only flagged at 30s.
- **Candles carry no provider** — `normaliseCandlesFromAngel` does `void provider` (candle-level provenance not implemented).
- **Missing field on one provider = MATCH** in reconciliation — silent OI/field drops not flagged.
- **Stale docstrings** reference NSE routing in `provider.ts` and `option-chain.service.ts` (no NSE code exists).
- **Thursday-hardcoded expiry** (`buildExpiryContext`) — incorrect after NSE expiry-day changes.
- **NIFTY lot size drift:** Python `LOT_SIZES["NIFTY"] = 75` while a test still asserts 50 (test stale; code likely current — verify against current NSE contract spec).
- fno-trend `metricLabel` regex → `0` on no match (silent data loss).

- Stale quotes / stale chains / missing OI / inconsistent timestamps / provider mismatch / incomplete-duplicate candles / look-ahead / tz: all **detected** by the code above except the intra-bar forming-candle usage (§9) and the missing-field-as-MATCH gap.

## 15. Duplicate / Conflicting Logic

1. **RSI ×4** — `signals/indicators.ts:rsi`, `indicators/index.ts:rsiNext`, `india-builder.ts:dailyRsi`, SuperTrend internal.
2. **ATR ×4** — same files + `market-data` `computeATR` + `auto-trader._computeAtr`.
3. **EMA/SMA duplicated** across `signals/indicators.ts`, `indicators/index.ts`, `india-builder.ts`, `auto-trader.ts`.
4. **5 grade ladders** (§5).
5. **≥3 confidence formulas** — `compositeScore`, ORB base-value, crypto `computeSignal`.
6. **≥3 win-probability formulas** — §6.
7. **PCR/max-pain twice** — raw (`options/compute.ts`) vs `chain.analytics`.
8. **PCR interpretation thresholds diverge** — 1.3/0.7 vs 1.2/0.8 vs 1.1/0.8/0.9/1.2.
9. **Two composite-weight tables** — `signal-quality-vector` vs `multi-layer-engine` (same concepts, different weights).
10. **Two BASE_COST_BPS constants** (both 5, drift risk); **3 TOD tables** (priors vs measured vs volume-mult).
11. **Two overlapping EOD closers** — `finaliseAutoTradingSession` + `india-eod-squareoff` race on the same `in:` rows.
12. **Two quality engines** — dead confluence vector vs report-only empirical engine — never reconciled.
13. **`GRADE_SCORE` duplicated** between `auto-trader.ts` and its test.

**Places ML output is ignored/overridden:** auto-trader `mlProbability:null`; `MLRiskResponse.prob_target_hit` and TFT probability discarded; `gradeOpportunityTier` empirical branch bypassed; `conflict-resolver.resolveSignalConflict` lets a heuristic `optionsFlowBias` demote an ML/strategy consensus BUY to WAIT (though this resolver is itself dead code).

**Places heuristic confidence is treated as probability:** `calibrateProbability(rawConfidence)` → `pWin`; `calibrateWinProbability`; ORB `0.42+0.4·confidence`; `risk/position-sizing.ts` uses `confidence` as a sizing scalar.

---

## 16. Top 20 Weaknesses (ranked by expected impact on realized edge)

Impact = how much it distorts the "fewer but statistically superior signals" objective.

| # | Weakness | Where | Expected impact |
|---|----------|-------|-----------------|
| 1 | "Probability" is a static transform of heuristic confidence; never fit to outcomes | `expected-value-engine.ts`, `engine.ts` | **Critical** — EV, sizing, grading all built on a fiction |
| 2 | Empirical calibration exists but is never wired to live decisions (TS branch bypassed; Python `CalibrationStore` never fit/loaded) | `probability-calibration.ts`, `meta/calibration.py`, `server.py` | **Critical** — the loop is open |
| 3 | Live `qualityScore = confidence·100`; the empirical quality engine is report-only; the confluence vector is dead code | `signal-center/route.ts`, `signal-quality/engine.ts`, `signal-quality-vector.ts` | **Critical** — quality ≠ profitability |
| 4 | Costs/slippage zeroed: resolver has none; Python EV defaults cost=0; TS marketImpact/latency=0 | `paper-trader.ts`, `ev_engine.py`, `expected-value-engine.ts` | **High** — inflates every P&L/EV, especially options |
| 5 | Five conflicting grade ladders merged as if comparable | §5 files | **High** — grade is not a stable signal |
| 6 | Intra-bar forming daily candle used as completed features | `india-builder.ts` `dailies.at(-1)` | **High** — overstates apparent edge |
| 7 | ML barely influences the live decision (±0.06 + 35% regime tilt; `mlProbability:null`) | `india-builder.ts`, `auto-trader.ts` | **High** — trained models largely unused |
| 8 | Served ML probabilities are uncalibrated softmax | `market_regime.py`, `server.py` | **High** |
| 9 | Overlapping fixed-horizon labels not t1-purged in training; PurgedKFold/CPCV imported-not-called | `train_all.py`, `purged_kfold.py` | **Medium-High** — optimistic OOS |
| 10 | `LABEL_VERSION` says triple-barrier but regime/ranker/strategy are fixed-horizon | `data_pipeline.py` | **Medium** — provenance mismatch |
| 11 | Fabricated metrics in the "empirical" report (recall 20% miss, MFE/MAE proxies, filter-ablation deltas) | `signal-quality/engine.ts` | **Medium** — pollutes the composite quality score |
| 12 | Two overlapping EOD closers race on the same rows | `finaliseAutoTradingSession`, `india-eod-squareoff.ts` | **Medium** — double-close / stat drift |
| 13 | RSI/ATR/EMA re-implemented 4× | multiple | **Medium** — silent divergence risk |
| 14 | Two divergent stale-threshold tables; chain cache 15s vs stale 30s | `health.ts`, `reconciliation.service.ts`, `market-cache.ts` | **Medium** |
| 15 | Reconciliation treats missing field as MATCH | `reconciliation.service.ts` | **Medium** — silent data drops |
| 16 | Hard-coded Thursday expiry (stale) | `derivatives-intelligence.ts` | **Medium** — wrong gamma/expiry gating |
| 17 | Dead code presents as the crown-jewel engine (multi-layer, quality vector, conflict resolver) | `signal-intelligence/*` | **Medium** — misleads maintainers |
| 18 | ATR fabricated as `price·0.012/0.015` on missing data | `india-builder.ts`, `signals/engine.ts` | **Low-Medium** — silent stop/target synthesis |
| 19 | Candle-level provenance discarded (`void provider`) | `normalizer.ts` | **Low** — auditability gap |
| 20 | TOD priors / regime multipliers / calibration base-rates all literals asserted as empirical | multiple | **Low-Medium** — comments overstate rigor |

## 17. Top 20 Improvements (ranked by expected impact) — NO IMPLEMENTATION YET

Ordered so that **measurement precedes optimization** (the brief forbids blindly lowering thresholds).

1. **Close the calibration loop.** Fit `CalibrationStore` (Platt/isotonic) on resolved `PaperTrade` outcomes per strategy; persist; load at inference; return calibrated probability. Make it the single source of `pWin`.
2. **Feed calibrated probability into EV and grading** instead of `calibrateProbability(rawConfidence)`. Replace the static shrinkage with the fitted calibrator (fall back to shrinkage only when sample < N).
3. **Make `qualityScore` empirical.** Wire `signal-quality/engine.ts`'s real metrics (precision, expectancy, calibration, drawdown) into the live quality — or, at minimum, blend calibrated-probability × net-EV as the score, not `confidence·100`.
4. **Apply the real cost/slippage stack everywhere P&L is computed** (resolver, both EV engines). Options especially: model bid-ask + impact.
5. **Unify grades into one ladder** driven by calibrated probability + net EV (cost-adjusted), applied identically to AI/pick/scanner. Kill the other four.
6. **Fix the intra-bar leakage:** drop the forming daily bar (`slice(0,-1)`) for daily features during market hours, or explicitly compute on the last *completed* session.
7. **Wire the Python meta layer** (EV, abstention, decision) into `server.py`, or delete it — do not ship implemented-but-unused decision logic.
8. **Purge overlapping labels in training** using the existing `PurgedKFold`/`build_t1_series` (they are already correct — just call them).
9. **Correct `LABEL_VERSION`** to reflect actual per-model labeling; adopt triple-barrier for ranker/strategy or relabel honestly.
10. **Remove fabricated metrics** from the quality report (recall/MFE/MAE/ablation) or replace with real tick-replay; do not let invented numbers enter a composite.
11. **Single EOD closer** — collapse `finaliseAutoTradingSession` and `india-eod-squareoff` into one Redis-locked path.
12. **Extract one shared indicator library** (RSI/ATR/EMA/SMA/VWAP) and delete the duplicates.
13. **Reconcile stale-threshold tables** into one config; align chain cache TTL ≤ stale threshold.
14. **Flag missing-field-on-one-provider** as a mismatch (not MATCH) in reconciliation.
15. **Data-drive the expiry calendar** (use `nse-trading-calendar.ts`) instead of hard-coded Thursday.
16. **Elevate ML from tie-breaker to first-class input** once calibrated: let calibrated ML probability (with abstention) drive gating, not a ±0.06 boost.
17. **Delete or wire the dead signal-intelligence engines** (multi-layer, quality vector, conflict resolver) — keep only what is consumed.
18. **Replace fabricated ATR fallback** with abstention (no ATR → no trade / degrade), not `price·0.012`.
19. **Add candle-level provenance** and propagate `dataProvider`/`dataObservationId` end-to-end (fields already exist on `UnifiedIndiaSignal`, currently `null`).
20. **Replace literal "empirical" priors** (TOD, regime multipliers, base rates) with values estimated from the outcome DB, with sample-size guards and shrinkage.

## 18. Exact Files That Must Change (for the improvements above)

**Calibration / probability / EV (improvements 1–4):**
- `ml-service/src/meta/calibration.py` (fit/save on real outcomes)
- `ml-service/src/training/train_all.py` (call `CalibrationStore.fit` + `.save` post-OOS)
- `ml-service/src/server.py` (load calibrator, apply at `/predict/*`)
- `src/lib/opportunity-engine/expected-value-engine.ts` (`calibrateProbability` → fitted calibrator)
- `src/lib/opportunity-engine/probability-calibration.ts` (pass real `calibrationReport` into `gradeOpportunityTier`)
- `src/features/ai-signals/engine.ts` (`calibrateWinProbability`)
- `src/features/india/paper-trading/auto-trader.ts` (stop passing `mlProbability:null`)

**Quality / grade unification (improvements 3, 5):**
- `src/app/api/in/signal-center/route.ts` (`qualityScore`, `strengthToGrade`)
- `src/features/india/daily-picks/engine.ts` (`gradeFromConfidence`)
- `src/lib/india-signal-center/aggregator.ts` (`GRADE_ORDER`, cluster grade)
- `src/lib/signal-quality/engine.ts` (feed live path; remove fabricated phases)

**Costs / resolver / EOD (improvements 4, 11):**
- `src/features/india/scalping/paper-trader.ts`, `paper-trader-core.ts`
- `ml-service/src/meta/ev_engine.py`
- `src/features/india/paper-trading/auto-trader.ts` + `worker/src/jobs/india-eod-squareoff.ts`

**Leakage / labels / validation (improvements 6, 8, 9, 10):**
- `src/features/ai-signals/india-builder.ts` (forming-bar slice)
- `ml-service/src/training/{train_all,data_pipeline}.py` (PurgedKFold wiring, LABEL_VERSION)

**Data quality (improvements 13–15, 19):**
- `src/lib/market-data/{health.ts, services/reconciliation.service.ts, cache/market-cache.ts, normalizer.ts}`
- `src/lib/signal-intelligence/derivatives-intelligence.ts` (expiry via `nse-trading-calendar.ts`)

**Cleanup (improvements 7, 12, 17, 18, 20):**
- `src/lib/signal-intelligence/{multi-layer-engine,signal-quality-vector,conflict-resolver}.ts`
- new shared indicator module (e.g. `src/lib/indicators/`) + delete duplicates
- `ml-service/src/decision/*` (wire or remove)

## 19. Tests Required

**First — the measurement harness (unblocks §A–D real numbers):**
1. **Outcome-export CLI** that runs `buildSignalQualityReport()` (`/api/in/signal-quality`) against a production/staging DB snapshot and emits: per-strategy precision/expectancy/PF/R, per-grade validation, calibration bins, score-bucket monotonicity. This *produces* the tables A–D currently marked NOT MEASURABLE.
2. **Calibration test** (extend existing): assert reliability-curve monotonicity and ECE < threshold on a held-out OOS fold, using `computeCalibrationReport` on real outcomes.
3. **Grade-monotonicity test:** assert `buildGradeValidation` yields `GRADE_SYSTEM_USEFUL` (win-rate & expectancy monotone A+→D within tolerance) on real data; fail CI if inverted.
4. **Quality-bucket monotonicity test:** win-rate/expectancy non-decreasing across 40–50…90–100.

**Regression / correctness:**
5. **Leakage unit test (fix + add):** update the stale `test_validation.py`/`test_data_pipeline.py` to the current guard messages/API, and add a forming-daily-bar test asserting India features use only completed candles.
6. **Cost-model test:** assert resolver and both EV engines never produce cost=0 for a real options trade; snapshot the cost stack.
7. **Single-ladder grade test:** one grading function; property test that grade is monotone in (calibrated prob × net EV).
8. **PurgedKFold-in-training test:** assert `train_all` invokes t1-aware purging (no train/test label overlap around test boundaries).
9. **EOD idempotency test:** a trade is closed exactly once (no race between the two closers).
10. **Indicator-parity test:** the single shared RSI/ATR/EMA equals prior per-file implementations on fixtures (guards the de-dup refactor).
11. **Calibration wiring test (Python):** `/predict/*` returns a calibrated probability (calibrator loaded) or an explicit `UNCALIBRATED` status — never a raw softmax silently labelled calibrated.

**Baseline to keep green:** existing 3131 TS tests; the 1748 passing Python tests.

## 20. Recommended Implementation Sequence (measure → calibrate → unify → optimize)

**Phase 0 — Measure (no logic change).** Build the outcome-export harness (§19.1) and run A–D against real data. Establish the *actual* baseline: current per-grade/quality win-rate, expectancy, PF, Brier, ECE. This is the evidence base the brief demands before any optimization.

**Phase 1 — Close the empirical loop.** Fit + persist + load calibration (Platt/isotonic) on realized outcomes (improvements 1, 2, 8). Return calibrated probability from the ML service. Do **not** change thresholds yet.

**Phase 2 — Make EV honest.** Wire calibrated probability into EV; apply the full cost/slippage stack everywhere (improvements 2, 4). Re-measure A–D.

**Phase 3 — Fix leakage & labels.** Drop the forming daily bar; wire PurgedKFold; correct LABEL_VERSION; retrain (improvements 6, 9, 10). Re-measure OOS.

**Phase 4 — Unify quality & grade.** Replace `confidence·100` with calibrated-prob × net-EV; collapse to one grade ladder; remove fabricated report metrics (improvements 3, 5, 11). Verify grade/quality monotonicity via §19 tests.

**Phase 5 — Consolidate & clean.** Single indicator lib; single EOD closer; reconcile stale tables; data-driven expiry; wire-or-delete dead engines (improvements 7, 11, 12, 13, 15, 17).

**Phase 6 — Then, and only then, tune for selectivity.** With a calibrated, cost-aware, monotone quality/grade system, raise gates to trade *fewer* signals where calibrated EV (net of costs, with abstention) is confidently positive — measuring the effect on realized expectancy each step. This is where "fewer but statistically superior" is finally earned, on evidence, not by lowering thresholds to manufacture A/A+ counts.

---

### Appendix — Baseline test run (this audit)

- **TypeScript (`npx vitest run`):** 201 files, **3131 passed / 0 failed** (~7.6s). Error-path stderr lines in logs are intentional negative tests.
- **Python (`.venv` 3.12, `pytest`):** **1748 passed / 19 failed**; 3 modules uncollectable (`test_portfolio_optimizer`, `test_talib_perf`, `test_technical`) due to missing optional deps (`riskfolio`, `talib`) in this environment, not code faults.
  - The 19 failures were individually inspected and are **stale tests / env gaps, not logic regressions**:
    - `test_gex` expects `LOT_SIZES["NIFTY"]==50` but code has `75` (NSE lot-size change) — verify current contract spec, then update the test.
    - Leakage tests (`test_validation`, `test_data_pipeline`) expect the old message `"Future leakage detected"`; the guard now correctly raises `"Structural leakage detected"` and `compute_stock_features` was moved — the guard *works*, the tests are outdated.
    - `test_phase3m/n/o` "import-clean" audits fail on the missing optional deps above.
    - `TestSourcePriorityChain` references a renamed data-source API.
- **Net:** no evidence of a functional regression in the current tree; the failing Python tests should be refreshed as part of Phase 0.
