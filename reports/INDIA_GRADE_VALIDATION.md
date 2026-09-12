# INDIA GRADE VALIDATION

**Component:** `src/lib/signal-intelligence/evidence-grading-engine.ts` (`ege-1.0.0`)
**Depends on:** `src/lib/signal-intelligence/predictive-quality-engine.ts` (`pqe-1.0.0`)
**Tests:** `tests/lib/signal-intelligence/evidence-grading-engine.test.ts` (17 tests, all passing)
**Status:** Engine + empirical threshold learner + transition tracking implemented and
validated on held-out synthetic outcomes. Awaiting a production outcome-DB export to
learn and freeze the first per-cell `LEARNED_OOS` threshold model (the shipped default
is `DEFAULT_CONSERVATIVE`).
**Supersedes:** the fixed EV/quality-threshold grading flagged in
`reports/INDIA_SIGNAL_FORENSIC_AUDIT.md` §5, §12.

---

## 0. What changed

| Before (audited) | After (this engine) |
|------------------|---------------------|
| A+/A/B/C/REJECT from fixed EV + quality thresholds | Grades from **calibrated P(profit)** + **12 simultaneous evidence criteria** |
| Universal thresholds | **Conditional** thresholds per `strategy × timeframe × regime`, **learned from OOS** |
| "A+ = high technical score" | A+ requires **all 12 criteria at once**; a high score alone cannot promote |
| No sample gating | **Minimum-sample gating** + **Wilson lower bound** — 80%@5 cannot beat 67%@500 |
| Not verified monotone | Realized expectancy **verified monotone** A+ > A > B > C on held-out data |
| No grade telemetry | `gradeEvidenceScore/Confidence/Stability`, OOS win-rate/expectancy/PF, transition matrix |

The grade now answers: **"What is the empirical, out-of-sample quality of this trade
opportunity?"** — not "how many indicators lined up."

---

## 1. Grade definitions

| Grade | Serialised | Meaning |
|-------|-----------|---------|
| `A_PLUS` | `A+` | Rare, highest-conviction — **all 12** evidence criteria hold simultaneously |
| `A` | `A` | Strong opportunity — A-tier probability/quality/robustness + adequate sample |
| `B` | `B` | Tradable but lower edge — calibrated prob above the strategy break-even + positive expectancy |
| `C` | `C` | Informational / weak edge — has some edge but below the execution bar; **not** structurally invalid |
| `REJECT` | `REJECT` | Negative net EV, poor calibration, critical data issue, thin liquidity, severe disagreement, adverse regime, or insufficient evidence |

Ordinal rank `REJECT(0) < C(1) < B(2) < A(3) < A_PLUS(4)`.

---

## 2. The 12 A+ criteria (all required simultaneously)

A+ is granted **only** when every one of these passes. Each is a named,
inspectable predicate exposed in `aPlusChecks`:

| # | Criterion | Condition |
|---|-----------|-----------|
| 1 | `calibratedProbability` | `p ≥ pAPlus` (strategy-conditional) **AND** Wilson-LB(OOS win rate) ≥ break-even |
| 2 | `positiveNetEV` | cost-adjusted net EV > 0 |
| 3 | `qualityScore` | quality ≥ conditional A+ quality floor |
| 4 | `modelAgreement` | model agreement ≥ severe-disagreement floor |
| 5 | `regimeFit` | regime supports the strategy (≥ 0.5) |
| 6 | `liquidity` | liquidity evidence ≥ 0.6 |
| 7 | `costRobustness` | survives 2× cost stress (≥ floor) |
| 8 | `historicalPerformance` | OOS expectancy > 0 **and** profit factor ≥ 1.2 |
| 9 | `sufficientSample` | OOS sample ≥ `minSampleAPlus` |
| 10 | `noMajorConflicts` | no conflicting-timeframe / derivatives veto |
| 11 | `noCriticalDataDegradation` | data confidence ≥ 0.7 |
| 12 | `noSevereAlphaDecay` | OOS expectancy ≥ alpha-decay floor |

> Test *"A+ requires ALL 12 criteria"* confirms a signal with a strong edge but a
> `hasMajorConflict = true` is denied A+, with `noMajorConflicts` failing.

`A`, `B`, `C` are then assigned by the highest tier whose (looser) condition set
holds; anything below `pC` or tripping a hard veto is `REJECT`.

---

## 3. Conditional thresholds (strategy × timeframe × regime)

Thresholds are **not universal**. Each `GradeThresholdCell` is keyed
`strategy|timeframe|regime` and carries strategy-specific probability cut-points
(`pAPlus, pA, pB, pC`), the implied `breakEvenProb`, quality floors, and
per-grade minimum samples. Lookup falls back
`strategy|tf|regime → strategy|tf|ANY → strategy|ANY|ANY → conservative fallback`.

### 3.1 How thresholds are learned (and why they can't inflate A+)

`learnGradeThresholds` fits each cell from OOS observations
(`GradeTrainingObs`: calibrated prob, quality, realized label, realized R, R:R):

- **break-even** = mean break-even probability implied by observed reward:risk
  (`breakEvenProbability(rewardR, riskR) = 1/(1+rewardR/riskR)`).
- **pB** = lowest probability decile whose *above-set realized expectancy is
  positive* and whose probability exceeds break-even.
- **pA** = lowest cut whose above-set expectancy ≥ **1.5×** the cell's mean
  expectancy (strong separation).
- **pAPlus** = starts at the anti-inflation quantile `(1 − maxAPlusShare)` and is
  **raised until the A+ set's realized expectancy strictly exceeds the A set's.**
  If no such cut exists on the data, the cell **falls back** to the conservative
  default — the engine never invents an A+ tier that doesn't separate.

`maxAPlusShare` (default 0.15) caps how common A+ can be, but the binding
constraint is empirical separation, **not** a target count. Cells with fewer than
`minCellSample` (default 50) OOS observations are not learned at all — they use
the conservative fallback.

> Test *"learned thresholds do not inflate A+"* confirms the A+ share on held-out
> data stays ≤ 0.2 (≈ 13% in the run below).

---

## 4. Statistical evidence gating

### 4.1 Wilson lower bound (the promotion gate)

Promotion to A+/A uses the **Wilson score lower bound** of the OOS win rate, not
the point estimate. This is the mechanism that makes a lucky small sample
worthless:

```
80% on n=5   → Wilson LB ≈ 0.376
67% on n=500 → Wilson LB ≈ 0.627
```

> Test *"wilson lower bound ranks the large sample above the tiny one"* asserts
> `LB(4/5) < LB(335/500)`; test *"grading uses the Wilson lower bound…"* confirms
> a tiny-but-glowing (n=5, 80%) cell is **not** graded A+.

`betaPosteriorMean` (Jeffreys prior) is also provided as a smooth small-sample
estimator.

### 4.2 Minimum-sample gating

A grade **cannot be promoted** below its configured minimum OOS sample
(`minSampleAPlus = 50`, `minSampleA = 30`, `minSampleB = 20` by default). The
`sufficientSample` criterion is one of the 12, and the A/B branches re-check it.

> Test *"a tiny conditional cell cannot be promoted to A+ or A"* confirms the
> `sufficientSample` check fails for n=5 and the grade is neither A+ nor A.

---

## 5. Hard vetoes → REJECT

Applied before any promotion; any one forces `REJECT`:

- data confidence < `criticalDataConfidence` (0.5) — **critical data degradation**
- liquidity < `minLiquidityForTrade` (0.3) — **unacceptable liquidity**
- net EV ≤ 0 — **negative expected value**
- calibrated prob < `pC` — **poor calibration / insufficient edge**
- regime fit < 0.2 — **adverse regime**

> Test *"negative net EV, critical data degradation, and thin liquidity each force
> REJECT"* confirms all three, with the responsible veto surfaced in `vetoes`.

---

## 6. Exposed grade-evidence fields (on the signal payload)

Every field required by the brief is on `GradeResult.evidence`:

| Field | Meaning |
|-------|---------|
| `gradeEvidenceScore` | fraction of the 12 criteria met (0 on a veto) |
| `gradeConfidence` | blend of data confidence, model agreement, and Wilson-interval tightness |
| `gradeStability` | share of grade preserved under ± cost/slippage perturbation (from `assessGradeStability`) |
| `gradeSampleCount` | OOS observations backing the conditional cell |
| `gradeOOSWinRate` | raw OOS win rate |
| `gradeOOSWinRateLB` | Wilson lower bound of the OOS win rate (the gating estimate) |
| `gradeOOSExpectancy` | OOS expectancy in R |
| `gradeOOSProfitFactor` | OOS profit factor |
| `gradeCostRobustness` | survives-2×-cost ratio ∈ [0,1] |

Plus `aPlusChecks` (all 12 with pass/detail), `aPlusCriteriaMet`, `reasons`,
`vetoes`, `thresholdKey`, and `thresholdProvenance`.

---

## 7. Grade transition matrix & lifecycle tracking

`GradeTransitionMatrix` tracks how signals move between grades over their
lifecycle. Canonical direction: **REJECT → C → B → A → A+**.

- `recordTransition(m, from, to)` — classifies a single move as promotion /
  demotion / hold and increments `counts[from][to]`.
- `trackLifecycle(m, [g0, g1, …])` — records a whole signal's grade path.
- `inflationRatio(grades)` — the A+ and A-or-better shares, for a monitor to
  alert on grade inflation.

> Test *"tracks promotions/demotions/holds along a lifecycle"* verifies
> `REJECT→C→B→A→A+` = 4 promotions, `A→B` = 1 demotion, `B→B` = 1 hold, with the
> matrix cells populated.

The grader prevents inflation **structurally** (12 simultaneous criteria + Wilson
+ min-sample + empirically-separated thresholds); the transition matrix and
`inflationRatio` are the **observability** layer on top.

---

## 8. Determinism & no look-ahead

`gradeSignal` is a **pure function** of pre-trade inputs (quality result +
conditional cell + threshold model + context). It never reads a realized outcome.

> Test *"grades do not depend on future information"* asserts two things: (a)
> identical inputs give byte-identical output; (b) a signal's own realized R does
> not enter the grader — two identical-pre-trade signals with opposite outcomes
> receive the same grade.

The only outcome data used is **historical OOS statistics of the conditional
cell** (win rate, expectancy, PF, sample), which were resolved strictly before the
signal — never the signal's own future.

---

## 9. Validation results

### 9.1 Test suite

`tests/lib/signal-intelligence/evidence-grading-engine.test.ts` — **17 tests, all
passing** (deterministic, seeded). Mapping to the required proofs:

| Required proof | Test | Result |
|----------------|------|--------|
| A+ realized expectancy > A > B > C, monotonic | "realized expectancy is monotone…" + "A+ strictly exceeds C" | ✅ |
| grade ordering | GRADE_RANK / GRADE_ORDER structure test | ✅ |
| grades do not depend on future info | "grades do not depend on future information" (purity + outcome-independence) | ✅ |
| stable under cost/slippage perturbation | "keeps its grade under ±15% EV" + "borderline is less stable" | ✅ |
| min-sample gating | "tiny conditional cell cannot be promoted" | ✅ |
| Wilson-CI dominance (80%@5 ≯ 67%@500) | "wilson lower bound ranks the large sample above the tiny one" + grading test | ✅ |
| A+ requires 12 criteria (not just high score) | "A+ requires ALL 12 criteria" | ✅ |
| REJECT vetoes | "negative EV / critical data / thin liquidity force REJECT" | ✅ |
| transition matrix | "tracks promotions/demotions/holds" + "recordTransition" + "inflationRatio" | ✅ |
| anti-inflation thresholds | "learned thresholds do not inflate A+" | ✅ |

### 9.2 Monotonic realized expectancy on held-out OOS data

Synthetic ground truth `P(profit) = 0.2 + 0.6·edge`, R:R = 2 (break-even ≈ 0.33).
Thresholds learned on 2,000 in-sample signals; graded on **4,000 disjoint
out-of-sample** signals. Realized expectancy by assigned grade:

| Grade | n (OOS) | realized expectancy (R) |
|-------|--------:|------------------------:|
| **A+** | 521 | **+1.30** |
| **A** | 1,226 | **+0.93** |
| **B** | 1,667 | **+0.24** |
| **C** | 550 | **−0.27** |
| **REJECT** | 36 | −0.08 |

- Strictly monotone **A+ > A > B > C**, each rung well separated.
- **A+ is rare** (~13% of graded signals) — earned by realized expectancy, not by
  loosening thresholds.
- Learned cell (`OPENING_BREAKOUT|INTRADAY|BULL_TREND`, n=2000):
  `pAPlus ≈ 0.65, pA ≈ 0.49, pB ≈ 0.34, pC = 0.30, breakEven ≈ 0.33,
  provenance = LEARNED_OOS`.

> These numbers come from the deterministic synthetic harness in the test suite.
> They demonstrate the *mechanism* separates realized profitability; the
> production magnitudes will be re-measured once the real outcome DB is wired
> (§10). Per the audit's discipline, real per-grade P&L on live data is
> **NOT MEASURABLE FROM SOURCE — requires the outcome DB.**

### 9.3 Baseline (regression safety)

- `npx tsc --noEmit` → **exit 0**.
- `npx eslint` on both new files → **clean**.
- Full suite `npx vitest run` → **203 files / 3172 tests pass** (was 202 / 3155;
  +1 file, +17 tests). No existing test regressed.

---

## 10. Integration plan (not yet wired to production — deliberate)

Mirrors the predictive-quality engine's measure-first rollout:

1. **Export OOS grade observations** (`GradeTrainingObs[]`) from resolved
   `PaperTrade`/`IndiaDailyPick` rows: the calibrated P(profit) and quality at
   signal time (from `scoreQuality`), realized cost-adjusted label, realized R,
   and the signal's R:R.
2. **Learn + freeze thresholds** via `learnGradeThresholds(...)`, per
   `strategy × timeframe × regime`; cells below `minCellSample` keep the
   conservative fallback.
3. **Replace the old grade** in the Signal Center / opportunity pipeline with
   `gradeSignal(quality, cell, gradingModel, ctx)`; retire the five conflicting
   ladders (audit §5). Serialise `gradeLabel` ("A+" …) and attach the full
   `evidence` bundle to the signal payload.
4. **Set `gradeStability`** on the payload via `assessGradeStability(...)`.
5. **Monitor** the transition matrix and `inflationRatio` continuously; alert if
   the A+/A share drifts up without a matching rise in realized expectancy
   (grade-inflation guard).

Until step 2, the shipped `DEFAULT_GRADING_MODEL` is `DEFAULT_CONSERVATIVE`
(A+ requires calibrated P ≥ 0.66, quality ≥ 72, n ≥ 50, and all 12 criteria), so
A+ is hard to earn by construction — the safe failure mode.
