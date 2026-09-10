/**
 * coverage.service.ts — Data Foundation V2, Phases 10-12.
 *
 * Calendar-aware historical coverage + history-sufficiency engine.
 *
 * Answers, from the REAL persisted `CandleBar` table:
 *   - "Exactly what candles do we have for instrument × interval × range,
 *      how many did we EXPECT (per the NSE trading calendar), and what's
 *      missing?" (coverage matrix)
 *   - "Do we have enough valid bars to compute this feature/strategy?"
 *      (history sufficiency → AVAILABLE / INSUFFICIENT_HISTORY / PARTIAL /
 *      INVALID)
 *
 * A weekend or NSE holiday is NEVER counted as a missing candle (Absolute Rule
 * — a closed market is not a data gap). Coverage numbers are computed from the
 * database; nothing is fabricated.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { nseCalendar, IST_OFFSET_MS } from "@/lib/india/nse-trading-calendar";
import type { Interval } from "../types";

// Bars per regular NSE session (09:15–15:30 IST = 375 minutes) by interval.
const SESSION_MINUTES = 375;
const BARS_PER_SESSION: Partial<Record<Interval, number>> = {
  "1m": 375,
  "3m": 125,
  "5m": 75,
  "10m": 38, // 375/10 rounded up (last partial bar counts)
  "15m": 25,
  "30m": 13, // 375/30 rounded up
  "1h": 7, // 375/60 rounded up
  "1d": 1,
  "1w": 0, // handled separately (not day-based)
  "1M": 0,
};

function toIstDateString(utcMs: number): string {
  const ist = new Date(utcMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const mo = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** Count NSE trading days in [fromMs, toMs] (inclusive), calendar-aware. */
export function tradingDaysInRange(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return 0;
  let count = 0;
  // Iterate day by day in IST. Cap the loop to a sane bound (10 years).
  const MAX_DAYS = 3_660;
  let cursorMs = fromMs;
  for (let i = 0; i <= MAX_DAYS && cursorMs <= toMs; i++) {
    const istDate = toIstDateString(cursorMs);
    if (nseCalendar.isTradingDay(istDate)) count++;
    cursorMs += 86_400_000;
  }
  return count;
}

/** Expected candle count for an interval over a UTC-ms range (calendar-aware). */
export function expectedBars(interval: Interval, fromMs: number, toMs: number): number {
  const tradingDays = tradingDaysInRange(fromMs, toMs);
  if (interval === "1w") return Math.max(0, Math.floor(tradingDays / 5));
  if (interval === "1M") return Math.max(0, Math.floor(tradingDays / 21));
  const perSession = BARS_PER_SESSION[interval] ?? Math.ceil(SESSION_MINUTES / intervalMinutes(interval));
  return tradingDays * perSession;
}

function intervalMinutes(interval: Interval): number {
  const map: Partial<Record<Interval, number>> = {
    "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "1h": 60, "1d": 375,
  };
  return map[interval] ?? 1;
}

// ── Coverage matrix ────────────────────────────────────────────────────────

export type CoverageCell = {
  instrumentId: string;
  exchange: string;
  interval: string;
  /** Persisted (actual) candle count in the DB for the range. */
  actualBars: number;
  /** Expected bars per the trading calendar (null when range unknown). */
  expectedBars: number | null;
  /** actual/expected clamped to [0,1] (null when expected unknown/zero). */
  completeness: number | null;
  firstTimeUtcSec: number | null;
  lastTimeUtcSec: number | null;
  firstIso: string | null;
  lastIso: string | null;
};

export type CoverageQuery = {
  instrumentId?: string;
  exchange?: string;
  interval?: string;
  /** UTC ms range to score completeness against. Defaults to observed span. */
  fromMs?: number;
  toMs?: number;
  prisma?: PrismaClient;
};

/**
 * Build a coverage matrix (one cell per instrument × exchange × interval) from
 * the real `CandleBar` table. Completeness is computed against the NSE calendar
 * so holidays/weekends are not counted as missing.
 */
export async function buildCoverageMatrix(q: CoverageQuery = {}): Promise<CoverageCell[]> {
  const prisma = q.prisma ?? getPrisma();

  const where: Record<string, unknown> = {};
  if (q.instrumentId) where.instrumentId = q.instrumentId;
  if (q.exchange) where.exchange = q.exchange;
  if (q.interval) where.intervalStr = q.interval;

  const groups = await prisma.candleBar.groupBy({
    by: ["instrumentId", "exchange", "intervalStr"],
    where,
    _count: { _all: true },
    _min: { time: true },
    _max: { time: true },
  });

  return groups.map((g) => {
    const first = g._min.time ?? null;
    const last = g._max.time ?? null;
    const fromMs = q.fromMs ?? (first != null ? first * 1000 : null);
    const toMs = q.toMs ?? (last != null ? last * 1000 : null);
    const interval = g.intervalStr as Interval;
    let expected: number | null = null;
    if (fromMs != null && toMs != null) {
      expected = expectedBars(interval, fromMs, toMs);
    }
    const actual = g._count._all;
    const completeness =
      expected != null && expected > 0 ? Math.min(1, actual / expected) : null;
    return {
      instrumentId: g.instrumentId,
      exchange: g.exchange,
      interval: g.intervalStr,
      actualBars: actual,
      expectedBars: expected,
      completeness,
      firstTimeUtcSec: first,
      lastTimeUtcSec: last,
      firstIso: first != null ? new Date(first * 1000).toISOString() : null,
      lastIso: last != null ? new Date(last * 1000).toISOString() : null,
    };
  });
}

// ── History sufficiency ────────────────────────────────────────────────────

export type HistorySufficiencyStatus =
  | "AVAILABLE"
  | "INSUFFICIENT_HISTORY"
  | "PARTIAL"
  | "INVALID";

export type HistorySufficiencyResult = {
  status: HistorySufficiencyStatus;
  requiredBars: number;
  availableBars: number;
  missingBars: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  reason: string | null;
};

export type HistorySufficiencyQuery = {
  instrumentId: string;
  exchange: string;
  interval: Interval;
  /** Minimum valid bars the feature/strategy needs (e.g. SMA200 → 200). */
  requiredBars: number;
  /** Optional range to bound the check (UTC ms). */
  fromMs?: number;
  toMs?: number;
  prisma?: PrismaClient;
};

/**
 * Determine whether enough persisted history exists to compute a feature.
 *
 * Returns INSUFFICIENT_HISTORY (not empty / not AVAILABLE) when fewer than
 * `requiredBars` are present — so a caller can fail closed instead of computing
 * a feature on too little data (Absolute Rule 10).
 */
export async function checkHistorySufficiency(
  q: HistorySufficiencyQuery,
): Promise<HistorySufficiencyResult> {
  const prisma = q.prisma ?? getPrisma();
  if (!Number.isFinite(q.requiredBars) || q.requiredBars <= 0) {
    return {
      status: "INVALID",
      requiredBars: q.requiredBars,
      availableBars: 0,
      missingBars: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      reason: "requiredBars must be a positive integer",
    };
  }

  const timeFilter: Record<string, number> = {};
  if (q.fromMs != null) timeFilter.gte = Math.floor(q.fromMs / 1000);
  if (q.toMs != null) timeFilter.lte = Math.floor(q.toMs / 1000);

  const where = {
    instrumentId: q.instrumentId,
    exchange: q.exchange,
    intervalStr: q.interval,
    ...(Object.keys(timeFilter).length > 0 ? { time: timeFilter } : {}),
  };

  const [count, agg] = await Promise.all([
    prisma.candleBar.count({ where }),
    prisma.candleBar.aggregate({ where, _min: { time: true }, _max: { time: true } }),
  ]);

  const availableBars = count;
  const missingBars = Math.max(0, q.requiredBars - availableBars);
  const first = agg._min.time ?? null;
  const last = agg._max.time ?? null;

  let status: HistorySufficiencyStatus;
  let reason: string | null = null;
  if (availableBars === 0) {
    status = "INSUFFICIENT_HISTORY";
    reason = "no persisted bars for this instrument/interval/range";
  } else if (availableBars < q.requiredBars) {
    status = "INSUFFICIENT_HISTORY";
    reason = `have ${availableBars} bars, need ${q.requiredBars}`;
  } else {
    status = "AVAILABLE";
  }

  return {
    status,
    requiredBars: q.requiredBars,
    availableBars,
    missingBars,
    firstTimestamp: first != null ? new Date(first * 1000).toISOString() : null,
    lastTimestamp: last != null ? new Date(last * 1000).toISOString() : null,
    reason,
  };
}
