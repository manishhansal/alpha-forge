/**
 * producer-data-gate.service.ts — Data Foundation V6 §20/§21/§22.
 *
 * A single, reusable, fail-closed data-integrity veto for SIGNAL PRODUCERS. It
 * standardises the idiom first wired into `india-scalper` (V5 §60) so every
 * producer that can emit / persist / execute a trading signal gates identically
 * instead of hand-rolling per-producer checks (§20 — wire EVERY producer).
 *
 * It composes:
 *   - `checkHistorySufficiency` (coverage.service) — REAL persisted-candle
 *     feature warm-up: returns INSUFFICIENT_HISTORY with required/available/
 *     missing bars when a strategy's warm-up window is not covered (§6/§21).
 *   - `enforceDataGate` (data-gate-enforcement.service) — turns the resulting
 *     availability status into an allow/deny decision (§17/§20).
 *
 * SCOPE (unchanged from V5): this module does NOT read or alter any ML / signal
 * / A+ / EV / profitability / strategy threshold. It is a DATA veto ON TOP of
 * whatever the strategy already decides — it can only ever BLOCK on missing /
 * insufficient / stale / invalid data, never relax a strategy rule.
 *
 * It never throws: a gate-read failure is itself treated as "cannot verify data"
 * and fails CLOSED (blocked) unless the caller opts into fail-open for a
 * non-critical, UI-only surface.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import type { Interval } from "../types";
import type { DataAvailabilityStatus } from "../data-availability";
import {
  checkHistorySufficiency,
  type HistorySufficiencyResult,
} from "./coverage.service";
import { enforceDataGate, dependencyFromStatus } from "./data-gate-enforcement.service";

export interface ProducerGateInput {
  /** Instrument symbol as persisted in CandleBar.instrumentId (e.g. "RELIANCE"). */
  instrumentId: string;
  exchange?: string;
  /** The timeframe whose warm-up window the strategy needs. */
  interval: Interval;
  /**
   * Minimum valid bars the strategy's LONGEST feature warm-up requires
   * (e.g. EMA200 → 200, ATR100 → 100). The producer supplies this from its own
   * feature dependency graph; the gate does not invent thresholds.
   */
  requiredBars: number;
  /**
   * strict mode (default false): when false, a strategy may operate under
   * DATA_DEGRADED provided its own critical dependency is not hard-unavailable
   * (matches the V5 india-scalper behaviour). When true, only DATA_READY passes.
   */
  requireFullyReady?: boolean;
  prisma?: PrismaClient;
}

export interface ProducerGateResult {
  /** May the producer emit / persist a signal for this instrument right now? */
  allowed: boolean;
  /** The mapped availability status the decision was based on. */
  status: DataAvailabilityStatus;
  reason: string;
  /** Feature warm-up detail (required vs available vs missing bars) — §6/§43. */
  history: HistorySufficiencyResult;
}

/**
 * Map a `checkHistorySufficiency` result to the canonical DataAvailabilityStatus.
 * INSUFFICIENT_HISTORY is preserved as a first-class status (not collapsed into
 * UNAVAILABLE) so the operator surface can show "requires N, have M, missing K".
 */
export function historyToAvailabilityStatus(
  h: HistorySufficiencyResult,
): DataAvailabilityStatus {
  if (h.status === "AVAILABLE") return "AVAILABLE";
  if (h.status === "INSUFFICIENT_HISTORY") return "INSUFFICIENT_HISTORY";
  if (h.status === "INVALID") return "INVALID";
  // PARTIAL: some bars but coverage incomplete.
  return h.availableBars > 0 ? "PARTIAL" : "UNAVAILABLE";
}

/**
 * Evaluate the fail-closed producer data gate for one instrument × interval.
 * Never throws. On any internal error the result is `allowed:false` (§42 — never
 * treat unavailable as available; fail closed).
 */
export async function evaluateProducerDataGate(
  input: ProducerGateInput,
): Promise<ProducerGateResult> {
  const exchange = input.exchange ?? "NSE";
  let history: HistorySufficiencyResult;
  try {
    history = await checkHistorySufficiency({
      instrumentId: input.instrumentId,
      exchange,
      interval: input.interval,
      requiredBars: input.requiredBars,
      prisma: input.prisma,
    });
  } catch (err) {
    return {
      allowed: false,
      status: "UNAVAILABLE",
      reason: `history-sufficiency check failed (fail-closed): ${(err as Error).message}`,
      history: {
        status: "INVALID",
        requiredBars: input.requiredBars,
        availableBars: 0,
        missingBars: input.requiredBars,
        firstTimestamp: null,
        lastTimestamp: null,
        reason: "gate read error",
      },
    };
  }

  const status = historyToAvailabilityStatus(history);
  const decision = enforceDataGate({
    dependencies: [dependencyFromStatus(`ohlcv_${input.interval}`, status, true)],
    requireFullyReady: input.requireFullyReady ?? false,
  });

  const reason =
    status === "INSUFFICIENT_HISTORY"
      ? `INSUFFICIENT_HISTORY: ${input.instrumentId} ${input.interval} requires ${history.requiredBars} bars, available ${history.availableBars}, missing ${history.missingBars}`
      : decision.reason;

  return { allowed: decision.allowed, status, reason, history };
}

/**
 * Convenience batch filter for producers that score many instruments at once
 * (Daily Picks, FnO scans). Returns the subset that PASSES the gate plus a
 * structured list of the blocked ones (with reasons) for observability. Never
 * throws.
 */
export async function filterInstrumentsByProducerGate<
  T extends { instrumentId: string },
>(
  items: T[],
  gate: Omit<ProducerGateInput, "instrumentId">,
): Promise<{
  allowed: T[];
  blocked: Array<{ item: T; result: ProducerGateResult }>;
}> {
  const allowed: T[] = [];
  const blocked: Array<{ item: T; result: ProducerGateResult }> = [];
  for (const item of items) {
    const result = await evaluateProducerDataGate({ ...gate, instrumentId: item.instrumentId });
    if (result.allowed) allowed.push(item);
    else blocked.push({ item, result });
  }
  return { allowed, blocked };
}
