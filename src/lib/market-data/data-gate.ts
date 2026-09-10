/**
 * data-gate.ts — Data Foundation V2, Phases 40 / 65 / 66.
 *
 * Two fail-closed gates that sit between the data layer and the signal engine.
 * Both are PURE functions of data facts — they do NOT read ML/ signal / A+ /
 * profitability thresholds and do NOT weaken any existing signal gate. They add
 * a data-integrity veto ON TOP of whatever the signal engine already does.
 *
 *   1. Snapshot consistency gate (Phase 40): all inputs to one signal must
 *      represent approximately the same market moment. If the cross-field
 *      timestamp skew exceeds tolerance, return DATA_SNAPSHOT_INCONSISTENT so a
 *      dependent signal is vetoed (Absolute Rule 14 — never mix incompatible
 *      timestamps in a signal snapshot).
 *
 *   2. Global data state (Phase 65/66): combine the availability statuses of a
 *      signal's data dependencies into ONE of DATA_READY / DATA_DEGRADED /
 *      DATA_BLOCKED. DATA_BLOCKED ⇒ NO SIGNAL. DATA_DEGRADED ⇒ only strategies
 *      whose CRITICAL fields remain healthy may operate.
 */

import type { DataAvailabilityStatus } from "./data-availability";
import { NON_TRADABLE_STATUSES } from "./data-availability";

// ── Snapshot consistency gate (Phase 40) ───────────────────────────────────

/** A single timestamped field that feeds a signal snapshot. */
export type SnapshotField = {
  /** Field label, e.g. "stockLtp", "niftyClose", "oi", "iv". */
  name: string;
  /** UTC epoch milliseconds of THIS field's data timestamp. */
  timestampMs: number;
  /** Whether the strategy actually requires this field (critical vs optional). */
  critical: boolean;
};

export type SnapshotConsistencyResult = {
  consistent: boolean;
  /** Max − min timestamp across the CRITICAL fields (ms). */
  skewMs: number;
  toleranceMs: number;
  status: "AVAILABLE" | "DATA_SNAPSHOT_INCONSISTENT";
  /** The critical fields sorted oldest-first (for diagnostics). */
  oldestField: string | null;
  newestField: string | null;
  reason: string | null;
};

/**
 * Default max cross-field skew (ms). Chosen conservatively: a signal snapshot
 * whose critical inputs span more than this are not the "same market moment".
 * Callers may override per strategy.
 */
export const DEFAULT_MAX_SNAPSHOT_SKEW_MS = 60_000; // 60s

/**
 * Evaluate whether the CRITICAL fields of a snapshot are close enough in time.
 * Optional fields are ignored for the skew computation (a stale optional field
 * should degrade, not veto — handled by the caller's field criticality).
 */
export function evaluateSnapshotConsistency(
  fields: SnapshotField[],
  toleranceMs: number = DEFAULT_MAX_SNAPSHOT_SKEW_MS,
): SnapshotConsistencyResult {
  const critical = fields.filter(
    (f) => f.critical && Number.isFinite(f.timestampMs),
  );
  if (critical.length <= 1) {
    return {
      consistent: true,
      skewMs: 0,
      toleranceMs,
      status: "AVAILABLE",
      oldestField: critical[0]?.name ?? null,
      newestField: critical[0]?.name ?? null,
      reason: null,
    };
  }

  let min = critical[0]!;
  let max = critical[0]!;
  for (const f of critical) {
    if (f.timestampMs < min.timestampMs) min = f;
    if (f.timestampMs > max.timestampMs) max = f;
  }
  const skewMs = max.timestampMs - min.timestampMs;
  const consistent = skewMs <= toleranceMs;

  return {
    consistent,
    skewMs,
    toleranceMs,
    status: consistent ? "AVAILABLE" : "DATA_SNAPSHOT_INCONSISTENT",
    oldestField: min.name,
    newestField: max.name,
    reason: consistent
      ? null
      : `critical-field skew ${skewMs}ms > ${toleranceMs}ms (${min.name} vs ${max.name})`,
  };
}

// ── Global data state (Phase 65/66) ─────────────────────────────────────────

export type GlobalDataState = "DATA_READY" | "DATA_DEGRADED" | "DATA_BLOCKED";

/** One data dependency of a signal, with its availability status + criticality. */
export type DataDependency = {
  /** Field/feed label, e.g. "ohlcv", "optionChain", "oi", "iv", "niftyContext". */
  name: string;
  status: DataAvailabilityStatus;
  /** Critical dependencies BLOCK the signal when unhealthy; optional DEGRADE. */
  critical: boolean;
};

export type GlobalDataDecision = {
  state: GlobalDataState;
  /** True only when state === DATA_READY. */
  tradable: boolean;
  /** Critical dependencies that are not tradable (drive DATA_BLOCKED). */
  blockedBy: string[];
  /** Non-critical dependencies that are unhealthy (drive DATA_DEGRADED). */
  degradedBy: string[];
  reason: string;
};

/**
 * Combine data dependencies into a fail-closed global state.
 *
 *   - Any CRITICAL dependency with a non-tradable status ⇒ DATA_BLOCKED
 *     (NO SIGNAL — Rule 15).
 *   - Else any dependency (critical or optional) that is STALE/PARTIAL, or any
 *     OPTIONAL dependency that is non-tradable ⇒ DATA_DEGRADED (only strategies
 *     whose critical fields are healthy may operate).
 *   - Else ⇒ DATA_READY.
 *
 * A dependency status counts as "unhealthy" via `NON_TRADABLE_STATUSES` (the
 * hard vetoes) plus STALE/PARTIAL (soft degradations).
 */
export function evaluateGlobalDataState(
  deps: DataDependency[],
): GlobalDataDecision {
  const blockedBy: string[] = [];
  const degradedBy: string[] = [];

  for (const dep of deps) {
    const hardUnhealthy = NON_TRADABLE_STATUSES.has(dep.status);
    const softUnhealthy = dep.status === "STALE" || dep.status === "PARTIAL";

    if (dep.critical && hardUnhealthy) {
      blockedBy.push(`${dep.name}:${dep.status}`);
    } else if (hardUnhealthy || softUnhealthy) {
      // Optional-but-hard-unhealthy or anything soft-unhealthy → degrade.
      degradedBy.push(`${dep.name}:${dep.status}`);
    }
  }

  if (blockedBy.length > 0) {
    return {
      state: "DATA_BLOCKED",
      tradable: false,
      blockedBy,
      degradedBy,
      reason: `critical data unavailable: ${blockedBy.join(", ")}`,
    };
  }
  if (degradedBy.length > 0) {
    return {
      state: "DATA_DEGRADED",
      tradable: false, // DATA_READY is required for the unconditional-tradable flag
      blockedBy,
      degradedBy,
      reason: `non-critical data issues: ${degradedBy.join(", ")}`,
    };
  }
  return {
    state: "DATA_READY",
    tradable: true,
    blockedBy,
    degradedBy,
    reason: "all data dependencies healthy",
  };
}

/**
 * Fail-closed helper: may a strategy with the given critical dependencies
 * operate right now? Returns true only when NONE of ITS critical deps are
 * blocked. Usable under DATA_DEGRADED so a strategy whose own critical fields
 * are healthy can still run while others are halted (Phase 66).
 */
export function strategyMayOperate(criticalDeps: DataDependency[]): {
  allowed: boolean;
  reason: string;
} {
  const blocked = criticalDeps
    .filter((d) => d.critical && NON_TRADABLE_STATUSES.has(d.status))
    .map((d) => `${d.name}:${d.status}`);
  if (blocked.length > 0) {
    return { allowed: false, reason: `critical data veto: ${blocked.join(", ")}` };
  }
  return { allowed: true, reason: "critical data healthy" };
}
