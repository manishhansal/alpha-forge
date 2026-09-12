/**
 * India ML Meta Decision Engine  (v1 — empirical, OOS-calibrated)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Turns the RAW outputs of the India model stack into a single, empirically
 * calibrated  P(profitable trade)  with uncertainty bounds and full provenance.
 *
 * The models whose raw outputs feed this layer (the "11 components" the brief
 * lists) are the ones the ML service already produces plus the TS heuristic:
 *   regimeClassifier, stockRanker, strategySelector, riskPredictor,
 *   priceForecaster, ivClassifier, quantEngine  — and the meta layer itself is
 *   the ensemble + calibrationStore + abstentionPolicy.
 *
 * DESIGN (the audit's "close the loop" fix)
 * -----------------------------------------
 *   1. Each model emits a RAW score in [0,1] (`ModelSignal.rawScore`) — this is
 *      NOT a probability of profit, it is the model's own output.
 *   2. A HIERARCHICAL calibration store maps each model's raw score → calibrated
 *      P(profit), using a calibrator learned from OOS outcomes at the most
 *      specific available level and shrunk toward the parent when data is thin:
 *         strategy+regime+timeframe → strategy+regime → strategy → global
 *   3. Per-model contributions are ensembled with weights LEARNED from OOS
 *      performance (calibration quality, recency, regime fit, sample size,
 *      drift) and DE-WEIGHTED for correlation, with a minimum effective sample.
 *   4. The output separates `rawProbability` (uncalibrated ensemble) from
 *      `calibratedProbability`, plus lower/upper bounds, method, sample count,
 *      calibration quality, model agreement and prediction uncertainty.
 *
 * CONFIDENCE ≠ PROBABILITY. `confidence` (the heuristic conviction score) is
 * carried alongside but never substituted for probability. This module never
 * lets a heuristic confidence override statistically stronger, calibrated ML
 * evidence.
 *
 * All inference is PURE and DETERMINISTIC given (signals, model artifact).
 * Training (`trainMetaModel`) uses OOS folds and is deterministic given a seed.
 *
 * I/O-free; no `server-only` guard so it is unit-testable and worker-usable.
 */

import {
  applyCalibrator,
  type Calibrator,
  type CalibrationMethod,
  type CalibrationMetrics,
  type ScoredOutcome,
  clamp01,
} from "./ml-calibration-metrics";

export const ML_META_DECISION_VERSION = "mmd-1.0.0";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Model identities & signals
// ═══════════════════════════════════════════════════════════════════════════

export const META_MODELS = [
  "regimeClassifier",
  "stockRanker",
  "strategySelector",
  "riskPredictor",
  "priceForecaster",
  "ivClassifier",
  "quantEngine",
] as const;

export type MetaModel = (typeof META_MODELS)[number];

export type MetaRegime = "BULL_TREND" | "BEAR_TREND" | "RANGE" | "HIGH_VOL" | "LOW_VOL" | "UNKNOWN";
export type MetaTimeframe = "SCALP" | "INTRADAY" | "SWING";

/** One model's raw contribution to a single decision. */
export interface ModelSignal {
  model: MetaModel;
  /** Raw model output in [0,1] (NOT a calibrated probability). */
  rawScore: number;
  /** True if the model actually produced this signal (else it is absent/dropout). */
  present: boolean;
}

/** The full input to a single meta decision. */
export interface MetaDecisionInput {
  strategyId: string;
  regime: MetaRegime;
  timeframe: MetaTimeframe;
  signals: ModelSignal[];
  /** The heuristic conviction score [0,1] — kept SEPARATE from probability. */
  confidence: number;
  /** Current time (ms) — used only for drift/staleness against model artifacts. */
  nowMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Per-model artifacts (learned from OOS)
// ═══════════════════════════════════════════════════════════════════════════

/** Calibration artifact for one model at one hierarchy level. */
export interface ModelCalibration {
  model: MetaModel;
  level: "strategy+regime+timeframe" | "strategy+regime" | "strategy" | "global";
  key: string;
  method: CalibrationMethod;
  calibrator: Calibrator;
  sampleCount: number;
  /** OOS calibration quality ∈ [0,1] (1 − normalised OOS log loss vs base). */
  quality: number;
  metrics: CalibrationMetrics | null;
}

/** How much empirical value a model adds (measured OOS). */
export interface ModelContribution {
  model: MetaModel;
  /** OOS ROC-AUC of the model's calibrated prob vs outcome. */
  rocAuc: number;
  /** Improvement in OOS log loss vs the base-rate constant predictor (≥0 good). */
  logLossImprovement: number;
  /** Top-decile lift of the model's ranking (>1 means the model concentrates winners). */
  topDecileLift: number;
  /** Realized win rate / expectancy / profit factor of the model's top-decile picks. */
  topDecileWinRate: number;
  topDecileExpectancyR: number;
  topDecileProfitFactor: number;
  /** Final verdict: does this model add measurable value? */
  addsValue: boolean;
}

/** Reliability of a model's probability estimates. */
export interface ModelReliability {
  model: MetaModel;
  brier: number;
  ece: number;
  calibrationSlope: number;
  calibrationIntercept: number;
  sampleCount: number;
  /** Effective sample size after correlation/temporal discount. */
  effectiveSampleSize: number;
}

/** Drift of a model between an early and a recent OOS window. */
export interface ModelDrift {
  model: MetaModel;
  /** |recent log loss − early log loss| (higher = more drift). */
  logLossDelta: number;
  /** PSI of the score distribution between windows. */
  psi: number;
  drifting: boolean;
  /** ms since the model artifact was last refreshed (staleness). */
  ageMs: number;
  stale: boolean;
}

/** Per-regime performance of a model (regime-conditioned weighting). */
export interface ModelRegimePerformance {
  model: MetaModel;
  byRegime: Partial<Record<MetaRegime, { rocAuc: number; logLoss: number; n: number }>>;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — The frozen meta model artifact
// ═══════════════════════════════════════════════════════════════════════════

export interface MetaModelArtifact {
  version: string;
  trainedAtMs: number | null;
  /** Hierarchical calibrators: calibration[model][key] where key encodes the level. */
  calibration: Record<MetaModel, Record<string, ModelCalibration>>;
  contribution: Record<MetaModel, ModelContribution>;
  reliability: Record<MetaModel, ModelReliability>;
  drift: Record<MetaModel, ModelDrift>;
  regimePerformance: Record<MetaModel, ModelRegimePerformance>;
  /**
   * Base ensemble weights per model (learned from OOS; NOT equal). These are
   * modulated per-decision by regime performance and adjusted for correlation.
   */
  baseWeights: Record<MetaModel, number>;
  /** Pairwise score correlation between models (for correlation de-weighting). */
  correlation: Record<string, number>;
  /** Global prior (base win rate) used as the shrinkage target of last resort. */
  globalPrior: number;
  /** Minimum effective sample size before a model's weight is trusted. */
  minEffectiveSample: number;
  /** Staleness threshold (ms) beyond which a model is considered stale. */
  staleMs: number;
  /** Abstention policy thresholds. */
  abstention: {
    /** Below this ensemble effective weight, abstain (no usable models). */
    minTotalWeight: number;
    /** Below this model agreement, abstain (severe disagreement). */
    minAgreement: number;
    /** Above this prediction uncertainty, abstain. */
    maxUncertainty: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Output
// ═══════════════════════════════════════════════════════════════════════════

/** Per-model attribution inside a decision. */
export interface ModelAttribution {
  model: MetaModel;
  present: boolean;
  rawScore: number;
  calibratedProbability: number;
  calibrationLevel: ModelCalibration["level"] | "none";
  calibrationMethod: CalibrationMethod;
  weight: number;               // effective weight after all adjustments
  effectiveSampleSize: number;
  stale: boolean;
  drifting: boolean;
}

export interface MetaDecisionResult {
  version: string;

  // ── The two things that must NEVER be conflated ─────────────────────────────
  /** Heuristic conviction, carried through untouched. NOT a probability. */
  confidence: number;
  /** Weighted ensemble of RAW model scores (uncalibrated). */
  rawProbability: number;
  /** Empirically OOS-calibrated P(profitable trade). */
  calibratedProbability: number;

  // ── Uncertainty ─────────────────────────────────────────────────────────────
  probabilityLowerBound: number;
  probabilityUpperBound: number;
  /** [0,1] — spread of per-model calibrated probs + interval width. */
  predictionUncertainty: number;
  /** [0,1] — how much independent models agree on direction/magnitude. */
  modelAgreement: number;

  // ── Calibration provenance ──────────────────────────────────────────────────
  /** The dominant calibration method used (highest-weight present model). */
  calibrationMethod: CalibrationMethod;
  /** Sample count backing the dominant calibrator. */
  calibrationSampleCount: number;
  /** [0,1] blended calibration quality of the contributing models. */
  calibrationQuality: number;

  /** Whether the engine abstains (insufficient/unreliable evidence). */
  abstained: boolean;
  abstentionReasons: string[];

  attribution: ModelAttribution[];
  reasons: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Helpers
// ═══════════════════════════════════════════════════════════════════════════

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const meanOf = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);
const stdOf = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Wilson interval for a proportion (reused for probability bounds). */
export function wilsonInterval(wins: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/** Bayesian shrinkage of an observed rate toward a prior via pseudo-counts. */
export function shrink(observed: number, n: number, prior: number, priorStrength = 20): { value: number; confidence: number } {
  if (n <= 0) return { value: prior, confidence: 0 };
  const c = n / (n + priorStrength);
  return { value: c * observed + (1 - c) * prior, confidence: c };
}

function levelKeys(strategyId: string, regime: MetaRegime, timeframe: MetaTimeframe): Array<{ level: ModelCalibration["level"]; key: string }> {
  return [
    { level: "strategy+regime+timeframe", key: `${strategyId}|${regime}|${timeframe}` },
    { level: "strategy+regime", key: `${strategyId}|${regime}` },
    { level: "strategy", key: `${strategyId}` },
    { level: "global", key: "GLOBAL" },
  ];
}

/**
 * Resolve the calibrator for a model at the most specific hierarchy level that
 * has one; returns the level, calibrator and its sample count/quality.
 */
export function resolveCalibration(
  artifact: MetaModelArtifact,
  model: MetaModel,
  strategyId: string,
  regime: MetaRegime,
  timeframe: MetaTimeframe,
): ModelCalibration | null {
  const table = artifact.calibration[model] ?? {};
  for (const { key } of levelKeys(strategyId, regime, timeframe)) {
    const cal = table[key];
    if (cal) return cal;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Deterministic inference: decide()
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Produce a calibrated P(profitable trade) for a single decision. PURE.
 *
 * Weighting per present model:
 *   w = baseWeight × regimeMultiplier × sampleMultiplier × driftMultiplier
 *       × stalenessMultiplier × calibrationQualityMultiplier
 *   then correlated models share weight (correlation de-weighting), and models
 *   below the minimum effective sample are down-weighted.
 */
export function decide(input: MetaDecisionInput, artifact: MetaModelArtifact): MetaDecisionResult {
  const reasons: string[] = [];
  const present = input.signals.filter((s) => s.present);

  // ── per-model calibrated probability + provenance ──────────────────────────
  const perModel: Array<{
    sig: ModelSignal;
    cal: ModelCalibration | null;
    calibrated: number;
    weight: number;
    eff: number;
    stale: boolean;
    drifting: boolean;
  }> = [];

  for (const sig of present) {
    const cal = resolveCalibration(artifact, sig.model, input.strategyId, input.regime, input.timeframe);
    const rawCalibrated = cal ? applyCalibrator(cal.calibrator, sig.rawScore) : sig.rawScore;
    // Bayesian shrinkage toward the global prior by the calibrator's sample
    // confidence. A thin (or `raw`-fallback) calibrator cannot emit an extreme
    // probability — small samples are pulled toward the base rate, never trusted
    // at face value. This is the small-sample over-confidence guard.
    const calN = cal?.sampleCount ?? 0;
    const calibrated = shrink(rawCalibrated, calN, artifact.globalPrior, artifact.minEffectiveSample).value;

    const rel = artifact.reliability[sig.model];
    const drift = artifact.drift[sig.model];
    const regPerf = artifact.regimePerformance[sig.model]?.byRegime[input.regime];
    const contribution = artifact.contribution[sig.model];

    // base weight (learned, not equal)
    let w = artifact.baseWeights[sig.model] ?? 0;

    // regime multiplier: models with strong regime ROC-AUC get more weight
    const regimeMult = regPerf ? clamp((regPerf.rocAuc - 0.5) / 0.3, 0.1, 1.3) : 0.6;
    // sample / effective-sample multiplier
    const eff = rel?.effectiveSampleSize ?? 0;
    const sampleMult = clamp(eff / (eff + artifact.minEffectiveSample), 0.1, 1);
    // drift multiplier: drifting models are trusted less
    const driftMult = drift?.drifting ? 0.5 : 1;
    // staleness multiplier
    const stale = drift ? drift.ageMs > artifact.staleMs : false;
    const staleMult = stale ? 0.4 : 1;
    // calibration-quality multiplier
    const calQ = cal?.quality ?? 0.5;
    const calMult = clamp(0.3 + 0.7 * calQ, 0.3, 1);
    // contribution gate: a model proven NOT to add value is heavily discounted
    const contribMult = contribution ? (contribution.addsValue ? 1 : 0.25) : 0.6;

    w = w * regimeMult * sampleMult * driftMult * staleMult * calMult * contribMult;

    perModel.push({ sig, cal, calibrated, weight: Math.max(0, w), eff, stale, drifting: drift?.drifting ?? false });
  }

  // ── correlation de-weighting: correlated models don't get full independent weight ──
  for (let i = 0; i < perModel.length; i++) {
    for (let j = i + 1; j < perModel.length; j++) {
      const a = perModel[i]!.sig.model;
      const b = perModel[j]!.sig.model;
      const corr = Math.abs(artifact.correlation[corrKey(a, b)] ?? 0);
      if (corr > 0.5) {
        // shave the smaller-weight model proportional to redundancy
        const shave = (corr - 0.5) / 0.5; // 0 at .5 → 1 at 1.0
        if (perModel[i]!.weight <= perModel[j]!.weight) perModel[i]!.weight *= 1 - 0.5 * shave;
        else perModel[j]!.weight *= 1 - 0.5 * shave;
      }
    }
  }

  const totalWeight = perModel.reduce((s, m) => s + m.weight, 0);

  // ── ensemble probabilities ──────────────────────────────────────────────────
  let rawProbability: number;
  let calibratedProbability: number;
  if (totalWeight <= 1e-9 || perModel.length === 0) {
    // no usable evidence → fall back to the global prior (NOT to confidence)
    rawProbability = artifact.globalPrior;
    calibratedProbability = artifact.globalPrior;
    reasons.push("no_usable_models:fell_back_to_global_prior");
  } else {
    rawProbability = perModel.reduce((s, m) => s + m.weight * clamp01(m.sig.rawScore), 0) / totalWeight;
    calibratedProbability = perModel.reduce((s, m) => s + m.weight * m.calibrated, 0) / totalWeight;
  }

  // ── model agreement & prediction uncertainty ────────────────────────────────
  const calibratedList = perModel.map((m) => m.calibrated);
  const spread = calibratedList.length > 1 ? stdOf(calibratedList) : 0;
  // agreement: 1 when all models cluster; lower when they scatter
  const modelAgreement = clamp01(1 - 2 * spread);

  // ── probability bounds ──────────────────────────────────────────────────────
  // Effective sample backing the ENSEMBLE = weighted sum of model eff samples.
  const ensembleEff = totalWeight > 0
    ? perModel.reduce((s, m) => s + m.weight * m.eff, 0) / totalWeight
    : 0;
  const wins = Math.round(calibratedProbability * Math.max(1, ensembleEff));
  const [wLo, wHi] = wilsonInterval(wins, Math.max(1, Math.round(ensembleEff)));
  // widen bounds by model spread (disagreement is extra uncertainty)
  const probabilityLowerBound = clamp01(Math.min(wLo, calibratedProbability - spread));
  const probabilityUpperBound = clamp01(Math.max(wHi, calibratedProbability + spread));
  const predictionUncertainty = clamp01(0.5 * (probabilityUpperBound - probabilityLowerBound) + 0.5 * spread);

  // ── dominant calibrator provenance ──────────────────────────────────────────
  const dominant = [...perModel].sort((a, b) => b.weight - a.weight)[0] ?? null;
  const calibrationMethod: CalibrationMethod = dominant?.cal?.method ?? "raw";
  const calibrationSampleCount = dominant?.cal?.sampleCount ?? 0;
  const calibrationQuality = totalWeight > 0
    ? clamp01(perModel.reduce((s, m) => s + m.weight * (m.cal?.quality ?? 0.5), 0) / totalWeight)
    : 0;

  // ── abstention policy ───────────────────────────────────────────────────────
  const abstentionReasons: string[] = [];
  if (totalWeight < artifact.abstention.minTotalWeight) abstentionReasons.push(`insufficient_model_weight:${totalWeight.toFixed(3)}`);
  if (present.length >= 2 && modelAgreement < artifact.abstention.minAgreement) abstentionReasons.push(`severe_disagreement:${modelAgreement.toFixed(2)}`);
  if (predictionUncertainty > artifact.abstention.maxUncertainty) abstentionReasons.push(`high_uncertainty:${predictionUncertainty.toFixed(2)}`);
  const abstained = abstentionReasons.length > 0;

  const attribution: ModelAttribution[] = perModel.map((m) => ({
    model: m.sig.model,
    present: true,
    rawScore: m.sig.rawScore,
    calibratedProbability: m.calibrated,
    calibrationLevel: m.cal?.level ?? "none",
    calibrationMethod: m.cal?.method ?? "raw",
    weight: totalWeight > 0 ? m.weight / totalWeight : 0,
    effectiveSampleSize: m.eff,
    stale: m.stale,
    drifting: m.drifting,
  }));
  // include absent models for transparency
  for (const sig of input.signals) {
    if (sig.present) continue;
    attribution.push({
      model: sig.model, present: false, rawScore: sig.rawScore, calibratedProbability: 0,
      calibrationLevel: "none", calibrationMethod: "raw", weight: 0, effectiveSampleSize: 0, stale: false, drifting: false,
    });
  }

  if (dominant?.stale) reasons.push(`dominant_model_stale:${dominant.sig.model}`);
  if (perModel.some((m) => m.drifting)) reasons.push("drift_detected_downweighted");

  return {
    version: ML_META_DECISION_VERSION,
    confidence: clamp01(input.confidence),   // carried SEPARATELY, untouched
    rawProbability: clamp01(rawProbability),
    calibratedProbability: clamp01(calibratedProbability),
    probabilityLowerBound,
    probabilityUpperBound,
    predictionUncertainty,
    modelAgreement,
    calibrationMethod,
    calibrationSampleCount,
    calibrationQuality,
    abstained,
    abstentionReasons,
    attribution,
    reasons,
  };
}

function corrKey(a: MetaModel, b: MetaModel): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

// (Training / artifact construction lives in ml-meta-training.ts.)
export { corrKey };
export type { Calibrator, CalibrationMethod, CalibrationMetrics, ScoredOutcome };
