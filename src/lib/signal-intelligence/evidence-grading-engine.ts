/**
 * Evidence-Based Signal Grading Engine  (v1 — empirical)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * ---------------
 * The forensic audit (`reports/INDIA_SIGNAL_FORENSIC_AUDIT.md`) found five
 * conflicting grade ladders, all keyed on fixed EV/quality thresholds, none
 * verified to separate realized profitability. This engine replaces the
 * A+/A/B/C/REJECT grading with an EVIDENCE-BASED framework layered on top of the
 * `predictive-quality-engine`.
 *
 * A grade here means: "the empirical quality of this trade opportunity, backed by
 * out-of-sample evidence." Specifically:
 *
 *   A+     rare, highest-conviction — ALL 12 evidence criteria hold simultaneously
 *   A      strong opportunity
 *   B      tradable but lower edge (above the strategy-specific break-even)
 *   C      informational / weak edge (not necessarily structurally invalid)
 *   REJECT negative or insufficient evidence, or a critical veto
 *
 * CORE RULES (all enforced in code + tests):
 *   1. A+ is NOT "high technical score". A+ requires 12 simultaneous conditions
 *      (calibrated P, positive net EV, quality, model agreement, regime fit,
 *      liquidity, cost robustness, historical performance, sufficient sample,
 *      no major conflicts, no critical data degradation, no severe alpha decay).
 *   2. Thresholds are CONDITIONAL on strategy × timeframe × regime and LEARNED
 *      from OOS outcomes — never a universal hard-coded probability when the
 *      empirical break-evens differ. `learnGradeThresholds` picks cut-points that
 *      SEPARATE realized expectancy, and explicitly does NOT maximise A+ count.
 *   3. Statistical evidence gating: a grade cannot be PROMOTED on fewer than the
 *      configured minimum OOS observations, and promotion uses the WILSON LOWER
 *      BOUND of the win rate — so 80% on n=5 cannot beat 67% on n=500.
 *   4. Deterministic: `gradeSignal(...)` is a pure function of its inputs.
 *
 * This module is I/O-free and has no `server-only` guard so it is unit-testable
 * and usable from both the Next app and the worker.
 */

import {
  scoreQuality,
  type QualityFeatureVector,
  type QualityModel,
  type QualityScoreResult,
  type ConditionalPerformanceCell,
  type QualityTimeframe,
  type QualityRegime,
} from "./predictive-quality-engine";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Grade vocabulary
// ═══════════════════════════════════════════════════════════════════════════

export const EVIDENCE_GRADING_ENGINE_VERSION = "ege-1.0.0";

/** The public grade ladder. `A_PLUS` serialises to "A+" via `gradeLabel`. */
export type EvidenceGrade = "A_PLUS" | "A" | "B" | "C" | "REJECT";

/** Ordinal rank for monotonicity checks and transition tracking. */
export const GRADE_RANK: Record<EvidenceGrade, number> = {
  REJECT: 0,
  C: 1,
  B: 2,
  A: 3,
  A_PLUS: 4,
};

export const GRADE_ORDER: EvidenceGrade[] = ["REJECT", "C", "B", "A", "A_PLUS"];

export function gradeLabel(g: EvidenceGrade): string {
  return g === "A_PLUS" ? "A+" : g;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — The 12 A+ criteria
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The twelve criteria that must ALL hold simultaneously for A+. Each is a named,
 * inspectable predicate so the grade is fully explainable and no single "high
 * technical score" can promote a signal on its own.
 */
export const A_PLUS_CRITERIA = [
  "calibratedProbability",     // P(profit) ≥ strategy-conditional A+ threshold (Wilson-gated)
  "positiveNetEV",             // cost-adjusted net EV > 0
  "qualityScore",              // quality score ≥ conditional A+ quality floor
  "modelAgreement",            // independent models agree (no severe disagreement)
  "regimeFit",                 // regime supports this strategy
  "liquidity",                 // acceptable liquidity / tradability
  "costRobustness",            // survives 2× cost stress
  "historicalPerformance",     // OOS expectancy & profit factor positive for this cell
  "sufficientSample",          // OOS sample ≥ min for A+ promotion
  "noMajorConflicts",          // no conflicting-timeframe / derivatives veto
  "noCriticalDataDegradation", // data confidence above the critical floor
  "noSevereAlphaDecay",        // recent edge for this cell not decaying badly
] as const;

export type APlusCriterion = (typeof A_PLUS_CRITERIA)[number];

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Conditional thresholds (strategy × timeframe × regime)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One cell of learned grade thresholds. Probabilities are CALIBRATED
 * P(profit) thresholds; `qualityFloor` is on the 0–100 quality score.
 * `minSample*` are the minimum OOS observations required to PROMOTE into a grade.
 */
export interface GradeThresholdCell {
  key: string;                 // "strategy|timeframe|regime"
  /** Calibrated P(profit) required for A+ (strategy-specific). */
  pAPlus: number;
  /** Calibrated P(profit) required for A. */
  pA: number;
  /** Calibrated P(profit) required for B — the strategy break-even + margin. */
  pB: number;
  /** Calibrated P(profit) floor for C (informational). Below → REJECT. */
  pC: number;
  /** The strategy break-even probability implied by its avg R:R. */
  breakEvenProb: number;
  /** Quality-score floor for A+ (0–100). */
  qualityFloorAPlus: number;
  /** Quality-score floor for A. */
  qualityFloorA: number;
  /** Minimum OOS sample to promote to A+ / A / B respectively. */
  minSampleAPlus: number;
  minSampleA: number;
  minSampleB: number;
  /** Provenance: was this cell learned from data, or a conservative default? */
  provenance: "LEARNED_OOS" | "DEFAULT_CONSERVATIVE";
  /** OOS sample the cell was learned on. */
  learnedFromSamples: number;
}

/**
 * The frozen grading model: a table of conditional threshold cells + fallbacks,
 * and global safety floors that apply regardless of the cell.
 */
export interface GradingModel {
  version: string;
  thresholds: Record<string, GradeThresholdCell>;
  /** Fallback used when no cell matches — deliberately conservative. */
  fallback: GradeThresholdCell;
  /** Global hard safety limits (vetoes) applied before any promotion. */
  safety: {
    /** Below this data confidence, the signal is REJECT (critical degradation). */
    criticalDataConfidence: number;
    /** Below this model agreement, A+/A are impossible (severe disagreement). */
    severeDisagreement: number;
    /** Below this cost robustness, A+ is impossible. */
    minCostRobustnessAPlus: number;
    /** Below this liquidity evidence [0,1], the signal cannot exceed C. */
    minLiquidityForTrade: number;
    /** Alpha-decay expectancy floor (R): below → severe decay veto for A+/A. */
    alphaDecayExpectancyFloorR: number;
  };
  /** Default minimum-sample requirements (used by fallback & as floors). */
  minSampleDefaults: { aPlus: number; a: number; b: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Statistical helpers (Wilson / Beta)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wilson score interval for a binomial proportion. More accurate than the normal
 * approximation for small n, and the standard tool for "is this win rate
 * trustworthy?". Returns [lower, upper] at confidence `z` (default 95%).
 */
export function wilsonInterval(wins: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/** Wilson LOWER bound — the conservative, promotion-gating win-rate estimate. */
export function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  return wilsonInterval(wins, n, z)[0];
}

/**
 * Beta posterior mean with a Jeffreys prior Beta(0.5, 0.5). A smooth alternative
 * to raw win rate that is well-defined at n=0 and shrinks small samples.
 */
export function betaPosteriorMean(wins: number, n: number, priorA = 0.5, priorB = 0.5): number {
  return (wins + priorA) / (n + priorA + priorB);
}

/** Break-even win probability for a given reward:risk ratio (after costs). */
export function breakEvenProbability(rewardR: number, riskR = 1): number {
  const rr = rewardR / Math.max(1e-9, riskR);
  // p·rr - (1-p)·1 = 0  ⇒  p = 1 / (1 + rr)
  return 1 / (1 + rr);
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Grade evidence & result
// ═══════════════════════════════════════════════════════════════════════════

/** Per-criterion A+ evaluation, exposed for full explainability. */
export interface CriterionCheck {
  criterion: APlusCriterion;
  passed: boolean;
  detail: string;
}

/**
 * The evidence bundle surfaced on the signal payload. Every field the brief
 * requires is present.
 */
export interface GradeEvidence {
  /** Composite 0–1 evidence score (how many of the weighted criteria hold). */
  gradeEvidenceScore: number;
  /** Confidence in the grade itself (Wilson-width + data confidence blend) ∈ [0,1]. */
  gradeConfidence: number;
  /** Stability of the grade under cost/slippage perturbation ∈ [0,1]. */
  gradeStability: number;
  /** OOS sample count backing the conditional cell. */
  gradeSampleCount: number;
  /** OOS observed win rate (raw) for the cell. */
  gradeOOSWinRate: number;
  /** Wilson lower bound of the OOS win rate (the promotion-gating estimate). */
  gradeOOSWinRateLB: number;
  /** OOS expectancy in R for the cell. */
  gradeOOSExpectancy: number;
  /** OOS profit factor for the cell. */
  gradeOOSProfitFactor: number;
  /** Cost robustness ∈ [0,1] (survives 2× cost stress). */
  gradeCostRobustness: number;
}

export interface GradeResult {
  version: string;
  grade: EvidenceGrade;
  gradeLabel: string;              // "A+", "A", ...
  /** The calibrated P(profit) used for grading (from the quality engine). */
  calibratedProbability: number;
  /** The conditional threshold cell used. */
  thresholdKey: string;
  thresholdProvenance: GradeThresholdCell["provenance"];
  /** All 12 A+ criteria with pass/fail + detail. */
  aPlusChecks: CriterionCheck[];
  /** Number of A+ criteria satisfied (0–12). */
  aPlusCriteriaMet: number;
  evidence: GradeEvidence;
  /** Deterministic human-readable reasons. */
  reasons: string[];
  /** Any hard veto that capped/blocked the grade. */
  vetoes: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — The grader (deterministic)
// ═══════════════════════════════════════════════════════════════════════════

/** Resolve the most specific available threshold cell for a signal. */
export function lookupThresholdCell(
  model: GradingModel,
  strategyId: string,
  timeframe: QualityTimeframe,
  regime: QualityRegime,
): GradeThresholdCell {
  return (
    model.thresholds[`${strategyId}|${timeframe}|${regime}`] ??
    model.thresholds[`${strategyId}|${timeframe}|ANY`] ??
    model.thresholds[`${strategyId}|ANY|ANY`] ??
    model.fallback
  );
}

/**
 * Grade a signal from its quality result + matched conditional cell + the
 * conditional threshold model. PURE and DETERMINISTIC.
 *
 * The algorithm:
 *   1. Apply HARD VETOES (critical data, adverse regime, unacceptable liquidity,
 *      negative EV, poor calibration) → REJECT immediately.
 *   2. Evaluate the 12 A+ criteria (statistical, Wilson-gated, min-sample-gated).
 *   3. Assign the highest grade whose full criterion set holds:
 *        A+  ⇐ all 12 criteria
 *        A   ⇐ A-tier probability/quality/robustness + adequate sample
 *        B   ⇐ probability above the strategy break-even + positive expectancy
 *        C   ⇐ has some edge but below execution bar (not structurally invalid)
 *        REJECT otherwise.
 *   4. Compute the exposed grade-evidence fields.
 */
export function gradeSignal(
  quality: QualityScoreResult,
  cell: ConditionalPerformanceCell | null,
  model: GradingModel,
  ctx: {
    strategyId: string;
    timeframe: QualityTimeframe;
    regime: QualityRegime;
    /** Liquidity evidence [0,1] (from the feature vector). */
    liquidity: number | null;
    /** Net EV in R (cost-adjusted). null ⇒ unknown. */
    netExpectedValueR: number | null;
    /** Regime-fit evidence [0,1]. */
    regimeFit: number | null;
    /** True if a conflicting-timeframe / derivatives conflict was detected. */
    hasMajorConflict: boolean;
  },
): GradeResult {
  const th = lookupThresholdCell(model, ctx.strategyId, ctx.timeframe, ctx.regime);
  const p = quality.predictedProfitProbability;
  const reasons: string[] = [];
  const vetoes: string[] = [];

  // ── OOS statistics from the conditional cell (with Wilson lower bound) ──────
  const sampleCount = cell?.sampleCount ?? 0;
  const oosWinRate = cell?.observedWinRate ?? 0;
  const wins = Math.round(oosWinRate * sampleCount);
  const oosWinRateLB = sampleCount > 0 ? wilsonLowerBound(wins, sampleCount) : 0;
  const oosExpectancy = cell?.expectancyR ?? 0;
  const oosProfitFactor = cell?.profitFactor ?? 0;

  const liq = ctx.liquidity ?? 0.5;
  const evR = ctx.netExpectedValueR;
  const regimeFit = ctx.regimeFit ?? 0.5;

  // ── (1) HARD VETOES → REJECT ────────────────────────────────────────────────
  if (quality.dataConfidence < model.safety.criticalDataConfidence) {
    vetoes.push(`critical_data_degradation:${quality.dataConfidence.toFixed(2)}`);
  }
  if (liq < model.safety.minLiquidityForTrade) {
    vetoes.push(`unacceptable_liquidity:${liq.toFixed(2)}`);
  }
  if (evR != null && evR <= 0) {
    vetoes.push(`negative_net_ev:${evR.toFixed(3)}R`);
  }
  if (p < th.pC) {
    vetoes.push(`below_min_calibrated_probability:${p.toFixed(3)}<${th.pC.toFixed(3)}`);
  }
  // Adverse regime is a veto only when regime fit is clearly against the strategy.
  if (regimeFit < 0.2) {
    vetoes.push(`adverse_regime:${regimeFit.toFixed(2)}`);
  }

  if (vetoes.length > 0) {
    return buildResult("REJECT", quality, th, [], reasons, vetoes, {
      sampleCount, oosWinRate, oosWinRateLB, oosExpectancy, oosProfitFactor,
    });
  }

  // ── (2) Evaluate the 12 A+ criteria ─────────────────────────────────────────
  const checks: CriterionCheck[] = [];
  const check = (c: APlusCriterion, passed: boolean, detail: string) =>
    checks.push({ criterion: c, passed, detail });

  // A+ probability is gated on BOTH the calibrated point estimate AND the Wilson
  // lower bound of the OOS win rate — so a lucky small sample cannot promote.
  const probOk = p >= th.pAPlus && (sampleCount === 0 ? false : oosWinRateLB >= th.breakEvenProb);
  check("calibratedProbability", probOk, `p=${p.toFixed(3)}≥${th.pAPlus.toFixed(3)} & wilsonLB=${oosWinRateLB.toFixed(3)}≥breakeven=${th.breakEvenProb.toFixed(3)}`);
  check("positiveNetEV", evR != null && evR > 0, `netEV=${evR == null ? "n/a" : evR.toFixed(3)}R`);
  check("qualityScore", quality.qualityScore >= th.qualityFloorAPlus, `q=${quality.qualityScore.toFixed(1)}≥${th.qualityFloorAPlus}`);
  check("modelAgreement", quality.modelAgreement >= model.safety.severeDisagreement, `agree=${quality.modelAgreement.toFixed(2)}`);
  check("regimeFit", regimeFit >= 0.5, `regimeFit=${regimeFit.toFixed(2)}`);
  check("liquidity", liq >= 0.6, `liq=${liq.toFixed(2)}`);
  check("costRobustness", quality.costRobustness >= model.safety.minCostRobustnessAPlus, `costRobust=${quality.costRobustness.toFixed(2)}`);
  check("historicalPerformance", oosExpectancy > 0 && oosProfitFactor >= 1.2, `expR=${oosExpectancy.toFixed(3)} pf=${oosProfitFactor.toFixed(2)}`);
  check("sufficientSample", sampleCount >= th.minSampleAPlus, `n=${sampleCount}≥${th.minSampleAPlus}`);
  check("noMajorConflicts", !ctx.hasMajorConflict, ctx.hasMajorConflict ? "conflict_present" : "no_conflict");
  check("noCriticalDataDegradation", quality.dataConfidence >= 0.7, `dataConf=${quality.dataConfidence.toFixed(2)}`);
  check("noSevereAlphaDecay", oosExpectancy >= model.safety.alphaDecayExpectancyFloorR, `expR=${oosExpectancy.toFixed(3)}≥${model.safety.alphaDecayExpectancyFloorR}`);

  const aPlusMet = checks.filter((c) => c.passed).length;

  // ── (3) Grade assignment (highest grade whose full set holds) ───────────────
  let grade: EvidenceGrade;
  if (aPlusMet === A_PLUS_CRITERIA.length) {
    grade = "A_PLUS";
    reasons.push("all_12_evidence_criteria_met");
  } else if (
    p >= th.pA &&
    (evR == null || evR > 0) &&
    quality.qualityScore >= th.qualityFloorA &&
    quality.modelAgreement >= model.safety.severeDisagreement &&
    quality.costRobustness >= 0.4 &&
    sampleCount >= th.minSampleA &&
    (sampleCount === 0 || oosWinRateLB >= th.breakEvenProb) &&
    !ctx.hasMajorConflict
  ) {
    grade = "A";
    reasons.push("strong_opportunity");
  } else if (
    p >= th.pB &&
    oosExpectancy > 0 &&
    sampleCount >= th.minSampleB
  ) {
    grade = "B";
    reasons.push("tradable_above_breakeven");
  } else if (p >= th.pC) {
    grade = "C";
    reasons.push("informational_weak_edge");
  } else {
    grade = "REJECT";
    reasons.push("insufficient_evidence");
  }

  // Record which criteria failed (for the top grades) for transparency.
  if (grade !== "A_PLUS") {
    const failed = checks.filter((c) => !c.passed).map((c) => c.criterion);
    if (failed.length > 0) reasons.push(`a_plus_blocked_by:${failed.join(",")}`);
  }

  return buildResult(grade, quality, th, checks, reasons, vetoes, {
    sampleCount, oosWinRate, oosWinRateLB, oosExpectancy, oosProfitFactor,
  });
}

function buildResult(
  grade: EvidenceGrade,
  quality: QualityScoreResult,
  th: GradeThresholdCell,
  checks: CriterionCheck[],
  reasons: string[],
  vetoes: string[],
  oos: { sampleCount: number; oosWinRate: number; oosWinRateLB: number; oosExpectancy: number; oosProfitFactor: number },
): GradeResult {
  const aPlusMet = checks.filter((c) => c.passed).length;

  // gradeEvidenceScore: fraction of the 12 criteria met (0 when REJECT-by-veto).
  const gradeEvidenceScore = vetoes.length > 0 ? 0 : aPlusMet / A_PLUS_CRITERIA.length;

  // gradeConfidence: blend of data confidence, model agreement, and how tight the
  // OOS win-rate interval is (narrow interval on a large sample ⇒ high confidence).
  const wilsonWidth = oos.sampleCount > 0
    ? (() => { const [lo, hi] = wilsonInterval(Math.round(oos.oosWinRate * oos.sampleCount), oos.sampleCount); return hi - lo; })()
    : 1;
  const intervalConfidence = clamp01(1 - wilsonWidth);
  const gradeConfidence = clamp01(
    0.4 * quality.dataConfidence + 0.3 * quality.modelAgreement + 0.3 * intervalConfidence,
  );

  const evidence: GradeEvidence = {
    gradeEvidenceScore,
    gradeConfidence,
    gradeStability: 1, // filled by the caller via assessGradeStability when needed
    gradeSampleCount: oos.sampleCount,
    gradeOOSWinRate: oos.oosWinRate,
    gradeOOSWinRateLB: oos.oosWinRateLB,
    gradeOOSExpectancy: oos.oosExpectancy,
    gradeOOSProfitFactor: oos.oosProfitFactor,
    gradeCostRobustness: quality.costRobustness,
  };

  return {
    version: EVIDENCE_GRADING_ENGINE_VERSION,
    grade,
    gradeLabel: gradeLabel(grade),
    calibratedProbability: quality.predictedProfitProbability,
    thresholdKey: th.key,
    thresholdProvenance: th.provenance,
    aPlusChecks: checks,
    aPlusCriteriaMet: aPlusMet,
    evidence,
    reasons,
    vetoes,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — Grade stability under cost/slippage perturbation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assess how stable the grade is under reasonable cost/slippage perturbations.
 * Re-grades the signal with the net EV (and calibrated probability proxy) nudged
 * by ± a fraction, and reports the share of perturbations that keep the SAME
 * grade. Deterministic given inputs.
 *
 * This is what backs the "grades are stable under reasonable cost/slippage
 * perturbations" test — a grade that flips on a 5 bps cost change is unstable.
 */
export function assessGradeStability(
  baseFeatures: QualityFeatureVector,
  qualityModel: QualityModel,
  gradingModel: GradingModel,
  cell: ConditionalPerformanceCell | null,
  ctx: Parameters<typeof gradeSignal>[3],
  perturbations: number[] = [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15],
): { stability: number; grades: EvidenceGrade[] } {
  const baseQuality = scoreQuality(baseFeatures, qualityModel);
  const baseGrade = gradeSignal(baseQuality, cell, gradingModel, ctx).grade;

  const grades: EvidenceGrade[] = [];
  for (const dp of perturbations) {
    // Perturb the cost-sensitive inputs: net EV in R and the 2×-cost EV.
    const evR = ctx.netExpectedValueR;
    const perturbedFeatures: QualityFeatureVector = {
      ...baseFeatures,
      netExpectedValueR: baseFeatures.netExpectedValueR == null ? null : baseFeatures.netExpectedValueR + dp,
      netExpectedValueRAt2xCost: baseFeatures.netExpectedValueRAt2xCost == null ? null : baseFeatures.netExpectedValueRAt2xCost + dp,
    };
    const q = scoreQuality(perturbedFeatures, qualityModel);
    const perturbedCtx = { ...ctx, netExpectedValueR: evR == null ? null : evR + dp };
    grades.push(gradeSignal(q, cell, gradingModel, perturbedCtx).grade);
  }
  const same = grades.filter((g) => g === baseGrade).length;
  return { stability: same / grades.length, grades };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — Empirical threshold learning (no inflation)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One labelled OOS observation used to learn grade thresholds. `calibratedProb`
 * is the quality engine's `predictedProfitProbability` at signal time, `label`
 * is the realized cost-adjusted outcome, `returnR` the realized R.
 */
export interface GradeTrainingObs {
  strategyId: string;
  timeframe: QualityTimeframe;
  regime: QualityRegime;
  calibratedProb: number;
  qualityScore: number;
  label: 0 | 1;
  returnR: number;
  /** Reward:risk at signal time (for break-even). */
  rewardR: number;
}

export interface LearnThresholdConfig {
  /** Minimum OOS observations in a cell before it is LEARNED (else fallback). */
  minCellSample: number;
  /** Minimum sample to promote to A+/A/B (evidence gate). */
  minSampleAPlus: number;
  minSampleA: number;
  minSampleB: number;
  /**
   * Target A+ selectivity as a MAX share of the cell's signals (anti-inflation).
   * A+ probability threshold is pushed UP until no more than this fraction would
   * qualify — thresholds are chosen to separate expectancy, never to hit a count.
   */
  maxAPlusShare: number;
  /** Confidence z for Wilson gating. */
  z: number;
}

export const DEFAULT_LEARN_THRESHOLD_CONFIG: LearnThresholdConfig = {
  minCellSample: 50,
  minSampleAPlus: 50,
  minSampleA: 30,
  minSampleB: 20,
  maxAPlusShare: 0.15, // A+ is rare by design
  z: 1.96,
};

/**
 * Learn conditional grade thresholds from OOS observations.
 *
 * Method (per strategy×timeframe×regime cell):
 *   • break-even = mean break-even prob implied by observed reward:risk.
 *   • Candidate probability cut-points are the deciles of the cell's calibrated
 *     probabilities. For each candidate we measure the realized expectancy of the
 *     signals AT OR ABOVE it.
 *   • pB   = lowest cut-point whose above-set expectancy is positive AND whose
 *            calibrated prob exceeds break-even (tradable edge).
 *   • pA   = lowest cut-point whose above-set expectancy is ≥ 1.5× the cell mean
 *            expectancy (strong separation).
 *   • pAPlus = the cut-point at the (1 − maxAPlusShare) quantile, RAISED until the
 *            above-set expectancy strictly exceeds the A-set expectancy — i.e.
 *            A+ must EMPIRICALLY out-perform A, not merely be scarcer.
 *   • pC   = break-even − small margin (informational floor).
 *
 * Crucially the A+ threshold is only ACCEPTED if the resulting A+ set has higher
 * realized expectancy than the A set on this OOS data; otherwise the cell falls
 * back to the conservative default (we never invent an A+ tier that doesn't
 * separate).
 */
export function learnGradeThresholds(
  observations: GradeTrainingObs[],
  cfg: LearnThresholdConfig = DEFAULT_LEARN_THRESHOLD_CONFIG,
  base: GradingModel = DEFAULT_GRADING_MODEL,
): GradingModel {
  const byCell = new Map<string, GradeTrainingObs[]>();
  for (const o of observations) {
    const k = `${o.strategyId}|${o.timeframe}|${o.regime}`;
    const arr = byCell.get(k);
    if (arr) arr.push(o);
    else byCell.set(k, [o]);
  }

  const thresholds: Record<string, GradeThresholdCell> = {};

  for (const [key, rows] of byCell) {
    if (rows.length < cfg.minCellSample) continue; // not enough evidence → fallback

    const [strategyId] = key.split("|");
    const probs = rows.map((r) => r.calibratedProb).sort((a, b) => a - b);
    const breakEven = mean(rows.map((r) => breakEvenProbability(r.rewardR, 1)));
    const cellExpectancy = expectancyOfObs(rows);

    const above = (cut: number) => rows.filter((r) => r.calibratedProb >= cut);
    const quantile = (q: number) => probs[Math.min(probs.length - 1, Math.floor(q * probs.length))]!;

    // pB — lowest decile cut with positive above-set expectancy and prob>breakeven
    let pB = breakEven;
    for (let q = 0.1; q <= 0.9; q += 0.1) {
      const cut = quantile(q);
      const set = above(cut);
      if (set.length >= cfg.minSampleB && expectancyOfObs(set) > 0 && cut >= breakEven) {
        pB = cut;
        break;
      }
    }

    // pA — lowest cut whose above-set expectancy ≥ 1.5× cell expectancy
    let pA = Math.max(pB + 0.02, quantile(0.6));
    for (let q = 0.5; q <= 0.95; q += 0.05) {
      const cut = quantile(q);
      const set = above(cut);
      if (set.length >= cfg.minSampleA && expectancyOfObs(set) >= Math.max(0, 1.5 * cellExpectancy)) {
        pA = Math.max(cut, pB + 0.02);
        break;
      }
    }

    // pAPlus — start at the anti-inflation quantile, raise until A+ > A empirically
    let pAPlus = Math.max(pA + 0.02, quantile(1 - cfg.maxAPlusShare));
    const aSet = above(pA);
    const aExp = expectancyOfObs(aSet);
    let aPlusAccepted = false;
    for (let q = 1 - cfg.maxAPlusShare; q <= 0.98; q += 0.02) {
      const cut = Math.max(quantile(q), pA + 0.02);
      const set = above(cut);
      if (set.length >= cfg.minSampleAPlus && expectancyOfObs(set) > aExp) {
        pAPlus = cut;
        aPlusAccepted = true;
        break;
      }
    }

    const qualitiesAbovePA = above(pA).map((r) => r.qualityScore);
    const qualitiesAbovePAPlus = above(pAPlus).map((r) => r.qualityScore);

    thresholds[key] = {
      key,
      pAPlus: aPlusAccepted ? pAPlus : base.fallback.pAPlus,
      pA,
      pB,
      pC: Math.max(0.3, breakEven - 0.05),
      breakEvenProb: breakEven,
      qualityFloorAPlus: qualitiesAbovePAPlus.length > 0 ? Math.max(60, percentileOf(qualitiesAbovePAPlus, 25)) : base.fallback.qualityFloorAPlus,
      qualityFloorA: qualitiesAbovePA.length > 0 ? Math.max(50, percentileOf(qualitiesAbovePA, 25)) : base.fallback.qualityFloorA,
      minSampleAPlus: cfg.minSampleAPlus,
      minSampleA: cfg.minSampleA,
      minSampleB: cfg.minSampleB,
      provenance: "LEARNED_OOS",
      learnedFromSamples: rows.length,
    };
    void strategyId;
  }

  return { ...base, thresholds };
}

function expectancyOfObs(rows: GradeTrainingObs[]): number {
  if (rows.length === 0) return 0;
  return mean(rows.map((r) => r.returnR));
}

function mean(a: number[]): number {
  return a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length;
}

function percentileOf(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx]!;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — Grade transition matrix & lifecycle tracking
// ═══════════════════════════════════════════════════════════════════════════

/** Counts of transitions between grades over signal lifecycles. */
export interface GradeTransitionMatrix {
  /** counts[from][to] = number of transitions. */
  counts: Record<EvidenceGrade, Record<EvidenceGrade, number>>;
  /** Total transitions observed. */
  total: number;
  /** Promotions (rank increased). */
  promotions: number;
  /** Demotions (rank decreased). */
  demotions: number;
  /** Held (rank unchanged). */
  holds: number;
}

export function newTransitionMatrix(): GradeTransitionMatrix {
  const empty = () =>
    GRADE_ORDER.reduce((acc, g) => { acc[g] = 0; return acc; }, {} as Record<EvidenceGrade, number>);
  const counts = GRADE_ORDER.reduce((acc, g) => { acc[g] = empty(); return acc; }, {} as Record<EvidenceGrade, Record<EvidenceGrade, number>>);
  return { counts, total: 0, promotions: 0, demotions: 0, holds: 0 };
}

/** Record one grade transition (from → to) into the matrix (mutates + returns). */
export function recordTransition(m: GradeTransitionMatrix, from: EvidenceGrade, to: EvidenceGrade): GradeTransitionMatrix {
  m.counts[from][to] += 1;
  m.total += 1;
  const d = GRADE_RANK[to] - GRADE_RANK[from];
  if (d > 0) m.promotions += 1;
  else if (d < 0) m.demotions += 1;
  else m.holds += 1;
  return m;
}

/**
 * Track a single signal's grade lifecycle (an ordered sequence of grades) into a
 * transition matrix. The canonical lifecycle direction is REJECT → C → B → A → A+.
 * Returns the number of transitions recorded.
 */
export function trackLifecycle(m: GradeTransitionMatrix, gradeSequence: EvidenceGrade[]): number {
  let n = 0;
  for (let i = 1; i < gradeSequence.length; i++) {
    recordTransition(m, gradeSequence[i - 1]!, gradeSequence[i]!);
    n++;
  }
  return n;
}

/**
 * Grade-inflation guard: the share of A+/A among all graded signals. A sudden
 * rise in this ratio (vs a learned baseline) indicates inflation. Returned so a
 * monitor can alert; the grader itself prevents inflation structurally (12
 * simultaneous criteria + Wilson + min-sample), this is the observability layer.
 */
export function inflationRatio(grades: EvidenceGrade[]): { aPlusShare: number; aOrBetterShare: number } {
  if (grades.length === 0) return { aPlusShare: 0, aOrBetterShare: 0 };
  const aPlus = grades.filter((g) => g === "A_PLUS").length;
  const aOrBetter = grades.filter((g) => g === "A_PLUS" || g === "A").length;
  return { aPlusShare: aPlus / grades.length, aOrBetterShare: aOrBetter / grades.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — Default conservative grading model
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A deliberately CONSERVATIVE default used until per-cell thresholds are learned
 * from real OOS data. Probability thresholds follow the brief's recommended
 * initial targets (A+ ~0.66, A ~0.60, B above break-even). It is safe (hard to
 * earn A+) rather than optimistic.
 */
export const DEFAULT_GRADING_MODEL: GradingModel = {
  version: EVIDENCE_GRADING_ENGINE_VERSION,
  thresholds: {},
  fallback: {
    key: "FALLBACK",
    pAPlus: 0.66,
    pA: 0.60,
    pB: 0.54,       // above a typical ~0.5 break-even
    pC: 0.45,
    breakEvenProb: 0.5,
    qualityFloorAPlus: 72,
    qualityFloorA: 62,
    minSampleAPlus: 50,
    minSampleA: 30,
    minSampleB: 20,
    provenance: "DEFAULT_CONSERVATIVE",
    learnedFromSamples: 0,
  },
  safety: {
    criticalDataConfidence: 0.5,
    severeDisagreement: 0.4,
    minCostRobustnessAPlus: 0.5,
    minLiquidityForTrade: 0.3,
    alphaDecayExpectancyFloorR: -0.05,
  },
  minSampleDefaults: { aPlus: 50, a: 30, b: 20 },
};
