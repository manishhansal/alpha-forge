/**
 * Trade attribution engine.
 *
 * Every closed trade carries immutable attribution fields:
 *   strategyId, signalId, modelVersion, featureVersion,
 *   marketRegime, dataQualityScore
 *
 * This module slices the trade list along those dimensions and produces
 * structured breakdowns that answer questions like:
 *   • Which strategy generated the most alpha?
 *   • Does performance degrade when data quality is low?
 *   • Which market regime suits each strategy best?
 *   • How does modelVersion v2 compare to v1?
 *
 * All values in INR unless suffixed _pct (fraction, not percentage points).
 */

import type { Trade } from "../models/trade";
import { mean, profitFactor, winRate, sharpeRatio } from "./metrics";

// ── Attribution slice ─────────────────────────────────────────────────────────

export interface AttributionSlice {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalNetPnlINR: number;
  avgNetPnlINR: number;
  avgPnlPct: number;
  profitFactor: number;
  sharpe: number;
  avgBarsHeld: number;
  /** Average data quality score of trades in this slice. */
  avgDataQuality: number;
  /** Win rate broken down by sub-regime within this slice. */
  regimeBreakdown?: RegimeStat[];
}

export interface RegimeStat {
  regime: string;
  trades: number;
  winRate: number;
  avgPnlPct: number;
}

// ── Attribution report ────────────────────────────────────────────────────────

export interface AttributionReport {
  /** Total trades analysed. */
  totalTrades: number;
  /** By strategy. */
  byStrategy: AttributionSlice[];
  /** By ML model version. */
  byModelVersion: AttributionSlice[];
  /** By feature pipeline version. */
  byFeatureVersion: AttributionSlice[];
  /** By market regime. */
  byMarketRegime: AttributionSlice[];
  /** By data quality band (high ≥0.8, medium 0.5–0.8, low <0.5). */
  byDataQuality: AttributionSlice[];
  /** Signal-level: first signal that generated each trade. */
  signalStats: SignalAttributionStats;
  /**
   * Lookahead audit: any trade where executionTimestampMs ≤ signalTimestampMs
   * is a lookahead violation. This array is ALWAYS empty in a correct run.
   */
  lookaheadViolations: LookaheadViolation[];
}

export interface SignalAttributionStats {
  totalSignals: number;
  approvedSignals: number;
  rejectedSignals: number;
  avgConfidence: number;
  avgRiskReward: number;
  /** Average bars from signal generation to order fill. */
  avgSignalToFillBars: number;
}

export interface LookaheadViolation {
  tradeId: string;
  strategyId: string;
  signalTimestampMs: number;
  executionTimestampMs: number;
  deltaMs: number;
}

// ── Builder ───────────────────────────────────────────────────────────────────

export interface AttributionInput {
  trades: Trade[];
  /** Optional: parallel array of (signalTimestampMs, executionTimestampMs, openBarIndex) for audit. */
  fillTimings?: Array<{
    tradeId: string;
    strategyId: string;
    signalTimestampMs: number;
    executionTimestampMs: number;
  }>;
  signalStats?: SignalAttributionStats;
}

export function buildAttributionReport(input: AttributionInput): AttributionReport {
  const { trades } = input;

  // ── Lookahead audit ────────────────────────────────────────────────────
  const violations: LookaheadViolation[] = [];
  if (input.fillTimings) {
    for (const ft of input.fillTimings) {
      if (ft.executionTimestampMs <= ft.signalTimestampMs) {
        violations.push({
          tradeId: ft.tradeId,
          strategyId: ft.strategyId,
          signalTimestampMs: ft.signalTimestampMs,
          executionTimestampMs: ft.executionTimestampMs,
          deltaMs: ft.executionTimestampMs - ft.signalTimestampMs,
        });
      }
    }
  }

  return {
    totalTrades: trades.length,
    byStrategy: groupAndSlice(trades, (t) => t.strategyId),
    byModelVersion: groupAndSlice(trades, (t) => t.modelVersion || "unknown"),
    byFeatureVersion: groupAndSlice(trades, (t) => t.featureVersion || "unknown"),
    byMarketRegime: groupAndSlice(trades, (t) => t.marketRegime),
    byDataQuality: groupAndSlice(trades, (t) => dataQualityBand(t.dataQualityScore)),
    signalStats: input.signalStats ?? defaultSignalStats(),
    lookaheadViolations: violations,
  };
}

// ── Slicing helpers ───────────────────────────────────────────────────────────

function groupAndSlice(
  trades: Trade[],
  key: (t: Trade) => string,
): AttributionSlice[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = key(t);
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, ts]) => buildSlice(label, ts));
}

function buildSlice(label: string, trades: Trade[]): AttributionSlice {
  const pnls = trades.map((t) => t.netPnl);
  const pnlPcts = trades.map((t) => t.pnlPct / 100);
  const wins = pnls.filter((p) => p > 0).length;
  const totalNet = pnls.reduce((a, b) => a + b, 0);

  // Sub-regime breakdown
  const regimeGroups = new Map<string, Trade[]>();
  for (const t of trades) {
    const arr = regimeGroups.get(t.marketRegime) ?? [];
    arr.push(t);
    regimeGroups.set(t.marketRegime, arr);
  }
  const regimeBreakdown: RegimeStat[] = Array.from(regimeGroups.entries()).map(
    ([regime, rs]) => ({
      regime,
      trades: rs.length,
      winRate: winRate(rs.map((t) => t.netPnl)),
      avgPnlPct: rs.length > 0 ? mean(rs.map((t) => t.pnlPct)) : 0,
    }),
  );

  return {
    label,
    trades: trades.length,
    wins,
    losses: pnls.filter((p) => p < 0).length,
    winRate: winRate(pnls),
    totalNetPnlINR: totalNet,
    avgNetPnlINR: trades.length > 0 ? totalNet / trades.length : 0,
    avgPnlPct: trades.length > 0 ? mean(trades.map((t) => t.pnlPct)) : 0,
    profitFactor: profitFactor(pnls),
    sharpe: sharpeRatio(pnlPcts),
    avgBarsHeld: trades.length > 0 ? mean(trades.map((t) => t.barsHeld)) : 0,
    avgDataQuality:
      trades.length > 0 ? mean(trades.map((t) => t.dataQualityScore)) : 0,
    regimeBreakdown,
  };
}

function dataQualityBand(score: number): string {
  if (score >= 0.8) return "high (≥0.8)";
  if (score >= 0.5) return "medium (0.5–0.8)";
  return "low (<0.5)";
}

function defaultSignalStats(): SignalAttributionStats {
  return {
    totalSignals: 0,
    approvedSignals: 0,
    rejectedSignals: 0,
    avgConfidence: 0,
    avgRiskReward: 0,
    avgSignalToFillBars: 0,
  };
}

// ── Convenience: extract fill timings from portfolio event log ────────────────

import type { AnyEvent } from "../events/index";

/**
 * Extract fill-timing records from an engine event log.
 * Used to populate `AttributionInput.fillTimings` for the lookahead audit.
 */
export function extractFillTimings(
  eventLog: ReadonlyArray<AnyEvent>,
): AttributionInput["fillTimings"] {
  const signals = new Map<string, { ts: number; strategyId: string }>();
  const result: NonNullable<AttributionInput["fillTimings"]> = [];

  for (const ev of eventLog) {
    if (ev.type === "SIGNAL_EVENT") {
      signals.set(ev.id, {
        ts: ev.timestampMs,
        strategyId: ev.attribution.strategyId,
      });
    }
    if (ev.type === "FILL_EVENT") {
      const sig = signals.get(ev.signalEventId);
      if (sig) {
        result.push({
          tradeId: ev.orderEventId,
          strategyId: sig.strategyId,
          signalTimestampMs: ev.signalTimestampMs,
          executionTimestampMs: ev.executionTimestampMs,
        });
      }
    }
  }
  return result;
}

/**
 * Extract signal stats from an engine event log.
 */
export function extractSignalStats(
  eventLog: ReadonlyArray<AnyEvent>,
): SignalAttributionStats {
  let total = 0;
  let approved = 0;
  let rejected = 0;
  let sumConfidence = 0;
  let sumRR = 0;
  const fillBars = new Map<string, number>(); // signalId → fill barIndex

  for (const ev of eventLog) {
    if (ev.type === "SIGNAL_EVENT") {
      total++;
      sumConfidence += ev.confidence;
      sumRR += ev.levels.riskReward;
    }
    if (ev.type === "RISK_CHECK") {
      if ("decision" in ev) {
        if (ev.decision === "APPROVED") approved++;
        else rejected++;
      }
    }
    if (ev.type === "FILL_EVENT") {
      const bars = ev.executionBarIndex;
      fillBars.set(ev.signalEventId, bars);
    }
  }

  // avg signal-to-fill bar distance
  let sumDelta = 0;
  let fillCount = 0;
  for (const ev of eventLog) {
    if (ev.type === "SIGNAL_EVENT") {
      const fillBar = fillBars.get(ev.id);
      if (fillBar !== undefined) {
        sumDelta += fillBar - ev.signalBarIndex;
        fillCount++;
      }
    }
  }

  return {
    totalSignals: total,
    approvedSignals: approved,
    rejectedSignals: rejected,
    avgConfidence: total > 0 ? sumConfidence / total : 0,
    avgRiskReward: total > 0 ? sumRR / total : 0,
    avgSignalToFillBars: fillCount > 0 ? sumDelta / fillCount : 0,
  };
}
