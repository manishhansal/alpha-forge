/**
 * realtime-reconciliation.service.ts — Data Foundation V7 §16.
 *
 * Compares a realtime-built confirmed candle against the same candle as served
 * by a historical provider, and records any material divergence in
 * `RealtimeHistoricalMismatch` — never silently overwriting either source.
 *
 * This is the wiring that connects the (previously pure/unused)
 * reconciliation.service.ts comparison logic to the live candle-builder path.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { Interval, OHLCVCandle } from "../types";
import { mdLog } from "../health";

/** Relative tolerance for a realtime-vs-historical close mismatch (0.1%). */
export const RECONCILE_REL_TOLERANCE = 0.001;

export interface ReconcileInput {
  symbol: string;
  exchange: string;
  interval: Interval;
  realtime: OHLCVCandle;
  historicalClose: number;
  realtimeProvider?: string | null;
  historicalProvider?: string | null;
  prisma?: PrismaClient;
}

export interface ReconcileResult {
  matched: boolean;
  difference: number;
  resolution: "WITHIN_TOLERANCE" | "RECORDED_ONLY";
}

/**
 * Reconcile one realtime candle against a historical close. When the closes
 * diverge beyond tolerance, a mismatch row is recorded (RECORDED_ONLY — neither
 * value is mutated; a later operator/policy decides the canonical value).
 */
export async function reconcileRealtimeVsHistorical(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const prisma = input.prisma ?? getPrisma();
  const rtClose = input.realtime.close;
  const hClose = input.historicalClose;
  const difference = Math.abs(rtClose - hClose);
  const denom = Math.max(Math.abs(hClose), 1e-9);
  const withinTolerance = difference / denom <= RECONCILE_REL_TOLERANCE;

  if (withinTolerance) {
    return { matched: true, difference, resolution: "WITHIN_TOLERANCE" };
  }

  try {
    await prisma.realtimeHistoricalMismatch.create({
      data: {
        symbol: input.symbol,
        exchange: input.exchange,
        intervalStr: input.interval,
        time: input.realtime.time,
        realtimeClose: rtClose,
        historicalClose: hClose,
        difference,
        realtimeProvider: input.realtimeProvider ?? null,
        historicalProvider: input.historicalProvider ?? null,
        resolution: "RECORDED_ONLY",
      },
    });
  } catch (err) {
    mdLog("data_mismatch", {
      operationId: "reconcileRealtimeVsHistorical",
      reason: "mismatch_persist_failed",
      symbol: input.symbol,
      error: (err as Error).message,
    });
  }

  mdLog("data_mismatch", {
    operationId: "reconcileRealtimeVsHistorical",
    symbol: input.symbol,
    interval: input.interval,
    time: input.realtime.time,
    realtimeClose: rtClose,
    historicalClose: hClose,
    difference,
  });

  return { matched: false, difference, resolution: "RECORDED_ONLY" };
}
