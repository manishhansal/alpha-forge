/**
 * India ML Meta Model Training  (offline; OOS folds + purge + embargo)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds the frozen `MetaModelArtifact` consumed by `decide()`:
 *   • hierarchical calibrators per model (chosen by OOS log loss),
 *   • ModelContribution / ModelReliability / ModelDrift / ModelRegimePerformance,
 *   • correlation matrix + OOS-learned base ensemble weights (NOT equal),
 *   • abstention thresholds.
 *
 * NO calibrator is ever fit and scored on the same rows. Calibration is fit on
 * an early time window and its OOS quality measured on a later, embargoed window
 * (walk-forward). This is the anti-leakage guarantee, tested in
 * `ml-meta-decision.test.ts`.
 *
 * Deterministic given a seed. I/O-free.
 */

import {
  selectCalibrationMethod,
  applyCalibrator,
  computeCalibrationMetrics,
  logLoss as logLossOf,
  rocAuc as rocAucOf,
  type ScoredOutcome,
  clamp01,
} from "./ml-calibration-metrics";
import {
  META_MODELS,
  shrink,
  corrKey,
  ML_META_DECISION_VERSION,
  type MetaModel,
  type MetaRegime,
  type MetaTimeframe,
  type MetaModelArtifact,
  type ModelCalibration,
  type ModelContribution,
  type ModelRegimePerformance,
} from "./ml-meta-decision";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Training observations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One resolved OOS observation. `rawScores` holds each model's raw output for
 * this signal; `label` is the realized cost-adjusted profitable outcome;
 * `returnR` the realized R (for contribution expectancy/PF). `signalMs` /
 * `outcomeMs` give temporal ordering for walk-forward + purge + embargo.
 */
export interface MetaTrainingObs {
  strategyId: string;
  regime: MetaRegime;
  timeframe: MetaTimeframe;
  rawScores: Partial<Record<MetaModel, number>>;
  label: 0 | 1;
  returnR: number;
  signalMs: number;
  outcomeMs: number;
}

export interface MetaTrainConfig {
  /** Fraction of the time-ordered data used to FIT calibrators (rest = OOS eval). */
  trainFraction: number;
  /** Embargo (ms) between the fit window end and the eval window start. */
  embargoMs: number;
  /** Minimum observations to LEARN a calibrator at a hierarchy level (else skip → parent). */
  minCellSample: number;
  /** Bayesian shrinkage pseudo-count. */
  priorStrength: number;
  /** Minimum effective sample before a model's weight is fully trusted. */
  minEffectiveSample: number;
  /** Staleness threshold (ms). */
  staleMs: number;
  /** Drift PSI threshold. */
  driftPsi: number;
}

export const DEFAULT_META_TRAIN_CONFIG: MetaTrainConfig = {
  trainFraction: 0.6,
  embargoMs: 2 * 24 * 60 * 60 * 1000,
  minCellSample: 50,
  priorStrength: 20,
  minEffectiveSample: 30,
  staleMs: 14 * 24 * 60 * 60 * 1000, // 14 days
  driftPsi: 0.2,
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Helpers
// ═══════════════════════════════════════════════════════════════════════════

const meanOf = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = meanOf(a.slice(0, n));
  const mb = meanOf(b.slice(0, n));
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

/** Population Stability Index between two score distributions (10 bins). */
function psi(a: number[], b: number[], bins = 10): number {
  if (a.length === 0 || b.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const pa = (a.filter((x) => x >= lo && x < hi).length + 1) / (a.length + bins);
    const pb = (b.filter((x) => x >= lo && x < hi).length + 1) / (b.length + bins);
    total += (pa - pb) * Math.log(pa / pb);
  }
  return Math.abs(total);
}

function expectancyR(rs: number[]): number {
  return meanOf(rs);
}
function profitFactorR(rs: number[]): number {
  const w = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const l = Math.abs(rs.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  return l === 0 ? (w > 0 ? Infinity : 0) : w / l;
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

/** Split time-ordered obs into (fit, eval) with an embargo gap. */
function walkForwardSplit(obs: MetaTrainingObs[], cfg: MetaTrainConfig): { fit: MetaTrainingObs[]; evalSet: MetaTrainingObs[] } {
  const sorted = [...obs].sort((a, b) => a.signalMs - b.signalMs);
  const cut = Math.floor(sorted.length * cfg.trainFraction);
  const fit = sorted.slice(0, cut);
  const fitEnd = fit.length > 0 ? fit[fit.length - 1]!.outcomeMs : 0;
  // eval starts after the embargo past the fit window's last resolved label
  const evalSet = sorted.slice(cut).filter((o) => o.signalMs >= fitEnd + cfg.embargoMs);
  return { fit, evalSet };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Ranker (and general model) contribution validation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Measure whether a model actually improves outcomes on OOS data: ROC-AUC,
 * log-loss improvement over the base rate, and the realized win rate /
 * expectancy / profit factor / lift of its TOP DECILE by raw score.
 *
 * A model only `addsValue` when it beats chance (ROC-AUC > 0.52), improves log
 * loss over the base rate, AND its top decile has positive expectancy with lift
 * > 1. This is the empirical gate that converts the old arbitrary `mlRankBoost`
 * into a validated contribution (or triggers abstention/down-weighting).
 */
export function measureContribution(model: MetaModel, evalSet: MetaTrainingObs[]): ModelContribution {
  const rows = evalSet.filter((o) => o.rawScores[model] != null);
  const preds = rows.map((o) => clamp01(o.rawScores[model]!));
  const labels = rows.map((o) => o.label);
  const rets = rows.map((o) => o.returnR);
  const n = rows.length;

  const baseRate = n > 0 ? meanOf(labels) : 0;
  const roc = n > 0 ? rocAucOf(preds, labels) : 0.5;
  const baseLogLoss = n > 0 ? logLossOf(labels.map(() => baseRate), labels) : Infinity;
  const modelLogLoss = n > 0 ? logLossOf(preds, labels) : Infinity;
  const logLossImprovement = Number.isFinite(baseLogLoss) && Number.isFinite(modelLogLoss) ? baseLogLoss - modelLogLoss : 0;

  // top decile by raw score
  const order = rows.map((o, i) => ({ p: preds[i]!, y: labels[i]!, r: rets[i]! })).sort((a, b) => b.p - a.p);
  const topN = Math.max(1, Math.floor(n / 10));
  const top = order.slice(0, topN);
  const topWin = meanOf(top.map((t) => t.y));
  const topExp = expectancyR(top.map((t) => t.r));
  const topPf = profitFactorR(top.map((t) => t.r));
  const lift = baseRate > 1e-9 ? topWin / baseRate : 0;

  const addsValue = n >= 30 && roc > 0.52 && logLossImprovement > 0 && topExp > 0 && lift > 1;

  return {
    model,
    rocAuc: roc,
    logLossImprovement,
    topDecileLift: lift,
    topDecileWinRate: topWin,
    topDecileExpectancyR: topExp,
    topDecileProfitFactor: Number.isFinite(topPf) ? topPf : 0,
    addsValue,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Train the meta artifact
// ═══════════════════════════════════════════════════════════════════════════

export interface MetaTrainResult {
  artifact: MetaModelArtifact;
  /** OOS ensemble metrics for reporting. */
  ensembleOOS: ReturnType<typeof computeCalibrationMetrics> | null;
  foldNote: string;
}

export function trainMetaModel(obs: MetaTrainingObs[], cfg: MetaTrainConfig = DEFAULT_META_TRAIN_CONFIG): MetaTrainResult {
  const { fit, evalSet } = walkForwardSplit(obs, cfg);
  const globalPrior = obs.length > 0 ? meanOf(obs.map((o) => o.label)) : 0.5;
  const nowMax = obs.length > 0 ? Math.max(...obs.map((o) => o.outcomeMs)) : 0;

  const calibration = {} as MetaModelArtifact["calibration"];
  const contribution = {} as MetaModelArtifact["contribution"];
  const reliability = {} as MetaModelArtifact["reliability"];
  const drift = {} as MetaModelArtifact["drift"];
  const regimePerformance = {} as MetaModelArtifact["regimePerformance"];
  const baseWeights = {} as Record<MetaModel, number>;

  // For calibration fitting we further split `fit` into inner (fit) + (valid)
  // for method selection, keeping `evalSet` untouched for reliability/quality.
  const innerCut = Math.floor(fit.length * 0.7);
  const innerFit = fit.slice(0, innerCut);
  const innerValid = fit.slice(innerCut);

  for (const model of META_MODELS) {
    calibration[model] = {};

    // ── Hierarchical calibrators ────────────────────────────────────────────
    const levelDefs: Array<{ level: ModelCalibration["level"]; keyer: (o: MetaTrainingObs) => string }> = [
      { level: "strategy+regime+timeframe", keyer: (o) => `${o.strategyId}|${o.regime}|${o.timeframe}` },
      { level: "strategy+regime", keyer: (o) => `${o.strategyId}|${o.regime}` },
      { level: "strategy", keyer: (o) => `${o.strategyId}` },
      { level: "global", keyer: () => "GLOBAL" },
    ];
    for (const { level, keyer } of levelDefs) {
      const groups = groupBy(innerFit.filter((o) => o.rawScores[model] != null), keyer);
      for (const [key, rows] of groups) {
        if (rows.length < cfg.minCellSample && level !== "global") continue;
        const trainScored: ScoredOutcome[] = rows.map((o) => ({ score: clamp01(o.rawScores[model]!), label: o.label }));
        const validRows = innerValid.filter((o) => o.rawScores[model] != null && keyer(o) === key);
        const validScored: ScoredOutcome[] = validRows.map((o) => ({ score: clamp01(o.rawScores[model]!), label: o.label }));
        const sel = validScored.length >= 10
          ? selectCalibrationMethod(trainScored, validScored, cfg.minEffectiveSample)
          : { chosen: "raw" as const, calibrator: { method: "raw" as const, nFit: trainScored.length }, oosByMethod: {} as never, reliable: false };

        // measure OOS quality of the chosen calibrator on the held-out evalSet
        const evalRows = evalSet.filter((o) => o.rawScores[model] != null && keyer(o) === key);
        const evalPreds = evalRows.map((o) => applyCalibrator(sel.calibrator, clamp01(o.rawScores[model]!)));
        const evalLabels = evalRows.map((o) => o.label);
        const metrics = evalRows.length >= 10 ? computeCalibrationMetrics(evalPreds, evalLabels) : null;
        // quality = 1 − (logloss / baseline logloss), clamped
        let quality = 0.5;
        if (metrics && evalRows.length >= 10) {
          const base = meanOf(evalLabels);
          const baseLL = logLossOf(evalLabels.map(() => base), evalLabels);
          const modelLL = metrics.logLoss;
          quality = clamp01(Number.isFinite(baseLL) && baseLL > 1e-9 ? 1 - modelLL / baseLL : 0.5);
        }

        calibration[model]![key] = {
          model, level, key,
          method: sel.calibrator.method,
          calibrator: sel.calibrator,
          sampleCount: rows.length,
          quality,
          metrics,
        };
      }
    }

    // ── Contribution (OOS) ──────────────────────────────────────────────────
    contribution[model] = measureContribution(model, evalSet);

    // ── Reliability (OOS) ───────────────────────────────────────────────────
    const relRows = evalSet.filter((o) => o.rawScores[model] != null);
    const relPreds = relRows.map((o) => {
      // use the global calibrator if present, else raw
      const globalCal = calibration[model]!["GLOBAL"];
      return globalCal ? applyCalibrator(globalCal.calibrator, clamp01(o.rawScores[model]!)) : clamp01(o.rawScores[model]!);
    });
    const relLabels = relRows.map((o) => o.label);
    const relMetrics = relRows.length >= 10 ? computeCalibrationMetrics(relPreds, relLabels) : null;
    // effective sample size: discount for temporal autocorrelation (halve — conservative)
    const effN = Math.floor(relRows.length * 0.5);
    reliability[model] = {
      model,
      brier: relMetrics?.brier ?? 1,
      ece: relMetrics?.ece ?? 1,
      calibrationSlope: relMetrics?.calibrationSlope ?? 0,
      calibrationIntercept: relMetrics?.calibrationIntercept ?? 0,
      sampleCount: relRows.length,
      effectiveSampleSize: effN,
    };

    // ── Drift (early vs recent OOS window) ──────────────────────────────────
    const sortedRel = [...relRows].sort((a, b) => a.signalMs - b.signalMs);
    const half = Math.floor(sortedRel.length / 2);
    const early = sortedRel.slice(0, half);
    const recent = sortedRel.slice(half);
    const earlyScores = early.map((o) => clamp01(o.rawScores[model]!));
    const recentScores = recent.map((o) => clamp01(o.rawScores[model]!));
    const earlyLL = early.length >= 5 ? logLossOf(earlyScores, early.map((o) => o.label)) : 0;
    const recentLL = recent.length >= 5 ? logLossOf(recentScores, recent.map((o) => o.label)) : 0;
    const psiVal = psi(earlyScores, recentScores);
    const ageMs = relRows.length > 0 ? nowMax - Math.max(...relRows.map((o) => o.outcomeMs)) : Infinity;
    drift[model] = {
      model,
      logLossDelta: Number.isFinite(earlyLL) && Number.isFinite(recentLL) ? Math.abs(recentLL - earlyLL) : 0,
      psi: psiVal,
      drifting: psiVal > cfg.driftPsi,
      ageMs,
      stale: ageMs > cfg.staleMs,
    };

    // ── Regime performance ──────────────────────────────────────────────────
    const byRegime: ModelRegimePerformance["byRegime"] = {};
    const regGroups = groupBy(relRows, (o) => o.regime);
    for (const [reg, rows] of regGroups) {
      const p = rows.map((o) => clamp01(o.rawScores[model]!));
      const y = rows.map((o) => o.label);
      byRegime[reg as MetaRegime] = {
        rocAuc: rows.length >= 10 ? rocAucOf(p, y) : 0.5,
        logLoss: rows.length >= 5 ? logLossOf(p, y) : 1,
        n: rows.length,
      };
    }
    regimePerformance[model] = { model, byRegime };
  }

  // ── Correlation matrix (on eval raw scores) ─────────────────────────────────
  const correlation: Record<string, number> = {};
  const modelScoreVectors: Partial<Record<MetaModel, number[]>> = {};
  for (const model of META_MODELS) {
    modelScoreVectors[model] = evalSet.map((o) => (o.rawScores[model] != null ? clamp01(o.rawScores[model]!) : NaN));
  }
  for (let i = 0; i < META_MODELS.length; i++) {
    for (let j = i + 1; j < META_MODELS.length; j++) {
      const a = META_MODELS[i]!;
      const b = META_MODELS[j]!;
      // align on rows where BOTH are present
      const av: number[] = [];
      const bv: number[] = [];
      const va = modelScoreVectors[a]!;
      const vb = modelScoreVectors[b]!;
      for (let k = 0; k < va.length; k++) {
        if (!Number.isNaN(va[k]!) && !Number.isNaN(vb[k]!)) { av.push(va[k]!); bv.push(vb[k]!); }
      }
      correlation[corrKey(a, b)] = av.length >= 10 ? pearson(av, bv) : 0;
    }
  }

  // ── OOS-learned base weights (NOT equal) ────────────────────────────────────
  // Weight ∝ each model's OOS ROC-AUC edge over chance × log-loss improvement,
  // shrunk toward a uniform prior by sample size, zeroed for no-value models.
  const rawW: Record<MetaModel, number> = {} as Record<MetaModel, number>;
  let wSum = 0;
  for (const model of META_MODELS) {
    const c = contribution[model];
    const rel = reliability[model];
    const edge = Math.max(0, c.rocAuc - 0.5); // 0..0.5
    const llImp = Math.max(0, c.logLossImprovement);
    const rawSkill = edge * 2 + llImp; // combine
    const shr = shrink(rawSkill, rel.sampleCount, 0.1, cfg.priorStrength); // shrink toward small prior
    const w = c.addsValue ? shr.value : shr.value * 0.25;
    rawW[model] = Math.max(0, w);
    wSum += rawW[model];
  }
  for (const model of META_MODELS) {
    baseWeights[model] = wSum > 1e-9 ? rawW[model] / wSum : 1 / META_MODELS.length;
  }

  const artifact: MetaModelArtifact = {
    version: ML_META_DECISION_VERSION,
    trainedAtMs: nowMax || null,
    calibration,
    contribution,
    reliability,
    drift,
    regimePerformance,
    baseWeights,
    correlation,
    globalPrior,
    minEffectiveSample: cfg.minEffectiveSample,
    staleMs: cfg.staleMs,
    abstention: {
      minTotalWeight: 0.05,
      minAgreement: 0.35,
      maxUncertainty: 0.6,
    },
  };

  // ── Ensemble OOS metrics for the report ─────────────────────────────────────
  let ensembleOOS: MetaTrainResult["ensembleOOS"] = null;
  if (evalSet.length >= 20) {
    const preds: number[] = [];
    const labels: number[] = [];
    for (const o of evalSet) {
      let num = 0;
      let den = 0;
      for (const model of META_MODELS) {
        if (o.rawScores[model] == null) continue;
        const cal = calibration[model]!["GLOBAL"];
        const p = cal ? applyCalibrator(cal.calibrator, clamp01(o.rawScores[model]!)) : clamp01(o.rawScores[model]!);
        const w = baseWeights[model];
        num += w * p;
        den += w;
      }
      if (den > 0) { preds.push(num / den); labels.push(o.label); }
    }
    if (preds.length >= 20) ensembleOOS = computeCalibrationMetrics(preds, labels);
  }

  return { artifact, ensembleOOS, foldNote: `fit=${fit.length} eval=${evalSet.length} (embargo ${cfg.embargoMs}ms)` };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Default (untrained) artifact — safe, abstains toward global prior
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A safe default used before any OOS training. Every model uses the identity
 * (`raw`) calibrator, no contribution proven, uniform-but-low base weights, and
 * the global prior 0.5. This CANNOT masquerade as calibrated — `decide()` will
 * report `calibrationMethod: "raw"` and low `calibrationQuality`.
 */
export function defaultMetaArtifact(): MetaModelArtifact {
  const calibration = {} as MetaModelArtifact["calibration"];
  const contribution = {} as MetaModelArtifact["contribution"];
  const reliability = {} as MetaModelArtifact["reliability"];
  const drift = {} as MetaModelArtifact["drift"];
  const regimePerformance = {} as MetaModelArtifact["regimePerformance"];
  const baseWeights = {} as Record<MetaModel, number>;
  for (const model of META_MODELS) {
    calibration[model] = { GLOBAL: { model, level: "global", key: "GLOBAL", method: "raw", calibrator: { method: "raw", nFit: 0 }, sampleCount: 0, quality: 0.5, metrics: null } };
    contribution[model] = { model, rocAuc: 0.5, logLossImprovement: 0, topDecileLift: 1, topDecileWinRate: 0.5, topDecileExpectancyR: 0, topDecileProfitFactor: 0, addsValue: false };
    reliability[model] = { model, brier: 0.25, ece: 0.1, calibrationSlope: 1, calibrationIntercept: 0, sampleCount: 0, effectiveSampleSize: 0 };
    drift[model] = { model, logLossDelta: 0, psi: 0, drifting: false, ageMs: 0, stale: false };
    regimePerformance[model] = { model, byRegime: {} };
    baseWeights[model] = 1 / META_MODELS.length;
  }
  return {
    version: ML_META_DECISION_VERSION,
    trainedAtMs: null,
    calibration, contribution, reliability, drift, regimePerformance, baseWeights,
    correlation: {},
    globalPrior: 0.5,
    minEffectiveSample: 30,
    staleMs: 14 * 24 * 60 * 60 * 1000,
    abstention: { minTotalWeight: 0.05, minAgreement: 0.35, maxUncertainty: 0.6 },
  };
}
