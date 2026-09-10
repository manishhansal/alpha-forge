# A+ SIGNAL FACTORY REPORT

**Component:** `src/lib/india/a-plus-signal-factory.ts` (`apf-1.0.0`)
**Tests:** `tests/lib/india/a-plus-signal-factory.test.ts` (14 tests, all passing)
**Status:** Engine + tests green. Pure and I/O-free — it is the ranking/selection
layer that CONSUMES the six engines' outputs as a `CandidateSignal` (kept as an
input interface so the factory stays deterministic and unit-testable). Wiring the
live producers into that interface is the remaining integration step.
**Sits on top of:** `INDIA_PROFITABILITY_ENGINE.md`, `INDIA_PREDICTIVE_SIGNAL_QUALITY.md`,
`INDIA_ML_CALIBRATION_REPORT.md`, `INDIA_GRADE_VALIDATION.md`,
`INDIA_STRATEGY_REGIME_MATRIX.md`, `INDIA_SIGNAL_LEARNING_REPORT.md`.

---

## 0. Objective

The purpose is **not** to generate more signals. It is to identify the **smallest
subset of signals with the strongest statistically-defensible edge**, and rank
them by **expected net P&L per unit risk** — never by raw confidence.

A+ is **rare by evidence, not by target percentage**. A candidate is A+ only when
**all** of the required evidence conditions hold **simultaneously**. No quota, no
"top N%", no forcing.

```
ALL CANDIDATES
  → DATA QUALITY → LIQUIDITY → REGIME → STRATEGY FIT → MULTI-LAYER CONFIRMATION
  → CALIBRATED PROBABILITY → PREDICTIVE SIGNAL QUALITY → NET EV
  → COST ROBUSTNESS → COUNTERFACTUAL ROBUSTNESS → HISTORICAL CONDITIONAL EDGE
  → MODEL AGREEMENT → CORRELATION DEDUPLICATION → A+/A/B → TOP OPPORTUNITIES
```

---

## 1. The 14-stage ranking pipeline

`PIPELINE_STAGES` encodes the brief's flow exactly. Stages split into **hard
gates** (reject → `NO_TRADE`) walked in order by `firstRejectingStage`, and
**soft stages** that feed the evidence score rather than hard-rejecting.

| # | Stage | Type | Reject condition (hard) / role (soft) |
|---|-------|------|----------------------------------------|
| 1 | `DATA_QUALITY` | hard | `criticalDataIssue` or `dataQuality < 0.5` |
| 2 | `LIQUIDITY` | hard | `liquidity < 0.3` |
| 3 | `REGIME` | hard | `regime === UNKNOWN` |
| 4 | `STRATEGY_FIT` | hard | `strategySuppressed` or not `strategyRegimeSuitable` |
| 5 | `MULTI_LAYER` | hard | `layerVetoed` or not `multiLayerConfirmed` |
| 6 | `CALIBRATED_PROBABILITY` | hard | `calibratedProbability < 0.5` |
| 7 | `PREDICTIVE_QUALITY` | hard | `qualityScore < 40` |
| 8 | `NET_EV` | hard | `netEVPct <= 0` (cost-adjusted EV must be positive) |
| 9 | `COST_ROBUSTNESS` | hard | not `survives2xCost` |
| 10 | `COUNTERFACTUAL_ROBUSTNESS` | hard | `fragile` (entry-perturbation sensitive) |
| 11 | `HISTORICAL_CONDITIONAL_EDGE` | soft | shrunk conditional win rate feeds evidence |
| 12 | `MODEL_AGREEMENT` | soft | ensemble agreement feeds evidence |
| 13 | `CORRELATION_DEDUP` | soft | clusters correlated signals; sets `independentSignalCount` |
| 14 | `GRADE` | — | evidence-defined bucketing (A+/A/B/WATCH/NO_TRADE) |

The hard gates are intentionally **defensive**: a signal that fails any of them
is not tradable at all, so it never competes for A+. Everything that survives is
then scored and bucketed.

---

## 2. Signal Evidence Score

`computeEvidenceScore` = **weighted positive evidence** attenuated by **weighted
penalties**, all clamped to `[0,1]`.

**Positive components (`EVIDENCE_COMPONENTS`, 8):**

| Component | Derivation |
|-----------|-----------|
| `probabilityEvidence` | `0.5·calibratedProbability + 0.5·probabilityLowerBound` (uses the **lower bound**, conservative) |
| `historicalEvidence` | shrunk `historicalWinRate` × sample-confidence `n/(n+30)` |
| `evEvidence` | net EV in R, normalised (`0R→0.5`, `+1R→1`) |
| `regimeEvidence` | `strategyHealth` if regime-suitable, else 0 |
| `modelAgreement` | ensemble agreement |
| `robustness` | `0.5·costRobustness + 0.5·counterfactualRobustness` |
| `liquidity` | executable liquidity |
| `execution` | `qualityScore/100` |

**Penalty components (`PENALTY_COMPONENTS`, 4):** `uncertainty`, `conflict`,
`costSensitivity` (`1 − costRobustness`), `dataRisk` (`1 − dataQuality`, or 1 on
critical issue).

**Aggregation:** `evidenceScore = positive · (1 − 0.5·penaltyScore)`. Penalties
**attenuate** rather than fully cancel evidence, so a single moderate penalty
can't zero out an otherwise strong signal, but stacked penalties compound.

**Weights are OOS-learnable.** `EvidenceWeights` carries a `provenance` field. The
shipped default `DEFAULT_EVIDENCE_WEIGHTS` is a **uniform prior** and is
explicitly flagged `UNTRAINED_UNIFORM_PRIOR` so it can never masquerade as
empirical. Learned weights (`LEARNED_OOS`) are injected via `runAPlusFactory({ weights })`.

---

## 3. Correlation clustering + `independentSignalCount`

The brief's example: five signals —

```
NIFTY LONG · NIFTY LONG · NIFTY CALL LONG · BANKNIFTY LONG · BANKNIFTY LONG
```

— are **not** five independent confirmations.

**Clustering (`clusterCandidates`):** signals sharing the same **underlying +
direction** within a **30-minute window** (`sameOpportunity`) form one cluster. A
NIFTY future and a NIFTY call are the same underlying, so they cluster together;
BANKNIFTY forms a separate cluster.

**Independence (`independentConfirmations`):** a confirmation counts as
independent evidence only if it brings a **new strategy AND new feature family AND
new signal family**. The independent count is the **minimum** of the distinct
`strategy`, `featureFamily`, and `signalFamily` counts — so a pile of same-family
signals collapses to ~1.

**No duplicate inflation:** cluster probability is the **geometric mean** of member
probabilities. The geometric mean of identical values equals that value — it can
**never** exceed the members' level. Only genuinely independent confirmations add
a small capped boost (`1 + 0.05·(indep − 1)`).

> On the brief's example, the two NIFTY-family LONGs + one NIFTY CALL collapse to
> `< 3` independent confirmations, and the two same-family BANKNIFTY LONGs collapse
> to exactly `1`. (Tested.)

---

## 4. OpportunityScore — net P&L per unit risk

`computeOpportunityScore`:

```
OpportunityScore =
  evFactor × probabilityFactor × qualityFactor
          × robustnessFactor × liquidityFactor × independenceFactor
```

- **`evFactor`** is the **net EV in R** normalised by the OOS `evPerRiskScale` —
  this is what makes the ranking optimise **net P&L per unit risk, not raw
  confidence**. A **negative-EV signal has `evFactor = 0`**, so its whole
  OpportunityScore is 0 regardless of how confident it looks.
- `independenceFactor` uses a `sqrt`-diminishing shape capped at 1, so correlated
  duplicates cannot push a cluster above a single independent bet.

**Product form (not a sum)** is deliberate: any single weak dimension (zero EV,
no liquidity, fragile) collapses the score toward 0. A signal has to be good on
**every** axis to rank highly. Normalisation is OOS-learnable
(`OpportunityNormalization`, default flagged untrained).

> Tested: a high-confidence (`p=0.95`) but negative-EV signal ranks **below** a
> lower-confidence (`p=0.60`) positive-EV signal, and its `evFactor` is exactly 0.

---

## 5. The A+ evidence gate (13 conditions, all simultaneous)

`evaluateAPlusGate` checks the brief's full list. A+ qualification requires **all
13** to pass **at once**, **plus** `evidenceScore ≥ 0.68`, no conflict, no layer
veto, and multi-layer confirmation:

1. positive cost-adjusted EV (survives 2× cost) · 2. high calibrated probability
(point + lower bound) · 3. strong historical win rate · 4. strong quality ·
5. strong regime fit · 6. high model agreement · 7. good liquidity · 8. robust
cost sensitivity · 9. robust entry sensitivity (not fragile) · 10. sufficient
sample · 11. low model uncertainty · 12. no critical data issues · 13. no
strategy degradation.

Because A+ must clear **every** bar simultaneously, it is rare **structurally** —
there is no percentage target anywhere in the code.

---

## 6. Buckets + top-opportunities surface

Evidence-defined bands (checked in order after the hard gates):

| Bucket | Condition |
|--------|-----------|
| `A_PLUS_PRIME` | A+ gate passes · `evidenceScore ≥ 0.80` · `opportunityScore ≥ 0.35` · `independentSignalCount ≥ 2` |
| `A_PLUS_STRONG` | A+ gate passes · `evidenceScore ≥ 0.72` |
| `A_HIGH` | `evidenceScore ≥ 0.60` · `netEV > 0` · survives 2× cost · `p ≥ 0.58` |
| `B_SELECTIVE` | `evidenceScore ≥ 0.45` · `netEV > 0` · survives 2× cost |
| `WATCH` | `netEV > 0` **or** `evidenceScore ≥ 0.30` |
| `NO_TRADE` | rejected at a hard gate, or insufficient evidence |

**PRIME requires an independent confirmation** — a single-source signal, however
strong, tops out at `A_PLUS_STRONG`. `topOpportunities` contains **only PRIME +
STRONG**, sorted by OpportunityScore descending. That is the only surface for the
highest-priority display. Ranking across the whole set is by OpportunityScore with
a deterministic `signalId` tie-break.

---

## 7. Evidence card (per A+ signal)

`buildEvidenceCard` returns a card for PRIME/STRONG signals and `null` for
everything else. Every field the brief requires:

`whyItQualifies` (the passed A+ criteria with their measured values) · `probability`
· `historicalWinRate` · `sampleSize` · `expectedValueR` · `riskReward`
(`|target−entry| / |entry−stop|`) · `regime` · `modelAgreement` · `liquidity` ·
`costRobustness` · `recentStrategyPerformance` (strategy health) ·
`mainInvalidation` (the stop-based thesis-invalidation condition).

---

## 8. Validation — A+ > A > B on realized OOS outcomes

The proof is **outcome-based**, not threshold-based. The test builds a large
candidate population whose observable evidence is driven by a **latent edge**,
buckets them with the factory, then **realizes each outcome from the true
(unobserved) win probability using a disjoint RNG seed** (the "untouched OOS"
draw). Realized R includes a cost drag.

Measured over a 6,000-candidate population (win = +2R, loss = −1R, −0.15R cost):

| Bucket | n | Realized win rate | Expectancy | Profit factor |
|--------|---|-------------------|-----------|---------------|
| **A+ (PRIME+STRONG)** | 793 | **72.5%** | **+1.025 R** | **4.24** |
| **A (HIGH)** | 836 | **59.8%** | **+0.644 R** | **2.39** |
| **B (SELECTIVE)** | 320 | **53.1%** | **+0.444 R** | **1.82** |

**A+ > A > B strictly holds on realized win rate, expectancy, profit factor, and
net return** — the assertions the brief requires. A+ was **13.2%** of the
population (rare, evidence-defined — no percentage was targeted).

> ⚠️ These figures come from the **synthetic OOS harness** that proves the ranking
> is monotonic in true edge. They are **NOT live production numbers**. Real A+/A/B
> realized statistics are **NOT MEASURABLE FROM SOURCE** until the six live
> engines feed the `CandidateSignal` interface and the signal-learning-loop
> resolves real outcomes into an outcome DB.

**Full test coverage (14 tests):**
- A+ > A > B on realized win rate / expectancy / PF / net return (OOS draw)
- A+ rarity (`< 25%` of a realistic population; achievable)
- `independentConfirmations` collapses same-family duplicates to 1; distinct
  families count higher
- five correlated NIFTY/BANKNIFTY LONGs ≠ five independent confirmations
- duplicate signals do not inflate cluster probability above members' level
- OpportunityScore ranks net-EV/risk over raw confidence (negative EV ⇒ score 0)
- top surface is PRIME/STRONG only, sorted by OpportunityScore
- hard-gate failure → `NO_TRADE` with the rejecting stage recorded
- net-negative EV can never be A+
- evidence card completeness (and `null` for non-A+)
- determinism (identical input → identical ranking + stable evidence score)

**Quality gates:** `tsc --noEmit` clean · `eslint` clean · full baseline
**208 files / 3,280 tests passing**.

---

## 9. Integration plan (remaining work)

1. **Adapters → `CandidateSignal`.** Map each live engine's output onto the input
   fields: profitability-engine (`netEVPct/netEVR/riskPct/costRobustness/
   survives2xCost/counterfactualRobustness/fragile`), predictive-quality
   (`qualityScore`), ml-calibration (`calibratedProbability/probabilityLowerBound/
   modelAgreement/predictionUncertainty`), grade/strategy-regime
   (`strategyRegimeSuitable/strategyHealth/strategyDegraded/regime`),
   market-data/reconciliation (`dataQuality/criticalDataIssue/liquidity`),
   multi-layer confirmation (`multiLayerConfirmed/layerVetoed`).
2. **Feature/signal-family taxonomy.** Populate `featureFamily`/`signalFamily`
   consistently so correlation dedup is meaningful across producers.
3. **OOS weight + normalisation training.** Learn `EvidenceWeights` and
   `OpportunityNormalization` from resolved outcomes (via the signal-learning-loop),
   flip `provenance` to `LEARNED_OOS`, and re-tune the bucket cutpoints against
   realized A+/A/B separation. Governed by champion/challenger promotion.
4. **Surface wiring.** Expose `topOpportunities` (PRIME/STRONG only) to the
   highest-priority signal surface; render `buildEvidenceCard` for each.
5. **Live monitoring.** Track realized A+/A/B win rate, expectancy, PF, and net
   return to confirm the monotonic ordering holds on real fills, and alert if it
   inverts.

---

## 10. Design decisions

- **Consumes, not imports, the engines.** The factory reads a `CandidateSignal`
  rather than importing the six engines directly — this keeps it pure,
  deterministic, and unit-testable, and avoids coupling the ranking logic to
  producer internals.
- **Evidence-defined rarity, never a quota.** No line of code targets a
  percentage. Rarity is an emergent property of requiring all 13 conditions plus a
  high evidence band simultaneously.
- **Conservative everywhere.** Lower-bound probability, shrunk historical win
  rate, geometric-mean cluster probability, product-form opportunity score,
  penalty attenuation — every choice biases against false A+ labels.
- **No duplicate inflation.** Correlated confirmations cannot raise confidence;
  only genuinely independent evidence can, and only modestly.
- **Untrained defaults are labelled.** Both weight vectors carry a `provenance`
  flag so an untrained uniform prior can never be mistaken for a learned,
  empirical model.
