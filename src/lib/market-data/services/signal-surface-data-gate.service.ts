/**
 * signal-surface-data-gate.service.ts — Data Foundation V7 §24/§25.
 *
 * A single fail-closed AUTHORITATIVE data veto for the three signal surfaces
 * that V6 left un-gated:
 *
 *   - SignalHistory ingest        (persists actionable signal rows)
 *   - A+ signal factory           (ranks/selects actionable opportunities)
 *   - ML inference decision path  (turns model output into a decision)
 *
 * It composes the EXISTING gate primitives — it does not invent new policy:
 *   - `evaluateGlobalDataState`      (data-gate.ts): combines dependency
 *     availability into DATA_READY / DATA_DEGRADED / DATA_BLOCKED.
 *   - `evaluateSnapshotConsistency`  (data-gate.ts): cross-field timestamp skew.
 *   - `evaluateProducerDataGate`     (producer-data-gate.service): REAL persisted
 *     history sufficiency for an NSE symbol+interval, when applicable.
 *
 * SCOPE (unchanged from V5/V6): this is a DATA veto ONLY. It never reads or
 * changes any ML threshold, EV, calibrated probability, signal score, A+
 * criterion, or profitability rule. It can only BLOCK on missing / stale /
 * insufficient / incoherent data. It NEVER relaxes an existing gate. It never
 * throws — any internal error fails CLOSED (blocked).
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import type { Interval } from "../types";
import type { DataAvailabilityStatus } from "../data-availability";
import {
  evaluateGlobalDataState,
  evaluateSnapshotConsistency,
  type DataDependency,
  type SnapshotField,
} from "../data-gate";
import { evaluateProducerDataGate } from "./producer-data-gate.service";

export interface SurfaceGateInput {
  /** Label of the surface being gated (for diagnostics). */
  surface: "SignalHistory" | "APlusFactory" | "MLInference";
  /**
   * The data dependencies this decision rests on, each with an availability
   * status + whether it is critical. Supplied by the caller from what it
   * actually consumed (candles, options, oi, iv, niftyContext, …).
   */
  dependencies?: DataDependency[];
  /**
   * Timestamped snapshot fields for cross-field coherence (§22). Only critical
   * fields drive the skew veto.
   */
  snapshotFields?: SnapshotField[];
  /** Max allowed cross-field skew (ms). Default from data-gate. */
  maxSkewMs?: number;
  /**
   * Optional NSE history check: when set, the surface's instrument must have
   * enough REAL persisted bars for `requiredBars` on `interval` (feature
   * warm-up). Skipped for non-NSE / crypto symbols.
   */
  history?: {
    instrumentId: string;
    exchange?: string;
    interval: Interval;
    requiredBars: number;
  };
  prisma?: PrismaClient;
}

export interface SurfaceGateResult {
  allowed: boolean;
  surface: string;
  /** DATA_READY | DATA_DEGRADED | DATA_BLOCKED */
  globalState: string;
  reason: string;
  blockedBy: string[];
  degradedBy: string[];
  snapshotConsistent: boolean;
}

/**
 * Evaluate the fail-closed authoritative data gate for a signal surface.
 * Returns allowed=false on ANY hard data problem (critical dependency
 * unavailable, snapshot skew exceeded, insufficient history). Never throws.
 */
export async function evaluateSignalSurfaceDataGate(
  input: SurfaceGateInput,
): Promise<SurfaceGateResult> {
  try {
    const deps: DataDependency[] = [...(input.dependencies ?? [])];

    // Optional real-history dependency (NSE symbols only).
    if (input.history) {
      const gate = await evaluateProducerDataGate({
        instrumentId: input.history.instrumentId,
        exchange: input.history.exchange ?? "NSE",
        interval: input.history.interval,
        requiredBars: input.history.requiredBars,
        requireFullyReady: false,
        prisma: input.prisma,
      });
      const status: DataAvailabilityStatus = gate.status;
      deps.push({ name: `history_${input.history.interval}`, status, critical: true });
    }

    // Snapshot coherence (only when fields provided).
    const snap = input.snapshotFields && input.snapshotFields.length > 0
      ? evaluateSnapshotConsistency(input.snapshotFields, input.maxSkewMs)
      : { consistent: true, reason: null as string | null };

    // Global data state from the dependencies. When no dependencies were
    // supplied AND no snapshot fields, we cannot verify → fail closed.
    if (deps.length === 0 && (!input.snapshotFields || input.snapshotFields.length === 0)) {
      return {
        allowed: false,
        surface: input.surface,
        globalState: "DATA_BLOCKED",
        reason: "no data dependencies supplied — cannot verify (fail-closed)",
        blockedBy: ["no_dependencies"],
        degradedBy: [],
        snapshotConsistent: true,
      };
    }

    const decision =
      deps.length > 0
        ? evaluateGlobalDataState(deps)
        : { state: "DATA_READY" as const, tradable: true, blockedBy: [], degradedBy: [], reason: "no dependencies" };

    const snapshotConsistent = snap.consistent;
    // Fail closed on: DATA_BLOCKED (critical dep unavailable) OR snapshot skew.
    const allowed = decision.state !== "DATA_BLOCKED" && snapshotConsistent;

    const reason = !snapshotConsistent
      ? `snapshot inconsistent: ${snap.reason ?? "skew exceeded"}`
      : decision.state === "DATA_BLOCKED"
        ? decision.reason
        : decision.state === "DATA_DEGRADED"
          ? `allowed under DATA_DEGRADED: ${decision.reason}`
          : "all data dependencies healthy";

    return {
      allowed,
      surface: input.surface,
      globalState: snapshotConsistent ? decision.state : "DATA_BLOCKED",
      reason,
      blockedBy: decision.blockedBy,
      degradedBy: decision.degradedBy,
      snapshotConsistent,
    };
  } catch (err) {
    return {
      allowed: false,
      surface: input.surface,
      globalState: "DATA_BLOCKED",
      reason: `gate evaluation failed (fail-closed): ${(err as Error).message}`,
      blockedBy: ["gate_error"],
      degradedBy: [],
      snapshotConsistent: false,
    };
  }
}
