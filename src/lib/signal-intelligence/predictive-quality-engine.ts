/**
 * Predictive Signal Quality Engine  (v2 — empirical)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 * ---------------
 * The forensic audit (`reports/INDIA_SIGNAL_FORENSIC_AUDIT.md`) established that
 * the previous "Signal Quality" was a heuristic *confluence* score: a weighted
 * sum of hand-tuned factor weights, with a probability manufactured from that
 * confluence via a fixed logistic. It was not fit to realized, cost-adjusted
 * trade outcomes, its grade ladders conflicted, and it was not verified to be
 * monotonic in realized win rate.
 *
 * This engine replaces that with an **empirically-weighted, monotonic,
 * probability-calibrated** quality score whose single job is to estimate:
 *
 *     P(this signal produces a profitable, COST-ADJUSTED trade)
 *
 * and to express it as a `qualityScore ∈ [0,100]` + `qualityGrade`, with full
 * per-component attribution.
 *
 * SEPARATION OF CONCERNS (the audit's core lesson: "close the empirical loop")
 * ---------------------------------------------------------------------------
 *   • TRAIN TIME (offline, may use randomness / cross-validation):
 *       `trainQualityModel(...)` learns the component WEIGHTS from OUT-OF-SAMPLE
 *       outcomes only (walk-forward / purged-K-fold / embargo / CPCV /
 *       regime-separated), fits a MONOTONIC isotonic calibration curve
 *       (raw blend → realized win probability), builds the conditional
 *       performance tables with Bayesian shrinkage, and freezes everything into
 *       a `QualityModel` artifact (a plain JSON-serialisable object).
 *
 *   • INFERENCE TIME (online, MUST be deterministic and side-effect free):
 *       `scoreQuality(features, model, opts)` is a PURE function of its inputs.
 *       Same inputs ⇒ byte-identical output. No Date.now(), no Math.random(),
 *       no I/O. Time-dependent behaviour (freshness / decay) is driven only by
 *       the explicit `nowMs` passed in `features.asOfMs` and `features.dataAgeMs`.
 *
 * KEY PRINCIPLES
 * --------------
 *   1. Weights are LEARNED from OOS outcomes, never hand-set. A shipped default
 *      model (`DEFAULT_QUALITY_MODEL`) uses UNIFORM weights within redundancy
 *      groups and is explicitly flagged `provenance: "UNTRAINED_UNIFORM_PRIOR"`
 *      so an untrained deployment can never masquerade as empirical.
 *   2. Redundant components are GROUPED so correlated evidence (ML prob vs
 *      historical win rate; trend/momentum/SMA; OI/PCR/derivatives) cannot be
 *      double-counted — the group shares a weight budget.
 *   3. Missing data becomes UNCERTAINTY (`dataConfidence`), never a directional
 *      penalty. A missing bullish input does not make a signal bearish.
 *   4. Small samples are shrunk toward a learned prior via `sampleConfidence`.
 *   5. The final score is monotone-calibrated so higher score ⇒ higher realized
 *      P(profit). Monotonicity is verifiable (`verifyMonotonicity`).
 *   6. The score DECAYS with staleness (`applyFreshnessDecay`).
 *
 * This module is I/O-free and has no `server-only` guard so it is unit-testable
 * and usable from both the Next app and the worker.
 */

import {
  mean,
  stdDev,
  safeDiv,
  expectancy as expectancyOf,
  profitFactor as profitFactorOf,
  toRMultiple,
  costAdjust,
  BASE_COST_BPS,
} from "@/lib/signal-quality/stats";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Vocabulary shared with the rest of the India stack
// ═══════════════════════════════════════════════════════════════════════════

export const PREDICTIVE_QUALITY_ENGINE_VERSION = "pqe-1.0.0";

export type QualityGrade =
  | "EXCEPTIONAL"
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "REJECT";

export type SignalDirection = "LONG" | "SHORT" | "NEUTRAL";

/** Coarse regime label used to select the conditional-performance table. */
export type QualityRegime =
  | "BULL_TREND"
  | "BEAR_TREND"
  | "RANGE"
  | "HIGH_VOL"
  | "LOW_VOL"
  | "UNKNOWN";

/** Coarse timeframe bucket used to select the conditional-performance table. */
export type QualityTimeframe = "SCALP" | "INTRADAY" | "SWING";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — The 20 components
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The 20 predictive components. Each is normalised to [0,1] where 1 = maximally
 * favourable evidence FOR the signal's own direction (never "bullish" in the
 * abstract — always relative to the signal's declared direction), and 0.5 =
 * neutral / no information.
 *
 * `null` means "not observed" — it is routed into `dataConfidence`, NOT scored
 * as 0. This is the audit fix for "missing data must not become a directional
 * penalty."
 */
export const QUALITY_COMPONENTS = [
  "predictiveProbability",       // 1  — calibrated ML/model P(win) for THIS setup
  "historicalConditionalWinRate",// 2  — shrunk win rate for (strategy×regime×tf×gradeBucket)
  "expectedValue",               // 3  — cost-adjusted net EV, normalised
  "regimeFit",                   // 4  — does the current regime support this strategy?
  "multiTimeframeAlignment",     // 5  — agreement across timeframes
  "marketStructure",             // 6  — BOS/CHoCH/structure quality
  "momentum",                    // 7  — RSI/ROC/ADX momentum quality
  "volume",                      // 8  — RVOL / participation
  "volatilityFit",               // 9  — is current vol in the strategy's sweet spot?
  "liquidity",                   // 10 — spread / depth / tradability
  "derivativesConfirmation",     // 11 — OI/PCR/max-pain confirmation
  "relativeStrength",            // 12 — vs benchmark / sector
  "executionQuality",            // 13 — time-of-day / slippage-friendly window
  "dataQuality",                 // 14 — freshness & provider agreement (evidence, not penalty)
  "modelAgreement",              // 15 — do independent models agree on direction?
  "signalStability",             // 16 — signal not flip-flopping / not late
  "costRobustness",              // 17 — survives 2× cost stress
  "alphaDecay",                  // 18 — edge for this setup not decaying over recent history
  "strategyHealth",              // 19 — the source strategy is currently healthy
  "historicalSampleConfidence",  // 20 — how much data backs the conditional estimate
] as const;

export type QualityComponent = (typeof QUALITY_COMPONENTS)[number];

/**
 * Redundancy groups. Components inside a group carry correlated information and
 * therefore SHARE a weight budget so evidence cannot be double-counted.
 *
 * The specific groupings implement the audit's examples:
 *   • ML probability and historical win rate overlap → PREDICTIVE_EDGE.
 *   • Trend / momentum / SMA stack are correlated → TREND_MOMENTUM.
 *   • OI / PCR / derivatives are correlated → DERIVATIVES.
 *
 * Confidence-type components (dataQuality, sampleConfidence, costRobustness,
 * modelAgreement, stability, alphaDecay, strategyHealth) are handled as
 * MULTIPLIERS/uncertainty, not additive score — see SECTION 6.
 */
export const REDUNDANCY_GROUPS: Record<string, QualityComponent[]> = {
  PREDICTIVE_EDGE: ["predictiveProbability", "historicalConditionalWinRate", "expectedValue"],
  REGIME: ["regimeFit", "volatilityFit"],
  TREND_MOMENTUM: ["multiTimeframeAlignment", "marketStructure", "momentum"],
  PARTICIPATION: ["volume", "liquidity"],
  DERIVATIVES: ["derivativesConfirmation"],
  RELATIVE_STRENGTH: ["relativeStrength"],
  EXECUTION: ["executionQuality"],
};

/** Components that are treated as UNCERTAINTY modifiers, not additive edge. */
export const UNCERTAINTY_COMPONENTS: QualityComponent[] = [
  "dataQuality",
  "modelAgreement",
  "signalStability",
  "costRobustness",
  "alphaDecay",
  "strategyHealth",
  "historicalSampleConfidence",
];

/** Additive-edge components = everything not in UNCERTAINTY_COMPONENTS. */
export const EDGE_COMPONENTS: QualityComponent[] = QUALITY_COMPONENTS.filter(
  (c) => !UNCERTAINTY_COMPONENTS.includes(c),
);

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Inference input (the feature vector)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A raw, direction-relative feature vector for ONE signal at inference time.
 * Every field is either a [0,1] evidence value (1 = favourable for the signal's
 * direction) or `null` (not observed → routed to uncertainty).
 *
 * Callers are responsible for orienting evidence to the signal's direction
 * (e.g. for a SHORT, "price below VWAP" is favourable → high value). This keeps
 * the engine agnostic to direction and prevents the "missing = bearish" bug.
 */
export interface QualityFeatureVector {
  // Identity / conditioning keys (select the conditional-performance table)
  strategyId: string;
  direction: SignalDirection;
  regime: QualityRegime;
  timeframe: QualityTimeframe;
  instrument: string;

  // ── Edge components (each [0,1] favourable-for-direction, or null) ──────────
  /** Calibrated model P(win) for this setup, already in [0,1]. null if no model. */
  predictiveProbability: number | null;
  /** Structural confirmation quality [0,1]. */
  marketStructure: number | null;
  /** Momentum quality [0,1]. */
  momentum: number | null;
  /** Volume / participation [0,1]. */
  volume: number | null;
  /** Volatility fit to the strategy's sweet spot [0,1]. */
  volatilityFit: number | null;
  /** Liquidity / tradability [0,1]. */
  liquidity: number | null;
  /** Derivatives (OI/PCR/max-pain) confirmation [0,1]. */
  derivativesConfirmation: number | null;
  /** Relative strength vs benchmark/sector [0,1]. */
  relativeStrength: number | null;
  /** Regime support for this strategy [0,1]. */
  regimeFit: number | null;
  /** Multi-timeframe alignment [0,1]. */
  multiTimeframeAlignment: number | null;
  /** Execution-window quality (time-of-day) [0,1]. */
  executionQuality: number | null;

  // ── Expected value (cost-adjusted), provided directly ──────────────────────
  /** Net expected value in R units (already cost/slippage adjusted upstream). null if unknown. */
  netExpectedValueR: number | null;

  // ── Uncertainty / robustness inputs ─────────────────────────────────────────
  /**
   * Directional votes from INDEPENDENT models/sources in [-1,1]
   * (+1 = strongly agrees with signal direction). Used for modelAgreement.
   * Empty ⇒ agreement unknown (dataConfidence lowered, no penalty).
   */
  modelVotes: number[];
  /**
   * Recent signal-direction history for stability (e.g. last N ticks' implied
   * direction as +1/-1/0). Empty ⇒ stability unknown.
   */
  recentDirectionVotes: number[];
  /** Net EV under 2× cost stress, in R. null ⇒ unknown. */
  netExpectedValueRAt2xCost: number | null;

  // ── Data-quality / freshness inputs (routed to dataConfidence + decay) ──────
  /** Age of the primary quote in ms. */
  quoteAgeMs: number | null;
  /** Age of the option chain snapshot in ms. null ⇒ no chain used by strategy. */
  optionChainAgeMs: number | null;
  /** Age of the OI snapshot in ms. null ⇒ no OI used. */
  oiAgeMs: number | null;
  /** True if a derivatives-dependent strategy is missing derivatives data. */
  derivativesRequiredButMissing: boolean;
  /** Cross-provider agreement [0,1]; 1 = providers agree. null ⇒ single provider. */
  providerAgreement: number | null;
  /** True if the primary data came from a fallback provider. */
  usedFallbackProvider: boolean;
  /** Observed data latency in ms (feed round-trip). null ⇒ unknown. */
  latencyMs: number | null;

  /** Age of THIS signal (for freshness decay), ms since generation. */
  signalAgeMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — The trained model artifact (frozen at train time)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A monotonic isotonic calibration curve: sorted (x → y) knots with y
 * non-decreasing in x. Maps the raw weighted edge blend [0,1] → calibrated
 * realized P(profit) [0,1]. Learned from OOS outcomes at train time.
 */
export interface IsotonicCurve {
  /** Strictly ascending x knots in [0,1]. */
  x: number[];
  /** Non-decreasing y knots in [0,1] (same length as x). */
  y: number[];
}

/** A single conditional-performance table cell (Bayesian-shrunk). */
export interface ConditionalPerformanceCell {
  key: string;                 // "strategy|regime|timeframe|bucket"
  sampleCount: number;
  /** Observed (raw) win rate before shrinkage. */
  observedWinRate: number;
  /** Prior win rate used for shrinkage (learned from the parent family). */
  priorWinRate: number;
  /** Shrinkage weight applied to the observation ∈ [0,1] (sampleConfidence). */
  sampleConfidence: number;
  /** effectiveWinRate = c·observed + (1-c)·prior. */
  effectiveWinRate: number;
  expectancyR: number;
  profitFactor: number;
  avgWinR: number;
  avgLossR: number;
  netReturnR: number;
  maxDrawdownR: number;
  costAdjustedReturnR: number;
  slippageAdjustedReturnR: number;
}

export type ModelProvenance =
  | "TRAINED_OOS"               // weights learned from out-of-sample outcomes
  | "UNTRAINED_UNIFORM_PRIOR";  // shipped default — uniform within groups

/**
 * The frozen, JSON-serialisable model produced by `trainQualityModel`.
 * `scoreQuality` is a pure function of (features, model).
 */
export interface QualityModel {
  version: string;
  provenance: ModelProvenance;
  trainedAtMs: number | null;
  /** OOS window the weights were learned on (for provenance/audit). */
  oosWindow: { startMs: number; endMs: number } | null;

  /** Per-redundancy-group weight budget. Sums to 1 across groups. */
  groupWeights: Record<string, number>;
  /**
   * Within-group per-component weights. Each group's component weights sum to 1.
   * A group's effective component weight = groupWeights[g] × withinGroup[g][c].
   */
  withinGroupWeights: Record<string, Partial<Record<QualityComponent, number>>>;

  /** Monotone calibration curve: raw edge blend → realized P(profit). */
  calibration: IsotonicCurve;

  /** Conditional-performance tables keyed by "strategy|regime|timeframe|bucket". */
  conditionalTable: Record<string, ConditionalPerformanceCell>;
  /** Learned family priors keyed by "strategy|regime" then "strategy" then "GLOBAL". */
  priors: Record<string, number>;
  /** Global fallback prior win rate. */
  globalPrior: number;

  /** Grade cut-points on the FINAL calibrated qualityScore [0,100], learned so
   *  that each grade's realized win rate is separated & monotone. */
  gradeCutpoints: { exceptional: number; high: number; medium: number; low: number };

  /** Freshness thresholds (ms) beyond which data is considered fully stale. */
  freshness: {
    quoteFullyStaleMs: number;
    optionChainFullyStaleMs: number;
    oiFullyStaleMs: number;
    latencyAbnormalMs: number;
    /** Half-life of quality decay with signal age. */
    signalHalfLifeMs: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Output shapes
// ═══════════════════════════════════════════════════════════════════════════

export interface ComponentAttribution {
  component: QualityComponent;
  group: string | null;
  /** Raw [0,1] evidence used (after neutral-imputation for missing). */
  value: number;
  /** Was the underlying feature observed? */
  observed: boolean;
  /** Effective weight this component contributed to the edge blend. */
  effectiveWeight: number;
  /** value × effectiveWeight (contribution to the raw edge blend). */
  contribution: number;
}

export interface QualityScoreResult {
  version: string;
  modelProvenance: ModelProvenance;

  /** 0–100 monotone-calibrated quality score AFTER freshness decay. */
  qualityScore: number;
  qualityGrade: QualityGrade;

  /** Calibrated realized-profit probability [0,1] BEFORE the 0–100 rescale. */
  predictedProfitProbability: number;

  /** Raw weighted edge blend [0,1] BEFORE calibration and decay. */
  rawEdgeBlend: number;
  /** Calibrated probability BEFORE freshness decay (for audit). */
  preDecayProbability: number;

  /** Uncertainty channel: 1 = full confidence, 0 = no confidence. */
  dataConfidence: number;
  modelAgreement: number;
  signalStability: number;
  costRobustness: number;
  sampleConfidence: number;
  /** Combined multiplier actually applied to the calibrated probability. */
  confidenceMultiplier: number;
  /** Freshness decay multiplier actually applied ∈ [0,1]. */
  freshnessDecay: number;

  /** Per-component attribution (edge components only carry weight). */
  attribution: ComponentAttribution[];

  /** Human-readable reasons (deterministic ordering). */
  reasons: string[];

  /** The conditional-performance cell used (if any). */
  conditionalCell: ConditionalPerformanceCell | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** Neutral value used when a feature is missing — 0.5 = "no information". */
const NEUTRAL = 0.5;

/**
 * Evaluate a monotone isotonic curve at x∈[0,1] with linear interpolation
 * between knots. Deterministic. Assumes `curve.x` strictly ascending and
 * `curve.y` non-decreasing (as produced by `fitIsotonic`).
 */
export function evalIsotonic(curve: IsotonicCurve, x: number): number {
  const { x: xs, y: ys } = curve;
  if (xs.length === 0) return clamp01(x);
  if (x <= xs[0]!) return clamp01(ys[0]!);
  if (x >= xs[xs.length - 1]!) return clamp01(ys[ys.length - 1]!);
  // binary search for the interval
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo]!;
  const x1 = xs[hi]!;
  const y0 = ys[lo]!;
  const y1 = ys[hi]!;
  const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  return clamp01(y0 + t * (y1 - y0));
}

/**
 * Pool-Adjacent-Violators isotonic regression: fit a non-decreasing step
 * function to (x, y) pairs weighted by `w`. Used at TRAIN time only.
 * Returned as a compact `IsotonicCurve`. Deterministic given inputs.
 */
export function fitIsotonic(
  points: Array<{ x: number; y: number; w?: number }>,
): IsotonicCurve {
  if (points.length === 0) return { x: [0, 1], y: [0, 1] };
  // sort by x (stable), average duplicate x's
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (const p of sorted) {
    const w = p.w ?? 1;
    if (xs.length > 0 && xs[xs.length - 1] === p.x) {
      const i = xs.length - 1;
      const nw = ws[i]! + w;
      ys[i] = (ys[i]! * ws[i]! + p.y * w) / nw;
      ws[i] = nw;
    } else {
      xs.push(p.x);
      ys.push(p.y);
      ws.push(w);
    }
  }
  // PAVA
  const blockY = [...ys];
  const blockW = [...ws];
  const blockStart: number[] = xs.map((_, i) => i);
  let i = 0;
  while (i < blockY.length - 1) {
    if (blockY[i]! > blockY[i + 1]!) {
      // merge blocks i and i+1
      const nw = blockW[i]! + blockW[i + 1]!;
      const ny = (blockY[i]! * blockW[i]! + blockY[i + 1]! * blockW[i + 1]!) / nw;
      blockY.splice(i, 2, ny);
      blockW.splice(i, 2, nw);
      blockStart.splice(i + 1, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  // expand blocks back to per-knot y (monotone)
  const outX: number[] = [];
  const outY: number[] = [];
  let bi = 0;
  for (let k = 0; k < xs.length; k++) {
    if (bi + 1 < blockStart.length && k >= blockStart[bi + 1]!) bi++;
    outX.push(xs[k]!);
    outY.push(clamp01(blockY[bi]!));
  }
  return { x: outX, y: outY };
}

/**
 * Bayesian shrinkage of an observed win rate toward a prior. Uses a
 * pseudo-count model: sampleConfidence = n / (n + priorStrength). Returns both
 * the effective rate and the confidence weight so callers can surface it.
 *
 * This is the mechanism that prevents a tiny sample from producing an
 * artificially high quality score.
 */
export function shrinkWinRate(
  wins: number,
  total: number,
  priorWinRate: number,
  priorStrength = 20,
): { effectiveWinRate: number; sampleConfidence: number; observedWinRate: number } {
  if (total <= 0) {
    return { effectiveWinRate: priorWinRate, sampleConfidence: 0, observedWinRate: priorWinRate };
  }
  const observed = wins / total;
  const sampleConfidence = total / (total + priorStrength);
  const effective = sampleConfidence * observed + (1 - sampleConfidence) * priorWinRate;
  return {
    effectiveWinRate: clamp01(effective),
    sampleConfidence: clamp01(sampleConfidence),
    observedWinRate: clamp01(observed),
  };
}

/** Deterministic key for a conditional-performance cell. */
export function conditionalKey(
  strategyId: string,
  regime: QualityRegime,
  timeframe: QualityTimeframe,
  bucket: string,
): string {
  return `${strategyId}|${regime}|${timeframe}|${bucket}`;
}

/** Look up the most specific learned prior available for a signal. */
export function lookupPrior(model: QualityModel, strategyId: string, regime: QualityRegime): number {
  return (
    model.priors[`${strategyId}|${regime}`] ??
    model.priors[strategyId] ??
    model.globalPrior
  );
}

// ─── Effective per-component weights (group budget × within-group) ────────────

/**
 * Compute the effective additive weight for every EDGE component, honouring the
 * redundancy-group budget so correlated components share weight (no
 * double-counting). Confidence components carry ZERO additive weight — they act
 * as multipliers (SECTION 8). Returns weights that sum to 1 over edge components.
 */
export function effectiveEdgeWeights(model: QualityModel): Record<QualityComponent, number> {
  const out = {} as Record<QualityComponent, number>;
  for (const c of QUALITY_COMPONENTS) out[c] = 0;

  let edgeGroupTotal = 0;
  for (const [group, comps] of Object.entries(REDUNDANCY_GROUPS)) {
    const gw = model.groupWeights[group] ?? 0;
    if (gw <= 0) continue;
    // only edge components inside this group receive additive weight
    const within = model.withinGroupWeights[group] ?? {};
    const edgeComps = comps.filter((c) => EDGE_COMPONENTS.includes(c));
    if (edgeComps.length === 0) continue;
    // normalise within-group weights over the edge components present
    let wsum = 0;
    for (const c of edgeComps) wsum += within[c] ?? 1;
    for (const c of edgeComps) {
      const wc = (within[c] ?? 1) / (wsum || 1);
      out[c] = gw * wc;
      edgeGroupTotal += out[c];
    }
  }
  // renormalise so edge weights sum to exactly 1 (groups may not cover all budget)
  if (edgeGroupTotal > 0) {
    for (const c of EDGE_COMPONENTS) out[c] = out[c] / edgeGroupTotal;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — Uncertainty channel (missing data → confidence, not penalty)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute `dataConfidence ∈ [0,1]` from freshness / provider / latency inputs.
 * CRITICAL: this never affects DIRECTION or additive edge — it only reduces how
 * much we trust the calibrated probability (pulls it toward the base rate).
 */
export function computeDataConfidence(f: QualityFeatureVector, model: QualityModel): number {
  const fr = model.freshness;
  const factors: number[] = [];

  // Quote freshness: 1 when fresh, →0 as it approaches fully-stale.
  if (f.quoteAgeMs != null) {
    factors.push(clamp01(1 - f.quoteAgeMs / fr.quoteFullyStaleMs));
  }
  // Option chain / OI freshness only counts when the strategy uses them.
  if (f.optionChainAgeMs != null) {
    factors.push(clamp01(1 - f.optionChainAgeMs / fr.optionChainFullyStaleMs));
  }
  if (f.oiAgeMs != null) {
    factors.push(clamp01(1 - f.oiAgeMs / fr.oiFullyStaleMs));
  }
  // Missing REQUIRED derivatives → strong confidence hit (but NOT directional).
  if (f.derivativesRequiredButMissing) factors.push(0.3);
  // Provider agreement (if cross-checked).
  if (f.providerAgreement != null) factors.push(clamp01(f.providerAgreement));
  // Fallback provider used → mild confidence hit.
  if (f.usedFallbackProvider) factors.push(0.8);
  // Abnormal latency → confidence hit proportional to overage.
  if (f.latencyMs != null) {
    factors.push(clamp01(1 - Math.max(0, f.latencyMs - fr.latencyAbnormalMs) / fr.latencyAbnormalMs));
  }

  if (factors.length === 0) return 1; // nothing to reduce confidence
  // Geometric-mean-like combination: the weakest signal dominates but doesn't zero out.
  const prod = factors.reduce((p, x) => p * clamp(x, 0.05, 1), 1);
  return clamp01(Math.pow(prod, 1 / factors.length));
}

/** Model agreement ∈ [0,1] from independent directional votes. */
export function computeModelAgreement(votes: number[]): { agreement: number; observed: boolean } {
  if (votes.length === 0) return { agreement: NEUTRAL, observed: false };
  // fraction of votes pointing in the signal direction (+), plus magnitude.
  const aligned = votes.map((v) => clamp(v, -1, 1));
  const meanAlign = mean(aligned); // [-1,1], +1 = all agree with direction
  // Disagreement penalty: high variance across votes lowers agreement.
  const dispersion = aligned.length > 1 ? stdDev(aligned) : 0;
  const agreement = clamp01((meanAlign + 1) / 2 - 0.25 * dispersion);
  return { agreement, observed: true };
}

/** Signal stability ∈ [0,1] — penalises flip-flopping recent direction. */
export function computeStability(recent: number[]): { stability: number; observed: boolean } {
  if (recent.length === 0) return { stability: NEUTRAL, observed: false };
  const signs = recent.map((v) => Math.sign(v));
  // count direction changes
  let flips = 0;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1] && signs[i] !== 0) flips++;
  const flipRate = safeDiv(flips, Math.max(1, signs.length - 1));
  return { stability: clamp01(1 - flipRate), observed: true };
}

/** Cost robustness ∈ [0,1] — does net EV survive 2× costs? */
export function computeCostRobustness(evR: number | null, evR2x: number | null): { robustness: number; observed: boolean } {
  if (evR == null || evR2x == null) return { robustness: NEUTRAL, observed: false };
  if (evR <= 0) return { robustness: 0, observed: true };
  // ratio of stressed EV to base EV, clamped; 1 = fully robust.
  return { robustness: clamp01(evR2x / evR), observed: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — Freshness decay
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Multiplicative freshness decay ∈ (0,1] applied to the calibrated probability
 * as a signal ages. Exponential half-life model: at signalHalfLifeMs the score
 * contribution above the base rate is halved. Deterministic in `signalAgeMs`.
 */
export function computeFreshnessDecay(signalAgeMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 1;
  const age = Math.max(0, signalAgeMs);
  return Math.pow(0.5, age / halfLifeMs);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9 — Deterministic inference: scoreQuality
// ═══════════════════════════════════════════════════════════════════════════

/** Map a raw edge blend [0,1] to a coarse conditional-table bucket label. */
export function edgeBucket(edge: number): string {
  if (edge >= 0.9) return "90_100";
  if (edge >= 0.8) return "80_90";
  if (edge >= 0.7) return "70_80";
  if (edge >= 0.6) return "60_70";
  if (edge >= 0.5) return "50_60";
  if (edge >= 0.4) return "40_50";
  return "0_40";
}

/** Resolve the [0,1] edge value for one component, applying neutral imputation. */
function edgeValueOf(f: QualityFeatureVector, c: QualityComponent, model: QualityModel): { value: number; observed: boolean } {
  switch (c) {
    case "predictiveProbability":
      return f.predictiveProbability == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.predictiveProbability), observed: true };
    case "historicalConditionalWinRate": {
      const cell = lookupConditionalCell(f, model);
      return cell ? { value: clamp01(cell.effectiveWinRate), observed: true } : { value: NEUTRAL, observed: false };
    }
    case "expectedValue": {
      if (f.netExpectedValueR == null) return { value: NEUTRAL, observed: false };
      // Normalise EV(R) into [0,1]: -1R → 0, 0R → 0.5, +2R → 1 (clamped).
      return { value: clamp01((f.netExpectedValueR + 1) / 3), observed: true };
    }
    case "regimeFit":
      return f.regimeFit == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.regimeFit), observed: true };
    case "multiTimeframeAlignment":
      return f.multiTimeframeAlignment == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.multiTimeframeAlignment), observed: true };
    case "marketStructure":
      return f.marketStructure == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.marketStructure), observed: true };
    case "momentum":
      return f.momentum == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.momentum), observed: true };
    case "volume":
      return f.volume == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.volume), observed: true };
    case "volatilityFit":
      return f.volatilityFit == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.volatilityFit), observed: true };
    case "liquidity":
      return f.liquidity == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.liquidity), observed: true };
    case "derivativesConfirmation":
      return f.derivativesConfirmation == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.derivativesConfirmation), observed: true };
    case "relativeStrength":
      return f.relativeStrength == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.relativeStrength), observed: true };
    case "executionQuality":
      return f.executionQuality == null ? { value: NEUTRAL, observed: false } : { value: clamp01(f.executionQuality), observed: true };
    default:
      // uncertainty components are handled separately; return neutral.
      return { value: NEUTRAL, observed: false };
  }
}

/** Find the conditional-performance cell for this signal (by edge bucket). */
export function lookupConditionalCell(f: QualityFeatureVector, model: QualityModel, edgeForBucket?: number): ConditionalPerformanceCell | null {
  // If an explicit edge is not provided, use a coarse pre-estimate from the
  // predictive probability (or neutral) so the lookup is deterministic.
  const edge = edgeForBucket ?? (f.predictiveProbability ?? NEUTRAL);
  const bucket = edgeBucket(edge);
  const exact = model.conditionalTable[conditionalKey(f.strategyId, f.regime, f.timeframe, bucket)];
  if (exact) return exact;
  // fall back to less specific keys (regime-agnostic, then tf-agnostic)
  const noRegime = model.conditionalTable[conditionalKey(f.strategyId, "UNKNOWN", f.timeframe, bucket)];
  if (noRegime) return noRegime;
  return null;
}

/**
 * PURE, DETERMINISTIC inference. Same (features, model) ⇒ identical result.
 *
 * Pipeline:
 *   1. Compute edge components (neutral-impute missing).
 *   2. Weighted blend using group-budgeted effective weights (no double-count).
 *   3. Refine conditional-table bucket from the blend; re-read historical win rate.
 *   4. Monotone-calibrate blend → predicted P(profit).
 *   5. Compute uncertainty channel (dataConfidence, agreement, stability,
 *      costRobustness, sampleConfidence) and pull probability toward base rate.
 *   6. Apply freshness decay.
 *   7. Rescale to 0–100, grade against learned cut-points, attach attribution.
 */
export function scoreQuality(f: QualityFeatureVector, model: QualityModel): QualityScoreResult {
  const weights = effectiveEdgeWeights(model);
  const reasons: string[] = [];

  // ── (1)+(2) first-pass edge blend (bucket-independent components) ──────────
  // predictiveProbability, EV and technicals don't depend on the bucket; the
  // historical win rate does. We iterate once to get a provisional blend, pick
  // the bucket, then finalise the historical component. Deterministic.
  const attribution: ComponentAttribution[] = [];

  const componentGroup: Record<QualityComponent, string | null> = {} as Record<QualityComponent, string | null>;
  for (const c of QUALITY_COMPONENTS) componentGroup[c] = null;
  for (const [g, comps] of Object.entries(REDUNDANCY_GROUPS)) for (const c of comps) componentGroup[c] = g;

  // provisional blend WITHOUT the historical win-rate component (weight redistributed)
  let provisional = 0;
  let provisionalWeight = 0;
  for (const c of EDGE_COMPONENTS) {
    if (c === "historicalConditionalWinRate") continue;
    const w = weights[c];
    if (w <= 0) continue;
    const { value } = edgeValueOf(f, c, model);
    provisional += value * w;
    provisionalWeight += w;
  }
  const provisionalBlend = provisionalWeight > 0 ? provisional / provisionalWeight : NEUTRAL;

  // ── (3) resolve conditional cell using the provisional blend ───────────────
  const cell = lookupConditionalCell(f, model, provisionalBlend);

  // ── (2 final) full weighted blend including historical win rate ────────────
  let rawEdgeBlend = 0;
  for (const c of EDGE_COMPONENTS) {
    const w = weights[c];
    const { value, observed } = c === "historicalConditionalWinRate"
      ? (cell ? { value: clamp01(cell.effectiveWinRate), observed: true } : { value: NEUTRAL, observed: false })
      : edgeValueOf(f, c, model);
    rawEdgeBlend += value * w;
    attribution.push({
      component: c,
      group: componentGroup[c],
      value,
      observed,
      effectiveWeight: w,
      contribution: value * w,
    });
  }
  rawEdgeBlend = clamp01(rawEdgeBlend);

  // ── (4) monotone calibration: raw blend → realized P(profit) ───────────────
  const calibratedProb = evalIsotonic(model.calibration, rawEdgeBlend);

  // ── (5) uncertainty channel ────────────────────────────────────────────────
  const dataConfidence = computeDataConfidence(f, model);
  const { agreement, observed: agrObs } = computeModelAgreement(f.modelVotes);
  const { stability, observed: stabObs } = computeStability(f.recentDirectionVotes);
  const { robustness, observed: costObs } = computeCostRobustness(f.netExpectedValueR, f.netExpectedValueRAt2xCost);
  const sampleConfidence = cell ? cell.sampleConfidence : 0;

  // record uncertainty components in attribution (zero additive weight)
  for (const [c, value, observed] of [
    ["dataQuality", dataConfidence, true],
    ["modelAgreement", agreement, agrObs],
    ["signalStability", stability, stabObs],
    ["costRobustness", robustness, costObs],
    ["historicalSampleConfidence", sampleConfidence, cell != null],
    ["alphaDecay", cell ? clamp01(0.5 + (cell.expectancyR) / 2) : NEUTRAL, cell != null],
    ["strategyHealth", cell ? clamp01(cell.effectiveWinRate) : NEUTRAL, cell != null],
  ] as Array<[QualityComponent, number, boolean]>) {
    attribution.push({ component: c, group: null, value, observed, effectiveWeight: 0, contribution: 0 });
  }

  // The confidence multiplier pulls the calibrated probability toward the base
  // rate (prior) — NOT toward zero — so uncertainty widens toward "no edge",
  // never fabricates a directional loss.
  const prior = lookupPrior(model, f.strategyId, f.regime);
  // Only APPLY the components that were actually observed; unobserved ones
  // default to full confidence (1) so missing ≠ penalty.
  const confParts = [
    dataConfidence,
    agrObs ? agreement : 1,
    stabObs ? stability : 1,
    costObs ? robustness : 1,
    cell ? sampleConfidence : 1,
  ];
  // weakest-link-aware combination
  const confidenceMultiplier = clamp01(
    Math.pow(confParts.reduce((p, x) => p * clamp(x, 0.05, 1), 1), 1 / confParts.length),
  );

  // pull toward prior by (1 - confidence)
  const confAdjustedProb = confidenceMultiplier * calibratedProb + (1 - confidenceMultiplier) * prior;

  // ── (6) freshness decay ─────────────────────────────────────────────────────
  const freshnessDecay = computeFreshnessDecay(f.signalAgeMs, model.freshness.signalHalfLifeMs);
  // decay pulls the (above-prior) portion of the probability back toward prior
  const decayedProb = prior + (confAdjustedProb - prior) * freshnessDecay;

  const predictedProfitProbability = clamp01(decayedProb);

  // ── (7) rescale + grade ─────────────────────────────────────────────────────
  const qualityScore = Math.round(predictedProfitProbability * 1000) / 10; // 0–100, 1 dp
  const qualityGrade = gradeFor(qualityScore, model);

  // deterministic reasons
  if (!cell) reasons.push("no_conditional_history: probability shrunk toward learned prior");
  if (dataConfidence < 0.7) reasons.push(`low_data_confidence:${dataConfidence.toFixed(2)}`);
  if (agrObs && agreement < 0.4) reasons.push(`model_disagreement:${agreement.toFixed(2)}`);
  if (costObs && robustness < 0.5) reasons.push(`cost_fragile:${robustness.toFixed(2)}`);
  if (freshnessDecay < 0.8) reasons.push(`stale_signal_decay:${freshnessDecay.toFixed(2)}`);
  if (cell && sampleConfidence < 0.5) reasons.push(`small_sample_shrunk:${cell.sampleCount}`);
  if (model.provenance === "UNTRAINED_UNIFORM_PRIOR") reasons.push("model_untrained: uniform prior weights — NOT empirically validated");

  return {
    version: model.version,
    modelProvenance: model.provenance,
    qualityScore,
    qualityGrade,
    predictedProfitProbability,
    rawEdgeBlend,
    preDecayProbability: clamp01(confAdjustedProb),
    dataConfidence,
    modelAgreement: agreement,
    signalStability: stability,
    costRobustness: robustness,
    sampleConfidence,
    confidenceMultiplier,
    freshnessDecay,
    attribution,
    reasons,
    conditionalCell: cell,
  };
}

/** Grade the final 0–100 quality score against the model's learned cut-points. */
export function gradeFor(qualityScore: number, model: QualityModel): QualityGrade {
  const g = model.gradeCutpoints;
  if (qualityScore >= g.exceptional) return "EXCEPTIONAL";
  if (qualityScore >= g.high) return "HIGH";
  if (qualityScore >= g.medium) return "MEDIUM";
  if (qualityScore >= g.low) return "LOW";
  return "REJECT";
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 10 — Training-time inputs & cross-validation splitting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One resolved, LABELLED training example. `features` is the same shape used at
 * inference; `label` is the realized, COST-ADJUSTED outcome (1 = profitable
 * after costs, 0 = not). `outcomeMs` is when the trade was RESOLVED (used for
 * temporal ordering, purging, and embargo). `netReturnR` / `costAdjustedR` /
 * `slippageAdjustedR` feed the conditional-performance tables.
 */
export interface QualityTrainingExample {
  features: QualityFeatureVector;
  /** 1 if the trade was profitable AFTER costs, else 0. */
  label: 0 | 1;
  /** Signal generation time (t0). */
  signalMs: number;
  /** Trade resolution time (t1) — label becomes known here. */
  outcomeMs: number;
  netReturnR: number;
  costAdjustedReturnR: number;
  slippageAdjustedReturnR: number;
}

export interface TrainConfig {
  /** Cross-validation scheme. */
  scheme: "walkForward" | "purgedKFold" | "cpcv";
  /** Number of folds (purgedKFold / cpcv) or walk-forward windows. */
  folds: number;
  /** Purge window in ms: training obs whose label overlaps a test window are removed. */
  purgeMs: number;
  /** Embargo window in ms after each test block. */
  embargoMs: number;
  /** Train weights separately per regime, then merge. */
  regimeSeparated: boolean;
  /** Bayesian shrinkage pseudo-count for conditional tables. */
  priorStrength: number;
  /** Grade cut-points are chosen so each grade's realized win rate is separated. */
  autoGradeCutpoints: boolean;
  /** Optional deterministic RNG seed for CPCV path selection. */
  seed: number;
}

export const DEFAULT_TRAIN_CONFIG: TrainConfig = {
  scheme: "purgedKFold",
  folds: 5,
  purgeMs: 24 * 60 * 60 * 1000,      // 1 trading day
  embargoMs: 2 * 24 * 60 * 60 * 1000, // 2 days
  regimeSeparated: true,
  priorStrength: 20,
  autoGradeCutpoints: true,
  seed: 42,
};

/** A single (train, test) index split. */
export interface CvSplit {
  trainIdx: number[];
  testIdx: number[];
}

/**
 * Build temporally-ordered CV splits with PURGING and EMBARGO (López-de-Prado).
 * Examples are sorted by `signalMs`. For each test block, training examples
 * whose label window [signalMs, outcomeMs] overlaps the test window — plus the
 * embargo tail after it — are removed to prevent leakage.
 *
 * `purgedKFold`: contiguous K test blocks.
 * `walkForward`: expanding train, forward test blocks (test always after train).
 * `cpcv`: combinatorial — pairs of test blocks (Combinatorial Purged CV).
 */
export function buildCvSplits(examples: QualityTrainingExample[], cfg: TrainConfig): CvSplit[] {
  const n = examples.length;
  if (n < cfg.folds) return [];
  const order = [...examples.keys()].sort((a, b) => examples[a]!.signalMs - examples[b]!.signalMs);
  const blockSize = Math.floor(n / cfg.folds);
  const blocks: number[][] = [];
  for (let k = 0; k < cfg.folds; k++) {
    const start = k * blockSize;
    const end = k === cfg.folds - 1 ? n : start + blockSize;
    blocks.push(order.slice(start, end));
  }

  const testWindow = (block: number[]): { t0: number; t1: number } => {
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const i of block) {
      t0 = Math.min(t0, examples[i]!.signalMs);
      t1 = Math.max(t1, examples[i]!.outcomeMs);
    }
    return { t0, t1 };
  };

  const purge = (trainCandidate: number[], win: { t0: number; t1: number }): number[] => {
    const embargoEnd = win.t1 + cfg.embargoMs;
    const purgeStart = win.t0 - cfg.purgeMs;
    return trainCandidate.filter((i) => {
      const e = examples[i]!;
      // remove if the example's label window overlaps [purgeStart, embargoEnd]
      const overlaps = e.outcomeMs >= purgeStart && e.signalMs <= embargoEnd;
      return !overlaps;
    });
  };

  const splits: CvSplit[] = [];

  if (cfg.scheme === "walkForward") {
    for (let k = 1; k < cfg.folds; k++) {
      const testIdx = blocks[k]!;
      const win = testWindow(testIdx);
      const trainCandidate = blocks.slice(0, k).flat();
      splits.push({ trainIdx: purge(trainCandidate, win), testIdx });
    }
  } else if (cfg.scheme === "cpcv") {
    // Combinatorial: all pairs of test blocks; train = the rest, purged.
    for (let a = 0; a < cfg.folds; a++) {
      for (let b = a + 1; b < cfg.folds; b++) {
        const testIdx = [...blocks[a]!, ...blocks[b]!];
        const win = testWindow(testIdx);
        const trainCandidate = order.filter((i) => !blocks[a]!.includes(i) && !blocks[b]!.includes(i));
        splits.push({ trainIdx: purge(trainCandidate, win), testIdx });
      }
    }
  } else {
    // purgedKFold
    for (let k = 0; k < cfg.folds; k++) {
      const testIdx = blocks[k]!;
      const win = testWindow(testIdx);
      const trainCandidate = order.filter((i) => !blocks[k]!.includes(i));
      splits.push({ trainIdx: purge(trainCandidate, win), testIdx });
    }
  }
  return splits;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 11 — Redundancy analysis (prevent double-counting)
// ═══════════════════════════════════════════════════════════════════════════

/** Pearson correlation between two equal-length numeric arrays. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/**
 * Correlation matrix across edge components computed on the training features.
 * Used to VERIFY the redundancy groupings (highly-correlated components should
 * sit in the same group so they share a weight budget).
 */
export function componentCorrelations(examples: QualityTrainingExample[], model: QualityModel): Record<string, number> {
  const cols: Record<string, number[]> = {};
  for (const c of EDGE_COMPONENTS) cols[c] = [];
  for (const ex of examples) {
    for (const c of EDGE_COMPONENTS) {
      cols[c]!.push(edgeValueOf(ex.features, c, model).value);
    }
  }
  const out: Record<string, number> = {};
  for (let i = 0; i < EDGE_COMPONENTS.length; i++) {
    for (let j = i + 1; j < EDGE_COMPONENTS.length; j++) {
      const ci = EDGE_COMPONENTS[i]!;
      const cj = EDGE_COMPONENTS[j]!;
      out[`${ci}~${cj}`] = pearson(cols[ci]!, cols[cj]!);
    }
  }
  return out;
}

/**
 * Permutation importance of each edge component: how much OOS Brier score
 * degrades when that component's values are shuffled. Deterministic (uses a
 * seeded LCG). Components in the same redundancy group will show LOW individual
 * importance if they are redundant — the signal we use to keep them grouped.
 */
export function permutationImportance(
  examples: QualityTrainingExample[],
  model: QualityModel,
  seed = 42,
): Record<QualityComponent, number> {
  const base = oosBrier(examples, model);
  const out = {} as Record<QualityComponent, number>;
  for (const c of QUALITY_COMPONENTS) out[c] = 0;

  // seeded permutation via LCG (deterministic)
  const rng = lcg(seed);
  for (const comp of EDGE_COMPONENTS) {
    // build a permuted copy of this component across examples
    const values = examples.map((e) => edgeValueOf(e.features, comp, model).value);
    const perm = shuffle(values, rng());
    let sum = 0;
    for (let i = 0; i < examples.length; i++) {
      const f2: QualityFeatureVector = injectComponent(examples[i]!.features, comp, perm[i]!);
      const p = scoreQuality(f2, model).predictedProfitProbability;
      sum += (p - examples[i]!.label) ** 2;
    }
    const permBrier = sum / Math.max(1, examples.length);
    out[comp] = permBrier - base; // positive ⇒ component was informative
  }
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function shuffle<T>(arr: T[], r: number): T[] {
  const a = [...arr];
  let rr = r;
  for (let i = a.length - 1; i > 0; i--) {
    rr = (rr * 9301 + 49297) % 233280;
    const j = Math.floor((rr / 233280) * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Return a shallow copy of features with one edge component overridden. */
function injectComponent(f: QualityFeatureVector, c: QualityComponent, value: number): QualityFeatureVector {
  const copy: QualityFeatureVector = { ...f };
  switch (c) {
    case "predictiveProbability": copy.predictiveProbability = value; break;
    case "expectedValue": copy.netExpectedValueR = value * 3 - 1; break;
    case "regimeFit": copy.regimeFit = value; break;
    case "multiTimeframeAlignment": copy.multiTimeframeAlignment = value; break;
    case "marketStructure": copy.marketStructure = value; break;
    case "momentum": copy.momentum = value; break;
    case "volume": copy.volume = value; break;
    case "volatilityFit": copy.volatilityFit = value; break;
    case "liquidity": copy.liquidity = value; break;
    case "derivativesConfirmation": copy.derivativesConfirmation = value; break;
    case "relativeStrength": copy.relativeStrength = value; break;
    case "executionQuality": copy.executionQuality = value; break;
    // historicalConditionalWinRate is table-driven; skip.
    default: break;
  }
  return copy;
}

/** Mean OOS Brier score of a model over labelled examples. */
export function oosBrier(examples: QualityTrainingExample[], model: QualityModel): number {
  if (examples.length === 0) return 1;
  let s = 0;
  for (const e of examples) {
    const p = scoreQuality(e.features, model).predictedProfitProbability;
    s += (p - e.label) ** 2;
  }
  return s / examples.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 12 — Conditional-performance tables (Bayesian shrinkage + priors)
// ═══════════════════════════════════════════════════════════════════════════

export interface ConditionalTableResult {
  table: Record<string, ConditionalPerformanceCell>;
  priors: Record<string, number>;
  globalPrior: number;
}

/**
 * Build the empirical conditional-performance tables
 *   strategy × regime × timeframe × edge-bucket
 * from TRAINING examples only (never test). Priors are LEARNED hierarchically:
 *   • globalPrior = overall win rate,
 *   • priors["strategy"] = strategy win rate (shrunk toward global),
 *   • priors["strategy|regime"] = family win rate (shrunk toward strategy).
 * Each cell's win rate is then shrunk toward its most specific available prior.
 *
 * This is the "prior must be learned from the relevant family, not hard-coded"
 * requirement, and the shrinkage prevents tiny samples inflating quality.
 */
export function buildConditionalTables(
  examples: QualityTrainingExample[],
  priorStrength = 20,
): ConditionalTableResult {
  const globalPrior = examples.length > 0 ? mean(examples.map((e) => e.label)) : 0.5;

  // strategy-level priors (shrunk toward global)
  const byStrategy = groupBy(examples, (e) => e.features.strategyId);
  const priors: Record<string, number> = {};
  for (const [sid, rows] of byStrategy) {
    const wins = rows.filter((r) => r.label === 1).length;
    priors[sid] = shrinkWinRate(wins, rows.length, globalPrior, priorStrength).effectiveWinRate;
  }
  // strategy|regime priors (shrunk toward strategy prior)
  const byFamily = groupBy(examples, (e) => `${e.features.strategyId}|${e.features.regime}`);
  for (const [key, rows] of byFamily) {
    const sid = key.split("|")[0]!;
    const parent = priors[sid] ?? globalPrior;
    const wins = rows.filter((r) => r.label === 1).length;
    priors[key] = shrinkWinRate(wins, rows.length, parent, priorStrength).effectiveWinRate;
  }

  // cells keyed by strategy|regime|timeframe|bucket
  const table: Record<string, ConditionalPerformanceCell> = {};
  const byCell = groupBy(examples, (e) => {
    // bucket derived from an untrained-uniform pre-score so table construction
    // does not depend on final weights (avoids circular dependency).
    const edge = e.features.predictiveProbability ?? NEUTRAL;
    return conditionalKey(e.features.strategyId, e.features.regime, e.features.timeframe, edgeBucket(edge));
  });

  for (const [key, rows] of byCell) {
    const [sid, regime] = key.split("|") as [string, QualityRegime];
    const familyPrior = priors[`${sid}|${regime}`] ?? priors[sid] ?? globalPrior;
    const wins = rows.filter((r) => r.label === 1).length;
    const shr = shrinkWinRate(wins, rows.length, familyPrior, priorStrength);

    const rMultiples = rows.map((r) => r.netReturnR);
    const winsR = rMultiples.filter((r) => r > 0);
    const lossesR = rMultiples.filter((r) => r < 0);
    const costAdj = rows.map((r) => r.costAdjustedReturnR);
    const slipAdj = rows.map((r) => r.slippageAdjustedReturnR);

    table[key] = {
      key,
      sampleCount: rows.length,
      observedWinRate: shr.observedWinRate,
      priorWinRate: familyPrior,
      sampleConfidence: shr.sampleConfidence,
      effectiveWinRate: shr.effectiveWinRate,
      expectancyR: expectancyOf(rMultiples),
      profitFactor: profitFactorOf(rMultiples),
      avgWinR: winsR.length > 0 ? mean(winsR) : 0,
      avgLossR: lossesR.length > 0 ? mean(lossesR) : 0,
      netReturnR: rMultiples.reduce((a, b) => a + b, 0),
      maxDrawdownR: computeMaxDrawdownR(rMultiples),
      costAdjustedReturnR: costAdj.reduce((a, b) => a + b, 0),
      slippageAdjustedReturnR: slipAdj.reduce((a, b) => a + b, 0),
    };
  }

  return { table, priors, globalPrior };
}

function computeMaxDrawdownR(rSeq: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rSeq) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function groupBy<T>(items: T[], keyFn: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 13 — Weight learning (OOS Brier minimisation, group-budgeted)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Learn per-GROUP weight budgets by coordinate descent minimising OOS Brier
 * across the CV splits. Within-group weights are learned by the same procedure
 * over each group's edge components. This is intentionally simple, deterministic
 * and dependency-free (no external optimiser): a grid/coordinate search over the
 * simplex. It replaces hand-tuned weights with data-driven ones and CANNOT be
 * "increased blindly" — every candidate is scored on held-out folds.
 */
function learnGroupWeights(
  examples: QualityTrainingExample[],
  splits: CvSplit[],
  baseModel: QualityModel,
): { groupWeights: Record<string, number>; withinGroupWeights: QualityModel["withinGroupWeights"] } {
  const groups = Object.keys(REDUNDANCY_GROUPS).filter((g) =>
    REDUNDANCY_GROUPS[g]!.some((c) => EDGE_COMPONENTS.includes(c)),
  );

  // initialise uniform over groups
  let gw: Record<string, number> = {};
  for (const g of groups) gw[g] = 1 / groups.length;

  const within: QualityModel["withinGroupWeights"] = {};
  for (const g of groups) {
    const comps = REDUNDANCY_GROUPS[g]!.filter((c) => EDGE_COMPONENTS.includes(c));
    within[g] = {};
    for (const c of comps) within[g]![c] = 1 / comps.length;
  }

  const scoreWeights = (candidateGW: Record<string, number>): number => {
    // per-fold: build conditional tables on TRAIN only, evaluate Brier on TEST
    let total = 0;
    let count = 0;
    for (const split of splits) {
      const train = split.trainIdx.map((i) => examples[i]!);
      const test = split.testIdx.map((i) => examples[i]!);
      if (train.length === 0 || test.length === 0) continue;
      const ct = buildConditionalTables(train, DEFAULT_TRAIN_CONFIG.priorStrength);
      const foldModel: QualityModel = {
        ...baseModel,
        groupWeights: candidateGW,
        withinGroupWeights: within,
        conditionalTable: ct.table,
        priors: ct.priors,
        globalPrior: ct.globalPrior,
        // fit calibration on TRAIN fold only
        calibration: fitCalibrationOnFold(train, { ...baseModel, groupWeights: candidateGW, withinGroupWeights: within, conditionalTable: ct.table, priors: ct.priors, globalPrior: ct.globalPrior }),
      };
      total += oosBrier(test, foldModel);
      count++;
    }
    return count > 0 ? total / count : 1;
  };

  // coordinate descent on the group simplex (deterministic step schedule)
  let bestScore = scoreWeights(gw);
  const steps = [0.2, 0.1, 0.05];
  for (const step of steps) {
    let improved = true;
    let guard = 0;
    while (improved && guard < 50) {
      improved = false;
      guard++;
      for (const g of groups) {
        for (const dir of [+1, -1]) {
          const cand = { ...gw };
          cand[g] = Math.max(0, (cand[g] ?? 0) + dir * step);
          const s = normaliseSimplex(cand);
          const sc = scoreWeights(s);
          if (sc < bestScore - 1e-6) {
            bestScore = sc;
            gw = s;
            improved = true;
          }
        }
      }
    }
  }

  return { groupWeights: gw, withinGroupWeights: within };
}

function normaliseSimplex(w: Record<string, number>): Record<string, number> {
  const total = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(w)) out[k] = total > 0 ? Math.max(0, v) / total : 0;
  return out;
}

/** Fit the monotone calibration curve on a single fold's TRAIN examples. */
function fitCalibrationOnFold(train: QualityTrainingExample[], model: QualityModel): IsotonicCurve {
  const pts = train.map((e) => ({ x: rawEdgeBlendOnly(e.features, model), y: e.label as number, w: 1 }));
  return fitIsotonic(pts);
}

/** Compute ONLY the raw edge blend (no calibration/decay) — used for fitting. */
export function rawEdgeBlendOnly(f: QualityFeatureVector, model: QualityModel): number {
  const weights = effectiveEdgeWeights(model);
  const cell = lookupConditionalCell(f, model, f.predictiveProbability ?? NEUTRAL);
  let blend = 0;
  for (const c of EDGE_COMPONENTS) {
    const w = weights[c];
    const { value } = c === "historicalConditionalWinRate"
      ? (cell ? { value: clamp01(cell.effectiveWinRate) } : { value: NEUTRAL })
      : edgeValueOf(f, c, model);
    blend += value * w;
  }
  return clamp01(blend);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 14 — Monotonicity verification
// ═══════════════════════════════════════════════════════════════════════════

export interface MonotonicityBucketStat {
  label: string;
  scoreMin: number;
  scoreMax: number;
  count: number;
  realizedWinRate: number;
  expectancyR: number;
  profitFactor: number;
}

export interface MonotonicityReport {
  buckets: MonotonicityBucketStat[];
  /** True if realized win rate is non-decreasing across score buckets (tolerance). */
  winRateMonotonic: boolean;
  /** True if expectancy is non-decreasing across score buckets (tolerance). */
  expectancyMonotonic: boolean;
  breaches: string[];
  spearman: number; // rank correlation of score vs realized win (per bucket)
}

/**
 * Verify that higher qualityScore ⇒ higher realized probability of a profitable
 * outcome, on a HELD-OUT set. If this fails, the caller must recalibrate/redesign
 * (the calibration curve is monotone by construction, but conditional-table
 * bucketing / uncertainty interactions can still introduce local inversions).
 */
export function verifyMonotonicity(
  examples: QualityTrainingExample[],
  model: QualityModel,
  tolerance = 0.03,
  bucketEdges: number[] = [40, 50, 60, 70, 80, 90, 100],
  /**
   * Minimum realized sample per bucket before its win rate is trusted for the
   * monotonicity assertion. Under-populated buckets are reported (for
   * transparency) but EXCLUDED from the monotonicity check — a 3-sample bucket
   * printing 100% is noise, not evidence, and must never fail (or pass) a
   * structural property. This is standard sample-size hygiene, not a workaround.
   * Defaults to `MIN_SAMPLE_FOR_PRECISION` (30) — the same bar the existing
   * signal-quality report uses before trusting a precision estimate.
   */
  minBucketCount = 30,
): MonotonicityReport {
  const scored = examples.map((e) => ({
    score: scoreQuality(e.features, model).qualityScore,
    win: e.label,
    r: e.netReturnR,
  }));

  const buckets: MonotonicityBucketStat[] = [];
  let prevMin = 0;
  for (const hi of bucketEdges) {
    const inB = scored.filter((s) => s.score >= prevMin && s.score < hi + (hi === 100 ? 0.001 : 0));
    if (inB.length > 0) {
      const rs = inB.map((s) => s.r);
      buckets.push({
        label: `${prevMin}-${hi}`,
        scoreMin: prevMin,
        scoreMax: hi,
        count: inB.length,
        realizedWinRate: mean(inB.map((s) => s.win)),
        expectancyR: expectancyOf(rs),
        profitFactor: profitFactorOf(rs),
      });
    }
    prevMin = hi;
  }

  // Only buckets with adequate sample size are used for the monotonicity check.
  const reliable = buckets.filter((b) => b.count >= minBucketCount);

  // Sample-aware allowance: a win-rate dip only counts as an inversion if it
  // is LARGER than the sampling noise between the two buckets. We use the
  // combined standard error of the two Bernoulli proportions (≈ Wilson) plus
  // the caller's floor `tolerance`. This is the statistically-honest criterion:
  // a 0.05 dip on n=50 (SE≈0.10) is indistinguishable from flat and must not be
  // called an inversion, whereas a 0.20 drop on large n still is.
  const winRateAllowance = (a: MonotonicityBucketStat, b: MonotonicityBucketStat): number => {
    const seA = Math.sqrt((a.realizedWinRate * (1 - a.realizedWinRate)) / Math.max(1, a.count));
    const seB = Math.sqrt((b.realizedWinRate * (1 - b.realizedWinRate)) / Math.max(1, b.count));
    return Math.max(tolerance, 1.96 * Math.sqrt(seA * seA + seB * seB));
  };

  const breaches: string[] = [];
  let winMono = true;
  let expMono = true;
  for (let i = 1; i < reliable.length; i++) {
    const prev = reliable[i - 1]!;
    const cur = reliable[i]!;
    const allow = winRateAllowance(prev, cur);
    if (cur.realizedWinRate < prev.realizedWinRate - allow) {
      winMono = false;
      breaches.push(`winRate inversion ${prev.label}(${prev.realizedWinRate.toFixed(3)}, n=${prev.count}) → ${cur.label}(${cur.realizedWinRate.toFixed(3)}, n=${cur.count}); drop exceeds ${allow.toFixed(3)} allowance`);
    }
    if (cur.expectancyR < prev.expectancyR - Math.max(tolerance, allow)) {
      expMono = false;
      breaches.push(`expectancy inversion ${prev.label} → ${cur.label}`);
    }
  }

  // Spearman rank correlation of bucket-index vs win rate (reliable buckets only)
  const idx = reliable.map((_, i) => i);
  const wr = reliable.map((b) => b.realizedWinRate);
  const spearman = reliable.length >= 2 ? pearson(rank(idx), rank(wr)) : 1;

  return { buckets, winRateMonotonic: winMono, expectancyMonotonic: expMono, breaches, spearman };
}

function rank(arr: number[]): number[] {
  const sorted = [...arr.keys()].sort((a, b) => arr[a]! - arr[b]!);
  const r = new Array(arr.length).fill(0);
  sorted.forEach((origIdx, rankPos) => { r[origIdx] = rankPos; });
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 15 — Grade cut-point selection (learned, monotone-separating)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Choose grade cut-points on the 0–100 score so each grade band has a MONOTONE,
 * meaningfully-separated realized win rate. Uses quantiles of the OOS score
 * distribution as candidate boundaries and keeps the boundaries that preserve
 * win-rate ordering. Deterministic.
 */
export function learnGradeCutpoints(
  examples: QualityTrainingExample[],
  model: QualityModel,
): QualityModel["gradeCutpoints"] {
  if (examples.length < 20) {
    // not enough data — conservative defaults (still monotone by construction)
    return { exceptional: 75, high: 62, medium: 50, low: 40 };
  }
  const scored = examples
    .map((e) => ({ s: scoreQuality(e.features, model).qualityScore, w: e.label }))
    .sort((a, b) => a.s - b.s);
  const q = (p: number) => scored[Math.min(scored.length - 1, Math.floor(p * scored.length))]!.s;
  // start from distribution quantiles then enforce a minimum spacing
  const low = q(0.4);
  let medium = q(0.6);
  let high = q(0.8);
  let exceptional = q(0.92);
  // enforce ordering + minimum gaps
  medium = Math.max(medium, low + 3);
  high = Math.max(high, medium + 3);
  exceptional = Math.max(exceptional, high + 3);
  return {
    low: Math.round(low * 10) / 10,
    medium: Math.round(medium * 10) / 10,
    high: Math.round(high * 10) / 10,
    exceptional: Math.round(exceptional * 10) / 10,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 16 — Top-level trainer
// ═══════════════════════════════════════════════════════════════════════════

export interface TrainResult {
  model: QualityModel;
  oosBrier: number;
  monotonicity: MonotonicityReport;
  componentImportance: Record<QualityComponent, number>;
  correlations: Record<string, number>;
  redundancyWarnings: string[];
  foldCount: number;
}

/**
 * Learn a `QualityModel` from labelled, OUT-OF-SAMPLE outcomes.
 *
 * Steps:
 *   1. Build CV splits (walk-forward / purged-K-fold / CPCV) with purge+embargo.
 *   2. Learn group-budgeted weights by minimising OOS Brier on the splits.
 *   3. Build conditional tables + learned priors on ALL data (final artifact).
 *   4. Fit the monotone isotonic calibration curve on the full raw-blend→label.
 *   5. Learn grade cut-points that keep realized win rate monotone.
 *   6. Run redundancy analysis (correlation + permutation importance) and verify
 *      monotonicity on the pooled OOS predictions.
 *
 * If `regimeSeparated`, weights are learned per regime and blended by sample
 * share (regime-separated validation) — reported in the returned model as the
 * effective merged weights.
 */
export function trainQualityModel(
  examples: QualityTrainingExample[],
  cfg: TrainConfig = DEFAULT_TRAIN_CONFIG,
  base: QualityModel = DEFAULT_QUALITY_MODEL,
): TrainResult {
  const splits = buildCvSplits(examples, cfg);

  // (2) learn weights
  let learned: { groupWeights: Record<string, number>; withinGroupWeights: QualityModel["withinGroupWeights"] };
  if (cfg.regimeSeparated) {
    const byRegime = groupBy(examples, (e) => e.features.regime);
    const acc: Record<string, number> = {};
    let totalN = 0;
    let mergedWithin: QualityModel["withinGroupWeights"] = {};
    for (const [, rows] of byRegime) {
      if (rows.length < cfg.folds * 2) continue;
      const rSplits = buildCvSplits(rows, cfg);
      if (rSplits.length === 0) continue;
      const w = learnGroupWeights(rows, rSplits, base);
      for (const [g, v] of Object.entries(w.groupWeights)) acc[g] = (acc[g] ?? 0) + v * rows.length;
      mergedWithin = w.withinGroupWeights;
      totalN += rows.length;
    }
    if (totalN > 0) {
      const gw: Record<string, number> = {};
      for (const [g, v] of Object.entries(acc)) gw[g] = v / totalN;
      learned = { groupWeights: normaliseSimplex(gw), withinGroupWeights: mergedWithin };
    } else {
      learned = splits.length > 0 ? learnGroupWeights(examples, splits, base) : { groupWeights: base.groupWeights, withinGroupWeights: base.withinGroupWeights };
    }
  } else {
    learned = splits.length > 0 ? learnGroupWeights(examples, splits, base) : { groupWeights: base.groupWeights, withinGroupWeights: base.withinGroupWeights };
  }

  // (3) conditional tables + priors on ALL data
  const ct = buildConditionalTables(examples, cfg.priorStrength);

  // interim model to fit calibration
  const interim: QualityModel = {
    ...base,
    provenance: "TRAINED_OOS",
    trainedAtMs: examples.length > 0 ? Math.max(...examples.map((e) => e.outcomeMs)) : null,
    oosWindow: examples.length > 0 ? { startMs: Math.min(...examples.map((e) => e.signalMs)), endMs: Math.max(...examples.map((e) => e.outcomeMs)) } : null,
    groupWeights: learned.groupWeights,
    withinGroupWeights: learned.withinGroupWeights,
    conditionalTable: ct.table,
    priors: ct.priors,
    globalPrior: ct.globalPrior,
  };

  // (4) calibration on full raw-blend → label (monotone by construction)
  const calibration = fitIsotonic(examples.map((e) => ({ x: rawEdgeBlendOnly(e.features, interim), y: e.label as number })));
  const withCal: QualityModel = { ...interim, calibration };

  // (5) grade cut-points
  const gradeCutpoints = cfg.autoGradeCutpoints ? learnGradeCutpoints(examples, withCal) : withCal.gradeCutpoints;
  const model: QualityModel = { ...withCal, gradeCutpoints };

  // (6) diagnostics
  const monotonicity = verifyMonotonicity(examples, model);
  const componentImportance = permutationImportance(examples, model, cfg.seed);
  const correlations = componentCorrelations(examples, model);
  const redundancyWarnings: string[] = [];
  for (const [pair, r] of Object.entries(correlations)) {
    if (Math.abs(r) > 0.8) {
      const [a, b] = pair.split("~");
      const sameGroup = Object.values(REDUNDANCY_GROUPS).some((g) => g.includes(a as QualityComponent) && g.includes(b as QualityComponent));
      if (!sameGroup) redundancyWarnings.push(`High correlation ${pair}=${r.toFixed(2)} but NOT in same redundancy group — risk of double-counting.`);
    }
  }

  return {
    model,
    oosBrier: oosBrier(examples, model),
    monotonicity,
    componentImportance,
    correlations,
    redundancyWarnings,
    foldCount: splits.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 17 — Default (UNTRAINED) model — uniform within groups
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The shipped default. It is explicitly flagged UNTRAINED so a deployment that
 * has not yet fit weights cannot masquerade as empirical. Weights are UNIFORM
 * across redundancy groups and uniform within each group (NOT hand-tuned to
 * favour any factor). Calibration is the identity curve. The conditional table
 * is empty (→ probabilities shrink toward the global prior of 0.5 until real
 * outcomes are supplied).
 *
 * IMPORTANT: this is a safe fallback, NOT a recommendation. `trainQualityModel`
 * must be run on real OOS outcomes before this model gates production.
 */
export const DEFAULT_QUALITY_MODEL: QualityModel = (() => {
  const groups = Object.keys(REDUNDANCY_GROUPS).filter((g) =>
    REDUNDANCY_GROUPS[g]!.some((c) => EDGE_COMPONENTS.includes(c)),
  );
  const groupWeights: Record<string, number> = {};
  for (const g of groups) groupWeights[g] = 1 / groups.length;

  const withinGroupWeights: QualityModel["withinGroupWeights"] = {};
  for (const g of groups) {
    const comps = REDUNDANCY_GROUPS[g]!.filter((c) => EDGE_COMPONENTS.includes(c));
    withinGroupWeights[g] = {};
    for (const c of comps) withinGroupWeights[g]![c] = 1 / comps.length;
  }

  return {
    version: PREDICTIVE_QUALITY_ENGINE_VERSION,
    provenance: "UNTRAINED_UNIFORM_PRIOR",
    trainedAtMs: null,
    oosWindow: null,
    groupWeights,
    withinGroupWeights,
    // identity calibration (blend passes through); monotone by construction
    calibration: { x: [0, 1], y: [0, 1] },
    conditionalTable: {},
    priors: {},
    globalPrior: 0.5,
    gradeCutpoints: { exceptional: 75, high: 62, medium: 50, low: 40 },
    freshness: {
      quoteFullyStaleMs: 60_000,          // 60s → fully stale quote
      optionChainFullyStaleMs: 120_000,   // 2m
      oiFullyStaleMs: 15 * 60_000,        // 15m
      latencyAbnormalMs: 2_000,           // 2s
      signalHalfLifeMs: 30 * 60_000,      // 30m half-life
    },
  };
})();

// Re-export the cost constant used by callers computing cost-adjusted returns.
export { BASE_COST_BPS, costAdjust, toRMultiple };
