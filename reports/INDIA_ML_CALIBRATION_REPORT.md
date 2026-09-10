# INDIA ML CALIBRATION REPORT

**Components:**
- `src/lib/india/ml-calibration-metrics.ts` — calibration methods + OOS metric suite
- `src/lib/india/ml-meta-decision.ts` (`mmd-1.0.0`) — Meta Decision Engine (`decide`)
- `src/lib/india/ml-meta-training.ts` — OOS trainer (`trainMetaModel`)
- `src/lib/india/ml-meta-artifact-store.ts` — frozen-artifact loader
- Wiring: `src/features/ai-signals/india-builder.ts`, `src/types/ai-signals.ts`

**Tests:** `tests/lib/india/ml-meta-decision.test.ts` (22 tests, all passing)
**Status:** Engine + trainer + validation harness implemented and green. Awaiting a
production outcome-DB export to fit and freeze the first OOS artifact (the shipped
default is a safe, un-calibrated fallback).
**Builds on:** `reports/INDIA_SIGNAL_FORENSIC_AUDIT.md`,
`reports/INDIA_PREDICTIVE_SIGNAL_QUALITY.md`, `reports/INDIA_GRADE_VALIDATION.md`.

---

## 0. Objective & what changed

**Objective:** make `P(profitable trade)` a *real, empirically calibrated
probability from out-of-sample predictions* — not a transformed confidence score.

The forensic audit established the failure mode: the India path used RAW model
outputs (softmax, rank score) and a fixed logistic of a heuristic confidence as
if they were probabilities; the Python `CalibrationStore` existed but was never
loaded; `MLRiskResponse.prob_target_hit` and the price-forecast probability were
computed and discarded; and ML entered only as a ±0.06 confidence nudge.

**What changed:**

| Before | After |
|--------|-------|
| Raw softmax / heuristic logistic treated as P(profit) | OOS-**calibrated** P(profit) per model, then ensembled |
| Calibration store never applied | Hierarchical calibrators applied at inference (`decide`) |
| Confidence == "probability" | `confidence` and `calibratedProbability` are **separate fields** everywhere |
| Fixed / equal model influence | Ensemble weights **learned from OOS performance** (not equal) |
| Arbitrary `mlRankBoost` (±0.06) | Ranker boost **gated by an OOS value check**; suppressed if it doesn't help |
| No uncertainty | `probabilityLowerBound/UpperBound`, `predictionUncertainty`, `modelAgreement` |
| No provenance | `calibrationMethod`, `calibrationSampleCount`, `calibrationQuality` |

---

## 1. The 11 components

The brief's 11 pieces map to the implementation as follows:

| Component | Role in this pipeline |
|-----------|----------------------|
| regime classifier | `ModelSignal` (`regimeClassifier`) — raw regime probability |
| stock ranker | `ModelSignal` (`stockRanker`) — raw rank score; boost now OOS-gated |
| strategy selector | `ModelSignal` (`strategySelector`) — raw strategy confidence |
| risk predictor | `ModelSignal` (`riskPredictor`) — `prob_target_hit` (now USED) |
| price forecaster | `ModelSignal` (`priceForecaster`) — directional probability |
| IV classifier | `ModelSignal` (`ivClassifier`) |
| quant engine | `ModelSignal` (`quantEngine`) — the heuristic composite as a model |
| meta decision engine | `decide()` — ensembles the calibrated per-model probabilities |
| calibration store | hierarchical `MetaModelArtifact.calibration[model][key]` |
| ensemble weighting | OOS-learned `baseWeights` + per-decision modulation |
| abstention policy | `MetaModelArtifact.abstention` + `decide()` abstention block |

Every model emits a **raw** score in [0,1]; the meta layer converts each to a
**calibrated** P(profit) and combines them. Confidence (heuristic conviction) is
carried through untouched and never substituted for probability.

---

## 2. Calibration methods & OOS selection

Four calibrators (`ml-calibration-metrics.ts`), all fit deterministically:

- **raw** — identity (a well-calibrated model isn't "corrected" for no reason).
- **Platt** — `sigmoid(a·s + b)`, gradient-fit.
- **isotonic** — PAVA monotone step curve (non-parametric; needs more data).
- **beta** — `sigmoid(a·ln s − b·ln(1−s) + c)` (Kull et al.; handles both over- and
  under-confidence and both sigmoid shapes).

**Method is chosen by OOS log loss** (`selectCalibrationMethod`): every method is
fit on the TRAIN split and scored on the **disjoint** VALID split; the lowest OOS
log loss wins (ties → Brier → ECE). `raw` is always a candidate. The routine
returns `reliable = false` when either split is below the minimum sample, so a
choice made on thin data is flagged rather than trusted.

> Test *"selectCalibrationMethod scores candidates ONLY on the disjoint valid
> set"* asserts the chosen method's OOS log loss ≤ raw's OOS log loss.

### 2.1 Per-model OOS metric suite

For every model `computeCalibrationMetrics` reports the full set the brief asks
for: **ROC-AUC** (Mann–Whitney rank-sum), **PR-AUC** (trapezoidal PR curve),
**Brier**, **log loss**, **ECE** (count-weighted reliability gap), **calibration
slope & intercept** (logistic regression of outcome on predicted log-odds; ideal
1 / 0), the **reliability curve** (10 equal-width bins), and **lift by
probability decile**. All are computed on the held-out window only.

> Test *"computes the full OOS metric set with sane ranges"* verifies every
> metric is present and in range for an informative model.

---

## 3. Hierarchical calibration store + Bayesian shrinkage

Calibrators are keyed at four levels and resolved most-specific-first
(`resolveCalibration`):

```
strategy + regime + timeframe
   → strategy + regime
      → strategy
         → global
```

A level is only LEARNED when it has ≥ `minCellSample` (default 50) observations;
otherwise the resolver falls through to the parent. A global calibrator always
exists so resolution never fails.

**Bayesian shrinkage** happens at TWO points:
1. During training, `baseWeights` are shrunk toward a small uniform prior by
   sample size (`shrink`).
2. **At inference**, each model's calibrated probability is shrunk toward the
   global prior by the calibrator's sample count:
   `p = shrink(rawCalibrated, calibratorN, globalPrior, minEffectiveSample)`.
   This is the small-sample over-confidence guard — a thin or `raw`-fallback
   calibrator **cannot** emit an extreme probability.

> Test *"a tiny calibration cell does not yield an extreme calibrated
> probability"* trains on 25 obs and confirms `P < 0.9` even for a raw score of
> 0.95. Test *"resolves the most specific level, then falls back to global"*
> confirms an unseen strategy/regime/timeframe resolves to `strategy`/`global`.

---

## 4. Model diagnostics fed into the ensemble

`trainMetaModel` produces, per model, the five artifacts the brief requires:

| Artifact | Fields |
|----------|--------|
| `ModelCalibration` | method, calibrator, sampleCount, OOS quality, full metrics |
| `ModelContribution` | rocAuc, logLossImprovement, top-decile lift/winRate/expectancy/PF, `addsValue` |
| `ModelReliability` | brier, ece, calibration slope/intercept, sampleCount, **effectiveSampleSize** |
| `ModelDrift` | logLossDelta (early vs recent), **PSI**, drifting flag, ageMs, stale flag |
| `ModelRegimePerformance` | per-regime rocAuc / logLoss / n |

Plus a pairwise **correlation** matrix on OOS scores.

---

## 5. OOS-learned ensemble weighting (not equal)

Base weights are learned, not fixed:

```
skill(model)  = 2·max(0, rocAuc − 0.5) + max(0, logLossImprovement)
baseWeight    ∝ shrink(skill, sampleCount, priorPrior)  × (addsValue ? 1 : 0.25)
```

At each decision, the base weight is modulated by all six required factors:

```
w = baseWeight
    × regimeMultiplier        // clamp((regimeRocAuc − 0.5)/0.3, 0.1, 1.3)
    × sampleMultiplier        // effN / (effN + minEffectiveSample)  — MIN EFFECTIVE SAMPLE
    × driftMultiplier         // 0.5 if drifting else 1
    × stalenessMultiplier     // 0.4 if ageMs > staleMs else 1
    × calibrationQualityMult  // 0.3 + 0.7·calQ
    × contributionMult        // addsValue ? 1 : 0.25
```

**Correlation de-weighting:** for any model pair with |corr| > 0.5, the
smaller-weight model's weight is shaved proportional to redundancy
`(corr − 0.5)/0.5`. Correlated models therefore do **not** each receive full
independent weight — the audit's OI/PCR-style double-counting is prevented at the
ensemble level too.

> Tests *"regime-conditioned … score differently"*, *"drifting model
> down-weighted"*, *"stale model down-weighted"*, and *"removing a model
> reweights the rest"* exercise each factor.

---

## 6. Meta Decision output (`decide`)

Deterministic, pure. Produces exactly the fields the brief specifies, with
**confidence and probability kept separate**:

| Field | Meaning |
|-------|---------|
| `confidence` | heuristic conviction, carried through untouched (NOT a probability) |
| `rawProbability` | weighted ensemble of **raw** model scores (uncalibrated) |
| `calibratedProbability` | weighted ensemble of **calibrated** per-model probabilities |
| `probabilityLowerBound` / `probabilityUpperBound` | Wilson interval (on ensemble effective sample) widened by model spread |
| `calibrationMethod` | method of the dominant (highest-weight) present model |
| `calibrationSampleCount` | sample count backing that calibrator |
| `calibrationQuality` | weight-blended OOS calibration quality [0,1] |
| `modelAgreement` | `1 − 2·std(perModelCalibrated)` [0,1] |
| `predictionUncertainty` | interval width + model spread [0,1] |
| `abstained` + `abstentionReasons` | see §7 |
| `attribution[]` | per-model raw/calibrated/level/method/weight/eff-sample/stale/drifting |

When no usable model weight remains, the engine falls back to the **global
prior** (NOT to confidence), and says so in `reasons`.

> Test *"confidence and probability are SEPARATE fields"* confirms a 0.99
> confidence with mediocre model signals does not yield a 0.99 probability. Test
> *"0 ≤ lower ≤ calibrated ≤ upper ≤ 1"* confirms the bounds invariant across the
> input range.

---

## 7. Abstention policy

`decide` abstains (evidence insufficient/unreliable) when any holds:
- total usable model weight < `minTotalWeight` (0.05),
- ≥ 2 models present but `modelAgreement < minAgreement` (0.35),
- `predictionUncertainty > maxUncertainty` (0.6).

> Test *"severe disagreement can trigger abstention"* confirms opposing models
> (0.98 vs 0.02) either abstain or report high uncertainty — never a falsely
> confident probability.

---

## 8. Anti-leakage guarantee

Calibration is fit on an EARLY time window and its OOS quality measured on a
LATER, embargoed window (`walkForwardSplit`: `trainFraction` fit, then an
`embargoMs` gap, then eval). Within the fit window a further inner split
(`innerFit`/`innerValid`) selects the calibration method; the **eval window is
never touched during fitting or selection**. No calibrator is fit and scored on
the same rows.

> Tests *"training splits calibration fit from evaluation by time + embargo"* and
> *"selectCalibrationMethod scores candidates ONLY on the disjoint valid set"*
> pin this down. `monotonicity` uses a disjoint seed for the test set (true OOS).

---

## 9. Ranker contribution — validated, not asserted

`measureContribution` decides whether a model (the stock ranker in particular)
actually improves outcomes on OOS data, reporting ROC-AUC, log-loss improvement
over the base rate, and the realized **win rate / expectancy / profit factor /
top-decile lift** of its highest-scored picks. A model `addsValue` only when:

```
n ≥ 30  AND  rocAuc > 0.52  AND  logLossImprovement > 0
        AND  topDecileExpectancyR > 0  AND  topDecileLift > 1
```

In the India builder, the old arbitrary `mlRankBoost` is now **gated by this
verdict**: `mlBoost = rankerAddsValue ? mlRankBoost : 0`. Until an OOS artifact
proves the ranker adds value, the boost is **suppressed** (the default artifact
has `addsValue = false`). A heuristic ranker delta can no longer override
statistically stronger evidence.

> Test *"an informative model is measured to add value; pure noise does not"*
> confirms a noise model gets `addsValue = false` and lower ROC-AUC than the
> informative ranker. Test *"default artifact suppresses the ranker …"* confirms
> the safe default.

---

## 10. India builder integration (confidence ≠ probability)

`buildIndiaSignal` now accepts an optional `metaDecision`. When present and not
abstained, `winProbability` is the **calibrated** probability; otherwise it falls
back to the legacy heuristic, and `probabilitySource` records which
(`"ml_calibrated"` vs `"heuristic"`). The signal payload gains
`calibratedProbability`, `probabilityLowerBound/UpperBound`, `calibrationMethod`,
`calibrationSampleCount`, `calibrationQuality`, `modelAgreement`,
`predictionUncertainty`, `mlAbstained` — all **separate** from `confidence` /
`confidenceScore`, which are unchanged.

---

## 11. Validation results

### 11.1 Test suite

`tests/lib/india/ml-meta-decision.test.ts` — **22 tests, all passing**
(deterministic, seeded). The 10 required categories:

| # | Category | Test | Result |
|---|----------|------|--------|
| 1 | calibration leakage | fit/eval time+embargo split; method selection on disjoint valid | ✅ |
| 2 | probability bounds | 0 ≤ lower ≤ calibrated ≤ upper ≤ 1 across inputs | ✅ |
| 3 | monotonicity | higher calibrated prob → higher realized win rate (OOS buckets) | ✅ |
| 4 | model dropout | absent models ignored; weights renormalise; still produces prob | ✅ |
| 5 | model disagreement | disagreement lowers agreement / triggers abstention | ✅ |
| 6 | regime changes | regime-conditioned calibration/weights differ | ✅ |
| 7 | calibration fallback | hierarchy resolves specific → global | ✅ |
| 8 | small samples | tiny cell shrinks toward prior; selection flagged unreliable | ✅ |
| 9 | drift | PSI-detected drift down-weights the model | ✅ |
| 10 | stale models | stale artifact down-weighted vs fresh | ✅ |
| + | confidence ≠ probability | 0.99 confidence ≠ probability | ✅ |
| + | determinism | identical inputs → byte-identical output | ✅ |
| + | metric suite / isotonic monotone / calibrators in [0,1] | — | ✅ |

### 11.2 Monotonicity on held-out synthetic data

Synthetic ground truth `P(profit) = 0.25 + 0.5·edge`, with intentionally
miscalibrated (squashed) raw scores; `ivClassifier` is pure noise. Trained on
1,500 in-sample obs, tested on 3,000 disjoint OOS obs. Realized win rate is
non-decreasing across calibrated-probability buckets (checked with a sample-aware
Wilson tolerance), the noise model earns `addsValue = false` and is down-weighted,
and the informative models earn most of the ensemble weight.

> Production magnitudes (per-model ROC-AUC/PR-AUC/Brier/ECE tables, method
> selected per model, decile lift) will be filled once the real outcome DB is
> wired — the harness (`computeCalibrationMetrics` per model +
> `TRAINED.ensembleOOS`) already produces them. Real numbers are
> **NOT MEASURABLE FROM SOURCE — requires the outcome DB.**

### 11.3 Baseline (regression safety)

- `npx tsc --noEmit` → **exit 0**.
- `npx eslint` on all new/changed files → **0 errors**.
- Full suite `npx vitest run` → **204 files / 3194 tests pass** (was 203 / 3172;
  +1 file, +22 tests). The India-builder wiring caused **no regressions**.

---

## 12. Integration plan (measure-first, per the audit)

1. **Export OOS observations** (`MetaTrainingObs[]`): for each resolved
   `PaperTrade`/`IndiaDailyPick`, capture every model's RAW score at signal time
   (regime prob, ranker score, `prob_target_hit`, price-forecast prob, IV, quant
   confidence), the realized cost-adjusted `label`, `returnR`, and
   `signalMs`/`outcomeMs`.
2. **Train + freeze** via `trainMetaModel(...)`; confirm `ensembleOOS` metrics and
   per-model contributions; persist the `MetaModelArtifact` JSON.
3. **Wire the loader**: call `setIndiaMetaArtifactResolver(...)` at boot to load
   the frozen artifact from the cache/store; `loadIndiaMetaArtifact()` already
   memoises it in the builder.
4. **Feed `decide()` output** into `buildIndiaSignal({ metaDecision })` so
   `winProbability` becomes the calibrated probability, and downstream EV/sizing
   consumes it (closing the loop the audit flagged).
5. **Monitor** drift/staleness/contribution each retrain; a model that stops
   adding OOS value is automatically down-weighted, and a drifting/stale one is
   discounted — no manual threshold tuning required.

Until step 2, the shipped `defaultMetaArtifact()` uses identity (`raw`)
calibrators, `addsValue = false` for every model (ranker boost suppressed), and
the global prior 0.5 — so an untrained deployment reports `calibrationMethod:
"raw"` with low `calibrationQuality` and can never masquerade as calibrated.
