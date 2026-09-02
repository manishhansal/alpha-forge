/**
 * Signal Quality Vector Engine — Phases 19–23
 *
 * Computes the multi-dimensional SignalQualityVector, Expected Value,
 * signal ranking grade, and abstention decisions.
 *
 * Key principles:
 *   1. Signals are represented as vectors, NOT single confidence scores.
 *   2. Expected Value uses calibrated probabilities — not raw confidence.
 *   3. Abstention (NO_TRADE) is a valid and important outcome.
 *   4. Ranking uses EV + quality + regime fit + liquidity — NOT just technical score.
 */

import type {
  SignalQualityVector,
  SignalQualityReason,
  ExpectedValueEstimate,
  SignalRankGrade,
  AbstentionReason,
  SignalDirection,
  MarketRegimeLabel,
} from "./types";
import type { MultiLayerEvaluation } from "./multi-layer-engine";
import type { MarketContextSnapshot } from "./market-context-engine";
import type { LiquidityResult } from "./multi-layer-engine";

// ─── Time-of-Day Signal Model ─────────────────────────────────────────────────

/**
 * NSE intraday session buckets with empirical performance priors.
 * These are baseline priors — actual performance per strategy overrides.
 */
const TOD_BUCKETS = [
  { label: "09:15–09:20", startMin: 0,   endMin: 5,   priorScore: 0.65, recommendation: "CAUTION" as const },
  { label: "09:20–09:30", startMin: 5,   endMin: 15,  priorScore: 0.75, recommendation: "TRADE" as const },
  { label: "09:30–10:00", startMin: 15,  endMin: 45,  priorScore: 0.80, recommendation: "TRADE" as const },
  { label: "10:00–11:00", startMin: 45,  endMin: 105, priorScore: 0.75, recommendation: "TRADE" as const },
  { label: "11:00–12:00", startMin: 105, endMin: 165, priorScore: 0.65, recommendation: "CAUTION" as const },
  { label: "12:00–13:00", startMin: 165, endMin: 225, priorScore: 0.55, recommendation: "CAUTION" as const },
  { label: "13:00–14:00", startMin: 225, endMin: 285, priorScore: 0.60, recommendation: "CAUTION" as const },
  { label: "14:00–15:00", startMin: 285, endMin: 345, priorScore: 0.70, recommendation: "TRADE" as const },
  { label: "15:00–15:20", startMin: 345, endMin: 365, priorScore: 0.55, recommendation: "CAUTION" as const },
  { label: "15:20–15:30", startMin: 365, endMin: 375, priorScore: 0.40, recommendation: "AVOID" as const },
] as const;

export interface TODBucketResult {
  label: string;
  recommendation: "TRADE" | "CAUTION" | "AVOID";
  priorScore: number;
  minutesFromOpen: number;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const NSE_OPEN_MINUTES = 9 * 60 + 15;

export function getTODBucket(nowMs: number): TODBucketResult {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const istMins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const minutesFromOpen = istMins - NSE_OPEN_MINUTES;

  const bucket =
    TOD_BUCKETS.find(
      (b) => minutesFromOpen >= b.startMin && minutesFromOpen < b.endMin,
    ) ?? TOD_BUCKETS[TOD_BUCKETS.length - 1];

  return {
    label: bucket.label,
    recommendation: bucket.recommendation,
    priorScore: bucket.priorScore,
    minutesFromOpen,
  };
}

// ─── Expected Value Engine ────────────────────────────────────────────────────

/** Base transaction cost for NSE F&O in basis points (STT + brokerage + SEBI) */
const BASE_COST_BPS = 5;

/**
 * NSE F&O typical lot sizes and contract values for slippage estimation.
 * Slippage scales with inverse liquidity.
 */
const BASE_SLIPPAGE_PCT = 0.05; // 5 bps baseline slippage for liquid F&O

/**
 * Calibrate raw confidence to win probability using a logistic adjustment.
 * Raw strategy confidence [0, 1] is NOT the same as win probability.
 * Typical calibration bias: models tend to be overconfident (predict 0.7 when true rate is 0.55).
 */
function calibrateWinProbability(
  rawConfidence: number,
  strategyId: string,
): number {
  // Default calibration offset (logistic shrinkage toward 0.5)
  // Replace with per-strategy calibration curves once OOS data is available
  const shrinkage = 0.65; // 35% shrinkage toward base rate 0.5
  const calibrated = rawConfidence * shrinkage + 0.5 * (1 - shrinkage);
  return Math.max(0.30, Math.min(0.80, calibrated));
}

/**
 * Compute the Expected Value for a signal.
 *
 * EV = P(win) × E[win%] - P(loss) × E[loss%] - costs
 *
 * Uses calibrated probabilities, not raw confidence scores.
 */
export function computeExpectedValue(
  rawConfidence: number,
  strategyId: string,
  entry: number,
  stopLoss: number,
  target: number,
  spreadPct: number | null,
  slippagePct?: number,
): ExpectedValueEstimate {
  const pWin = calibrateWinProbability(rawConfidence, strategyId);
  const pLoss = 1 - pWin;

  const riskPct = Math.abs(entry - stopLoss) / entry * 100;
  const rewardPct = Math.abs(target - entry) / entry * 100;

  // Expected win = fraction of reward typically captured (not always full target)
  // Conservative: assume 85% of stated target is captured on average
  const expectedWinPct = rewardPct * 0.85;
  const expectedLossPct = riskPct; // stop is always honored

  const costPct = (BASE_COST_BPS / 10000) * 100 * 2; // round-trip
  const slipPct = slippagePct ?? (spreadPct !== null ? spreadPct / 2 : BASE_SLIPPAGE_PCT);
  const totalCostPct = costPct + slipPct;

  const ev = pWin * expectedWinPct - pLoss * expectedLossPct - totalCostPct;

  // Risk-adjusted EV: Kelly-fraction-like scaling
  const stdDevEv = Math.sqrt(pWin * pLoss) * (expectedWinPct + expectedLossPct);
  const riskAdjustedEv = stdDevEv > 0 ? ev / stdDevEv : 0;

  return {
    pWin,
    pLoss,
    expectedWinPct,
    expectedLossPct,
    estimatedCostPct: costPct,
    estimatedSlippagePct: slipPct,
    ev,
    riskAdjustedEv,
  };
}

// ─── Signal Quality Vector Builder ───────────────────────────────────────────

export interface QualityVectorInput {
  strategyId: string;
  direction: SignalDirection;
  /** Market context score from IndiaMarketContextEngine [-1, 1] */
  marketContextScore: number;
  /** ML probability from FastAPI [0, 1] — 0.5 if unavailable */
  mlProbability: number;
  /** Regime fit: does current regime support this strategy? */
  regimeFit: "SUPPORTED" | "NEUTRAL" | "ADVERSE";
  /** MTF alignment score [-1, 1] */
  mtfAlignmentScore: number;
  /** Market structure score [0, 1] */
  structureScore: number;
  /** Momentum quality score [0, 1] */
  momentumScore: number;
  /** Volume score [0, 1] */
  volumeScore: number;
  /** Volatility fit score [0, 1] */
  volatilityFitScore: number;
  /** Liquidity score [0, 1] */
  liquidityScore: number;
  /** Derivatives confirmation score [-1, 1] */
  derivativesScore: number;
  /** Relative strength vs NIFTY [-1, 1] */
  relativeStrengthScore: number;
  /** Expected value estimate */
  ev: ExpectedValueEstimate;
  /** Liquidity details */
  liquidity: LiquidityResult;
  /** Data quality [0, 1] */
  dataQualityScore: number;
  /** Time-of-day bucket */
  tod: TODBucketResult;
  /** Raw confidence from strategy [0, 1] */
  rawConfidence: number;
}

/**
 * Build a complete SignalQualityVector from individual layer scores.
 * Each component is separately inspectable for attribution.
 */
export function buildSignalQualityVector(input: QualityVectorInput): SignalQualityVector {
  const reasons: SignalQualityReason[] = [];
  const isLong = input.direction === "LONG";
  const dir: "BULLISH" | "BEARISH" | "NEUTRAL" =
    isLong ? "BULLISH" : input.direction === "SHORT" ? "BEARISH" : "NEUTRAL";

  const toDirectionalScore = (raw: number, flip = false) =>
    flip ? -raw : raw;

  // Market context: directional alignment
  const ctxScore = (input.marketContextScore + 1) / 2;
  const marketContext =
    isLong ? ctxScore : 1 - ctxScore;
  reasons.push({ component: "marketContext", score: marketContext, direction: dir, label: "Market context alignment" });

  // Regime fit
  const regimeFit =
    input.regimeFit === "SUPPORTED" ? 0.85 :
    input.regimeFit === "NEUTRAL" ? 0.50 : 0.15;
  reasons.push({ component: "regimeFit", score: regimeFit, direction: dir, label: `Regime: ${input.regimeFit}` });

  // MTF alignment: convert [-1,1] → [0,1] directionally adjusted
  const mtfAligned = (input.mtfAlignmentScore + 1) / 2;
  const mtfAlignment = isLong ? mtfAligned : 1 - mtfAligned;
  reasons.push({ component: "mtfAlignment", score: mtfAlignment, direction: dir, label: "Multi-timeframe alignment" });

  const structureQuality = Math.max(0, Math.min(1, input.structureScore));
  reasons.push({ component: "structureQuality", score: structureQuality, direction: dir, label: "Market structure" });

  const momentumQuality = Math.max(0, Math.min(1, input.momentumScore));
  reasons.push({ component: "momentumQuality", score: momentumQuality, direction: dir, label: "Momentum" });

  const volumeQuality = Math.max(0, Math.min(1, input.volumeScore));
  reasons.push({ component: "volumeQuality", score: volumeQuality, direction: dir, label: "Volume" });

  const volatilityFit = Math.max(0, Math.min(1, input.volatilityFitScore));
  reasons.push({ component: "volatilityFit", score: volatilityFit, direction: dir, label: "Volatility regime fit" });

  const liquidityQuality = Math.max(0, Math.min(1, input.liquidityScore));
  reasons.push({ component: "liquidityQuality", score: liquidityQuality, direction: dir, label: "Liquidity" });

  // Derivatives: directional
  const derivAligned = (input.derivativesScore + 1) / 2;
  const derivativesConfirmation = isLong ? derivAligned : 1 - derivAligned;
  reasons.push({ component: "derivativesConfirmation", score: derivativesConfirmation, direction: dir, label: "Derivatives confirmation" });

  // Relative strength: directional
  const rsAligned = (input.relativeStrengthScore + 1) / 2;
  const relativeStrength = isLong ? rsAligned : 1 - rsAligned;
  reasons.push({ component: "relativeStrength", score: relativeStrength, direction: dir, label: "Relative strength vs NIFTY" });

  const mlProbability = Math.max(0, Math.min(1, input.mlProbability));
  reasons.push({ component: "mlProbability", score: mlProbability, direction: dir, label: "ML model probability" });

  // EV: normalize EV range to [0, 1]
  const evNorm = Math.max(0, Math.min(1, (input.ev.ev + 2) / 4));
  const expectedValue = evNorm;
  reasons.push({ component: "expectedValue", score: expectedValue, direction: dir, label: `EV: ${input.ev.ev.toFixed(3)}` });

  // Execution: TOD score
  const executionQuality = Math.max(0, Math.min(1, input.tod.priorScore));
  reasons.push({ component: "executionQuality", score: executionQuality, direction: dir, label: `Time-of-day: ${input.tod.label}` });

  const dataQuality = Math.max(0, Math.min(1, input.dataQualityScore));
  reasons.push({ component: "dataQuality", score: dataQuality, direction: dir, label: "Data quality" });

  // Composite (weighted)
  const composite = Math.max(0, Math.min(1,
    marketContext * 0.10 +
    regimeFit * 0.10 +
    mtfAlignment * 0.08 +
    structureQuality * 0.08 +
    momentumQuality * 0.08 +
    volumeQuality * 0.10 +
    volatilityFit * 0.06 +
    liquidityQuality * 0.10 +
    derivativesConfirmation * 0.10 +
    relativeStrength * 0.06 +
    mlProbability * 0.05 +
    expectedValue * 0.05 +
    executionQuality * 0.02 +
    dataQuality * 0.02,
  ));

  return {
    marketContext,
    regimeFit,
    mtfAlignment,
    structureQuality,
    momentumQuality,
    volumeQuality,
    volatilityFit,
    liquidityQuality,
    derivativesConfirmation,
    relativeStrength,
    mlProbability,
    expectedValue,
    executionQuality,
    dataQuality,
    composite,
    reasons,
  };
}

// ─── Signal Ranking Engine ────────────────────────────────────────────────────

/**
 * Grade a signal based on Expected Value and quality vector.
 * Statistical criteria (not arbitrary thresholds):
 *   A+ — EV > 0.5%, quality > 0.75, liquidity confirmed
 *   A  — EV > 0.2%, quality > 0.65
 *   B  — EV > 0.0%, quality > 0.50
 *   C  — EV > -0.1%, quality > 0.40
 *   REJECT — EV ≤ -0.1% OR quality ≤ 0.40 OR liquidity rejected
 */
export function gradeSignal(
  ev: ExpectedValueEstimate,
  qualityVector: SignalQualityVector,
  liquidityRejected: boolean,
  dataQualityCritical: boolean,
): SignalRankGrade {
  if (liquidityRejected || dataQualityCritical) return "REJECT";

  const q = qualityVector.composite;
  const evValue = ev.ev;

  if (evValue > 0.5 && q > 0.75) return "A_PLUS";
  if (evValue > 0.2 && q > 0.65) return "A";
  if (evValue > 0.0 && q > 0.50) return "B";
  if (evValue > -0.1 && q > 0.40) return "C";
  return "REJECT";
}

/**
 * Compute the final ranking score [0, 100].
 * Used to sort signals when multiple pass the grade threshold.
 */
export function computeRankingScore(
  ev: ExpectedValueEstimate,
  qualityVector: SignalQualityVector,
  grade: SignalRankGrade,
): number {
  if (grade === "REJECT") return 0;
  const evComponent = Math.max(0, Math.min(1, (ev.ev + 1) / 3)) * 30;
  const qualityComponent = qualityVector.composite * 40;
  const mlComponent = qualityVector.mlProbability * 15;
  const liquidityComponent = qualityVector.liquidityQuality * 10;
  const dataComponent = qualityVector.dataQuality * 5;
  return Math.min(100, evComponent + qualityComponent + mlComponent + liquidityComponent + dataComponent);
}

// ─── Signal Abstention Engine ─────────────────────────────────────────────────

export interface AbstractionDecision {
  shouldAbstain: boolean;
  action: "TRADE" | "NO_TRADE";
  reasons: AbstentionReason[];
  explanation: string;
}

/**
 * Evaluate whether the system should abstain from a signal.
 * Abstention is a valid model outcome — prefer NO_TRADE over a low-quality trade.
 */
export function evaluateAbstention(params: {
  grade: SignalRankGrade;
  ev: ExpectedValueEstimate;
  qualityVector: SignalQualityVector;
  liquidityResult: LiquidityResult;
  regimeFit: "SUPPORTED" | "NEUTRAL" | "ADVERSE";
  dataQualityLevel: "COMPLETE" | "PARTIAL" | "STALE" | "MISSING" | "ESTIMATED";
  mlProbability: number;
  tod: TODBucketResult;
  hasConflictingTimeframes: boolean;
  hasConflictingDerivatives: boolean;
  portfolioExposurePct: number;
  correlatedPositions: number;
  isExpiryDay: boolean;
  isGammaRiskActive: boolean;
}): AbstractionDecision {
  const reasons: AbstentionReason[] = [];

  // Hard vetoes
  if (params.grade === "REJECT") {
    reasons.push("LOW_EDGE");
  }
  if (params.liquidityResult.rejected) {
    reasons.push("LOW_LIQUIDITY");
    if (params.liquidityResult.spreadPct !== null && params.liquidityResult.spreadPct > 0.30) {
      reasons.push("SPREAD_TOO_WIDE");
    }
  }
  if (params.dataQualityLevel === "MISSING" || params.dataQualityLevel === "STALE") {
    reasons.push("DATA_QUALITY");
  }
  if (params.regimeFit === "ADVERSE") {
    reasons.push("BAD_REGIME");
  }
  if (params.ev.pWin < 0.35) {
    reasons.push("LOW_EDGE");
  }
  if (Math.abs(params.ev.ev) > 0 && params.ev.ev < -0.2) {
    reasons.push("POOR_RISK_REWARD");
  }
  if (params.mlProbability < 0.35 && params.mlProbability > 0) {
    // Only abstain on ML if it's strongly against the signal
    if (params.mlProbability < 0.30) {
      reasons.push("ML_UNCERTAINTY");
    }
  }
  if (params.hasConflictingTimeframes) {
    reasons.push("CONFLICTING_TIMEFRAMES");
  }
  if (params.hasConflictingDerivatives) {
    reasons.push("CONFLICTING_DERIVATIVES");
  }
  if (params.correlatedPositions >= 3) {
    reasons.push("HIGH_CORRELATION");
  }
  if (params.portfolioExposurePct > 80) {
    reasons.push("EXCESS_PORTFOLIO_EXPOSURE");
  }
  if (params.isGammaRiskActive) {
    reasons.push("EXPIRY_RISK");
  }
  if (params.tod.recommendation === "AVOID") {
    reasons.push("BAD_REGIME");
  }

  const shouldAbstain = reasons.length > 0;
  const explanation = shouldAbstain
    ? `NO_TRADE: ${reasons.slice(0, 3).join(", ")}${reasons.length > 3 ? ` +${reasons.length - 3} more` : ""}`
    : "TRADE: All filters passed";

  return {
    shouldAbstain,
    action: shouldAbstain ? "NO_TRADE" : "TRADE",
    reasons,
    explanation,
  };
}
