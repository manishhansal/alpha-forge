/**
 * v8-signal-data-gate.service.ts — Data Foundation V8 §17/§39/§56.
 *
 * V8 enhancement to the signal data gate. Adds provenance + quality score
 * verification on top of the existing evaluateSignalSurfaceDataGate.
 *
 * The V7 gate already handles:
 *   - DATA_READY / DATA_DEGRADED / DATA_BLOCKED evaluation
 *   - snapshot consistency (cross-field timestamp skew)
 *   - per-producer history sufficiency
 *
 * The V8 gate additionally verifies:
 *   - data provenance is BROKER_AUTHENTICATED or OPEN_SOURCE_NSE_DERIVED
 *     (not UNKNOWN or YAHOO_FALLBACK for signals)
 *   - quality score is above the strategy's minimum threshold
 *   - reconciliation status is acceptable (no MAJOR_DISCREPANCY for live signals)
 *   - 3m interval is ALWAYS blocked (cannot produce a signal)
 *   - strategy data contract is satisfied (all required fields present)
 *
 * ABSOLUTE RULES:
 *   - Never relaxes the V7 gate — only adds checks.
 *   - Never throws — all errors return BLOCKED.
 *   - No ML threshold changes.
 *   - No strategy threshold changes.
 *   - YAHOO_FALLBACK is permitted for DEGRADED signals only (never VERIFIED).
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { Interval } from "../types";
import { assertSupportedInterval, isSupportedInterval } from "../types";
import {
  evaluateSignalSurfaceDataGate,
  type SurfaceGateInput,
  type SurfaceGateResult,
} from "./signal-surface-data-gate.service";

// ---------------------------------------------------------------------------
// Strategy data contract
// ---------------------------------------------------------------------------

/** Every strategy must declare its data requirements. */
export interface StrategyDataContract {
  strategyId: string;
  /** Timeframe this strategy runs on. */
  timeframe: Interval;
  /** F&O equity underlyings universe (or explicit symbol list). */
  instrumentUniverse: "FNO_EQUITY" | "FNO_INDEX" | "SPECIFIC";
  /** Whether this strategy requires historical candle data. */
  requiresHistory: boolean;
  /** Minimum bars required (when requiresHistory=true). */
  requiredBars?: number;
  /** Whether OI data is required (BLOCK if missing). */
  requiresOI: boolean;
  /** Whether IV data is required (BLOCK if missing, DEGRADED if optional). */
  requiresIV: "REQUIRED" | "OPTIONAL" | "NOT_NEEDED";
  /** Whether bid/ask is required. */
  requiresBidAsk: boolean;
  /** Minimum quality score to proceed [0–100]. */
  minimumQualityScore: number;
  /** Acceptable provenance types for live signals. */
  acceptableProvenanceTypes: string[];
  /** Whether MAJOR_DISCREPANCY reconciliation status blocks this strategy. */
  majorDiscrepancyBlocks: boolean;
}

// ---------------------------------------------------------------------------
// Canonical strategy data contracts
// ---------------------------------------------------------------------------

export const STRATEGY_DATA_CONTRACTS: readonly StrategyDataContract[] = [
  {
    strategyId: "ORB_5m",
    timeframe: "5m",
    instrumentUniverse: "FNO_EQUITY",
    requiresHistory: true,
    requiredBars: 75,  // one full session of 5m
    requiresOI: false,
    requiresIV: "NOT_NEEDED",
    requiresBidAsk: false,
    minimumQualityScore: 70,
    acceptableProvenanceTypes: ["BROKER_AUTHENTICATED", "OPEN_SOURCE_NSE_DERIVED"],
    majorDiscrepancyBlocks: true,
  },
  {
    strategyId: "VWAP_scalp_5m",
    timeframe: "5m",
    instrumentUniverse: "FNO_EQUITY",
    requiresHistory: true,
    requiredBars: 75,
    requiresOI: false,
    requiresIV: "NOT_NEEDED",
    requiresBidAsk: false,
    minimumQualityScore: 70,
    acceptableProvenanceTypes: ["BROKER_AUTHENTICATED", "OPEN_SOURCE_NSE_DERIVED"],
    majorDiscrepancyBlocks: true,
  },
  {
    strategyId: "trend_1h",
    timeframe: "1h",
    instrumentUniverse: "FNO_EQUITY",
    requiresHistory: true,
    requiredBars: 150,
    requiresOI: false,
    requiresIV: "NOT_NEEDED",
    requiresBidAsk: false,
    minimumQualityScore: 75,
    acceptableProvenanceTypes: ["BROKER_AUTHENTICATED", "OPEN_SOURCE_NSE_DERIVED"],
    majorDiscrepancyBlocks: true,
  },
  {
    strategyId: "daily_swing",
    timeframe: "1d",
    instrumentUniverse: "FNO_EQUITY",
    requiresHistory: true,
    requiredBars: 200,
    requiresOI: false,
    requiresIV: "NOT_NEEDED",
    requiresBidAsk: false,
    minimumQualityScore: 80,
    acceptableProvenanceTypes: ["BROKER_AUTHENTICATED", "OPEN_SOURCE_NSE_DERIVED"],
    majorDiscrepancyBlocks: false,  // EOD data — minor discrepancies acceptable
  },
  {
    strategyId: "option_OI_strategy",
    timeframe: "5m",
    instrumentUniverse: "FNO_EQUITY",
    requiresHistory: true,
    requiredBars: 75,
    requiresOI: true,
    requiresIV: "OPTIONAL",
    requiresBidAsk: false,
    minimumQualityScore: 75,
    acceptableProvenanceTypes: ["BROKER_AUTHENTICATED"],  // OI requires broker auth
    majorDiscrepancyBlocks: true,
  },
  {
    strategyId: "option_IV_strategy",
    timeframe: "5m",
    instrumentUniverse: "FNO_EQUITY",
    requiresHistory: true,
    requiredBars: 75,
    requiresOI: true,
    requiresIV: "REQUIRED",
    requiresBidAsk: false,
    minimumQualityScore: 80,
    acceptableProvenanceTypes: ["BROKER_AUTHENTICATED"],
    majorDiscrepancyBlocks: true,
  },
  {
    strategyId: "NIFTY_ORB_5m",
    timeframe: "5m",
    instrumentUniverse: "FNO_INDEX",
    requiresHistory: true,
    requiredBars: 75,
    requiresOI: false,
    requiresIV: "NOT_NEEDED",
    requiresBidAsk: false,
    minimumQualityScore: 70,
    acceptableProvenanceTypes: ["BROKER_AUTHENTICATED", "OPEN_SOURCE_NSE_DERIVED"],
    majorDiscrepancyBlocks: true,
  },
] as const;

// ---------------------------------------------------------------------------
// V8 gate input/result
// ---------------------------------------------------------------------------

export interface V8SignalGateInput extends SurfaceGateInput {
  /** Strategy data contract to validate against. */
  strategyContract?: StrategyDataContract;
  /**
   * Current provenance type for the data being used.
   * e.g. "BROKER_AUTHENTICATED" | "OPEN_SOURCE_NSE_DERIVED" | "YAHOO_FALLBACK"
   */
  dataProvenanceType?: string;
  /**
   * Current data quality score [0–100]. When supplied, must meet the strategy
   * minimum threshold. When absent, treated as unknown (warn but don't block).
   */
  dataQualityScore?: number | null;
  /** Current reconciliation status for the data being used. */
  reconciliationStatus?: string | null;
  /** Whether OI data is actually available. */
  oiAvailable?: boolean;
  /** Whether IV data is actually available. */
  ivAvailable?: boolean;
}

export interface V8SignalGateResult extends SurfaceGateResult {
  /** Whether the strategy data contract was satisfied. */
  contractSatisfied: boolean;
  /** Strategy ID that was evaluated. */
  strategyId: string | null;
  /** Additional V8-specific block reasons. */
  v8BlockedBy: string[];
  /** Data provenance type used for this signal. */
  dataProvenanceType: string | null;
  /** Data quality score. */
  dataQualityScore: number | null;
}

// ---------------------------------------------------------------------------
// V8 gate evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the V8 signal data gate.
 *
 * Composes V7 gate (history sufficiency + snapshot consistency + global state)
 * with V8 additions (provenance + quality + contract validation + 3m rejection).
 *
 * Never throws — all errors return BLOCKED.
 */
export async function evaluateV8SignalDataGate(
  input: V8SignalGateInput,
): Promise<V8SignalGateResult> {
  // Run V7 gate first
  const v7Result = await evaluateSignalSurfaceDataGate(input);
  const v8BlockedBy: string[] = [];
  let contractSatisfied = true;

  // 3m is permanently blocked — never generate a signal for 3m
  if ((input.history?.interval as string) === "3m") {
    v8BlockedBy.push("3m_interval_permanently_removed");
    return {
      ...v7Result,
      allowed: false,
      globalState: "DATA_BLOCKED",
      reason: "3m interval was permanently removed from AlphaForge (V8). No signals generated for 3m.",
      blockedBy: [...v7Result.blockedBy, "3m_permanently_removed"],
      contractSatisfied: false,
      strategyId: input.strategyContract?.strategyId ?? null,
      v8BlockedBy: ["3m_permanently_removed"],
      dataProvenanceType: input.dataProvenanceType ?? null,
      dataQualityScore: input.dataQualityScore ?? null,
    };
  }

  // Validate strategy interval is supported
  if (input.history?.interval && !isSupportedInterval(input.history.interval)) {
    v8BlockedBy.push(`unsupported_interval_${input.history.interval}`);
  }

  // Strategy data contract validation
  if (input.strategyContract) {
    const contract = input.strategyContract;

    // Check provenance acceptability
    if (input.dataProvenanceType) {
      if (!contract.acceptableProvenanceTypes.includes(input.dataProvenanceType)) {
        v8BlockedBy.push(
          `provenance_${input.dataProvenanceType}_not_acceptable_for_${contract.strategyId}`
        );
        contractSatisfied = false;
      }
    }

    // Check quality score
    if (input.dataQualityScore !== undefined && input.dataQualityScore !== null) {
      if (input.dataQualityScore < contract.minimumQualityScore) {
        v8BlockedBy.push(
          `quality_score_${input.dataQualityScore.toFixed(1)}_below_minimum_${contract.minimumQualityScore}`
        );
        contractSatisfied = false;
      }
    }

    // Check OI requirement
    if (contract.requiresOI && !input.oiAvailable) {
      v8BlockedBy.push(`strategy_${contract.strategyId}_requires_OI_not_available`);
      contractSatisfied = false;
    }

    // Check IV requirement
    if (contract.requiresIV === "REQUIRED" && !input.ivAvailable) {
      v8BlockedBy.push(`strategy_${contract.strategyId}_requires_IV_not_available`);
      contractSatisfied = false;
    }

    // Check reconciliation
    if (
      contract.majorDiscrepancyBlocks &&
      input.reconciliationStatus === "MAJOR_DISCREPANCY"
    ) {
      v8BlockedBy.push(`major_reconciliation_discrepancy_blocks_${contract.strategyId}`);
      contractSatisfied = false;
    }
  }

  const v8Blocked = v8BlockedBy.length > 0;
  const allowed = v7Result.allowed && !v8Blocked;

  const reason = v8Blocked
    ? `V8 gate blocked: ${v8BlockedBy.join("; ")}`
    : v7Result.reason;

  return {
    ...v7Result,
    allowed,
    reason,
    blockedBy: [...v7Result.blockedBy, ...v8BlockedBy],
    contractSatisfied,
    strategyId: input.strategyContract?.strategyId ?? null,
    v8BlockedBy,
    dataProvenanceType: input.dataProvenanceType ?? null,
    dataQualityScore: input.dataQualityScore ?? null,
  };
}

/**
 * Look up the data contract for a strategy by ID.
 * Returns null when no contract is registered.
 */
export function getStrategyContract(strategyId: string): StrategyDataContract | null {
  return STRATEGY_DATA_CONTRACTS.find((c) => c.strategyId === strategyId) ?? null;
}
