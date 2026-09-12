import "server-only";

import type { PrismaClient } from "@prisma/client";

import type { Interval } from "../market-data/types";
import type { DataAvailabilityStatus } from "../market-data/data-availability";
import type { DataDependency, SnapshotField } from "../market-data/data-gate";
import {
  evaluateSignalSurfaceDataGate,
  type SurfaceGateResult,
} from "../market-data/services/signal-surface-data-gate.service";
import { requiredBarsForTimeframe } from "../market-data/services/feature-lookback.service";

import type { MetaModelArtifact } from "./ml-meta-decision";
import {
  evaluateShadow,
  type CanonicalCandidate,
  type ShadowDecision,
} from "./shadow-intelligence";

/**
 * shadow-data-gate.ts — Data Foundation §21 live-builder ↔ data-gate wiring.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the PRODUCTION integration point the audit found missing: nothing
 * computed and passed `evaluateShadow`'s `dataGateVeto`, so the A+ factory and
 * the ML inference decision path were not runtime-gated by the authoritative
 * (DB-backed) data gate — only by the candidate's self-reported flags.
 *
 * `evaluateShadowWithDataGate` closes that gap. For a canonical candidate it:
 *   1. Builds the authoritative gate inputs from what the candidate ACTUALLY
 *      consumed (its data dependencies + timestamped snapshot fields), plus an
 *      optional REAL persisted-history sufficiency check for NSE symbols.
 *   2. Calls `evaluateSignalSurfaceDataGate` (fail-closed, never throws).
 *   3. Derives a `dataGateVeto { blocked, insufficient, reason }` from the
 *      verdict and passes it into `evaluateShadow`, where it can ONLY strengthen
 *      the data veto (OR-ed into criticalDataIssue / insufficientData). It never
 *      relaxes a gate and never touches EV / probability / score.
 *
 * SCOPE: pure orchestration + a DATA veto. No ML model, threshold, EV, or
 * signal-scoring change. Fail-closed: any gate problem forces the veto ON.
 */

/** Everything the caller must supply about the data the candidate consumed. */
export interface ShadowDataGateInput {
  /** Which un-gated surface this decision feeds (for diagnostics/audit). */
  surface: "APlusFactory" | "MLInference" | "SignalHistory";
  /**
   * The data dependencies the candidate actually consumed, each with its
   * availability status + whether it is critical for THIS strategy. Example:
   * price ohlcv (critical), option OI (critical for an OI strategy), IV
   * (optional for a price strategy), niftyContext (optional).
   */
  dependencies?: DataDependency[];
  /**
   * Timestamped snapshot fields for cross-field coherence (§18). Only the
   * CRITICAL fields drive the skew veto. Supply the real data timestamps of the
   * price/option/context inputs so a stale-price + fresh-OI mix is rejected.
   */
  snapshotFields?: SnapshotField[];
  /** Max allowed cross-field skew (ms). Defaults to the data-gate default. */
  maxSkewMs?: number;
  /**
   * Optional REAL history sufficiency check. When supplied, the candidate's
   * instrument must have enough persisted bars for `interval` (feature warm-up).
   * `requiredBars` defaults to the feature-lookback requirement for the
   * timeframe when omitted. Skipped for non-NSE symbols.
   */
  history?: {
    instrumentId: string;
    exchange?: string;
    interval: Interval;
    requiredBars?: number;
  };
  prisma?: PrismaClient;
}

export interface ShadowWithGateResult {
  decision: ShadowDecision;
  gate: SurfaceGateResult;
  /** The veto that was passed into evaluateShadow (audit trail). */
  dataGateVeto: { blocked: boolean; insufficient: boolean; reason?: string };
}

/**
 * Statuses that mean the dependency could not be trusted at all — the gate
 * treats a CRITICAL one of these as DATA_BLOCKED. Mirrors the data-availability
 * non-tradable set; kept local so this module has no coupling to its internals.
 */
const INSUFFICIENT_STATUSES: ReadonlySet<DataAvailabilityStatus> = new Set([
  "INSUFFICIENT_HISTORY",
]);

/**
 * Derive the `dataGateVeto` from an authoritative surface-gate verdict.
 *
 *   - blocked      ⇐ gate not allowed (critical dep unavailable, snapshot skew,
 *                    or a fail-closed internal error).
 *   - insufficient ⇐ any dependency reported INSUFFICIENT_HISTORY, OR the gate
 *                    blocked specifically on a history_* dependency.
 *
 * Both can only ADD a block downstream; neither ever clears one.
 */
export function deriveDataGateVeto(
  gate: SurfaceGateResult,
  dependencies: DataDependency[] = [],
): { blocked: boolean; insufficient: boolean; reason?: string } {
  const historyBlocked = gate.blockedBy.some((b) => b.startsWith("history_"));
  const depInsufficient = dependencies.some((d) => INSUFFICIENT_STATUSES.has(d.status));
  const blocked = !gate.allowed;
  const insufficient = depInsufficient || historyBlocked;
  return {
    blocked,
    insufficient,
    reason: blocked || insufficient ? gate.reason : undefined,
  };
}

/**
 * Evaluate a canonical candidate through the authoritative data gate FIRST,
 * then through the full shadow pipeline with the resulting fail-closed veto.
 *
 * This is the single production entry the live builder / worker should call so
 * the A+ factory + ML decision path can never emit a TRADE on data the
 * authoritative gate rejected. Never throws (the gate itself fails closed).
 */
export async function evaluateShadowWithDataGate(
  candidate: CanonicalCandidate,
  artifact: MetaModelArtifact,
  gateInput: ShadowDataGateInput,
  cluster: CanonicalCandidate[] = [],
): Promise<ShadowWithGateResult> {
  const dependencies = gateInput.dependencies ?? [];

  const history = gateInput.history
    ? {
        instrumentId: gateInput.history.instrumentId,
        exchange: gateInput.history.exchange,
        interval: gateInput.history.interval,
        requiredBars:
          gateInput.history.requiredBars ??
          requiredBarsForTimeframe(gateInput.history.interval),
      }
    : undefined;

  const gate = await evaluateSignalSurfaceDataGate({
    surface: gateInput.surface,
    dependencies,
    snapshotFields: gateInput.snapshotFields,
    maxSkewMs: gateInput.maxSkewMs,
    history,
    prisma: gateInput.prisma,
  });

  const dataGateVeto = deriveDataGateVeto(gate, dependencies);

  const decision = evaluateShadow(candidate, artifact, cluster, dataGateVeto);

  return { decision, gate, dataGateVeto };
}
