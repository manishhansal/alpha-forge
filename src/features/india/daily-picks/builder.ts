/**
 * Daily Picks — builder (I/O layer).
 *
 * Glues the pure engine to the data + persistence stack:
 *
 *   1. Pull a fresh candidate pool from the India AI universe.
 *   2. The first time the board is requested on a given IST trading day, the
 *      top three picks per bucket are *frozen* into Postgres (entry / stop /
 *      target locked in) so the day's picks become an honest, immutable
 *      track record.
 *   3. On every subsequent request the frozen picks are live-tracked against
 *      the latest mark — P&L, progress-to-target, and TARGET_HIT / STOP_HIT
 *      resolution are refreshed and persisted in place.
 *   4. History exposes every past trading day's picks + their final outcome.
 *
 * Every DB touch is wrapped so the board still renders (ephemerally) when
 * Postgres is unavailable — the feature degrades, it never hard-fails.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { AI_MODEL_VERSION } from "@/features/ai-signals/engine";
import { getIndiaDailyPickCandidates } from "@/features/ai-signals/india-builder";
import { getIndiaOpeningBreakoutSignals } from "@/features/india/scalping/strategies/opening-breakout";
import {
  isNseSessionEndedForDateIST,
  nseCloseMsForDateIST,
} from "@/lib/india/market-hours";
import type { AiMarketContext } from "@/types/ai-signals";
import type { AiSignal } from "@/types/ai-signals";

import {
  buildDailyPicks,
  dailyPickFromScalpSignal,
  EXTERNAL_BUCKETS,
  groupDailyPicks,
  istDateKey,
  squareOffPick,
  trackPick,
  type DailyPick,
  type DailyPickBucket,
  type DailyPickGroup,
  type DailyPickStatus,
} from "./engine";

/** How many Opening Breakout signals seed the externally-sourced bucket. */
const OPENING_BREAKOUT_PICKS = 3;

const isExternalBucket = (bucket: string): boolean =>
  (EXTERNAL_BUCKETS as readonly string[]).includes(bucket);

export interface DailyPicksResponse {
  market: "india";
  tradeDate: string;
  generatedAt: number;
  modelVersion: string;
  context: AiMarketContext;
  inActiveWindow: boolean;
  groups: DailyPickGroup[];
  /** True when the picks are DB-frozen; false when served ephemerally. */
  persisted: boolean;
}

export interface DailyPicksDaySummary {
  total: number;
  targetHit: number;
  stopHit: number;
  /** Squared off at the market close without hitting target/stop. */
  closed: number;
  open: number;
  /** Resolved win rate = targetHit / (targetHit + stopHit). */
  winRate: number;
}

export interface DailyPicksHistoryDay {
  tradeDate: string;
  groups: DailyPickGroup[];
  summary: DailyPicksDaySummary;
}

export interface DailyPicksHistoryResponse {
  market: "india";
  generatedAt: number;
  days: DailyPicksHistoryDay[];
}

/** `getPrisma()` throws when DATABASE_URL is missing — soften that to null. */
function safeGetPrisma(): PrismaClient | null {
  try {
    return getPrisma();
  } catch {
    return null;
  }
}

function priceMap(signals: AiSignal[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of signals) m.set(s.symbol, s.underlyingPrice);
  return m;
}

/**
 * Fetch the Opening Breakout strategy's top signals and project them into
 * `OPENING_BREAKOUT` Daily Picks. Resilient — a failing scan yields no picks
 * rather than blanking the board. ORB signals only appear once the opening
 * candle has broken + retested (typically 9:30+), so this can legitimately
 * return [] early in the session.
 */
async function loadOpeningBreakoutPicks(
  tradeDate: string,
  now: number,
): Promise<{ picks: DailyPick[]; prices: Map<string, number> }> {
  const prices = new Map<string, number>();
  try {
    // Pull a deeper slice for live-price coverage, freeze only the top few.
    const signals = await getIndiaOpeningBreakoutSignals({
      timeframe: "5m",
      limit: 12,
    });
    for (const s of signals) {
      if (Number.isFinite(s.price) && s.price > 0) prices.set(s.symbol, s.price);
    }
    const picks = signals
      .slice(0, OPENING_BREAKOUT_PICKS)
      .map((signal, i) =>
        dailyPickFromScalpSignal({ signal, rank: i + 1, tradeDate, now }),
      );
    return { picks, prices };
  } catch (err) {
    console.warn(
      "[daily-picks] opening-breakout unavailable:",
      (err as Error).message,
    );
    return { picks: [], prices };
  }
}

function ephemeralPicks(
  signals: AiSignal[],
  tradeDate: string,
  now: number,
  prices: Map<string, number>,
  marketBias: number,
  orbPicks: DailyPick[],
): DailyPick[] {
  const fresh = [
    ...buildDailyPicks({ signals, tradeDate, now, marketBias }),
    ...orbPicks,
  ];
  const sessionEnded = isNseSessionEndedForDateIST(tradeDate, new Date(now));
  return fresh.map((p) => {
    const tracked = trackPick(p, prices.get(p.symbol) ?? p.underlyingPrice, now);
    return sessionEnded ? squareOffPick(tracked, now) : tracked;
  });
}

type DailyPickCreate = Parameters<
  PrismaClient["indiaDailyPick"]["createMany"]
>[0] extends { data: infer D }
  ? D extends ReadonlyArray<infer E>
    ? E
    : D
  : never;

function toCreateData(p: DailyPick): DailyPickCreate {
  return {
    tradeDate: p.tradeDate,
    bucket: p.bucket,
    rank: p.rank,
    symbol: p.symbol,
    displayName: p.displayName,
    direction: p.direction,
    action: p.action,
    horizon: p.horizon,
    grade: p.grade,
    confidence: p.confidence,
    confidenceScore: p.confidenceScore,
    winProbability: p.winProbability,
    underlyingPrice: p.underlyingPrice,
    entry: p.entry,
    stopLoss: p.stopLoss,
    target: p.target,
    canMoveUpto: p.canMoveUpto,
    canExpectPct: p.canExpectPct,
    riskReward: p.riskReward,
    bucketScore: p.bucketScore,
    rationale: p.rationale,
    logic: p.logic,
    status: p.status,
    lastPrice: p.lastPrice,
    pnlPct: p.pnlPct,
    achievedPct: p.achievedPct,
    resolvedAt: p.resolvedAt != null ? new Date(p.resolvedAt) : null,
    generatedAt: new Date(p.generatedAt),
  } as DailyPickCreate;
}

interface DailyPickRow {
  tradeDate: string;
  bucket: string;
  rank: number;
  symbol: string;
  displayName: string;
  direction: string;
  action: string;
  horizon: string;
  grade: string;
  confidence: number;
  confidenceScore: number;
  winProbability: number;
  underlyingPrice: number;
  entry: number;
  stopLoss: number;
  target: number;
  canMoveUpto: number;
  canExpectPct: number;
  riskReward: number;
  bucketScore: number;
  rationale: string[];
  logic: string;
  status: string;
  lastPrice: number | null;
  pnlPct: number | null;
  achievedPct: number | null;
  resolvedAt: Date | null;
  generatedAt: Date;
  updatedAt: Date;
}

function rowToPick(row: DailyPickRow): DailyPick {
  return {
    tradeDate: row.tradeDate,
    bucket: row.bucket as DailyPickBucket,
    rank: row.rank,
    symbol: row.symbol,
    displayName: row.displayName,
    pair: row.symbol,
    direction: row.direction as DailyPick["direction"],
    action: row.action as DailyPick["action"],
    horizon: row.horizon as DailyPick["horizon"],
    grade: row.grade as DailyPick["grade"],
    confidence: row.confidence,
    confidenceScore: row.confidenceScore,
    winProbability: row.winProbability,
    underlyingPrice: row.underlyingPrice,
    entry: row.entry,
    stopLoss: row.stopLoss,
    target: row.target,
    canMoveUpto: row.canMoveUpto,
    canExpectPct: row.canExpectPct,
    riskReward: row.riskReward,
    bucketScore: row.bucketScore,
    rationale: row.rationale,
    logic: row.logic,
    status: row.status as DailyPickStatus,
    lastPrice: row.lastPrice,
    pnlPct: row.pnlPct,
    achievedPct: row.achievedPct,
    resolvedAt: row.resolvedAt ? row.resolvedAt.getTime() : null,
    generatedAt: row.generatedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Track + persist a fresh batch of frozen picks (first freeze of a bucket). */
async function freezeAndTrack(
  db: PrismaClient,
  fresh: DailyPick[],
  tradeDate: string,
  prices: Map<string, number>,
  now: number,
  sessionEnded: boolean,
): Promise<DailyPick[]> {
  if (fresh.length === 0) return [];
  const tracked = fresh.map((p) => {
    const t = trackPick(p, prices.get(p.symbol) ?? p.underlyingPrice, now);
    return sessionEnded ? squareOffPick(t, now) : t;
  });
  await db.indiaDailyPick.createMany({
    data: tracked.map(toCreateData),
    skipDuplicates: true,
  });
  return tracked;
}

/** Live-track already-frozen rows against the latest mark, persisting deltas. */
async function trackExistingRows(
  db: PrismaClient,
  rows: DailyPickRow[],
  tradeDate: string,
  prices: Map<string, number>,
  now: number,
  sessionEnded: boolean,
): Promise<DailyPick[]> {
  const updated: DailyPick[] = [];
  for (const row of rows) {
    const pick = rowToPick(row);
    const price = prices.get(pick.symbol) ?? pick.lastPrice ?? null;
    const tracked = trackPick(pick, price, now);
    const next = sessionEnded ? squareOffPick(tracked, now) : tracked;
    updated.push(next);

    const changed =
      next.status !== pick.status ||
      next.lastPrice !== pick.lastPrice ||
      next.pnlPct !== pick.pnlPct ||
      next.achievedPct !== pick.achievedPct ||
      next.resolvedAt !== pick.resolvedAt;
    if (changed) {
      await db.indiaDailyPick.update({
        where: {
          tradeDate_bucket_rank: {
            tradeDate,
            bucket: pick.bucket,
            rank: pick.rank,
          },
        },
        data: {
          status: next.status,
          lastPrice: next.lastPrice,
          pnlPct: next.pnlPct,
          achievedPct: next.achievedPct,
          resolvedAt: next.resolvedAt != null ? new Date(next.resolvedAt) : null,
        },
      });
    }
  }
  return updated;
}

async function loadOrCreateAndTrack(
  db: PrismaClient,
  signals: AiSignal[],
  tradeDate: string,
  prices: Map<string, number>,
  now: number,
  marketBias: number,
  orbPicks: DailyPick[],
): Promise<DailyPick[]> {
  const existing = (await db.indiaDailyPick.findMany({
    where: { tradeDate },
  })) as unknown as DailyPickRow[];

  // Intraday-only: once this trade date's 15:30 IST session has ended, any
  // still-open pick is force-squared-off at its last mark (no overnight carry).
  const sessionEnded = isNseSessionEndedForDateIST(tradeDate, new Date(now));

  // The AI-sourced buckets (indices / momentum / scalping / potential) and the
  // externally-sourced Opening Breakout bucket are frozen independently: the AI
  // buckets freeze on the first request of the day, while ORB freezes *lazily*
  // the first time its signals exist (the opening candle must break + retest
  // first, usually 9:30+). Each then live-tracks in place.
  const aiExisting = existing.filter((r) => !isExternalBucket(r.bucket));
  const orbExisting = existing.filter((r) => isExternalBucket(r.bucket));

  const ai =
    aiExisting.length === 0
      ? await freezeAndTrack(
          db,
          buildDailyPicks({ signals, tradeDate, now, marketBias }),
          tradeDate,
          prices,
          now,
          sessionEnded,
        )
      : await trackExistingRows(
          db,
          aiExisting,
          tradeDate,
          prices,
          now,
          sessionEnded,
        );

  const orb =
    orbExisting.length === 0
      ? await freezeAndTrack(db, orbPicks, tradeDate, prices, now, sessionEnded)
      : await trackExistingRows(
          db,
          orbExisting,
          tradeDate,
          prices,
          now,
          sessionEnded,
        );

  return [...ai, ...orb];
}

/**
 * Build today's Daily Picks board — frozen + live-tracked when Postgres is
 * reachable, ephemeral otherwise.
 */
export async function getIndiaDailyPicks(
  prisma?: PrismaClient,
): Promise<DailyPicksResponse> {
  const now = Date.now();
  const tradeDate = istDateKey(new Date(now));
  const [candidates, orb] = await Promise.all([
    getIndiaDailyPickCandidates(),
    loadOpeningBreakoutPicks(tradeDate, now),
  ]);
  const prices = priceMap(candidates.signals);
  // Merge Opening Breakout live prices so its (possibly non-AI-universe) symbols
  // also track live.
  for (const [sym, px] of orb.prices) prices.set(sym, px);
  const marketBias = candidates.context.regimeScore;

  let picks: DailyPick[];
  let persisted = false;

  const db = prisma ?? safeGetPrisma();
  if (db) {
    try {
      picks = await loadOrCreateAndTrack(
        db,
        candidates.signals,
        tradeDate,
        prices,
        now,
        marketBias,
        orb.picks,
      );
      persisted = true;
    } catch (err) {
      console.warn(
        "[daily-picks] DB unavailable, serving ephemeral picks:",
        (err as Error).message,
      );
      picks = ephemeralPicks(
        candidates.signals,
        tradeDate,
        now,
        prices,
        marketBias,
        orb.picks,
      );
    }
  } else {
    picks = ephemeralPicks(
      candidates.signals,
      tradeDate,
      now,
      prices,
      marketBias,
      orb.picks,
    );
  }

  return {
    market: "india",
    tradeDate,
    generatedAt: now,
    modelVersion: AI_MODEL_VERSION,
    context: candidates.context,
    inActiveWindow: candidates.inActiveWindow,
    groups: groupDailyPicks(picks),
    persisted,
  };
}

export function summariseDay(picks: DailyPick[]): DailyPicksDaySummary {
  let targetHit = 0;
  let stopHit = 0;
  let closed = 0;
  let open = 0;
  for (const p of picks) {
    if (p.status === "TARGET_HIT") targetHit += 1;
    else if (p.status === "STOP_HIT") stopHit += 1;
    else if (p.status === "CLOSED" || p.status === "EXPIRED") closed += 1;
    else open += 1;
  }
  const resolved = targetHit + stopHit;
  return {
    total: picks.length,
    targetHit,
    stopHit,
    closed,
    open,
    winRate: resolved > 0 ? targetHit / resolved : 0,
  };
}

/**
 * Past trading days' picks + their final outcome, most recent first. Today
 * is excluded by default (it lives on the live board). Returns an empty list
 * when Postgres is unavailable.
 */
export async function getIndiaDailyPicksHistory(
  opts?: { days?: number; excludeDate?: string },
  prisma?: PrismaClient,
): Promise<DailyPicksHistoryResponse> {
  const now = Date.now();
  const db = prisma ?? safeGetPrisma();
  if (!db) return { market: "india", generatedAt: now, days: [] };

  try {
    const days = Math.min(Math.max(opts?.days ?? 14, 1), 60);
    const exclude = opts?.excludeDate ?? istDateKey(new Date(now));

    const dateRows = (await db.indiaDailyPick.findMany({
      where: { tradeDate: { not: exclude } },
      distinct: ["tradeDate"],
      orderBy: { tradeDate: "desc" },
      take: days,
      select: { tradeDate: true },
    })) as Array<{ tradeDate: string }>;

    const dates = dateRows.map((r) => r.tradeDate);
    if (dates.length === 0) return { market: "india", generatedAt: now, days: [] };

    const rows = (await db.indiaDailyPick.findMany({
      where: { tradeDate: { in: dates } },
      orderBy: [{ tradeDate: "desc" }, { rank: "asc" }],
    })) as unknown as DailyPickRow[];

    // Every history day is a *past* trading day, so its session has ended —
    // force-square-off any pick still left OPEN (intraday, no overnight carry)
    // and persist the flip so the track record is honest on future reads too.
    const squaredOff: Array<{
      tradeDate: string;
      bucket: string;
      rank: number;
      resolvedAt: number | null;
    }> = [];
    const byDate = new Map<string, DailyPick[]>();
    for (const row of rows) {
      let pick = rowToPick(row);
      if (pick.status === "OPEN") {
        // Resolve at that day's 15:30 IST close (not "now"), so the recorded
        // time-to-outcome reflects a real intraday hold, not the gap until the
        // history was viewed.
        const closeMs = nseCloseMsForDateIST(pick.tradeDate) ?? now;
        pick = squareOffPick(pick, closeMs);
        squaredOff.push({
          tradeDate: pick.tradeDate,
          bucket: pick.bucket,
          rank: pick.rank,
          resolvedAt: pick.resolvedAt,
        });
      }
      const bucket = byDate.get(pick.tradeDate) ?? [];
      bucket.push(pick);
      byDate.set(pick.tradeDate, bucket);
    }

    // Persist the flips so the track record stays honest on future reads. Each
    // day closes at its own instant, so these are per-pick updates.
    for (const s of squaredOff) {
      try {
        await db.indiaDailyPick.update({
          where: {
            tradeDate_bucket_rank: {
              tradeDate: s.tradeDate,
              bucket: s.bucket,
              rank: s.rank,
            },
          },
          data: {
            status: "CLOSED",
            resolvedAt: s.resolvedAt != null ? new Date(s.resolvedAt) : null,
          },
        });
      } catch {
        // Display still reflects the square-off even if the write fails.
      }
    }

    const out: DailyPicksHistoryDay[] = dates
      .filter((d) => byDate.has(d))
      .map((tradeDate) => {
        const picks = byDate.get(tradeDate) ?? [];
        return {
          tradeDate,
          groups: groupDailyPicks(picks),
          summary: summariseDay(picks),
        };
      });

    return { market: "india", generatedAt: now, days: out };
  } catch (err) {
    console.warn(
      "[daily-picks] history unavailable:",
      (err as Error).message,
    );
    return { market: "india", generatedAt: now, days: [] };
  }
}
