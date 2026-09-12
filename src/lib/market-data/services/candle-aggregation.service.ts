/**
 * candle-aggregation.service.ts — Data Foundation V3 §8.
 *
 * Derive higher-timeframe candles from REAL persisted 1m candles. This is the
 * ONLY permitted form of "synthetic" data (§47): mathematically derived from
 * real lower-timeframe bars, completeness-verified, lineage-recorded, and
 * clearly marked as derived (via datasetVersion `agg-1m`).
 *
 * Hard rules:
 *   - Source must be the persisted 1m series (never a provider round-trip here).
 *   - A target bar is emitted ONLY when ALL of its constituent 1m source bars
 *     are present AND no unresolved DataGap overlaps that target window. If any
 *     source bar is missing the target bar is DROPPED, and the overall result
 *     is PARTIAL — never a complete-looking candle from incomplete source.
 *   - Session boundaries are respected: a target bucket is aligned to the NSE
 *     session open and never spans a session boundary.
 *
 * OHLC math: open = first source open, close = last source close,
 * high = max(highs), low = min(lows), volume = sum(volumes) (or unavailable if
 * ANY source bar has volumeUnavailable).
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  nseCalendar,
  IST_OFFSET_MS,
  SESSION_OPEN_MINUTES,
} from "@/lib/india/nse-trading-calendar";
import type { Interval, OHLCVCandle } from "../types";
import { datasetVersion } from "../dataset-version";

const TARGET_MINUTES: Partial<Record<Interval, number>> = {
  "3m": 3,
  "5m": 5,
  "10m": 10,
  "15m": 15,
  "30m": 30,
  "1h": 60,
};

function toIstDateString(utcMs: number): string {
  const ist = new Date(utcMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const mo = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function istMidnightUtcSec(istDate: string): number {
  const [y, m, d] = istDate.split("-").map(Number);
  return Math.floor((Date.UTC(y!, m! - 1, d!) - IST_OFFSET_MS) / 1000);
}

export interface AggregationLineage {
  datasetVersion: string;
  sourceInterval: "1m";
  aggregationMethod: string;
  sourceProviders: string[];
  sourceTimeRange: { fromSec: number | null; toSec: number | null };
}

export interface AggregateResult {
  interval: Interval;
  status: "AVAILABLE" | "PARTIAL" | "DATA_INSUFFICIENT";
  candles: OHLCVCandle[];
  expectedBars: number;
  producedBars: number;
  droppedBars: number;
  lineage: AggregationLineage;
}

export interface AggregateInput {
  instrumentId: string;
  exchange: string;
  target: Interval;
  fromIstDate: string;
  toIstDate: string;
  prisma?: PrismaClient;
  /** When true, skip target windows overlapping an unresolved DataGap. */
  respectGaps?: boolean;
}

/**
 * Aggregate persisted 1m candles into `target` for one instrument × range.
 * Returns the derived candles plus lineage + completeness status. Does NOT
 * persist — the caller decides (so tests can assert without writes).
 */
export async function aggregateFrom1m(input: AggregateInput): Promise<AggregateResult> {
  const prisma = input.prisma ?? getPrisma();
  const targetMin = TARGET_MINUTES[input.target];
  const method = `1m→${input.target} (OHLC roll-up, sum volume)`;

  if (!targetMin) {
    return {
      interval: input.target,
      status: "DATA_INSUFFICIENT",
      candles: [],
      expectedBars: 0,
      producedBars: 0,
      droppedBars: 0,
      lineage: {
        datasetVersion: datasetVersion(input.fromIstDate, { kind: "aggregation", sourceInterval: "1m" }),
        sourceInterval: "1m",
        aggregationMethod: method,
        sourceProviders: [],
        sourceTimeRange: { fromSec: null, toSec: null },
      },
    };
  }

  const fromSec = istMidnightUtcSec(input.fromIstDate);
  const toSec = istMidnightUtcSec(input.toIstDate) + 86_400;

  const source = await prisma.candleBar.findMany({
    where: {
      instrumentId: input.instrumentId,
      exchange: input.exchange,
      intervalStr: "1m",
      time: { gte: fromSec, lte: toSec },
    },
    orderBy: { time: "asc" },
  });

  const byTime = new Map<number, (typeof source)[number]>();
  const providers = new Set<string>();
  for (const r of source) {
    byTime.set(r.time, r);
    if (r.provider) providers.add(r.provider);
  }

  // Unresolved gaps overlapping the range (for the target-window gate).
  let unresolvedGapWindows: Array<{ start: number; end: number }> = [];
  if (input.respectGaps) {
    const gaps = await prisma.dataGap.findMany({
      where: {
        instrumentId: input.instrumentId,
        exchange: input.exchange,
        intervalStr: "1m",
        recoveryStatus: { notIn: ["RECOVERED"] },
        gapStart: { lte: toSec },
        gapEnd: { gte: fromSec },
      },
      select: { gapStart: true, gapEnd: true },
    });
    unresolvedGapWindows = gaps.map((g) => ({ start: g.gapStart, end: g.gapEnd }));
  }

  const targetSecs = targetMin * 60;
  const candles: OHLCVCandle[] = [];
  let expectedBars = 0;
  let dropped = 0;

  // Iterate trading days; within each, bucket from session open.
  let cursor = input.fromIstDate;
  for (let guard = 0; guard < 4000; guard++) {
    if (cursor > input.toIstDate) break;
    if (nseCalendar.isTradingDay(cursor)) {
      const midnight = istMidnightUtcSec(cursor);
      const openSec = midnight + SESSION_OPEN_MINUTES * 60;
      const closeSec = midnight + (SESSION_OPEN_MINUTES + 375) * 60; // 09:15 + 375m = 15:30

      for (let bucketStart = openSec; bucketStart < closeSec; bucketStart += targetSecs) {
        const bucketEnd = Math.min(bucketStart + targetSecs, closeSec);
        expectedBars += 1;

        // Gate: skip window overlapping an unresolved gap.
        const overlapsGap = unresolvedGapWindows.some(
          (w) => w.start < bucketEnd && w.end >= bucketStart,
        );

        // Collect all 1m source opens in [bucketStart, bucketEnd).
        const needed: number[] = [];
        for (let t = bucketStart; t < bucketEnd; t += 60) needed.push(t);
        const srcBars = needed.map((t) => byTime.get(t));
        const complete = srcBars.every((b) => b != null);

        if (overlapsGap || !complete) {
          dropped += 1;
          continue; // NEVER fabricate a bar from incomplete source
        }

        const bars = srcBars as NonNullable<(typeof srcBars)[number]>[];
        const open = bars[0]!.open;
        const close = bars[bars.length - 1]!.close;
        const high = Math.max(...bars.map((b) => b.high));
        const low = Math.min(...bars.map((b) => b.low));
        const anyVolUnavail = bars.some((b) => b.volumeUnavailable);
        const volume = anyVolUnavail ? 0 : bars.reduce((s, b) => s + b.volume, 0);

        candles.push({
          time: bucketStart,
          open,
          high,
          low,
          close,
          volume,
          volumeUnavailable: anyVolUnavail,
        });
      }
    }
    const [y, m, d] = cursor.split("-").map(Number);
    cursor = toIstDateString(Date.UTC(y!, m! - 1, d!) + 86_400_000);
  }

  const status: AggregateResult["status"] =
    candles.length === 0
      ? "DATA_INSUFFICIENT"
      : dropped > 0
        ? "PARTIAL"
        : "AVAILABLE";

  return {
    interval: input.target,
    status,
    candles,
    expectedBars,
    producedBars: candles.length,
    droppedBars: dropped,
    lineage: {
      datasetVersion: datasetVersion(input.fromIstDate, { kind: "aggregation", sourceInterval: "1m" }),
      sourceInterval: "1m",
      aggregationMethod: method,
      sourceProviders: [...providers],
      sourceTimeRange: {
        fromSec: source.length > 0 ? source[0]!.time : null,
        toSec: source.length > 0 ? source[source.length - 1]!.time : null,
      },
    },
  };
}
