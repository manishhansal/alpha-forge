/**
 * data-gate-enforcement.service.ts — Data Foundation V4 §21/§22.
 *
 * A thin, reusable ENFORCEMENT wrapper that composes the V2 data-gate functions
 * (`evaluateGlobalDataState`, `strategyMayOperate`, `evaluateSnapshotConsistency`)
 * with the V2 status-aware reads, so any signal/paper-trade producer can enforce
 * the data contract with a single call instead of hand-rolling dependency checks.
 *
 * IMPORTANT SCOPE NOTE: this module does NOT read or alter any ML / signal / A+ /
 * EV / profitability / strategy threshold. It only turns data-availability FACTS
 * into a fail-closed allow/deny decision (a data-integrity veto ON TOP of the
 * strategy's own logic). Wiring it into a specific producer is a deliberate,
 * operator-visible step because it can legitimately HALT trading when data is
 * insufficient — which is exactly the point (§22), but must be adopted knowingly.
 *
 * The V3 baseline + the V4 context map both confirm these gate functions had
 * ZERO production call sites (D-V4-16). This helper is the migration surface.
 */

import "server-only";

import {
  evaluateGlobalDataState,
  evaluateSnapshotConsistency,
  strategyMayOperate,
  type DataDependency,
  type SnapshotField,
  type GlobalDataState,
} from "../data-gate";
import type { DataAvailabilityStatus } from "../data-availability";

export interface GateDecision {
  /** May the producer emit a signal / open a trade right now? */
  allowed: boolean;
  state: GlobalDataState;
  /** DATA_SNAPSHOT_INCONSISTENT when critical-field skew exceeds tolerance. */
  snapshotConsistent: boolean;
  blockedBy: string[];
  degradedBy: string[];
  reason: string;
}

export interface EnforceGateInput {
  /**
   * The signal's data dependencies with their real availability status. Build
   * these from the `*WithStatus` reads (e.g. the `.status` of
   * getHistoricalCandlesWithStatus / getOptionChainWithStatus).
   */
  dependencies: DataDependency[];
  /**
   * Optional timestamped snapshot fields — when supplied, cross-field skew is
   * checked and an inconsistent snapshot forces a block.
   */
  snapshotFields?: SnapshotField[];
  snapshotToleranceMs?: number;
  /**
   * When true (default), operate under strict global state: DATA_READY only.
   * When false, allow a strategy to run under DATA_DEGRADED provided ITS OWN
   * critical dependencies are healthy (`strategyMayOperate`, Phase 66).
   */
  requireFullyReady?: boolean;
}

/**
 * Fail-closed data-contract enforcement. Returns `allowed:false` whenever a
 * critical dependency is non-tradable, or (in strict mode) the global state is
 * not DATA_READY, or the snapshot is time-inconsistent. Never throws.
 */
export function enforceDataGate(input: EnforceGateInput): GateDecision {
  const requireFullyReady = input.requireFullyReady ?? true;

  // 1. Snapshot consistency (if fields provided).
  let snapshotConsistent = true;
  let snapshotReason: string | null = null;
  if (input.snapshotFields && input.snapshotFields.length > 0) {
    const snap = evaluateSnapshotConsistency(input.snapshotFields, input.snapshotToleranceMs);
    snapshotConsistent = snap.consistent;
    snapshotReason = snap.reason;
  }

  // 2. Global data state.
  const global = evaluateGlobalDataState(input.dependencies);

  // 3. Strategy-scoped allowance (used when not requiring full readiness).
  const criticalDeps = input.dependencies.filter((d) => d.critical);
  const strat = strategyMayOperate(criticalDeps);

  let allowed: boolean;
  let reason: string;
  if (!snapshotConsistent) {
    allowed = false;
    reason = snapshotReason ?? "snapshot inconsistent";
  } else if (global.state === "DATA_BLOCKED") {
    allowed = false;
    reason = global.reason;
  } else if (requireFullyReady) {
    allowed = global.state === "DATA_READY";
    reason = allowed ? "DATA_READY" : global.reason;
  } else {
    // Permit under DATA_DEGRADED iff this strategy's own critical deps are healthy.
    allowed = strat.allowed;
    reason = strat.allowed ? `operating under ${global.state}: ${strat.reason}` : strat.reason;
  }

  return {
    allowed,
    state: global.state,
    snapshotConsistent,
    blockedBy: global.blockedBy,
    degradedBy: global.degradedBy,
    reason,
  };
}

/** Convenience: build a DataDependency from a `*WithStatus` status. */
export function dependencyFromStatus(
  name: string,
  status: DataAvailabilityStatus,
  critical: boolean,
): DataDependency {
  return { name, status, critical };
}
