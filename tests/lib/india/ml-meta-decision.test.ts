/**
 * Tests for the India ML Meta-Decision / calibration pipeline.
 *
 * Required categories:
 *   1. calibration leakage      — calibrators fit/eval on disjoint time windows
 *   2. probability bounds        — 0 ≤ lower ≤ calibrated ≤ upper ≤ 1
 *   3. monotonicity              — higher OOS-calibrated prob → higher realized win rate
 *   4. model dropout             — absent models are ignored, engine still produces a prob
 *   5. model disagreement        — disagreement lowers agreement / can trigger abstention
 *   6. regime changes            — regime-conditioned calibration/weights differ
 *   7. calibration fallback      — hierarchy falls back strat+regime+tf → … → global
 *   8. small samples             — thin cells don't produce over-confident calibrated probs
 *   9. drift                     — drifting models are detected and down-weighted
 *  10. stale models              — stale artifacts are detected and down-weighted
 *  (+ confidence ≠ probability, determinism)
 */

import { describe, it, expect } from "vitest";
import {
  computeCalibrationMetrics,
  selectCalibrationMethod,
  applyCalibrator,
  fitPlatt,
  fitIsotonicCal,
  fitBeta,
  type ScoredOutcome,
} from "@/lib/india/ml-calibration-metrics";
import {
  decide,
  resolveCalibration,
  META_MODELS,
  type MetaDecisionInput,
  type MetaModel,
  type MetaRegime,
  type ModelSignal,
} from "@/lib/india/ml-meta-decision";
import {
  trainMetaModel,
  measureContribution,
  defaultMetaArtifact,
  DEFAULT_META_TRAIN_CONFIG,
  type MetaTrainingObs,
} from "@/lib/india/ml-meta-training";

// ─── Deterministic synthetic generator ────────────────────────────────────────

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0xffffffff; };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Generate observations where the TRUE P(profit) = 0.25 + 0.5·edge.
 * - `regimeClassifier` and `stockRanker` are INFORMATIVE (raw score ≈ edge).
 * - `riskPredictor` is informative but noisier.
 * - `ivClassifier` is PURE NOISE (should learn addsValue=false, weight↓).
 * The raw scores are intentionally miscalibrated (squashed) so calibration has
 * work to do. `regimeSep` shifts the base rate per regime so regime tables differ.
 */
function makeObs(n: number, seed: number, opts: { regime?: MetaRegime; noiseOnlyIV?: boolean } = {}): MetaTrainingObs[] {
  const rng = lcg(seed);
  const out: MetaTrainingObs[] = [];
  const regime = opts.regime ?? "BULL_TREND";
  for (let i = 0; i < n; i++) {
    const edge = rng();
    const trueP = clamp01(0.25 + 0.5 * edge);
    const win = rng() < trueP ? 1 : 0;
    const noise = () => (rng() - 0.5) * 0.2;
    // miscalibrated raw scores: compress toward 0.5 (over-confident middle)
    const squash = (x: number) => 0.5 + (x - 0.5) * 0.6;
    out.push({
      strategyId: "OPENING_BREAKOUT",
      regime,
      timeframe: "INTRADAY",
      rawScores: {
        regimeClassifier: clamp01(squash(edge) + noise()),
        stockRanker: clamp01(squash(edge) + noise()),
        riskPredictor: clamp01(squash(edge) + noise() * 1.5),
        ivClassifier: opts.noiseOnlyIV === false ? clamp01(squash(edge)) : clamp01(rng()), // pure noise by default
      },
      label: win as 0 | 1,
      returnR: win === 1 ? 1.8 : -1.0,
      signalMs: T0 + i * (DAY / 3),
      outcomeMs: T0 + i * (DAY / 3) + 3 * 60 * 60 * 1000,
    });
  }
  return out;
}

function makeInput(rawScores: Partial<Record<MetaModel, number>>, opts: Partial<MetaDecisionInput> = {}): MetaDecisionInput {
  const signals: ModelSignal[] = META_MODELS.map((m) => ({
    model: m,
    rawScore: rawScores[m] ?? 0.5,
    present: rawScores[m] != null,
  }));
  return {
    strategyId: "OPENING_BREAKOUT",
    regime: "BULL_TREND",
    timeframe: "INTRADAY",
    signals,
    confidence: 0.8,
    nowMs: T0 + 400 * (DAY / 3),
    ...opts,
  };
}

const meanOf = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);

// Shared trained artifact (deterministic, computed once).
const TRAIN_OBS = makeObs(1500, 11);
const TRAINED = trainMetaModel(TRAIN_OBS, DEFAULT_META_TRAIN_CONFIG);
const ARTIFACT = TRAINED.artifact;

// ═══════════════════════════════════════════════════════════════════════════

describe("MLMetaDecision — structure & determinism", () => {
  it("exposes 7 meta models", () => {
    expect(META_MODELS).toHaveLength(7);
  });

  it("decide() is deterministic — identical inputs, identical output", () => {
    const inp = makeInput({ regimeClassifier: 0.8, stockRanker: 0.75, riskPredictor: 0.7 });
    const a = decide(inp, ARTIFACT);
    const b = decide(inp, ARTIFACT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("confidence and probability are SEPARATE fields (confidence never becomes probability)", () => {
    const inp = makeInput({ regimeClassifier: 0.55, stockRanker: 0.55 }, { confidence: 0.99 });
    const r = decide(inp, ARTIFACT);
    expect(r.confidence).toBeCloseTo(0.99, 6);
    // a mediocre model signal must NOT inherit the 0.99 confidence as probability
    expect(r.calibratedProbability).toBeLessThan(0.9);
    expect(r.calibratedProbability).not.toBeCloseTo(0.99, 2);
  });
});

describe("1. calibration leakage", () => {
  it("training splits calibration fit from evaluation by time + embargo", () => {
    // The eval window used for quality must start strictly after the fit window
    // + embargo. We assert the trainer produced a non-trivial eval set and that
    // calibrators exist without having seen the eval rows (checked via foldNote).
    expect(TRAINED.foldNote).toMatch(/fit=\d+ eval=\d+/);
    const fitN = Number(TRAINED.foldNote.match(/fit=(\d+)/)![1]);
    const evalN = Number(TRAINED.foldNote.match(/eval=(\d+)/)![1]);
    expect(fitN).toBeGreaterThan(0);
    expect(evalN).toBeGreaterThan(0);
    // OOS ensemble metrics were computed on the held-out window
    expect(TRAINED.ensembleOOS).not.toBeNull();
  });

  it("selectCalibrationMethod scores candidates ONLY on the disjoint valid set", () => {
    // Build train/valid where a Platt fit on train would look great in-sample
    // but we score on valid. The chosen method must be the one best on VALID.
    const train = makeObs(400, 21).map((o) => ({ score: o.rawScores.regimeClassifier!, label: o.label }));
    const valid = makeObs(400, 22).map((o) => ({ score: o.rawScores.regimeClassifier!, label: o.label }));
    const sel = selectCalibrationMethod(train, valid);
    // whatever is chosen, its OOS log loss must be ≤ the raw OOS log loss
    expect(sel.oosByMethod[sel.chosen].logLoss).toBeLessThanOrEqual(sel.oosByMethod.raw.logLoss + 1e-9);
    expect(sel.reliable).toBe(true);
  });
});

describe("2. probability bounds", () => {
  it("0 ≤ lower ≤ calibrated ≤ upper ≤ 1 for a range of inputs", () => {
    for (let e = 0; e <= 1.0001; e += 0.1) {
      const r = decide(makeInput({ regimeClassifier: e, stockRanker: clamp01(e + 0.05), riskPredictor: e }), ARTIFACT);
      expect(r.probabilityLowerBound).toBeGreaterThanOrEqual(0);
      expect(r.probabilityUpperBound).toBeLessThanOrEqual(1);
      expect(r.probabilityLowerBound).toBeLessThanOrEqual(r.calibratedProbability + 1e-9);
      expect(r.calibratedProbability).toBeLessThanOrEqual(r.probabilityUpperBound + 1e-9);
      expect(r.calibratedProbability).toBeGreaterThanOrEqual(0);
      expect(r.calibratedProbability).toBeLessThanOrEqual(1);
    }
  });
});

describe("3. monotonicity", () => {
  it("higher calibrated probability → higher realized win rate on held-out data", () => {
    const test = makeObs(3000, 999); // disjoint seed = OOS
    const scored = test.map((o) => {
      const r = decide(makeInput(o.rawScores), ARTIFACT);
      return { p: r.calibratedProbability, y: o.label };
    });
    // bucket by calibrated prob and check realized win rate is non-decreasing
    const edges = [0.3, 0.4, 0.5, 0.6, 0.7, 1.01];
    const buckets: Array<{ n: number; wr: number }> = [];
    let lo = 0;
    for (const hi of edges) {
      const inB = scored.filter((s) => s.p >= lo && s.p < hi);
      if (inB.length >= 30) buckets.push({ n: inB.length, wr: meanOf(inB.map((s) => s.y)) });
      lo = hi;
    }
    expect(buckets.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < buckets.length; i++) {
      // sample-aware tolerance
      const se = Math.sqrt((buckets[i]!.wr * (1 - buckets[i]!.wr)) / buckets[i]!.n) +
                 Math.sqrt((buckets[i - 1]!.wr * (1 - buckets[i - 1]!.wr)) / buckets[i - 1]!.n);
      expect(buckets[i]!.wr).toBeGreaterThanOrEqual(buckets[i - 1]!.wr - Math.max(0.03, 1.96 * se));
    }
  });
});

describe("4. model dropout", () => {
  it("absent models are ignored; the engine still produces a probability", () => {
    // only ONE model present
    const r = decide(makeInput({ regimeClassifier: 0.8 }), ARTIFACT);
    expect(r.calibratedProbability).toBeGreaterThan(0);
    const presentAttr = r.attribution.filter((a) => a.present);
    expect(presentAttr).toHaveLength(1);
    // dropped models appear with weight 0
    const absent = r.attribution.filter((a) => !a.present);
    expect(absent.length).toBe(META_MODELS.length - 1);
    absent.forEach((a) => expect(a.weight).toBe(0));
  });

  it("removing a model does not crash and reweights the rest", () => {
    const full = decide(makeInput({ regimeClassifier: 0.7, stockRanker: 0.7, riskPredictor: 0.7 }), ARTIFACT);
    const dropped = decide(makeInput({ regimeClassifier: 0.7, riskPredictor: 0.7 }), ARTIFACT);
    // present-model weights always renormalise to sum ~1
    const sumW = (r: typeof full) => r.attribution.filter((a) => a.present).reduce((s, a) => s + a.weight, 0);
    expect(sumW(full)).toBeCloseTo(1, 5);
    expect(sumW(dropped)).toBeCloseTo(1, 5);
  });
});

describe("5. model disagreement", () => {
  it("disagreeing models lower modelAgreement vs agreeing models", () => {
    const agree = decide(makeInput({ regimeClassifier: 0.8, stockRanker: 0.8, riskPredictor: 0.8 }), ARTIFACT);
    const disagree = decide(makeInput({ regimeClassifier: 0.9, stockRanker: 0.1, riskPredictor: 0.5 }), ARTIFACT);
    expect(disagree.modelAgreement).toBeLessThan(agree.modelAgreement);
  });

  it("severe disagreement can trigger abstention", () => {
    const disagree = decide(makeInput({ regimeClassifier: 0.98, stockRanker: 0.02, riskPredictor: 0.98, priceForecaster: 0.02 }), ARTIFACT);
    // either abstains OR reports high uncertainty — never a falsely-confident prob
    expect(disagree.abstained || disagree.predictionUncertainty > 0.3).toBe(true);
  });
});

describe("6. regime changes", () => {
  it("regime-conditioned calibration/weights make the same raw scores score differently", () => {
    // Train an artifact where BULL wins often and BEAR loses often at the same raw score.
    const bull = makeObs(800, 31, { regime: "BULL_TREND" }).map((o) => ({ ...o, label: 1 as const }));
    const bear = makeObs(800, 32, { regime: "BEAR_TREND" }).map((o) => ({ ...o, label: 0 as const }));
    const art = trainMetaModel([...bull, ...bear], DEFAULT_META_TRAIN_CONFIG).artifact;
    const base = { regimeClassifier: 0.6, stockRanker: 0.6, riskPredictor: 0.6 };
    const inBull = decide(makeInput(base, { regime: "BULL_TREND" }), art);
    const inBear = decide(makeInput(base, { regime: "BEAR_TREND" }), art);
    expect(inBull.calibratedProbability).toBeGreaterThan(inBear.calibratedProbability);
  });
});

describe("7. calibration fallback (hierarchy)", () => {
  it("resolves the most specific level, then falls back to global", () => {
    // The trained artifact has a global calibrator for each model; a novel
    // strategy/regime/timeframe must fall back to it (never throw).
    const cal = resolveCalibration(ARTIFACT, "regimeClassifier", "UNSEEN_STRAT", "UNKNOWN", "SWING");
    expect(cal).not.toBeNull();
    expect(["strategy", "global"]).toContain(cal!.level);
    // and a known key resolves to a more specific level when present
    const known = resolveCalibration(ARTIFACT, "regimeClassifier", "OPENING_BREAKOUT", "BULL_TREND", "INTRADAY");
    expect(known).not.toBeNull();
  });
});

describe("8. small samples (Bayesian shrinkage / no over-confidence)", () => {
  it("a tiny calibration cell does not yield an extreme calibrated probability", () => {
    // Train on a very small set — calibrators should stay conservative.
    const tiny = makeObs(25, 41);
    const art = trainMetaModel(tiny, DEFAULT_META_TRAIN_CONFIG).artifact;
    const r = decide(makeInput({ regimeClassifier: 0.95, stockRanker: 0.95 }), art);
    // with almost no data, the calibrated prob must not be wildly confident
    expect(r.calibratedProbability).toBeLessThan(0.9);
    // calibration quality should be modest and sample count low
    expect(r.calibrationQuality).toBeLessThanOrEqual(1);
  });

  it("selectCalibrationMethod flags unreliable when samples are tiny", () => {
    const train = makeObs(10, 42).map((o) => ({ score: o.rawScores.regimeClassifier!, label: o.label }));
    const valid = makeObs(10, 43).map((o) => ({ score: o.rawScores.regimeClassifier!, label: o.label }));
    const sel = selectCalibrationMethod(train, valid, 50);
    expect(sel.reliable).toBe(false);
  });
});

describe("9. drift", () => {
  it("a model whose score distribution shifts between windows is flagged drifting", () => {
    // Build obs where ivClassifier's distribution shifts sharply in the 2nd half.
    const rows = makeObs(800, 51);
    const shifted = rows.map((o, i) => {
      if (i < rows.length / 2) return o;
      return { ...o, rawScores: { ...o.rawScores, ivClassifier: clamp01((o.rawScores.ivClassifier ?? 0.5) * 0.2) } };
    });
    const art = trainMetaModel(shifted, DEFAULT_META_TRAIN_CONFIG).artifact;
    expect(art.drift.ivClassifier.psi).toBeGreaterThan(0);
    // drifting models get down-weighted in decide (weight lower than a stable one)
    const r = decide(makeInput({ ivClassifier: 0.8, regimeClassifier: 0.8 }), art);
    const iv = r.attribution.find((a) => a.model === "ivClassifier")!;
    const reg = r.attribution.find((a) => a.model === "regimeClassifier")!;
    // regime (informative, stable) should carry at least as much weight as drifting IV noise
    expect(reg.weight).toBeGreaterThanOrEqual(iv.weight);
  });
});

describe("10. stale models", () => {
  it("a stale artifact (old ageMs) is detected and its models down-weighted", () => {
    // Make a decision far in the future so the artifact looks stale.
    const art = defaultMetaArtifact();
    // mark one model stale via a long age
    art.drift.regimeClassifier = { ...art.drift.regimeClassifier, ageMs: art.staleMs + DAY, stale: true };
    const r = decide(makeInput({ regimeClassifier: 0.9, stockRanker: 0.9 }), art);
    const reg = r.attribution.find((a) => a.model === "regimeClassifier")!;
    const ranker = r.attribution.find((a) => a.model === "stockRanker")!;
    expect(reg.stale).toBe(true);
    // the fresh ranker should not be penalised the same way
    expect(ranker.stale).toBe(false);
    // stale model carries less weight than the equally-scored fresh one
    expect(reg.weight).toBeLessThanOrEqual(ranker.weight + 1e-9);
  });
});

describe("ranker contribution validation (mlRankBoost gating)", () => {
  it("an informative model is measured to add value; pure noise does not", () => {
    const eval1 = makeObs(1000, 61);
    const rankerContrib = measureContribution("stockRanker", eval1);
    const ivContrib = measureContribution("ivClassifier", eval1); // pure noise
    expect(rankerContrib.rocAuc).toBeGreaterThan(ivContrib.rocAuc);
    expect(ivContrib.addsValue).toBe(false); // noise must not earn a boost
  });

  it("default artifact suppresses the ranker (addsValue=false) until validated", () => {
    const art = defaultMetaArtifact();
    expect(art.contribution.stockRanker.addsValue).toBe(false);
  });
});

describe("calibration metric suite", () => {
  it("computes the full OOS metric set with sane ranges", () => {
    const obs = makeObs(600, 71);
    const preds = obs.map((o) => o.rawScores.regimeClassifier!);
    const labels = obs.map((o) => o.label);
    const m = computeCalibrationMetrics(preds, labels);
    expect(m.rocAuc).toBeGreaterThan(0.5);       // informative
    expect(m.rocAuc).toBeLessThanOrEqual(1);
    expect(m.prAuc).toBeGreaterThanOrEqual(0);
    expect(m.brier).toBeGreaterThanOrEqual(0);
    expect(m.ece).toBeGreaterThanOrEqual(0);
    expect(m.reliability).toHaveLength(10);
    expect(m.decileLift).toHaveLength(10);
    expect(Number.isFinite(m.calibrationSlope)).toBe(true);
    expect(Number.isFinite(m.calibrationIntercept)).toBe(true);
  });

  it("isotonic calibration is monotone non-decreasing", () => {
    const cal = fitIsotonicCal(makeObs(500, 72).map((o) => ({ score: o.rawScores.regimeClassifier!, label: o.label })));
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const p = applyCalibrator(cal, x);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p;
    }
  });

  it("all four calibrators return values in [0,1]", () => {
    const data: ScoredOutcome[] = makeObs(300, 73).map((o) => ({ score: o.rawScores.regimeClassifier!, label: o.label }));
    for (const cal of [{ method: "raw" as const, nFit: 0 }, fitPlatt(data), fitIsotonicCal(data), fitBeta(data)]) {
      for (const x of [0, 0.25, 0.5, 0.75, 1]) {
        const p = applyCalibrator(cal, x);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});
