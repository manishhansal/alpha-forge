# INDIA PREDICTIVE SIGNAL QUALITY

**Component:** `src/lib/signal-intelligence/predictive-quality-engine.ts` (`pqe-1.0.0`)
**Tests:** `tests/lib/signal-intelligence/predictive-quality-engine.test.ts` (24 tests, all passing)
**Status:** Engine + training harness + validation harness implemented. Awaiting a
production outcome-DB export to fit and freeze the first `TRAINED_OOS` model
(the shipped default is explicitly `UNTRAINED_UNIFORM_PRIOR`).
**Supersedes (conceptually):** the heuristic confluence scores documented in
`reports/INDIA_SIGNAL_FORENSIC_AUDIT.md` §7, §12, §13.

---

## 0. What changed and why

The forensic audit established that the old "Signal Quality" was a weighted
*confluence* score whose "probability" was manufactured from that confluence via
a fixed logistic, never fit to realized cost-adjusted outcomes, with five
conflicting grade ladders and no verified monotonicity.

This engine answers **one** question and is measured on exactly that:

> **Q:** What is the probability that this signal produces a **profitable,
> cost-adjusted** trade?
> **A:** `predictedProfitProbability ∈ [0,1]`, rescaled to `qualityScore ∈ [0,100]`
> and bucketed into `EXCEPTIONAL / HIGH / MEDIUM / LOW / REJECT`.

Three non-negotiable properties, all enforced in code and tests:

1. **Weights are learned OUT-OF-SAMPLE, never hand-set.** The shipped default is
   flagged `UNTRAINED_UNIFORM_PRIOR` so it cannot masquerade as empirical.
2. **The score is monotone-calibrated:** higher score ⇒ higher realized P(profit).
3. **Missing/stale data becomes UNCERTAINTY, not a directional penalty.**

---

## 1. Definitions and notation

| Symbol | Meaning |
|--------|---------|
| `f` | feature vector for one signal at inference (`QualityFeatureVector`) |
| `M` | frozen model artifact (`QualityModel`) produced by training |
| `xᵢ ∈ [0,1] ∪ {∅}` | direction-relative evidence for edge component *i* (`∅` = not observed) |
| `wᵢ` | effective additive weight of edge component *i* (∑ over edge comps = 1) |
| `b` | raw edge blend ∈ [0,1] |
| `g(·)` | monotone isotonic calibration curve, `b ↦ P(profit)` |
| `π` | learned prior win rate for the signal's `(strategy, regime)` family |
| `κ` | confidence multiplier ∈ [0,1] (uncertainty channel) |
| `δ` | freshness decay ∈ (0,1] |
| `p` | final `predictedProfitProbability` |

All probabilities are for a **cost-adjusted profitable outcome** (label = 1 iff
the trade was net-of-costs profitable).

---

## 2. The 20 components and their partition

The components split into **edge** (carry additive weight) and **uncertainty**
(act as multipliers — they cannot add spurious edge).

**Edge components (13):**
`predictiveProbability`, `historicalConditionalWinRate`, `expectedValue`,
`regimeFit`, `multiTimeframeAlignment`, `marketStructure`, `momentum`, `volume`,
`volatilityFit`, `liquidity`, `derivativesConfirmation`, `relativeStrength`,
`executionQuality`.

**Uncertainty components (7):**
`dataQuality`, `modelAgreement`, `signalStability`, `costRobustness`,
`alphaDecay`, `strategyHealth`, `historicalSampleConfidence`.

> Test *structure* asserts exactly 20 components, each in exactly one partition
> (XOR), and that uncertainty components carry **zero additive weight**.

### 2.1 Redundancy groups (anti–double-counting)

Correlated components **share a weight budget** so overlapping evidence cannot be
counted multiple times. The groupings implement the audit's explicit examples:

| Group | Components | Rationale (audit) |
|-------|-----------|-------------------|
| `PREDICTIVE_EDGE` | predictiveProbability, historicalConditionalWinRate, expectedValue | ML prob and historical win rate overlap |
| `REGIME` | regimeFit, volatilityFit | regime & vol regime co-move |
| `TREND_MOMENTUM` | multiTimeframeAlignment, marketStructure, momentum | trend/momentum/SMA-stack correlated |
| `PARTICIPATION` | volume, liquidity | participation twins |
| `DERIVATIVES` | derivativesConfirmation | OI/PCR/max-pain collapsed into one score |
| `RELATIVE_STRENGTH` | relativeStrength | — |
| `EXECUTION` | executionQuality | — |

Effective weight of edge component *c* in group *G*:

```
wᵢ = groupWeight[G] × ( withinGroup[G][c] / Σ_{c'∈G} withinGroup[G][c'] )   , renormalised so Σ wᵢ = 1
```

Because a group's total contribution is capped at `groupWeight[G]`, adding a
third perfectly-correlated momentum feature cannot out-vote the rest — it just
splits the same budget. (Test *correlated feature handling* verifies the
`TREND_MOMENTUM` group budget stays < 0.5 and > 0.)

---

## 3. Component normalisation (evidence, not direction)

Every `xᵢ` is oriented **for the signal's own direction** and clamped to [0,1]
where 1 = maximally favourable, 0.5 = neutral. The caller orients evidence (for a
SHORT, "price below VWAP" → high value), so the engine is direction-agnostic and
"missing bullish input ≠ bearish".

Special cases:
- `predictiveProbability`: the calibrated model P(win), used directly in [0,1].
- `historicalConditionalWinRate`: the Bayesian-shrunk `effectiveWinRate` of the
  matched conditional-performance cell (§6).
- `expectedValue`: net EV in R mapped `EV_R ↦ clamp((EV_R + 1)/3, 0, 1)`
  (−1R → 0, 0R → 0.5, +2R → 1).

**Missing (`∅`) ⇒ neutral-impute to 0.5 AND mark `observed = false`.** It never
contributes 0. (Test *missing data* asserts an omitted component gets
`value = 0.5, observed = false` and the score does not collapse below the neutral
region.)

---

## 4. The raw edge blend

```
b = clamp( Σ_{i ∈ edge} wᵢ · xᵢ , 0, 1 )
```

`historicalConditionalWinRate` depends on which conditional cell matches, and the
cell is chosen from the blend — so inference does a deterministic two-pass:

1. Compute a provisional blend from the **bucket-independent** edge components
   (weights renormalised over them).
2. Use the provisional blend to select the conditional cell (edge bucket).
3. Recompute the full blend including `historicalConditionalWinRate = effectiveWinRate`.

This is fully deterministic (no randomness, no clock).

---

## 5. Monotone probability calibration

The blend is mapped to a realized-profit probability by a **monotone isotonic
regression** curve fit at train time (Pool-Adjacent-Violators):

```
p_calibrated = g(b) ,  g non-decreasing by construction
```

**This is the structural monotonicity guarantee:** a higher raw edge can never
receive a lower calibrated probability. (Test *predicted profit probability is
monotone non-decreasing in qualityScore* sweeps the latent edge and confirms.)

Isotonic (vs Platt) is chosen because it is non-parametric, cannot introduce the
"conviction multiplier" inflation the audit flagged, and is trivially monotone.

---

## 6. Conditional-performance tables + Bayesian shrinkage

Built from **training outcomes only**, keyed by

```
strategy × regime × timeframe × edge-bucket
```

Buckets: `0_40, 40_50, 50_60, 60_70, 70_80, 80_90, 90_100`.

For each cell we store (all reported in the artifact):
`sampleCount, observedWinRate, priorWinRate, sampleConfidence, effectiveWinRate,
expectancyR, profitFactor, avgWinR, avgLossR, netReturnR, maxDrawdownR,
costAdjustedReturnR, slippageAdjustedReturnR`.

### 6.1 Learned hierarchical priors (never hard-coded)

```
π_global              = overall training win rate
π_strategy            = shrink( strategy wins,  strategy n,  π_global )
π_{strategy|regime}   = shrink( family  wins,   family  n,   π_strategy )
```

A cell's win rate is shrunk toward its **most specific available** prior. The
prior is therefore learned from the relevant strategy/regime family, exactly as
required — not a blind constant. (Test *regime transition* confirms
`π_{MOMENTUM|BULL_TREND} > π_{MOMENTUM|BEAR_TREND}` and that identical features
score higher in the bull family.)

### 6.2 Shrinkage (the small-sample guard)

```
sampleConfidence  c = n / (n + priorStrength)          # priorStrength default 20
effectiveWinRate    = c · observedWinRate + (1 − c) · priorWinRate
```

A perfect but tiny sample (3/3) with prior 0.5 yields
`effectiveWinRate < 0.65, c < 0.2` — it **cannot** produce a top grade. (Tests
*small-sample shrinkage*: 3/3 → effective < 0.65; 700/1000 → effective > 0.68,
c > 0.97; and a tiny strong cell → not `EXCEPTIONAL`.)

`sampleConfidence` is also surfaced as component #20
(`historicalSampleConfidence`) and feeds the uncertainty channel (§7), so
thin evidence widens toward the prior instead of inflating the score.

---

## 7. Uncertainty channel (missing/stale/conflict ⇒ confidence, not penalty)

None of these can change **direction** or add **edge**. They only pull the
calibrated probability **toward the prior** π (i.e. toward "no edge"), never
toward zero.

**`dataConfidence`** — geometric-mean of freshness/agreement factors, each
computed only when the corresponding data is actually used:

```
quoteFactor   = 1 − quoteAgeMs / quoteFullyStaleMs
chainFactor   = 1 − optionChainAgeMs / optionChainFullyStaleMs   (only if chain used)
oiFactor      = 1 − oiAgeMs / oiFullyStaleMs                      (only if OI used)
missingReqDeriv → 0.3 ;  providerAgreement → itself ; fallbackProvider → 0.8
latencyFactor = 1 − max(0, latencyMs − abnormal)/abnormal
dataConfidence = ( Π clamp(factorⱼ, 0.05, 1) )^{1/J}
```

(Test *stale data* confirms `dataConfidence` decreases with quote age; test
*missing data* confirms a derivatives-required-but-missing signal lowers
`dataConfidence` only.)

**`modelAgreement`** from independent directional votes `vⱼ ∈ [−1,1]`:
```
agreement = clamp01( (mean(v) + 1)/2 − 0.25·stddev(v) )
```
Conflicting votes lower agreement without flipping direction. (Test *conflicting
models*: `[1,−1,1,−1]` < `[1,1,1]`, score no higher, probability stays > 0.3.)

**`signalStability`** = `1 − flipRate` over recent direction votes.

**`costRobustness`** = `clamp01(EV_R@2× / EV_R)`; if base EV ≤ 0 → 0. (Test *cost
stress*: EV collapsing at 2× cost scores strictly lower.)

**Combination — only observed factors apply (missing ⇒ 1, i.e. no penalty):**
```
κ = ( Π clamp(factorₖ, 0.05, 1) )^{1/K}
p_conf = κ · g(b) + (1 − κ) · π
```

So uncertainty interpolates the calibrated probability **toward the learned
prior**, which is the mathematically honest expression of "we are less sure",
and is why missing data is never a directional loss.

---

## 8. Freshness decay

Quality decays as the signal ages, via an exponential half-life applied to the
**above-prior** portion of the probability:

```
δ        = 0.5 ^ ( signalAgeMs / signalHalfLifeMs )      # default half-life 30 min
p        = π + ( p_conf − π ) · δ
```

At one half-life the edge over the prior is halved; a very old signal collapses
to the prior (no fabricated edge). (Test *stale data*: older signal scores lower;
`computeFreshnessDecay(30m, 30m) = 0.5`.) Decay is a pure function of the
explicit `signalAgeMs` — no wall-clock read, preserving determinism.

---

## 9. Final score, grade, attribution

```
qualityScore = round( p · 100 , 1dp )
qualityGrade = EXCEPTIONAL if score ≥ cut.exceptional
               HIGH        if score ≥ cut.high
               MEDIUM      if score ≥ cut.medium
               LOW         if score ≥ cut.low
               REJECT      otherwise
```

**Grade cut-points are learned** (`learnGradeCutpoints`) from OOS-score quantiles
(0.40/0.60/0.80/0.92) with enforced minimum spacing, so each band separates
realized win rate rather than being an arbitrary literal.

The result carries full **component attribution** (`value`, `observed`,
`effectiveWeight`, `contribution`), the uncertainty channel values, `rawEdgeBlend`,
`preDecayProbability`, `freshnessDecay`, deterministic `reasons`, and the matched
conditional cell.

> **Explicitly NOT optimised for the count of top-grade signals.** Grades are set
> from the calibrated realized-profit probability; `EXCEPTIONAL` is rare by
> construction and is earned only by high realized expectancy + win rate, backed
> by adequate sample.

---

## 10. Training pipeline (offline, may use CV; produces a frozen artifact)

`trainQualityModel(examples, cfg)` learns everything from **labelled OOS
outcomes** and freezes a `QualityModel`:

1. **Build CV splits** with purge + embargo (`buildCvSplits`):
   - `walkForward` — expanding train, forward test blocks (test always after train).
   - `purgedKFold` — K contiguous test blocks; the rest is train, purged.
   - `cpcv` — Combinatorial Purged CV: all **pairs** of test blocks.
   - Purge rule: a training example whose label window `[signalMs, outcomeMs]`
     overlaps `[testStart − purgeMs, testEnd + embargoMs]` is removed.
2. **Learn group-budget weights** by deterministic coordinate descent that
   **minimises mean OOS Brier** across the splits (conditional tables + isotonic
   calibration are refit on each fold's TRAIN only). This is what replaces
   hand-tuned weights — no weight can be "increased" unless it lowers held-out
   Brier.
3. **Regime-separated** (default): weights are learned per regime and blended by
   sample share.
4. **Build conditional tables + hierarchical priors** on all data (§6).
5. **Fit the isotonic calibration** on `rawEdgeBlend → label` (§5).
6. **Learn grade cut-points** (§9).
7. **Diagnostics:** OOS Brier, monotonicity report, permutation importance,
   component-correlation matrix, and redundancy warnings (any |corr| > 0.8 pair
   NOT already in the same group is flagged as a double-counting risk).

Config (`DEFAULT_TRAIN_CONFIG`): `purgedKFold`, 5 folds, purge 1 day, embargo 2
days, regime-separated, priorStrength 20, auto grade cut-points, seed 42.

### 10.1 Deterministic inference contract

`scoreQuality(f, M)` is a **pure function**: no `Date.now()`, no `Math.random()`,
no I/O. Freshness/decay depend only on the explicit `signalAgeMs`. (Test
*reproducibility*: identical inputs → byte-identical `JSON.stringify`; repeated
calls give a single distinct score; training is identical for a fixed seed.)

---

## 11. Empirical conditional-performance tables (schema)

`buildConditionalTables` emits, per `strategy × regime × timeframe × bucket` cell,
every metric the brief requires:

| Field | Meaning |
|-------|---------|
| `sampleCount` | resolved trades in the cell |
| `observedWinRate` | raw win rate (pre-shrinkage) |
| `priorWinRate` | family prior used for shrinkage |
| `sampleConfidence` | `n/(n+priorStrength)` |
| `effectiveWinRate` | shrunk win rate (fed to the score) |
| `expectancyR` | expectancy in R |
| `profitFactor` | Σwins/|Σlosses| in R |
| `avgWinR`, `avgLossR` | average winner / loser in R |
| `netReturnR` | Σ R |
| `maxDrawdownR` | peak-to-trough of the R equity curve |
| `costAdjustedReturnR` | Σ cost-adjusted R |
| `slippageAdjustedReturnR` | Σ slippage-adjusted R |

These reuse the audited `stats.ts` helpers (`expectancy`, `profitFactor`,
R-multiple, cost adjust) so the numbers match the existing signal-quality report.

---

## 12. Validation results

### 12.1 Test suite (deterministic, seeded — reproducible)

`tests/lib/signal-intelligence/predictive-quality-engine.test.ts` — **24 tests,
all passing.** The 10 required behaviours map to tests as follows:

| # | Requirement | Test(s) | Result |
|---|-------------|---------|--------|
| 1 | monotonicity | "higher qualityScore ⇒ higher realized win rate" + "predicted probability monotone" | ✅ |
| 2 | no leakage | "CV splits never share indices" + "label-overlap purged (+embargo)" | ✅ |
| 3 | small-sample shrinkage | 3/3→<0.65; 700/1000→>0.68; tiny cell not EXCEPTIONAL | ✅ |
| 4 | correlated feature handling | group membership + group budget < 0.5 | ✅ |
| 5 | missing data | omitted comp → value 0.5/observed false; prob ≥ 0.3; not more confident than full | ✅ |
| 6 | stale data | dataConfidence ↓ with age; older signal scores lower; decay(30m,30m)=0.5 | ✅ |
| 7 | regime transition | family priors differ; identical features score differently by regime | ✅ |
| 8 | conflicting models | disagreement lowers confidence, not direction; prob stays > 0.3 | ✅ |
| 9 | cost stress | EV collapsing at 2× cost → lower costRobustness and lower score | ✅ |
| 10 | reproducibility | byte-identical output; identical training; no clock/random dependence | ✅ |

Plus structural tests (20 components, edge/uncertainty XOR partition, edge weights
sum to 1, default flagged UNTRAINED) and the isotonic monotonicity-by-construction test.

### 12.2 Monotonicity on held-out synthetic data

To validate the calibration end-to-end without a production DB, the tests use a
**seeded synthetic generator** with a known ground truth `P(win) = 0.25 + 0.5·edge`
and train/test on disjoint seeds (true OOS). Observed on the held-out set
(1,500 train / 1,500 test):

| Score bucket | n | realized win rate |
|--------------|----|-------------------|
| 0–40 | 79 | 0.203 |
| 40–50 | 718 | 0.419 |
| 50–60 | 281 | 0.594 |
| 60–70 | 325 | 0.646 |
| 70–80 | 42 | 0.738 |
| 80–90 | 55 | 0.691 |

- **Spearman(score-rank, realized-win-rank) = 0.94.**
- **OOS Brier ≈ 0.23** (vs 0.25 uninformative baseline).
- Win rate rises monotonically across the mass of the distribution
  (0.20 → 0.42 → 0.59 → 0.65 → 0.74).
- The only wobble is the extreme tail (70–80 → 80–90: −0.047 on n=42/55), which
  is **inside the sampling-noise allowance** (combined SE ≈ 0.10) — see §12.3.
- **Learned group weights are non-uniform and data-driven** — e.g.
  `PREDICTIVE_EDGE ≈ 0.32`, `TREND_MOMENTUM ≈ 0.33`, and `PARTICIPATION` driven to
  ~0 when uninformative — demonstrating the trainer does not merely inflate
  existing weights.

### 12.3 Monotonicity criterion (honest, sample-aware)

`verifyMonotonicity` implements the brief's "if monotonicity fails, recalibrate or
redesign" with statistically defensible rules:

1. **Structural guarantee** — predicted probability is monotone in the raw edge
   *by construction* (isotonic). Verified directly.
2. **Realized guarantee** — realized win rate must be non-decreasing across
   **adequately-sampled** buckets (`minBucketCount = 30`, matching the codebase's
   `MIN_SAMPLE_FOR_PRECISION`). Under-populated buckets are reported but excluded.
3. **Sample-aware tolerance** — a dip counts as an inversion only if it exceeds
   `max(tolerance, 1.96·√(SEₐ² + SEᵦ²))` (Wilson-style combined standard error).
   A 0.05 dip on n≈50 (SE≈0.10) is statistically indistinguishable from flat and
   is *not* called an inversion; a 0.20 drop on large n still is.

This prevents both false alarms (tail noise) and false comfort (real inversions
hidden by a loose flat tolerance).

### 12.4 Anti-leakage validation

- CV splits are asserted **disjoint** (train ∩ test = ∅) for all three schemes.
- Every training example whose label window overlaps the test window **±purge/
  embargo** is asserted **absent** from that fold's train set.
- Conditional tables and calibration are refit **per fold on TRAIN only** during
  weight search — the OOS Brier that drives weight selection never sees test data.

### 12.5 Baseline (regression safety)

- `npx tsc --noEmit` → **exit 0** (both app and worker projects).
- `npx eslint` on both new files → **clean**.
- Full suite `npx vitest run` → **202 files / 3155 tests pass** (was 201 / 3131;
  +1 file, +24 tests). No existing test regressed.

---

## 13. Integration plan (not yet wired to production — deliberate)

The engine is complete and tested but is **not yet connected to the live signal
path**, matching the audit's "measure → calibrate → unify → then optimise"
sequence. To go live:

1. **Export outcomes** — build `QualityTrainingExample[]` from resolved
   `PaperTrade` (source `in:`) + `IndiaDailyPick` rows: features captured at
   signal time, `label = 1` iff cost-adjusted profitable, `signalMs`/`outcomeMs`
   for temporal ordering, and R-multiple returns for the tables.
2. **Fit + freeze** — run `trainQualityModel(...)`, confirm
   `monotonicity.winRateMonotonic` and acceptable `oosBrier`, then persist the
   `QualityModel` JSON as a versioned artifact.
3. **Replace the confluence quality** — have the Signal Center / opportunity
   pipeline call `scoreQuality(features, frozenModel)` and use its
   `qualityScore`/`qualityGrade` as the single source of quality & grade,
   retiring the five conflicting ladders (audit §5).
4. **Feed calibrated probability into EV/sizing** — use
   `predictedProfitProbability` as `pWin`, closing the loop the audit flagged.
5. **Monitor** — periodically re-run `verifyMonotonicity` on fresh outcomes; if it
   fails, refit calibration or redesign (never silently loosen thresholds).

Until step 2 completes, the shipped `DEFAULT_QUALITY_MODEL` is
`UNTRAINED_UNIFORM_PRIOR` and every result carries a
`"model_untrained: … NOT empirically validated"` reason, so an untrained
deployment is impossible to mistake for a validated one.

---

## 14. Mapping to the brief's required component list

| # | Brief component | Engine component | Kind |
|---|-----------------|------------------|------|
| 1 | PredictiveProbability | `predictiveProbability` | edge |
| 2 | HistoricalConditionalWinRate | `historicalConditionalWinRate` | edge (shrunk) |
| 3 | ExpectedValue | `expectedValue` | edge |
| 4 | RegimeFit | `regimeFit` | edge |
| 5 | MultiTimeframeAlignment | `multiTimeframeAlignment` | edge |
| 6 | MarketStructure | `marketStructure` | edge |
| 7 | Momentum | `momentum` | edge |
| 8 | Volume | `volume` | edge |
| 9 | VolatilityFit | `volatilityFit` | edge |
| 10 | Liquidity | `liquidity` | edge |
| 11 | DerivativesConfirmation | `derivativesConfirmation` | edge |
| 12 | RelativeStrength | `relativeStrength` | edge |
| 13 | ExecutionQuality | `executionQuality` | edge |
| 14 | DataQuality | `dataQuality` (`dataConfidence`) | uncertainty |
| 15 | ModelAgreement | `modelAgreement` | uncertainty (−disagreement) |
| 16 | SignalStability | `signalStability` | uncertainty |
| 17 | CostRobustness | `costRobustness` | uncertainty (−cost sensitivity) |
| 18 | AlphaDecay | `alphaDecay` | uncertainty |
| 19 | StrategyHealth | `strategyHealth` | uncertainty |
| 20 | HistoricalSampleConfidence | `historicalSampleConfidence` (`sampleConfidence`) | uncertainty |

The brief's target formula —
`SignalQuality = predictiveEdge · structural · regime · liquidity · derivatives ·
execution · historical · calibration · robustness − disagreement − dataUncertainty
− costSensitivity` — is realised as: a **weighted additive edge blend** over the
edge components (the "· factors"), passed through a **monotone calibration**, then
**multiplicatively discounted toward the prior** by the uncertainty channel (the
"− disagreement/uncertainty/cost" terms), and finally decayed by freshness.
