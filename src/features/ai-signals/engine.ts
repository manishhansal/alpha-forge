/**
 * AI Signals engine — pure, deterministic helpers shared by both the crypto
 * and the India market signal builders.
 *
 * The market-specific builders (`features/ai-signals/crypto-builder.ts` and
 * `features/ai-signals/india-builder.ts`) own data fetching + market wiring;
 * this file owns the math: confluence scoring, grading, take-profit ladder
 * construction, win-probability calibration, position sizing and timing.
 *
 * Every export here is pure — no `Date.now()`, no `fetch`, no `crypto`. The
 * caller passes `now` and `id` so tests can pin the wall-clock.
 */

import type {
  AiAction,
  AiConfluenceFactor,
  AiDirection,
  AiGrade,
  AiHorizon,
  AiReason,
  AiRiskLevel,
  AiTakeProfit,
  AiTimingWindow,
} from "@/types/ai-signals";

export const AI_MODEL_VERSION = "alphaforge-ai-v1";

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

/**
 * Default per-horizon tuning. Driven empirically against the crypto + India
 * backtests but exposed here so the builders can override per signal (e.g.
 * give a strong-confluence signal a wider SL multiplier).
 */
export const HORIZON_PROFILE: Record<
  AiHorizon,
  {
    stopAtrMult: number;
    targetAtrMults: [number, number, number];
    validForMs: number;
    /** Position sizing baseline (assumes 1% risk). */
    sizingMult: number;
    /** Floor cap on tradeable % so a 1-cent-stop doesn't blow the account up. */
    sizingCapPct: number;
  }
> = {
  scalp: {
    stopAtrMult: 0.8,
    targetAtrMults: [1.0, 1.8, 2.6],
    validForMs: 30 * 60 * 1000,
    sizingMult: 1.0,
    sizingCapPct: 12,
  },
  intraday: {
    stopAtrMult: 1.4,
    targetAtrMults: [1.6, 2.6, 4.0],
    validForMs: 4 * 60 * 60 * 1000,
    sizingMult: 1.0,
    sizingCapPct: 10,
  },
  swing: {
    stopAtrMult: 2.2,
    targetAtrMults: [2.5, 4.0, 6.5],
    validForMs: 3 * 24 * 60 * 60 * 1000,
    sizingMult: 0.8,
    sizingCapPct: 8,
  },
  positional: {
    stopAtrMult: 3.5,
    targetAtrMults: [3.5, 6.0, 10.0],
    validForMs: 14 * 24 * 60 * 60 * 1000,
    sizingMult: 0.6,
    sizingCapPct: 6,
  },
};

/**
 * Aggregate confluence factors into a [-1, 1] composite score and a [0, 1]
 * confidence. Confidence scales with both directional magnitude AND the
 * share of factors that were actually available — a 0.9 score backed by
 * only 2/9 inputs is much less convincing than 0.6 backed by all 9.
 */
export interface CompositeScore {
  score: number;
  confidence: number;
  bullishCount: number;
  bearishCount: number;
  usedWeight: number;
}

export function compositeScore(
  factors: readonly AiConfluenceFactor[],
): CompositeScore {
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const usedWeight = factors
    .filter((f) => f.available)
    .reduce((s, f) => s + f.weight, 0);

  const weighted = factors.reduce(
    (s, f) => s + f.weight * (f.available ? f.score : 0),
    0,
  );

  const score = usedWeight > 0 ? weighted / usedWeight : 0;
  const coverage = totalWeight > 0 ? usedWeight / totalWeight : 0;

  // Magnitude * coverage. We deliberately don't return ≥ 1 confidence even
  // for a unanimous +1 vote — there's always residual uncertainty.
  const confidence = clamp(Math.abs(score) * (0.55 + 0.45 * coverage), 0, 0.98);

  let bullishCount = 0;
  let bearishCount = 0;
  for (const f of factors) {
    if (!f.available || f.score === 0) continue;
    if (f.score > 0) bullishCount++;
    else bearishCount++;
  }

  return { score, confidence, bullishCount, bearishCount, usedWeight };
}

/**
 * Classify the composite score into a concrete trade action.
 *
 * Crypto-style instruments (perp futures) lean LONG/SHORT when the
 * derivatives share of the score is dominant; spot-style instruments lean
 * BUY/SELL. India F&O always uses LONG/SHORT.
 */
export function classifyAction(
  score: number,
  derivativeShare: number,
  options: { allowPerps?: boolean; minMagnitude?: number } = {},
): AiAction {
  const { allowPerps = true, minMagnitude = 0.18 } = options;
  if (Math.abs(score) < minMagnitude) return "WAIT";
  const usePerp = allowPerps && derivativeShare >= 0.35;
  if (score > 0) return usePerp ? "LONG" : "BUY";
  return usePerp ? "SHORT" : "SELL";
}

export function directionFromAction(action: AiAction): AiDirection {
  switch (action) {
    case "LONG":
    case "BUY":
      return "BULLISH";
    case "SHORT":
    case "SELL":
      return "BEARISH";
    default:
      return "NEUTRAL";
  }
}

/**
 * 0-100 confidence → letter grade. Calibrated so that S is reserved for
 * exceptional alignment — at least 4/5 factors agreeing.
 */
export function gradeFromConfidence(confidence: number): AiGrade {
  // Compare against the [0, 1] thresholds directly — multiplying by 100 first
  // exposes IEEE-754 rounding (0.58 * 100 = 57.99999999999999) which silently
  // demotes a boundary signal a full grade.
  if (confidence >= 0.85) return "S";
  if (confidence >= 0.72) return "A";
  if (confidence >= 0.58) return "B";
  if (confidence >= 0.42) return "C";
  return "D";
}

/**
 * Map a [0, 1] composite-score magnitude → calibrated [0, 1] win-probability
 * (TP1 hit before SL). Uses a logistic curve centred at score ≈ 0.35 so a
 * marginal signal sits around 50% and a strong signal climbs to ~78%. We
 * deliberately cap below 0.85 — no real trade is "almost certain to win"
 * over enough samples, and overconfidence is the #1 way retail blows up.
 */
export function calibrateWinProbability(
  scoreMagnitude: number,
  confidence: number,
): number {
  const x = clamp(scoreMagnitude, 0, 1);
  const baseline = 0.5;
  const slope = 6;
  const offset = 0.35;
  const logistic = 1 / (1 + Math.exp(-slope * (x - offset)));
  const calibrated = baseline + (logistic - 0.5) * 0.7;
  const conviction = 0.85 + 0.15 * clamp(confidence, 0, 1);
  return clamp(calibrated * conviction, 0.3, 0.85);
}

/**
 * Compute the position-size suggestion in percent of total equity, given a
 * fixed-risk-per-trade budget (default 1%) and the stop distance. We cap by
 * `sizingCapPct` so a hair-thin stop can't recommend the user leverage-up.
 */
export function suggestPositionSizePct(
  entry: number,
  stopLoss: number,
  horizon: AiHorizon,
  options: { riskBudgetPct?: number; confidence?: number } = {},
): number {
  const { riskBudgetPct = 1, confidence = 0.5 } = options;
  if (entry <= 0) return 0;
  const stopDistPct = Math.abs((entry - stopLoss) / entry) * 100;
  if (stopDistPct <= 0) return 0;
  const profile = HORIZON_PROFILE[horizon];
  const raw = (riskBudgetPct / stopDistPct) * profile.sizingMult * 100;
  // Scale by confidence so a marginal signal sizes smaller than a strong one.
  const scaled = raw * (0.5 + 0.5 * clamp(confidence, 0, 1));
  return Math.max(0.1, Math.min(profile.sizingCapPct, Number(scaled.toFixed(2))));
}

export function riskLevelFromConfidence(
  confidence: number,
  alignedRatio: number,
): AiRiskLevel {
  if (confidence >= 0.62 && alignedRatio >= 0.7) return "low";
  if (confidence >= 0.42 && alignedRatio >= 0.55) return "medium";
  return "high";
}

/**
 * Build a 3-tier take-profit ladder using the horizon profile + a directional
 * sign. Allocations are weighted toward TP1 (50%) so partials de-risk early.
 */
export function buildTakeProfits(
  entry: number,
  atr: number,
  horizon: AiHorizon,
  bullish: boolean,
): AiTakeProfit[] {
  const { targetAtrMults } = HORIZON_PROFILE[horizon];
  const sign = bullish ? 1 : -1;
  const allocations: [number, number, number] = [0.5, 0.3, 0.2];
  return targetAtrMults.map((mult, idx) => {
    const price = entry + sign * mult * atr;
    const percent = ((price - entry) / entry) * 100;
    return {
      level: (idx + 1) as 1 | 2 | 3,
      price,
      percent,
      allocation: allocations[idx],
    };
  });
}

export interface BuildLevelsArgs {
  underlyingPrice: number;
  atr: number;
  horizon: AiHorizon;
  bullish: boolean;
  /** Optional tighter entry zone (e.g. pull-back target). Defaults to ±0.25×ATR. */
  entryZoneAtrMult?: number;
}

export interface BuiltLevels {
  entry: number;
  entryZone: { min: number; max: number };
  stopLoss: number;
  takeProfits: AiTakeProfit[];
  riskReward: number;
  riskRewardBlended: number;
  expectedMovePct: number;
}

export function buildTradeLevels(args: BuildLevelsArgs): BuiltLevels {
  const { underlyingPrice, atr, horizon, bullish } = args;
  const profile = HORIZON_PROFILE[horizon];
  const sign = bullish ? 1 : -1;
  const entry = underlyingPrice;
  const stopLoss = entry - sign * profile.stopAtrMult * atr;
  const takeProfits = buildTakeProfits(entry, atr, horizon, bullish);

  const stopDist = Math.abs(entry - stopLoss);
  const tp1Dist = Math.abs(takeProfits[0].price - entry);
  const riskReward = stopDist > 0 ? tp1Dist / stopDist : 0;

  const blendedTargetDist = takeProfits.reduce(
    (s, tp) => s + Math.abs(tp.price - entry) * tp.allocation,
    0,
  );
  const riskRewardBlended = stopDist > 0 ? blendedTargetDist / stopDist : 0;

  const tp3Dist = Math.abs(takeProfits[2].price - entry);
  const expectedMovePct = entry > 0 ? (tp3Dist / entry) * 100 : 0;

  const zoneMult = args.entryZoneAtrMult ?? 0.25;
  const zoneDist = zoneMult * atr;
  const entryZone = bullish
    ? { min: entry - zoneDist, max: entry + zoneDist * 0.3 }
    : { min: entry - zoneDist * 0.3, max: entry + zoneDist };

  return {
    entry,
    entryZone,
    stopLoss,
    takeProfits,
    riskReward,
    riskRewardBlended,
    expectedMovePct,
  };
}

export interface BuildTimingArgs {
  now: number;
  horizon: AiHorizon;
  inActiveWindow: boolean;
  windowLabel: string;
  /**
   * Optional next-session anchor for markets that have a closed state
   * (e.g. NSE F&O). When the market is closed AND this is supplied, the
   * timing window rebases `enterBy` / `exitBy` to that future open and
   * the entry note explicitly frames the signal as "queued for the next
   * trading day" — so the live countdown chip ticks down toward the
   * actual open instead of expiring in the dead zone.
   * Always omitted for 24/7 markets (crypto).
   */
  nextSession?: {
    opensAt: number;
    dayLabel: string;
    timeLabel: string;
  };
}

export function buildTimingWindow(args: BuildTimingArgs): AiTimingWindow {
  const { now, horizon, inActiveWindow, windowLabel, nextSession } = args;
  const profile = HORIZON_PROFILE[horizon];
  const validForMs = profile.validForMs;

  let enterBy: number;
  let exitBy: number;
  let bestEntryNote: string;

  if (!inActiveWindow && nextSession) {
    // Market is closed and the caller told us when it next opens.
    // Anchor entry to that open, keep the horizon's `validForMs` as the
    // post-open lifespan, and phrase the entry note as a "queued for
    // tomorrow" plan instead of the generic "wait for window" message.
    enterBy = nextSession.opensAt;
    exitBy = nextSession.opensAt + validForMs;
    bestEntryNote = `Queued for ${nextSession.dayLabel} — enter at the ${nextSession.timeLabel} open.`;
  } else {
    enterBy = now + Math.min(15 * 60 * 1000, validForMs / 4);
    exitBy = now + validForMs;
    bestEntryNote = inActiveWindow
      ? `Enter now — inside ${windowLabel}.`
      : `Wait for ${windowLabel} to open before sizing in.`;
  }

  const bestExitNote =
    horizon === "scalp"
      ? "Exit on TP1 touch or 30m hard stop."
      : horizon === "intraday"
        ? "Close any runner by session end; no overnight risk."
        : horizon === "swing"
          ? "Trail SL to break-even after TP2; let TP3 ride."
          : "Re-evaluate on next weekly close.";
  return {
    generatedAt: now,
    enterBy,
    exitBy,
    validForMs,
    bestEntryNote,
    bestExitNote,
  };
}

/**
 * Build a human-readable rationale list from the top contributing factors.
 * Each entry is a {category, text, bullish} triple so the UI can render a
 * tinted chip per row.
 */
export function buildReasons(
  factors: readonly AiConfluenceFactor[],
  options: { limit?: number; minContribution?: number } = {},
): AiReason[] {
  const { limit = 6, minContribution = 0.02 } = options;
  return factors
    .filter((f) => f.available && Math.abs(f.contribution) >= minContribution)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, limit)
    .map((f) => ({
      category: f.category,
      text: `${f.label}: ${f.description}`,
      bullish: f.contribution >= 0,
    }));
}

/**
 * Compute the share of weighted contributions that came from derivatives
 * factors. Used by `classifyAction` to lean toward LONG/SHORT (perp) when
 * the read is dominated by funding / OI / liquidations.
 */
export function derivativeShare(
  factors: readonly AiConfluenceFactor[],
  derivativeIds: Set<string>,
): number {
  let total = 0;
  let deriv = 0;
  for (const f of factors) {
    if (!f.available) continue;
    total += f.weight;
    if (derivativeIds.has(f.id)) deriv += f.weight;
  }
  return total > 0 ? deriv / total : 0;
}

/**
 * Tiny helper: make a factor row programmatically. Accepts a raw score (any
 * scale) and clamps to [-1, 1] using `denominator`. Returns a zero factor
 * with `available: false` if the input is null/undefined/non-finite.
 */
export function makeFactor(
  input: {
    id: string;
    category: AiFactorCategoryArg;
    label: string;
    weight: number;
    raw: number | null | undefined;
    denominator: number;
    describe: (raw: number) => string;
    invert?: boolean;
  },
): AiConfluenceFactor {
  const {
    id,
    category,
    label,
    weight,
    raw,
    denominator,
    describe,
    invert = false,
  } = input;
  if (raw == null || !Number.isFinite(raw) || denominator === 0) {
    return {
      id,
      category,
      label,
      weight,
      score: 0,
      contribution: 0,
      available: false,
      description: "Unavailable",
    };
  }
  const normalised = clamp(raw / denominator, -1, 1);
  const score = invert ? -normalised : normalised;
  return {
    id,
    category,
    label,
    weight,
    score,
    contribution: weight * score,
    available: true,
    description: describe(raw),
  };
}

type AiFactorCategoryArg = AiConfluenceFactor["category"];

/**
 * Round price to the nearest tick. Crypto: 2 decimals for BTC/ETH-scale,
 * 4 decimals otherwise; India: 0.05 INR tick on stocks, 5 INR tick on
 * indices ≥ 5,000.
 */
export function roundToTick(price: number, tick: number): number {
  if (tick <= 0) return price;
  return Number((Math.round(price / tick) * tick).toFixed(8));
}

/**
 * Decide the appropriate AI horizon from the user's session window + the
 * dominant strategy category. A best-time "ideal" window with a heavy
 * derivatives read leans toward scalp; "good" leans intraday; "moderate"
 * leans swing.
 */
export function pickHorizon(args: {
  inActiveWindow: boolean;
  derivativeShare: number;
  scoreMagnitude: number;
}): AiHorizon {
  if (!args.inActiveWindow) return "swing";
  if (args.derivativeShare >= 0.45 && args.scoreMagnitude >= 0.5) return "scalp";
  if (args.scoreMagnitude >= 0.35) return "intraday";
  return "swing";
}

/**
 * Compose a one-line summary the UI shows above the rationale list.
 */
export function composeSummary(args: {
  action: AiAction;
  symbol: string;
  grade: AiGrade;
  confidenceScore: number;
  reasons: AiReason[];
  horizon: AiHorizon;
}): string {
  const { action, symbol, grade, confidenceScore, reasons, horizon } = args;
  if (action === "WAIT") {
    return `WAIT on ${symbol} · ${confidenceScore}% read · grade ${grade} — no edge in the next ${horizonLabel(horizon)}.`;
  }
  const lead = reasons[0]?.text ?? "Multi-factor confluence";
  return `${action} ${symbol} · ${confidenceScore}% confidence · grade ${grade} (${horizonLabel(horizon)}) — ${lead}.`;
}

export function horizonLabel(horizon: AiHorizon): string {
  switch (horizon) {
    case "scalp":
      return "next 30m";
    case "intraday":
      return "next 1-4h";
    case "swing":
      return "next 1-3 days";
    case "positional":
      return "next 1-2 weeks";
  }
}

export interface InvalidationArgs {
  bullish: boolean;
  stopLoss: number;
  horizon: AiHorizon;
}

export function invalidationLine(args: InvalidationArgs): string {
  const { bullish, stopLoss, horizon } = args;
  const side = bullish ? "below" : "above";
  const span =
    horizon === "scalp"
      ? "1m close"
      : horizon === "intraday"
        ? "15m close"
        : horizon === "swing"
          ? "daily close"
          : "weekly close";
  return `Setup invalidates on a ${span} ${side} ${stopLoss.toFixed(2)} — exit immediately.`;
}
