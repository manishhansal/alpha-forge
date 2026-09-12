import "server-only";

import type { PrismaClient } from "@prisma/client";

import { PrismaSignalRecordStore } from "./prisma-signal-record-store";
import type {
  PredictionRecord,
  ResolutionRecord,
  SignalRecordStore,
  OutcomeState,
  LearnRegime,
  LearnTimeframe,
  LearnInstrument,
  LearnGrade,
  SignalDirection,
} from "./signal-learning-loop";
import type { CanonicalCandidate, ShadowDecision } from "./shadow-intelligence";

/**
 * Shadow persistence service (remediation P0/P1 — Phases 5/6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Wires `PrismaSignalRecordStore` into the real signal lifecycle so that every
 * shadow-evaluated signal writes an IMMUTABLE `PredictionRecord` at creation and
 * an IDEMPOTENT `ResolutionRecord` at close. This is the durable outcome store
 * the closed-loop learning needs — proven used (not merely imported).
 *
 * Critical safety properties:
 *   • The prediction snapshot is written ONCE and never recomputed.
 *   • Resolution is idempotent — a duplicated close event cannot create a second
 *     outcome row.
 *   • This module does NOT change execution or the existing trade-resolution
 *     policy; it records, in parallel, what the new stack decided.
 */

const REGIMES = new Set<LearnRegime>(["BULL_TREND", "BEAR_TREND", "RANGE", "HIGH_VOL", "LOW_VOL", "UNKNOWN"]);
function toLearnRegime(r: string): LearnRegime {
  return (REGIMES.has(r as LearnRegime) ? r : "UNKNOWN") as LearnRegime;
}
function toLearnGrade(bucket: string): LearnGrade {
  switch (bucket) {
    case "A_PLUS_PRIME":
    case "A_PLUS_STRONG":
      return "A_PLUS";
    case "A_HIGH":
      return "A";
    case "B_SELECTIVE":
      return "B";
    case "WATCH":
      return "C";
    default:
      return "REJECT";
  }
}
function toLearnTimeframe(instrument: LearnInstrument, minutesFromOpen: number): LearnTimeframe {
  // Coarse: intraday by default; callers may override by passing a richer field.
  return minutesFromOpen >= 0 ? "INTRADAY" : "SWING";
}
function istTradeDate(timestampMs: number): string {
  const ist = new Date(timestampMs + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/**
 * Build the immutable prediction snapshot from a shadow decision. The values
 * are frozen exactly as the engines produced them at this instant — they are
 * never recalculated later.
 */
export function buildPredictionRecord(c: CanonicalCandidate, d: ShadowDecision): PredictionRecord {
  return {
    signalId: c.signalId,
    symbol: c.symbol,
    strategy: c.strategy,
    direction: c.direction as SignalDirection,
    timestamp: c.timestamp,
    entry: c.entry,
    stop: c.stop,
    targets: [c.target],
    timeframe: toLearnTimeframe(c.instrument as LearnInstrument, c.minutesFromOpen),
    regime: toLearnRegime(c.regime),
    instrumentType: c.instrument as LearnInstrument,
    sector: null,
    signalQuality: c.qualityScore,
    grade: toLearnGrade(d.aPlusBucket),
    rawConfidence: c.rawConfidence,
    calibratedProbability: c.calibratedProbability,
    expectedValue: d.profitability.netEV.netEVR,
    modelContributions: { meta: d.modelContribution },
    qualityComponents: {},
    abstentionDecision: d.canonical.decision === "ABSTAIN" || d.canonical.decision === "WAIT",
    featureSnapshot: {},
    derivativesSnapshot: {
      maxPainAgrees: c.maxPainAgrees ? 1 : 0,
      pcrAgrees: c.pcrAgrees ? 1 : 0,
      oiAgrees: c.oiAgrees ? 1 : 0,
    },
    marketContext: { volatility: c.volatility },
    dataQuality: c.dataQuality,
    liquidity: c.liquidity,
    costEstimate: d.profitability.cost.totalPct,
    slippageEstimate: d.profitability.slippage.slippagePct,
    modelVersion: `${d.version}|modelState=${d.modelState}`,
    tradeDate: istTradeDate(c.timestamp),
  };
}

/** Map a chronologically-resolved paper outcome to a durable ResolutionRecord. */
export interface ResolvedTradeInput {
  signalId: string;
  outcome: OutcomeState;
  exit: number | null;
  exitTime: number | null;
  returnPct: number | null;
  returnR: number | null;
  mfe: number;
  mae: number;
  holdingTimeMs: number | null;
  targetReached: boolean;
  stopReached: boolean;
  costActual: number;
  slippageActual: number;
  regimeDuringTrade: LearnRegime;
  /** True when intrabar ordering was undeterminable (both touched) — excluded from stats. */
  ambiguous: boolean;
  resolvedAt: number;
}

export function buildResolutionRecord(r: ResolvedTradeInput): ResolutionRecord {
  const netReturn = r.returnPct == null ? null : r.returnPct - r.costActual - r.slippageActual;
  return {
    signalId: r.signalId,
    outcome: r.outcome,
    exit: r.exit,
    exitTime: r.exitTime,
    returnPct: r.returnPct,
    returnR: r.returnR,
    mfe: r.mfe,
    mae: r.mae,
    holdingTimeMs: r.holdingTimeMs,
    targetReached: r.targetReached,
    stopReached: r.stopReached,
    costActual: r.costActual,
    slippageActual: r.slippageActual,
    netReturn,
    regimeDuringTrade: r.regimeDuringTrade,
    ambiguous: r.ambiguous,
    resolvedAt: r.resolvedAt,
  };
}

/**
 * Persist an immutable prediction snapshot for a shadow-evaluated signal.
 * Returns `false` (does not throw) when the prediction already exists — a
 * re-emitted signal must not overwrite the frozen snapshot.
 */
export async function persistShadowPrediction(
  prisma: PrismaClient,
  candidate: CanonicalCandidate,
  decision: ShadowDecision,
  store: SignalRecordStore = new PrismaSignalRecordStore(prisma),
): Promise<{ persisted: boolean; reason?: string }> {
  const record = buildPredictionRecord(candidate, decision);
  try {
    await store.savePrediction(record);
    return { persisted: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/immutable/.test(msg)) return { persisted: false, reason: "already_exists_immutable" };
    throw err;
  }
}

/**
 * Persist a resolution for a signal. Idempotent: returns `false` (no throw)
 * when the signal was already resolved, so a duplicated close event can never
 * create a second outcome row.
 */
export async function persistShadowResolution(
  prisma: PrismaClient,
  resolved: ResolvedTradeInput,
  store: SignalRecordStore = new PrismaSignalRecordStore(prisma),
): Promise<{ persisted: boolean; reason?: string }> {
  const record = buildResolutionRecord(resolved);
  try {
    await store.saveResolution(record);
    return { persisted: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/already resolved|idempotent/.test(msg)) return { persisted: false, reason: "already_resolved" };
    if (/unknown signal/.test(msg)) return { persisted: false, reason: "no_prediction" };
    throw err;
  }
}
