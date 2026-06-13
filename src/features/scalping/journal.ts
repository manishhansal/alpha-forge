import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import {
  parseTradeSource,
  type PaperTradeStatus,
  type ScalpStrategyId,
  type ScalpTimeframe,
} from "@/features/scalping/types";
import type { SymbolId } from "@/types/market";

export interface PaperTradeRow {
  id: string;
  symbol: SymbolId;
  direction: "LONG" | "SHORT";
  status: PaperTradeStatus;
  /** Raw `source` column — kept for debugging / replay. */
  source: string;
  /** Parsed strategy id (defaults to UT_SMC for legacy rows). */
  strategyId: ScalpStrategyId;
  /** Parsed timeframe (defaults to 5m for legacy rows). */
  strategyTimeframe: ScalpTimeframe;
  rationale: string[];
  notional: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  atr: number;
  exitPrice: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  note: string | null;
  openedAt: Date;
  closedAt: Date | null;
}

export interface JournalQuery {
  symbol?: SymbolId;
  status?: PaperTradeStatus;
  /** When provided, restricts rows to those produced by these strategies. */
  strategyIds?: ReadonlyArray<ScalpStrategyId>;
  /**
   * When provided, restricts rows to these exact (strategy × timeframe)
   * source strings (e.g. `"UT_SMC:5m"`). Takes precedence over `strategyIds`
   * — used by the picker that lets the user attach individual timeframes
   * per strategy.
   */
  sources?: ReadonlyArray<string>;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 200;

/**
 * List paper trades for the journal table. Newest first; OPEN trades are
 * surfaced via the dedicated `listOpenTrades()` so the journal table itself
 * defaults to closed history when no status is passed.
 */
export async function listPaperTrades(
  query: JournalQuery = {},
  prisma?: PrismaClient,
): Promise<PaperTradeRow[]> {
  const db = prisma ?? getPrisma();
  // Defensive: guard against a caller handing us NaN / undefined for
  // limit or offset. Either would translate to `take: NaN` / `skip: NaN`
  // in the Prisma call, which fails the runtime validator with the
  // confusing "Argument `take` is missing." error.
  const rawLimit = typeof query.limit === "number" && Number.isFinite(query.limit)
    ? Math.trunc(query.limit)
    : 50;
  const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset = typeof query.offset === "number" && Number.isFinite(query.offset)
    ? Math.max(0, Math.trunc(query.offset))
    : 0;

  const rows = await db.paperTrade.findMany({
    where: {
      ...(query.symbol ? { symbol: query.symbol } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...sourceFilter(query),
    },
    orderBy: [{ openedAt: "desc" }],
    take: limit,
    skip: offset,
  });

  return rows.map(toRow);
}

/**
 * Count rows that match the same `where` clause as `listPaperTrades` —
 * used by the paginated journal API to expose the total page count to
 * the frontend without forcing it to fetch the entire dataset.
 *
 * Pagination params (`limit` / `offset`) are intentionally ignored —
 * the count must reflect the full filtered result set, not the slice.
 */
export async function countPaperTrades(
  query: Pick<JournalQuery, "symbol" | "status" | "strategyIds" | "sources"> = {},
  prisma?: PrismaClient,
): Promise<number> {
  const db = prisma ?? getPrisma();
  return db.paperTrade.count({
    where: {
      ...(query.symbol ? { symbol: query.symbol } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...sourceFilter(query),
    },
  });
}

export async function listOpenTrades(
  prisma?: PrismaClient,
  strategyIds?: ReadonlyArray<ScalpStrategyId>,
  sources?: ReadonlyArray<string>,
): Promise<PaperTradeRow[]> {
  const db = prisma ?? getPrisma();
  const rows = await db.paperTrade.findMany({
    where: {
      status: "OPEN",
      ...sourceFilter({ strategyIds, sources }),
    },
    orderBy: [{ openedAt: "asc" }],
  });
  return rows.map(toRow);
}

/**
 * Build the `source` `IN (...)` filter. Exact source strings take priority;
 * otherwise we fall back to the (legacy) per-strategy expansion that covers
 * every timeframe lane of the supplied strategies.
 */
function sourceFilter(query: {
  strategyIds?: ReadonlyArray<ScalpStrategyId>;
  sources?: ReadonlyArray<string>;
}): { source?: { in: string[] } } {
  if (query.sources && query.sources.length > 0) {
    return { source: { in: [...query.sources] } };
  }
  if (query.strategyIds && query.strategyIds.length > 0) {
    return { source: { in: expandStrategySources(query.strategyIds) } };
  }
  return {};
}

/**
 * `source` is stored as `${strategyId}:${timeframe}`. Postgres has no LIKE
 * over an `in` list, so we materialise every supported (strategy × timeframe)
 * combination. With 7 strategies × 3 timeframes that's 21 strings — cheap.
 */
function expandStrategySources(ids: ReadonlyArray<ScalpStrategyId>): string[] {
  const tfs: ScalpTimeframe[] = ["1m", "5m", "15m"];
  const out: string[] = [];
  for (const id of ids) {
    for (const tf of tfs) out.push(`${id}:${tf}`);
    // Legacy alias — historical rows used `SMC_UTBOT:<tf>` for UT_SMC.
    if (id === "UT_SMC") for (const tf of tfs) out.push(`SMC_UTBOT:${tf}`);
  }
  return out;
}

export interface SymbolStats {
  symbol: SymbolId;
  total: number;
  open: number;
  wins: number;
  losses: number;
  expired: number;
  cancelled: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlUsd: number;
  profitFactor: number;
}

export interface StrategyStats {
  strategyId: ScalpStrategyId;
  total: number;
  open: number;
  wins: number;
  losses: number;
  expired: number;
  cancelled: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlUsd: number;
  profitFactor: number;
}

export interface JournalStats {
  overall: SymbolStats;
  bySymbol: SymbolStats[];
  byStrategy: StrategyStats[];
  recentTrades: PaperTradeRow[];
}

export async function getJournalStats(prisma?: PrismaClient): Promise<JournalStats> {
  const db = prisma ?? getPrisma();
  const all = await db.paperTrade.findMany({
    orderBy: { openedAt: "desc" },
    take: 1000,
  });

  interface SymAccumulator {
    stats: SymbolStats;
    grossWin: number;
    grossLoss: number;
    pnlPctSum: number;
    pnlPctCount: number;
  }
  interface StratAccumulator {
    stats: StrategyStats;
    grossWin: number;
    grossLoss: number;
    pnlPctSum: number;
    pnlPctCount: number;
  }
  const newSymAcc = (symbol: SymbolId): SymAccumulator => ({
    stats: makeStatSeed(symbol),
    grossWin: 0,
    grossLoss: 0,
    pnlPctSum: 0,
    pnlPctCount: 0,
  });
  const newStratAcc = (id: ScalpStrategyId): StratAccumulator => ({
    stats: makeStrategyStatSeed(id),
    grossWin: 0,
    grossLoss: 0,
    pnlPctSum: 0,
    pnlPctCount: 0,
  });

  const overall = newSymAcc("BTC");
  const perSymbol = new Map<SymbolId, SymAccumulator>();
  const perStrategy = new Map<ScalpStrategyId, StratAccumulator>();

  for (const row of all) {
    const sym = row.symbol as SymbolId;
    const parsed = parseTradeSource(row.source);
    const stratId = parsed?.strategyId ?? "UT_SMC";

    const symBucket = perSymbol.get(sym) ?? newSymAcc(sym);
    const stratBucket = perStrategy.get(stratId) ?? newStratAcc(stratId);
    symBucket.stats.total += 1;
    stratBucket.stats.total += 1;
    overall.stats.total += 1;

    switch (row.status) {
      case "OPEN":
        symBucket.stats.open += 1;
        stratBucket.stats.open += 1;
        overall.stats.open += 1;
        break;
      case "WIN":
        symBucket.stats.wins += 1;
        stratBucket.stats.wins += 1;
        overall.stats.wins += 1;
        break;
      case "LOSS":
        symBucket.stats.losses += 1;
        stratBucket.stats.losses += 1;
        overall.stats.losses += 1;
        break;
      case "EXPIRED":
        symBucket.stats.expired += 1;
        stratBucket.stats.expired += 1;
        overall.stats.expired += 1;
        break;
      case "CANCELLED":
        symBucket.stats.cancelled += 1;
        stratBucket.stats.cancelled += 1;
        overall.stats.cancelled += 1;
        break;
    }

    if (row.pnlPct !== null) {
      symBucket.pnlPctSum += row.pnlPct;
      symBucket.pnlPctCount += 1;
      stratBucket.pnlPctSum += row.pnlPct;
      stratBucket.pnlPctCount += 1;
      overall.pnlPctSum += row.pnlPct;
      overall.pnlPctCount += 1;
    }
    if (row.pnlUsd !== null) {
      symBucket.stats.totalPnlUsd += row.pnlUsd;
      stratBucket.stats.totalPnlUsd += row.pnlUsd;
      overall.stats.totalPnlUsd += row.pnlUsd;
      if (row.pnlUsd > 0) {
        symBucket.grossWin += row.pnlUsd;
        stratBucket.grossWin += row.pnlUsd;
        overall.grossWin += row.pnlUsd;
      } else {
        symBucket.grossLoss += Math.abs(row.pnlUsd);
        stratBucket.grossLoss += Math.abs(row.pnlUsd);
        overall.grossLoss += Math.abs(row.pnlUsd);
      }
    }
    perSymbol.set(sym, symBucket);
    perStrategy.set(stratId, stratBucket);
  }

  const finalizeSym = (a: SymAccumulator): SymbolStats => ({
    ...a.stats,
    avgPnlPct: a.pnlPctCount > 0 ? a.pnlPctSum / a.pnlPctCount : 0,
    winRate: winRate(a.stats),
    profitFactor: profitFactor(a.grossWin, a.grossLoss),
  });
  const finalizeStrat = (a: StratAccumulator): StrategyStats => ({
    ...a.stats,
    avgPnlPct: a.pnlPctCount > 0 ? a.pnlPctSum / a.pnlPctCount : 0,
    winRate: winRate(a.stats),
    profitFactor: profitFactor(a.grossWin, a.grossLoss),
  });

  return {
    overall: finalizeSym(overall),
    bySymbol: Array.from(perSymbol.values())
      .map(finalizeSym)
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    byStrategy: Array.from(perStrategy.values())
      .map(finalizeStrat)
      .sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
    recentTrades: all.slice(0, 10).map(toRow),
  };
}

export async function setTradeNote(
  id: string,
  note: string | null,
  prisma?: PrismaClient,
): Promise<PaperTradeRow | null> {
  const db = prisma ?? getPrisma();
  const updated = await db.paperTrade.updateMany({
    where: { id },
    data: { note: note ?? null },
  });
  if (updated.count === 0) return null;
  const row = await db.paperTrade.findUnique({ where: { id } });
  return row ? toRow(row) : null;
}

export async function cancelOpenTrade(
  id: string,
  prisma?: PrismaClient,
): Promise<PaperTradeRow | null> {
  const db = prisma ?? getPrisma();
  const existing = await db.paperTrade.findUnique({ where: { id }, select: { status: true } });
  if (!existing || existing.status !== "OPEN") return null;
  await db.paperTrade.update({
    where: { id },
    data: { status: "CANCELLED", closedAt: new Date() },
  });
  const row = await db.paperTrade.findUnique({ where: { id } });
  return row ? toRow(row) : null;
}

function makeStatSeed(symbol: SymbolId): SymbolStats {
  return {
    symbol,
    total: 0,
    open: 0,
    wins: 0,
    losses: 0,
    expired: 0,
    cancelled: 0,
    winRate: 0,
    avgPnlPct: 0,
    totalPnlUsd: 0,
    profitFactor: 0,
  };
}

function makeStrategyStatSeed(strategyId: ScalpStrategyId): StrategyStats {
  return {
    strategyId,
    total: 0,
    open: 0,
    wins: 0,
    losses: 0,
    expired: 0,
    cancelled: 0,
    winRate: 0,
    avgPnlPct: 0,
    totalPnlUsd: 0,
    profitFactor: 0,
  };
}

function winRate(s: { wins: number; losses: number; expired: number }): number {
  const closed = s.wins + s.losses + s.expired;
  return closed > 0 ? s.wins / closed : 0;
}

function profitFactor(grossWin: number, grossLoss: number): number {
  if (grossLoss === 0) {
    if (grossWin === 0) return 0;
    return Number.POSITIVE_INFINITY;
  }
  return grossWin / grossLoss;
}

function toRow(row: {
  id: string;
  symbol: string;
  direction: string;
  status: string;
  source: string;
  rationale: string[];
  notional: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  atr: number;
  exitPrice: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  note: string | null;
  openedAt: Date;
  closedAt: Date | null;
}): PaperTradeRow {
  const parsed = parseTradeSource(row.source);
  return {
    id: row.id,
    symbol: row.symbol as SymbolId,
    direction: row.direction as "LONG" | "SHORT",
    status: row.status as PaperTradeStatus,
    source: row.source,
    strategyId: parsed?.strategyId ?? "UT_SMC",
    strategyTimeframe: parsed?.timeframe ?? "5m",
    rationale: row.rationale,
    notional: row.notional,
    entry: row.entry,
    stopLoss: row.stopLoss,
    target: row.target,
    riskReward: row.riskReward,
    atr: row.atr,
    exitPrice: row.exitPrice,
    pnlPct: row.pnlPct,
    pnlUsd: row.pnlUsd,
    note: row.note,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}
