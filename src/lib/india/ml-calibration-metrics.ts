/**
 * ML Calibration Metrics & Methods
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure, dependency-free (I/O-free) statistics for turning a model's RAW score
 * into an empirically-calibrated probability, and for measuring how good that
 * calibration is on OUT-OF-SAMPLE data.
 *
 * WHY THIS EXISTS
 * ---------------
 * The forensic audit (`reports/INDIA_SIGNAL_FORENSIC_AUDIT.md`) found that the
 * India ML path returns/uses RAW model outputs (softmax, rank score, heuristic
 * confidence) as if they were P(profitable trade). They are not. This module
 * provides the calibration methods (raw / Platt / isotonic / beta) and the full
 * OOS metric suite (ROC-AUC, PR-AUC, Brier, log loss, ECE, calibration slope &
 * intercept, reliability curve, decile lift) so the meta layer can CHOOSE the
 * calibration method that minimises OOS error — never in-sample.
 *
 * Everything here is deterministic: fitting and evaluation depend only on their
 * inputs, so calibration artifacts are reproducible and auditable.
 */

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Small numeric helpers
// ═══════════════════════════════════════════════════════════════════════════

const EPS = 1e-9;
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampProb = (p: number): number => Math.min(1 - 1e-6, Math.max(1e-6, p));
const mean = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);

/** A labelled OOS observation: a model's raw score in [0,1] and the outcome. */
export interface ScoredOutcome {
  /** Raw model score/probability in [0,1]. */
  score: number;
  /** 1 = profitable (after costs), 0 = not. */
  label: 0 | 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Calibration methods
// ═══════════════════════════════════════════════════════════════════════════

export type CalibrationMethod = "raw" | "platt" | "isotonic" | "beta";

/**
 * A fitted calibrator. `method` names the family; the remaining fields hold the
 * fitted parameters (only those relevant to the method are populated). All are
 * JSON-serialisable so a calibrator can be frozen into an artifact.
 */
export interface Calibrator {
  method: CalibrationMethod;
  /** Platt: sigmoid(a·s + b). */
  platt?: { a: number; b: number };
  /** Isotonic: monotone step curve as (x,y) knots. */
  isotonic?: { x: number[]; y: number[] };
  /** Beta calibration: sigmoid(a·ln(s) − b·ln(1−s) + c). */
  beta?: { a: number; b: number; c: number };
  /** Number of observations the calibrator was fit on. */
  nFit: number;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Apply a fitted calibrator to a raw score → calibrated probability [0,1]. */
export function applyCalibrator(cal: Calibrator, score: number): number {
  const s = clamp01(score);
  switch (cal.method) {
    case "raw":
      return s;
    case "platt": {
      const { a, b } = cal.platt!;
      return clamp01(sigmoid(a * s + b));
    }
    case "isotonic":
      return evalIsotonic(cal.isotonic!, s);
    case "beta": {
      const { a, b, c } = cal.beta!;
      const sc = clampProb(s);
      return clamp01(sigmoid(a * Math.log(sc) - b * Math.log(1 - sc) + c));
    }
  }
}

// ─── Platt scaling (logistic regression on a single score) ────────────────────

/**
 * Fit Platt scaling `P = sigmoid(a·s + b)` by Newton/IRLS-free gradient descent
 * with L2 (deterministic, no external solver). Small, robust, and enough for a
 * 1-D logistic fit.
 */
export function fitPlatt(data: ScoredOutcome[], iters = 400, lr = 0.5): Calibrator {
  let a = 1;
  let b = 0;
  const n = data.length;
  if (n === 0) return { method: "platt", platt: { a: 1, b: 0 }, nFit: 0 };
  for (let it = 0; it < iters; it++) {
    let ga = 0;
    let gb = 0;
    for (const d of data) {
      const s = clamp01(d.score);
      const p = sigmoid(a * s + b);
      const err = p - d.label;
      ga += err * s;
      gb += err;
    }
    a -= (lr * ga) / n;
    b -= (lr * gb) / n;
  }
  return { method: "platt", platt: { a, b }, nFit: n };
}

// ─── Isotonic regression (Pool-Adjacent-Violators) ───────────────────────────

export function fitIsotonicCal(data: ScoredOutcome[]): Calibrator {
  const pts = data.map((d) => ({ x: clamp01(d.score), y: d.label as number }));
  return { method: "isotonic", isotonic: fitIsotonic(pts), nFit: data.length };
}

/** PAVA isotonic fit → compact monotone curve. Deterministic. */
export function fitIsotonic(points: Array<{ x: number; y: number; w?: number }>): { x: number[]; y: number[] } {
  if (points.length === 0) return { x: [0, 1], y: [0, 1] };
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
  const blockY = [...ys];
  const blockW = [...ws];
  const blockStart: number[] = xs.map((_, i) => i);
  let i = 0;
  while (i < blockY.length - 1) {
    if (blockY[i]! > blockY[i + 1]!) {
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

export function evalIsotonic(curve: { x: number[]; y: number[] }, x: number): number {
  const { x: xs, y: ys } = curve;
  if (xs.length === 0) return clamp01(x);
  if (x <= xs[0]!) return clamp01(ys[0]!);
  if (x >= xs[xs.length - 1]!) return clamp01(ys[ys.length - 1]!);
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

// ─── Beta calibration (Kull et al.) ───────────────────────────────────────────

/**
 * Fit beta calibration `P = sigmoid(a·ln s − b·ln(1−s) + c)` via gradient
 * descent. Beta is a flexible parametric family that handles both over- and
 * under-confidence and both sigmoidal shapes — a good middle ground between
 * Platt (too rigid) and isotonic (needs lots of data). Deterministic.
 */
export function fitBeta(data: ScoredOutcome[], iters = 500, lr = 0.3): Calibrator {
  let a = 1;
  let b = 1;
  let c = 0;
  const n = data.length;
  if (n === 0) return { method: "beta", beta: { a: 1, b: 1, c: 0 }, nFit: 0 };
  const rows = data.map((d) => {
    const s = clampProb(clamp01(d.score));
    return { ls: Math.log(s), l1s: Math.log(1 - s), y: d.label as number };
  });
  for (let it = 0; it < iters; it++) {
    let ga = 0;
    let gb = 0;
    let gc = 0;
    for (const r of rows) {
      const z = a * r.ls - b * r.l1s + c;
      const p = sigmoid(z);
      const err = p - r.y;
      ga += err * r.ls;
      gb += err * -r.l1s;
      gc += err;
    }
    a -= (lr * ga) / n;
    b -= (lr * gb) / n;
    c -= (lr * gc) / n;
  }
  return { method: "beta", beta: { a, b, c }, nFit: n };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — OOS metric suite
// ═══════════════════════════════════════════════════════════════════════════

export interface ReliabilityBin {
  lower: number;
  upper: number;
  meanPredicted: number;
  observedRate: number;
  count: number;
}

export interface DecileLift {
  decile: number;       // 1 (lowest) .. 10 (highest)
  meanPredicted: number;
  observedRate: number;
  count: number;
  /** observedRate / baseRate — how much better than average this decile is. */
  lift: number;
}

export interface CalibrationMetrics {
  n: number;
  baseRate: number;
  rocAuc: number;
  prAuc: number;
  brier: number;
  logLoss: number;
  ece: number;
  /** Calibration slope (regress outcome on predicted; ideal = 1). */
  calibrationSlope: number;
  /** Calibration intercept (ideal = 0). */
  calibrationIntercept: number;
  reliability: ReliabilityBin[];
  decileLift: DecileLift[];
}

/** ROC-AUC via the rank-sum (Mann–Whitney U) identity. Deterministic. */
export function rocAuc(preds: number[], labels: number[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < preds.length; i++) (labels[i] === 1 ? pos : neg).push(preds[i]!);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  // rank all predictions (average ranks for ties)
  const all = preds.map((p, i) => ({ p, y: labels[i]! }));
  all.sort((x, y) => x.p - y.p);
  const ranks = new Array(all.length).fill(0);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.p === all[i]!.p) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based average rank
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let k = 0; k < all.length; k++) if (all[k]!.y === 1) rankSumPos += ranks[k]!;
  const nPos = pos.length;
  const nNeg = neg.length;
  const auc = (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  return clamp01(auc);
}

/** PR-AUC via the trapezoidal rule over the precision–recall curve. */
export function prAuc(preds: number[], labels: number[]): number {
  const order = preds.map((p, i) => ({ p, y: labels[i]! })).sort((a, b) => b.p - a.p);
  const totalPos = labels.reduce((s, y) => s + y, 0);
  if (totalPos === 0) return 0;
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let prevPrecision = 1;
  let area = 0;
  for (const o of order) {
    if (o.y === 1) tp++;
    else fp++;
    const recall = tp / totalPos;
    const precision = tp / (tp + fp);
    area += ((recall - prevRecall) * (precision + prevPrecision)) / 2;
    prevRecall = recall;
    prevPrecision = precision;
  }
  return clamp01(area);
}

export function brierScore(preds: number[], labels: number[]): number {
  if (preds.length === 0) return 1;
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i]! - labels[i]!) ** 2;
  return s / preds.length;
}

export function logLoss(preds: number[], labels: number[]): number {
  if (preds.length === 0) return Infinity;
  let s = 0;
  for (let i = 0; i < preds.length; i++) {
    const p = clampProb(preds[i]!);
    s += labels[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / preds.length;
}

/** Expected Calibration Error — count-weighted mean bin gap. */
export function expectedCalibrationError(bins: ReliabilityBin[], n: number): number {
  if (n === 0) return 0;
  return bins.reduce((s, b) => s + (b.count / n) * Math.abs(b.meanPredicted - b.observedRate), 0);
}

/** Reliability curve — equal-width bins. */
export function reliabilityCurve(preds: number[], labels: number[], nBins = 10): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let b = 0; b < nBins; b++) {
    const lo = b / nBins;
    const hi = (b + 1) / nBins;
    const idx: number[] = [];
    for (let i = 0; i < preds.length; i++) {
      const p = preds[i]!;
      if (p >= lo && (p < hi || (b === nBins - 1 && p <= hi))) idx.push(i);
    }
    const cnt = idx.length;
    bins.push({
      lower: lo,
      upper: hi,
      meanPredicted: cnt > 0 ? mean(idx.map((i) => preds[i]!)) : (lo + hi) / 2,
      observedRate: cnt > 0 ? mean(idx.map((i) => labels[i]!)) : 0,
      count: cnt,
    });
  }
  return bins;
}

/**
 * Calibration slope & intercept via a simple logistic regression of the outcome
 * on the predicted log-odds. Ideal calibration ⇒ slope 1, intercept 0.
 * slope < 1 ⇒ over-confident; slope > 1 ⇒ under-confident.
 */
export function calibrationSlopeIntercept(preds: number[], labels: number[]): { slope: number; intercept: number } {
  const n = preds.length;
  if (n < 2) return { slope: 1, intercept: 0 };
  const x = preds.map((p) => Math.log(clampProb(p) / (1 - clampProb(p)))); // logit
  let slope = 1;
  let intercept = 0;
  for (let it = 0; it < 300; it++) {
    let gS = 0;
    let gI = 0;
    for (let i = 0; i < n; i++) {
      const z = slope * x[i]! + intercept;
      const p = sigmoid(z);
      const err = p - labels[i]!;
      gS += err * x[i]!;
      gI += err;
    }
    slope -= (0.1 * gS) / n;
    intercept -= (0.1 * gI) / n;
  }
  return { slope, intercept };
}

/** Lift by predicted-probability decile. */
export function decileLift(preds: number[], labels: number[]): DecileLift[] {
  const n = preds.length;
  const base = n > 0 ? mean(labels) : 0;
  const order = preds.map((p, i) => ({ p, y: labels[i]! })).sort((a, b) => a.p - b.p);
  const out: DecileLift[] = [];
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor((d * n) / 10);
    const hi = Math.floor(((d + 1) * n) / 10);
    const slice = order.slice(lo, hi);
    const cnt = slice.length;
    const obs = cnt > 0 ? mean(slice.map((s) => s.y)) : 0;
    out.push({
      decile: d + 1,
      meanPredicted: cnt > 0 ? mean(slice.map((s) => s.p)) : 0,
      observedRate: obs,
      count: cnt,
      lift: base > EPS ? obs / base : 0,
    });
  }
  return out;
}

/** Compute the full OOS metric suite for a set of (prediction, label) pairs. */
export function computeCalibrationMetrics(preds: number[], labels: number[], nBins = 10): CalibrationMetrics {
  const n = preds.length;
  const rel = reliabilityCurve(preds, labels, nBins);
  const si = calibrationSlopeIntercept(preds, labels);
  return {
    n,
    baseRate: n > 0 ? mean(labels) : 0,
    rocAuc: rocAuc(preds, labels),
    prAuc: prAuc(preds, labels),
    brier: brierScore(preds, labels),
    logLoss: logLoss(preds, labels),
    ece: expectedCalibrationError(rel, n),
    calibrationSlope: si.slope,
    calibrationIntercept: si.intercept,
    reliability: rel,
    decileLift: decileLift(preds, labels),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — OOS method selection
// ═══════════════════════════════════════════════════════════════════════════

export interface MethodSelection {
  chosen: CalibrationMethod;
  calibrator: Calibrator;
  /** OOS metric of each candidate (log loss is the primary selection score). */
  oosByMethod: Record<CalibrationMethod, { logLoss: number; brier: number; ece: number }>;
  /** Whether selection had enough OOS data to be trusted. */
  reliable: boolean;
}

/**
 * Fit every calibration method on TRAIN and select the one with the lowest OOS
 * log loss on the disjoint VALID set (ties broken by Brier then ECE). Selection
 * NEVER uses the fit data to score — that is the anti-leakage guarantee.
 *
 * `raw` is always a candidate (identity), so a model that is already
 * well-calibrated is not "over-corrected".
 */
export function selectCalibrationMethod(
  train: ScoredOutcome[],
  valid: ScoredOutcome[],
  minReliable = 50,
): MethodSelection {
  const candidates: Record<CalibrationMethod, Calibrator> = {
    raw: { method: "raw", nFit: train.length },
    platt: fitPlatt(train),
    isotonic: fitIsotonicCal(train),
    beta: fitBeta(train),
  };
  const validLabels = valid.map((v) => v.label);
  const oosByMethod = {} as MethodSelection["oosByMethod"];
  let chosen: CalibrationMethod = "raw";
  let bestScore = Infinity;
  let bestBrier = Infinity;
  let bestEce = Infinity;
  for (const m of ["raw", "platt", "isotonic", "beta"] as CalibrationMethod[]) {
    const cal = candidates[m];
    const preds = valid.map((v) => applyCalibrator(cal, v.score));
    const ll = logLoss(preds, validLabels);
    const br = brierScore(preds, validLabels);
    const rel = reliabilityCurve(preds, validLabels);
    const ece = expectedCalibrationError(rel, valid.length);
    oosByMethod[m] = { logLoss: ll, brier: br, ece };
    const better = ll < bestScore - 1e-9
      || (Math.abs(ll - bestScore) <= 1e-9 && br < bestBrier - 1e-9)
      || (Math.abs(ll - bestScore) <= 1e-9 && Math.abs(br - bestBrier) <= 1e-9 && ece < bestEce);
    if (better) {
      bestScore = ll;
      bestBrier = br;
      bestEce = ece;
      chosen = m;
    }
  }
  return {
    chosen,
    calibrator: candidates[chosen],
    oosByMethod,
    reliable: valid.length >= minReliable && train.length >= minReliable,
  };
}
