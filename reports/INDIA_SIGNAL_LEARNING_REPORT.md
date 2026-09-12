# INDIA SIGNAL LEARNING REPORT

**Component:** `src/lib/india/signal-learning-loop.ts` (`sll-1.0.0`)
**Tests:** `tests/lib/india/signal-learning-loop.test.ts` (25 tests, all passing)
**Status:** Engine + tests green. Persistence is an injected interface (in-memory
store for tests); a thin Prisma adapter is the remaining wiring.
**Closes the loop** every prior report pointed to:
`INDIA_SIGNAL_FORENSIC_AUDIT.md` → … → `INDIA_PROFITABILITY_ENGINE.md`.

---

## 0. Objective

Turn every generated India signal into an **auditable prediction record**, resolve
it by the **actual execution policy** (not price direction), aggregate **rolling
statistics** across many dimensions, and feed those outcomes back into the six
engines via **delayed, out-of-sample-only** retraining governed by
**champion/challenger** promotion.

The loop:

```
signal → PredictionRecord → chronological outcome → ResolutionRecord →
rolling statistics → DELAYED OOS retrain → champion/challenger → (human) promote
```

---

## 1. Auditable records

### 1.1 PredictionRecord (persisted AT SIGNAL CREATION, immutable)

Every field the brief requires: `signalId, symbol, strategy, direction,
timestamp, entry, stop, targets, timeframe, regime, instrumentType, sector,
signalQuality, grade, rawConfidence, calibratedProbability, expectedValue,
modelContributions, qualityComponents, abstentionDecision, featureSnapshot,
derivativesSnapshot, marketContext, dataQuality, liquidity, costEstimate,
slippageEstimate, modelVersion, tradeDate`.

`rawConfidence` (heuristic conviction) and `calibratedProbability` (empirical
P(profit)) are stored **separately** — never conflated. Predictions are
**immutable**: the store rejects a second write to the same `signalId`.

### 1.2 ResolutionRecord (appended AT CLOSE)

`outcome, exit, exitTime, returnPct, returnR, mfe, mae, holdingTimeMs,
targetReached, stopReached, costActual, slippageActual, netReturn,
regimeDuringTrade, ambiguous, resolvedAt`.

### 1.3 Store

`SignalRecordStore` is an injected interface (`savePrediction`,
`saveResolution`, `getPrediction`, `listCompleted`, `listOpenPredictions`).
`InMemorySignalRecordStore` backs the tests; a Prisma adapter maps to the
existing `PaperTrade` + a new signal-record table.

> Tests: prediction immutability; resolution requires an existing prediction;
> open-prediction listing.

---

## 2. Outcome policy — chronological, anti-inflation

Outcome states: **TARGET_HIT, STOP_HIT, TIME_EXIT, MANUAL_CLOSE, INVALIDATED,
NO_FILL, CANCELLED**.

`evaluateOutcome` walks candles **chronologically** from entry and resolves by
the actual policy — **never** by final price direction. Excursions (MFE/MAE),
holding time and net return (after cost + slippage) are computed along the path.

**The anti-inflation rule.** If a single candle touches BOTH the stop and the
target and intrabar tick ordering is unavailable, the result is
**AMBIGUOUS** — recorded conservatively as a `STOP_HIT` for P&L, but flagged
`ambiguous = true` and **excluded from all statistics**. A backtest must never
assume the favorable fill. A gap-open beyond one level (with
`intrabarOrderingAvailable`) resolves the ordering and is not ambiguous.

`isStatEligible` excludes ambiguous / NO_FILL / CANCELLED / INVALIDATED records.
`isWin` labels by the execution policy net of costs, not by price direction.

> Tests: TARGET first → TARGET_HIT; STOP first → STOP_HIT; both-in-one-candle →
> AMBIGUOUS + excluded; gap-open resolves ordering; TIME_EXIT / NO_FILL; MFE/MAE/
> holding/net computed; a trade whose stop hits first is a LOSS even if price
> later rallies (win ≠ final direction).

---

## 3. Rolling statistics

`buildRollingStatistics` computes, over the **11 required dimensions** —
`strategy, symbol, sector, regime, timeframe, grade, qualityBucket,
probabilityBucket, timeOfDay, side, instrument` — rolling windows of
**20 / 50 / 100 / 250** most-recent (chronological) stat-eligible observations.

Each window reports `winRate, expectancyR, profitFactor, avgReturnPct, sharpe,
maxDrawdownR, brier`, plus `full` (n ≥ window) and `reliable` (n ≥ minReliable).
Ambiguous observations are excluded so they cannot drag the win rate.

> Tests: all dimensions present; the 20-window is `full` at 120 obs while the
> 250-window is not; a thin bucket is not `reliable`; adding ambiguous losses
> leaves the win rate unchanged (exclusion works); bucketers map correctly.

---

## 4. Delayed retraining — same-day embargo + OOS

Outcomes feed **all seven learnable targets**: `calibration, qualityScore,
strategyHealth, gradeThresholds, modelWeights, featureImportance,
abstentionThresholds`. But:

> **Live models are NEVER updated from the same day's outcomes.** Retraining is
> delayed and evaluation is strictly out-of-sample.

`buildRetrainSplit(observations, asOfDay, cfg)`:
- **EMBARGO** — any observation whose `tradeDate` is within `embargoDays` of
  `asOfDay` (or on/after it) is excluded entirely.
- The remaining history is split chronologically into a **fit** set (early) and
  an **untouched OOS** set (late). The champion/challenger comparison runs only
  on OOS.

`assertNoSameDayLeakage` is a **hard guard** the live path calls before applying
any retrained artifact — it fails if any training observation violates the
embargo. `runDelayedRetrain` is the governance wrapper: it builds the split,
runs the guard, and reports whether a candidate may be produced (delegating the
actual fitting to each engine's existing trainer).

> Tests: as-of-day observations never appear in train/oos; the hard guard fails
> on a same-day observation in train; a candidate is produced only with enough
> embargoed history + a clean guard; too-little history → no candidate.

---

## 5. Champion / Challenger

`computeMetricBattery` computes the **full required battery** on an OOS set:
`winRate, expectancyR, profitFactor, sharpe, maxDrawdownR, calibrationGap,
brier, ece, turnover, costAdjustedReturnPct, regimeRobustness` (regime
robustness = worst per-regime expectancy).

`evaluateChampionChallenger` returns **PROMOTE / HOLD / REJECT**. A challenger
replaces the champion **only** when, on untouched OOS data, it shows a
**statistically-meaningful improvement**:

- required metrics improved (expectancy, Brier, cost-adjusted return),
- calibration not regressed — **Brier-primary** (a strict proper scoring rule
  capturing calibration + sharpness); ECE is secondary and only blocks when it
  regresses *and* Brier did not improve (so a coincidentally-perfect champion ECE
  cannot veto a genuinely better-scoring challenger),
- max drawdown not materially worse,
- expectancy gain ≥ threshold **and** two-sample **z ≥ 1.96**,
- adequate OOS sample (else HOLD).

Otherwise HOLD (keep champion) or REJECT (clearly worse). **Nothing is ever
auto-promoted to LIVE** without passing this gate — the final promotion remains
a human decision.

> Tests: a clearly-better, better-calibrated challenger with z > 1.96 → PROMOTE;
> a marginal challenger → HOLD; thin OOS sample → HOLD; a challenger that wins
> more but is over-confident (worse Brier) → NOT promoted; the full battery is
> computed.

---

## 6. Validation results

### 6.1 Test suite

`tests/lib/india/signal-learning-loop.test.ts` — **25 tests, all passing**
(deterministic):

| Area | Result |
|------|--------|
| immutable auditable record store | ✅ |
| chronological TARGET/STOP resolution | ✅ |
| intrabar AMBIGUOUS (both touched) → excluded, not favorable | ✅ |
| gap-open resolves ordering | ✅ |
| TIME_EXIT / NO_FILL | ✅ |
| MFE / MAE / holding / net return | ✅ |
| win by execution policy, not price direction | ✅ |
| rolling 20/50/100/250 across all 11 dimensions + full/reliable | ✅ |
| ambiguous excluded from stats (no inflation) | ✅ |
| same-day embargo + hard leakage guard | ✅ |
| delayed-retrain candidate gating | ✅ |
| champion/challenger PROMOTE / HOLD / REJECT gates | ✅ |
| over-confident challenger rejected (Brier-primary calibration) | ✅ |
| determinism | ✅ |

### 6.2 Baseline (regression safety)

- `npx tsc --noEmit` → **exit 0**.
- `npx eslint` on both new files → **clean**.
- Full suite `npx vitest run` → **207 files / 3266 tests pass** (was 206 / 3241;
  +1 file, +25 tests). No existing test regressed.

---

## 7. Integration plan

1. **Persist a PredictionRecord at signal creation** — the profitability engine's
   `runProfitabilityPipeline` output (grade, calibrated probability, net EV,
   quality components, model contributions) plus the feature/derivatives/context
   snapshots map directly onto `PredictionRecord`. Add a Prisma
   `IndiaSignalRecord` table + a `SignalRecordStore` adapter.
2. **Resolve via `evaluateOutcome`** in the worker (replacing the legacy
   touch-both = LOSS resolver), storing the `ResolutionRecord` with the
   `ambiguous` flag.
3. **Nightly rolling-stats job** — `buildRollingStatistics` over the completed
   observations; surface the tables in the UI.
4. **Delayed retrain job** — `runDelayedRetrain(asOfDay)` builds the embargoed
   OOS split and feeds each engine's trainer (calibration store, quality model,
   strategy health, grade thresholds, ensemble weights, feature importance,
   abstention); `assertNoSameDayLeakage` guards every artifact before it goes
   live.
5. **Champion/Challenger gate** — run `evaluateChampionChallenger` on the OOS
   set; on PROMOTE, stage the challenger for human approval (never auto-LIVE).

The whole loop is deterministic and I/O-free at its core, so every record,
statistic and promotion decision is reproducible and auditable — closing the
empirical loop the forensic audit demanded.

---

## 8. The complete stack (this session)

This closes the seven-part arc. The India signal system now has, end to end:

1. **Forensic audit** — `INDIA_SIGNAL_FORENSIC_AUDIT.md`
2. **Predictive quality** — `predictive-quality-engine.ts`
3. **Evidence grading** — `evidence-grading-engine.ts`
4. **ML calibration** — `ml-meta-decision.ts` + friends
5. **Strategy × regime scoring** — `strategy-regime-scoring.ts`
6. **Profitability selection** — `profitability-engine.ts`
7. **Closed-loop learning** — `signal-learning-loop.ts` (this report)

Each is pure, deterministic, tested, and documented, with a measure-first
integration path. Together they replace heuristic confluence with an
empirically-grounded, cost-aware, self-improving selection stack — where the
loop from outcome back to model is finally closed, with strict OOS discipline
and no auto-promotion to live.
