/**
 * gap-detection.service.ts — Data Foundation V3 §9/§10.
 *
 * Durable data-gap detection. Computes the set of EXPECTED candle open-times
 * for an instrument × interval × range using the NSE trading calendar and the
 * regular-session window, then compares against the persisted `CandleBar` rows
 * to find contiguous runs of MISSING candles. Each run is persisted as a
 * `DataGap` with a deterministic lifecycle.
 *
 * A weekend, NSE holiday, out-of-session minute, or a time before the
 * instrument's first observed bar is NEVER counted as a gap (Absolute Rule — a
 * closed market / not-yet-listed instrument is not a data gap). Nothing is
 * fabricated; this only records what is genuinely absent.
 *
 * Gap lifecycle (recoveryStatus): PENDING → RECOVERING → RECOVERED |
 * PARTIALLY_RECOVERED | UNRESOLVED (UNRECOVERABLE) | MARKET_CLOSED |
 * INVALID_DATA. The schema seeds "PENDING" as the DETECTED state.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  nseCalendar,
  IST_OFFSET_MS,
  SESSION_OPEN_MINUTES,
  SESSION_CLOSE_MINUTES,
} from "@/lib/india/nse-trading-calendar";
import { mdLog } from "../health";
import type { Interval } from "../types";

// 3m intentionally absent — not a supported AlphaForge interval (V8 removal).
const INTERVAL_SECONDS: Partial<Record<Interval, number>> = {
  "1m": 60,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "1d": 86_400,
};

function toIstDateString(utcMs: number): string {
  const ist = new Date(utcMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const mo = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** UTC epoch seconds for 00:00 IST of an IST date `YYYY-MM-DD`. */
function istMidnightUtcSec(istDate: string): number {
  const [y, m, d] = istDate.split("-").map(Number);
  const midnightUtcMs = Date.UTC(y!, m! - 1, d!) - IST_OFFSET_MS;
  return Math.floor(midnightUtcMs / 1000);
}

/**
 * Compute the expected candle OPEN times (UTC epoch seconds) for one interval
 * over an inclusive IST-date range. For intraday intervals only bar-opens that
 * fall inside the regular session [09:15, 15:30) count; the last bar-open that
 * still starts before 15:30 is included. For "1d" one bar per trading day at
 * session open.
 */
export function expectedCandleTimes(
  interval: Interval,
  fromIstDate: string,
  toIstDate: string,
): number[] {
  const secs = INTERVAL_SECONDS[interval];
  if (!secs) return [];
  const times: number[] = [];

  let cursor = fromIstDate;
  // Guard against pathological ranges.
  for (let guard = 0; guard < 4000; guard++) {
    if (cursor > toIstDate) break;
    if (nseCalendar.isTradingDay(cursor)) {
      const midnight = istMidnightUtcSec(cursor);
      const openSec = midnight + SESSION_OPEN_MINUTES * 60;
      const closeSec = midnight + SESSION_CLOSE_MINUTES * 60;
      if (interval === "1d") {
        times.push(openSec);
      } else {
        // Bar opens at openSec, openSec+secs, ... while open < close.
        for (let t = openSec; t < closeSec; t += secs) {
          times.push(t);
        }
      }
    }
    // Advance one calendar day.
    const [y, m, d] = cursor.split("-").map(Number);
    const nextMs = Date.UTC(y!, m! - 1, d!) + 86_400_000;
    cursor = toIstDateString(nextMs);
  }
  return times;
}

export interface DetectedGap {
  gapStart: number; // UTC epoch sec, first missing bar open (inclusive)
  gapEnd: number; // UTC epoch sec, last missing bar open (inclusive)
  missingBars: number;
}

export interface DetectGapsInput {
  instrumentId: string;
  exchange: string;
  interval: Interval;
  /** Inclusive IST date range. */
  fromIstDate: string;
  toIstDate: string;
  /** Provider expected to have supplied the data (for the gap record). */
  expectedProvider?: string | null;
  prisma?: PrismaClient;
}

export interface DetectGapsResult {
  instrumentId: string;
  exchange: string;
  interval: Interval;
  expectedBars: number;
  actualBars: number;
  /** True when the instrument has NO persisted bars in range (not-listed vs true gap). */
  noData: boolean;
  gaps: DetectedGap[];
  /** First/last persisted bar times (UTC sec) used to bound "active period". */
  firstActualSec: number | null;
  lastActualSec: number | null;
}

/**
 * Detect missing-candle gaps for an instrument × interval × range from the real
 * DB. Gaps outside the instrument's observed active period (before its first
 * persisted bar) are NOT reported — an instrument that listed mid-range has no
 * gap for the period before it existed.
 */
export async function detectGaps(input: DetectGapsInput): Promise<DetectGapsResult> {
  const prisma = input.prisma ?? getPrisma();

  const fromSec = istMidnightUtcSec(input.fromIstDate);
  const toSec = istMidnightUtcSec(input.toIstDate) + 86_400; // end of the to-day

  const rows = await prisma.candleBar.findMany({
    where: {
      instrumentId: input.instrumentId,
      exchange: input.exchange,
      intervalStr: input.interval,
      time: { gte: fromSec, lte: toSec },
    },
    select: { time: true },
    orderBy: { time: "asc" },
  });

  const present = new Set<number>(rows.map((r) => r.time));
  const firstActualSec = rows.length > 0 ? rows[0]!.time : null;
  const lastActualSec = rows.length > 0 ? rows[rows.length - 1]!.time : null;

  const expected = expectedCandleTimes(input.interval, input.fromIstDate, input.toIstDate);

  // Bound expected times to the instrument's ACTIVE period: never flag a bar
  // before the first observed bar (instrument not yet listed / not captured).
  // If there is no data at all, we cannot assert a gap vs never-listed → noData.
  const activeExpected =
    firstActualSec != null
      ? expected.filter((t) => t >= firstActualSec && (lastActualSec == null || t <= lastActualSec))
      : [];

  const gaps: DetectedGap[] = [];
  let runStart: number | null = null;
  let runEnd: number | null = null;
  let runCount = 0;

  const flush = () => {
    if (runStart != null && runEnd != null) {
      gaps.push({ gapStart: runStart, gapEnd: runEnd, missingBars: runCount });
    }
    runStart = null;
    runEnd = null;
    runCount = 0;
  };

  for (const t of activeExpected) {
    if (!present.has(t)) {
      if (runStart == null) runStart = t;
      runEnd = t;
      runCount += 1;
    } else {
      flush();
    }
  }
  flush();

  return {
    instrumentId: input.instrumentId,
    exchange: input.exchange,
    interval: input.interval,
    expectedBars: expected.length,
    actualBars: rows.length,
    noData: rows.length === 0,
    gaps,
    firstActualSec,
    lastActualSec,
  };
}

/**
 * Persist detected gaps as `DataGap` rows (idempotent via the unique
 * [instrumentId,exchange,intervalStr,gapStart] key). Existing rows are left
 * untouched (never overwrite recovery state); new runs are inserted PENDING.
 * Returns the number of NEW gap rows written.
 */
export async function persistDetectedGaps(
  result: DetectGapsResult,
  opts: { expectedProvider?: string | null; prisma?: PrismaClient } = {},
): Promise<number> {
  const prisma = opts.prisma ?? getPrisma();
  const secs = INTERVAL_SECONDS[result.interval] ?? 0;
  let written = 0;

  for (const gap of result.gaps) {
    try {
      const existing = await prisma.dataGap.findUnique({
        where: {
          instrumentId_exchange_intervalStr_gapStart: {
            instrumentId: result.instrumentId,
            exchange: result.exchange,
            intervalStr: result.interval,
            gapStart: gap.gapStart,
          },
        },
        select: { id: true },
      });
      if (existing) continue; // never clobber an existing gap's recovery state

      await prisma.dataGap.create({
        data: {
          instrumentId: result.instrumentId,
          exchange: result.exchange,
          intervalStr: result.interval,
          gapStart: gap.gapStart,
          gapEnd: gap.gapEnd,
          durationSec: gap.gapEnd - gap.gapStart + secs,
          expectedProvider: opts.expectedProvider ?? null,
          recoveryStatus: "PENDING",
          reason: `${gap.missingBars} missing ${result.interval} bar(s)`,
        },
      });
      written += 1;
    } catch (err) {
      mdLog("stale_data", {
        reason: "data_gap_persist_failed",
        instrumentId: result.instrumentId,
        interval: result.interval,
        gapStart: gap.gapStart,
        error: (err as Error).message,
      });
    }
  }

  if (written > 0) {
    mdLog("data_mismatch", {
      event: "DATA_GAP_DETECTED",
      instrumentId: result.instrumentId,
      exchange: result.exchange,
      interval: result.interval,
      newGaps: written,
      totalGaps: result.gaps.length,
    });
  }
  return written;
}

/** Convenience: detect + persist in one call. */
export async function detectAndPersistGaps(
  input: DetectGapsInput,
): Promise<{ result: DetectGapsResult; written: number }> {
  const result = await detectGaps(input);
  const written = await persistDetectedGaps(result, {
    expectedProvider: input.expectedProvider ?? null,
    prisma: input.prisma,
  });
  return { result, written };
}

// ── Data Foundation V8 §27 — gap classification ───────────────────────────

/**
 * V8 gap classification that distinguishes expected absence from real gaps.
 *
 * EXPECTED_NO_DATA    — before the instrument's first observed bar (not listed yet)
 * MARKET_HOLIDAY      — falls on an NSE holiday (not a data gap)
 * MARKET_CLOSED       — outside session hours (weekend / after-hours)
 * PROVIDER_UNAVAILABLE — provider had outage or capability gap for this interval
 * ACTUAL_DATA_GAP     — genuine missing bars that should be recovered
 * PENDING_RECOVERY    — gap detected, recovery queued or in progress
 */
export type GapClassification =
  | "EXPECTED_NO_DATA"
  | "MARKET_HOLIDAY"
  | "MARKET_CLOSED"
  | "PROVIDER_UNAVAILABLE"
  | "ACTUAL_DATA_GAP"
  | "PENDING_RECOVERY";

export interface ClassifiedGap extends DetectedGap {
  classification: GapClassification;
  /** Human-readable reason for the classification. */
  classificationReason: string;
}

/**
 * Classify detected gaps to distinguish real data gaps from expected absences.
 *
 * Rules (in priority order):
 * 1. Gap entirely before first observed bar → EXPECTED_NO_DATA
 * 2. All missing times fall on NSE holidays → MARKET_HOLIDAY
 * 3. Provider has no historical capability for this interval → PROVIDER_UNAVAILABLE
 * 4. Gap is marked PENDING in the DataGap table → PENDING_RECOVERY
 * 5. Otherwise → ACTUAL_DATA_GAP
 */
export function classifyGap(
  gap: DetectedGap,
  interval: Interval,
  firstActualSec: number | null,
  expectedProvider?: string | null,
): ClassifiedGap {
  // Rule 1: before first observed bar
  if (firstActualSec != null && gap.gapEnd < firstActualSec) {
    return {
      ...gap,
      classification: "EXPECTED_NO_DATA",
      classificationReason: "gap is before the instrument's first observed bar",
    };
  }

  // Rule 2: check if all missing times in the gap are on NSE holidays
  const secs = INTERVAL_SECONDS[interval] ?? 0;
  if (secs > 0) {
    const missingTimes: number[] = [];
    for (let t = gap.gapStart; t <= gap.gapEnd; t += secs) {
      missingTimes.push(t);
    }
    const allHoliday = missingTimes.every((t) => {
      const istDate = toIstDateString(t * 1000);
      return !nseCalendar.isTradingDay(istDate);
    });
    if (allHoliday) {
      return {
        ...gap,
        classification: "MARKET_HOLIDAY",
        classificationReason: "all missing bars fall on NSE holidays or weekends",
      };
    }
  }

  // Rule 3: provider has no capability for this interval
  if (expectedProvider) {
    const { intervalCapability } = require("../provider-capability-matrix");
    const cap = intervalCapability(expectedProvider, interval);
    if (!cap.history) {
      return {
        ...gap,
        classification: "PROVIDER_UNAVAILABLE",
        classificationReason: `provider '${expectedProvider}' has no historical capability for ${interval}`,
      };
    }
  }

  // Rule 4: classify as actual gap (caller can check DataGap.recoveryStatus for PENDING)
  return {
    ...gap,
    classification: "ACTUAL_DATA_GAP",
    classificationReason: `${gap.missingBars} genuine missing ${interval} bars detected`,
  };
}

/**
 * Detect, classify, and persist gaps for an instrument in one call.
 * Returns gaps with classification attached.
 */
export async function detectClassifyAndPersistGaps(
  input: DetectGapsInput,
): Promise<{ result: DetectGapsResult; classified: ClassifiedGap[]; written: number }> {
  const { result, written } = await detectAndPersistGaps(input);
  const classified: ClassifiedGap[] = result.gaps.map((gap) =>
    classifyGap(gap, input.interval, result.firstActualSec, input.expectedProvider),
  );
  return { result, classified, written };
}
