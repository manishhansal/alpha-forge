/**
 * Counterfactual Analysis Engine
 *
 * For every REJECTED opportunity, track what would have happened if
 * the trade had been taken. This allows the system to:
 *
 *   1. Measure False Rejection Rate (rejected → would have WON)
 *   2. Measure False Acceptance Rate (accepted → LOST)
 *   3. Identify which filters add genuine value vs remove good trades
 *   4. Continuously improve the rejection logic
 *
 * Key principle: A rejection engine that prevents 10 losses at the cost
 * of missing 2 winners may or may not be net positive — it depends on
 * the magnitude of the saved losses vs the missed gains.
 *
 * Rejection Quality Metric:
 *   Value = (prevented_loss_magnitude) - (missed_gain_magnitude)
 *
 * For each hard rejection code, compute:
 *   - Trades rejected by this code
 *   - How many would-have-won
 *   - How many would-have-lost
 *   - Net expected value of the filter
 *   - Whether the filter adds or destroys edge
 *
 * This module is I/O-free.
 */

import type { HardRejectionCode, SoftPenaltyCode } from "./types";

// ─── Counterfactual Outcome ───────────────────────────────────────────────────

export type CounterfactualOutcome = "WIN" | "LOSS" | "BREAKEVEN" | "UNKNOWN";

export interface CounterfactualRecord {
  opportunityId: string;
  rejectionCode: HardRejectionCode | null;
  softPenaltyCodes: SoftPenaltyCode[];
  instrument: string;
  strategy: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  target1: number;
  timestamp: number;

  // Post-rejection tracking
  counterfactualOutcome: CounterfactualOutcome;
  actualHighAfterRejection: number | null;  // max price after rejection
  actualLowAfterRejection: number | null;   // min price after rejection
  wouldHaveHitTarget: boolean;
  wouldHaveHitStop: boolean;
  counterfactualReturn: number | null;      // % return if taken
  counterfactualRMultiple: number | null;   // R-multiple if taken

  wasCorrectRejection: boolean;   // rejection prevented a loss
  wasIncorrectRejection: boolean; // rejection prevented a gain

  evaluatedAt: number;
}

// ─── Filter Performance Report ────────────────────────────────────────────────

export interface FilterPerformanceReport {
  filterCode: HardRejectionCode | string;
  filterType: "HARD" | "SOFT";

  totalRejected: number;
  rejectedAndWouldHaveLost: number;    // correct rejections
  rejectedAndWouldHaveWon: number;     // incorrect rejections
  rejectedAndUnknown: number;

  falseRejectionRate: number;          // rejectedAndWouldHaveWon / totalRejected
  trueRejectionRate: number;           // rejectedAndWouldHaveLost / totalRejected

  // Value computation
  avgSavedLossPct: number;             // avg % saved on correct rejections
  avgMissedGainPct: number;            // avg % missed on incorrect rejections
  netFilterValue: number;              // saved losses - missed gains (positive = filter adds value)

  // Recommendation
  recommendation: "KEEP" | "RELAX" | "REMOVE" | "TIGHTEN" | "INVESTIGATE";
  reasoning: string;

  sampleSizeAdequate: boolean;         // >= 30 rejections
}

// ─── Rejection Quality Summary ────────────────────────────────────────────────

export interface RejectionQualityReport {
  sessionDate: string;
  generatedAt: number;

  // Aggregate metrics
  totalRejections: number;
  correctRejections: number;    // prevented losses
  incorrectRejections: number;  // blocked profitable trades

  overallFalseRejectionRate: number;
  overallFalseAcceptanceRate: number;

  // Per-filter reports
  filterReports: FilterPerformanceReport[];

  // Top 3 best-performing filters (highest net value)
  bestFilters: FilterPerformanceReport[];
  // Top 3 worst-performing filters (lowest net value — consider relaxing)
  worstFilters: FilterPerformanceReport[];

  // Opportunity cost
  estimatedMissedGainTotal: number;  // total % of capital missed due to incorrect rejections
  estimatedSavedLossTotal: number;   // total % of capital saved by correct rejections
  netRejectionEngineValue: number;   // saved - missed (positive = system adds value overall)
}

// ─── Counterfactual Evaluator ─────────────────────────────────────────────────

/**
 * Evaluate a rejected opportunity's counterfactual outcome.
 * Requires post-event price data (actual high/low after rejection).
 */
export function evaluateCounterfactual(
  opportunityId: string,
  rejectionCode: HardRejectionCode | null,
  softPenaltyCodes: SoftPenaltyCode[],
  instrument: string,
  strategy: string,
  direction: "LONG" | "SHORT",
  entry: number,
  stopLoss: number,
  target1: number,
  timestamp: number,
  subsequentHigh: number | null,
  subsequentLow: number | null,
): CounterfactualRecord {
  let wouldHaveHitTarget = false;
  let wouldHaveHitStop = false;
  let counterfactualReturn: number | null = null;
  let counterfactualRMultiple: number | null = null;
  let outcome: CounterfactualOutcome = "UNKNOWN";

  if (subsequentHigh !== null && subsequentLow !== null) {
    if (direction === "LONG") {
      wouldHaveHitTarget = subsequentHigh >= target1;
      wouldHaveHitStop = subsequentLow <= stopLoss;
      // Conservative: if both hit, assume stop first (worst case)
      if (wouldHaveHitStop && wouldHaveHitTarget) {
        // Check which is more likely first based on direction
        wouldHaveHitStop = true;
        wouldHaveHitTarget = false;
      }
    } else {
      wouldHaveHitTarget = subsequentLow <= target1;
      wouldHaveHitStop = subsequentHigh >= stopLoss;
      if (wouldHaveHitStop && wouldHaveHitTarget) {
        wouldHaveHitStop = true;
        wouldHaveHitTarget = false;
      }
    }

    if (wouldHaveHitTarget) {
      counterfactualReturn = entry > 0 ? Math.abs(target1 - entry) / entry * 100 : null;
      const risk = entry > 0 ? Math.abs(entry - stopLoss) / entry * 100 : 1;
      counterfactualRMultiple = risk > 0 && counterfactualReturn !== null ? counterfactualReturn / risk : null;
      outcome = "WIN";
    } else if (wouldHaveHitStop) {
      counterfactualReturn = entry > 0 ? -Math.abs(entry - stopLoss) / entry * 100 : null;
      counterfactualRMultiple = -1;
      outcome = "LOSS";
    } else {
      outcome = "BREAKEVEN";
      counterfactualReturn = 0;
      counterfactualRMultiple = 0;
    }
  }

  const wasCorrectRejection = outcome === "LOSS";
  const wasIncorrectRejection = outcome === "WIN";

  return {
    opportunityId, rejectionCode, softPenaltyCodes, instrument, strategy, direction,
    entry, stopLoss, target1, timestamp,
    counterfactualOutcome: outcome,
    actualHighAfterRejection: subsequentHigh,
    actualLowAfterRejection: subsequentLow,
    wouldHaveHitTarget,
    wouldHaveHitStop,
    counterfactualReturn,
    counterfactualRMultiple,
    wasCorrectRejection,
    wasIncorrectRejection,
    evaluatedAt: Date.now(),
  };
}

// ─── Filter Performance Analyzer ─────────────────────────────────────────────

/**
 * Compute per-filter performance from a set of counterfactual records.
 */
export function analyzeFilterPerformance(
  filterCode: HardRejectionCode | string,
  filterType: "HARD" | "SOFT",
  records: CounterfactualRecord[],
): FilterPerformanceReport {
  const total = records.length;
  const won = records.filter(r => r.wasIncorrectRejection);
  const lost = records.filter(r => r.wasCorrectRejection);
  const unknown = records.filter(r => r.counterfactualOutcome === "UNKNOWN");

  const falseRejectionRate = total > 0 ? won.length / total : 0;
  const trueRejectionRate = total > 0 ? lost.length / total : 0;

  const savedLosses = lost.map(r => Math.abs(r.counterfactualReturn ?? 0));
  const missedGains = won.map(r => r.counterfactualReturn ?? 0);

  const avgSavedLossPct = savedLosses.length > 0
    ? savedLosses.reduce((a, b) => a + b, 0) / savedLosses.length : 0;
  const avgMissedGainPct = missedGains.length > 0
    ? missedGains.reduce((a, b) => a + b, 0) / missedGains.length : 0;

  // Net value: weighted by count
  const netFilterValue =
    (avgSavedLossPct * lost.length) - (avgMissedGainPct * won.length);

  let recommendation: FilterPerformanceReport["recommendation"];
  let reasoning: string;

  if (total < 10) {
    recommendation = "INVESTIGATE";
    reasoning = `Insufficient data (${total} rejections) — cannot evaluate`;
  } else if (netFilterValue > 0 && falseRejectionRate < 0.25) {
    recommendation = "KEEP";
    reasoning = `Net positive filter: saved ${avgSavedLossPct.toFixed(2)}%/trade, missed ${avgMissedGainPct.toFixed(2)}%/trade`;
  } else if (falseRejectionRate > 0.50) {
    recommendation = "RELAX";
    reasoning = `Too many incorrect rejections: ${(falseRejectionRate * 100).toFixed(0)}% of rejected trades would have won`;
  } else if (netFilterValue < -1.0 && total >= 30) {
    recommendation = "REMOVE";
    reasoning = `Net negative filter: costing ${Math.abs(netFilterValue).toFixed(2)}% per 100 trades in missed opportunities`;
  } else if (trueRejectionRate > 0.70 && netFilterValue > 0) {
    recommendation = "TIGHTEN";
    reasoning = `High precision filter — consider tightening for even better performance`;
  } else {
    recommendation = "KEEP";
    reasoning = `Marginally positive filter — monitor for more data`;
  }

  return {
    filterCode, filterType, totalRejected: total,
    rejectedAndWouldHaveLost: lost.length, rejectedAndWouldHaveWon: won.length,
    rejectedAndUnknown: unknown.length,
    falseRejectionRate, trueRejectionRate,
    avgSavedLossPct, avgMissedGainPct, netFilterValue,
    recommendation, reasoning,
    sampleSizeAdequate: total >= 30,
  };
}

// ─── Rejection Quality Report Builder ────────────────────────────────────────

export function buildRejectionQualityReport(
  sessionDate: string,
  allCounterfactuals: CounterfactualRecord[],
  acceptedTradeOutcomes: { won: boolean; pnlPct: number }[],
): RejectionQualityReport {
  // Aggregate metrics
  const correctRejections = allCounterfactuals.filter(r => r.wasCorrectRejection).length;
  const incorrectRejections = allCounterfactuals.filter(r => r.wasIncorrectRejection).length;
  const totalRejections = allCounterfactuals.length;

  const overallFalseRejectionRate = totalRejections > 0 ? incorrectRejections / totalRejections : 0;

  // False acceptance rate = accepted trades that lost / total accepted
  const totalAccepted = acceptedTradeOutcomes.length;
  const acceptedLosses = acceptedTradeOutcomes.filter(t => !t.won).length;
  const overallFalseAcceptanceRate = totalAccepted > 0 ? acceptedLosses / totalAccepted : 0;

  // Per hard rejection code
  const hardCodes = [...new Set(allCounterfactuals.map(r => r.rejectionCode).filter((c): c is HardRejectionCode => c !== null))];
  const filterReports: FilterPerformanceReport[] = hardCodes.map(code => {
    const forCode = allCounterfactuals.filter(r => r.rejectionCode === code);
    return analyzeFilterPerformance(code, "HARD", forCode);
  });

  // Sort for best/worst
  const sortedByNetValue = [...filterReports].sort((a, b) => b.netFilterValue - a.netFilterValue);
  const bestFilters = sortedByNetValue.slice(0, 3);
  const worstFilters = sortedByNetValue.slice(-3).reverse();

  // Totals
  const savedLosses = allCounterfactuals.filter(r => r.wasCorrectRejection)
    .map(r => Math.abs(r.counterfactualReturn ?? 0));
  const missedGains = allCounterfactuals.filter(r => r.wasIncorrectRejection)
    .map(r => r.counterfactualReturn ?? 0);

  const estimatedSavedLossTotal = savedLosses.reduce((a, b) => a + b, 0);
  const estimatedMissedGainTotal = missedGains.reduce((a, b) => a + b, 0);
  const netRejectionEngineValue = estimatedSavedLossTotal - estimatedMissedGainTotal;

  return {
    sessionDate, generatedAt: Date.now(),
    totalRejections, correctRejections, incorrectRejections,
    overallFalseRejectionRate, overallFalseAcceptanceRate,
    filterReports, bestFilters, worstFilters,
    estimatedMissedGainTotal, estimatedSavedLossTotal, netRejectionEngineValue,
  };
}
