import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";

import {
  ALL_INDIA_STRATEGY_IDS,
  isIndiaScalpStrategyId,
  type IndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import {
  INDIA_SCALP_TIMEFRAMES,
  parseIndiaTradeSource,
  type IndiaPaperTradeStatus,
  type IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

/**
 * Server-side journal queries for India F&O paper trades. Mirrors the
 * crypto-side `src/features/scalping/journal.ts` but every read is
 * scoped to rows where `PaperTrade.source` starts with the canonical
 * `in:` prefix — so the two markets always stay in their own lanes
 * inside the same Postgres table.
 *
 * The companion crypto query explicitly filters by exact `<id>:<tf>`
 * sources, so it cannot accidentally surface India rows even if a
 * crypto strategy ever gained the same id. The two layers are
 * symmetrical and never need to know about each other.
 *
 * `PaperTrade.symbol` is a free-form `String` column (see the
 * `20260518050000_papertrade_symbol_string` migration), so the symbol
 * filter is pushed down into Prisma and served by the
 * `PaperTrade_symbol_openedAt_idx` index. Earlier revisions of this
 * file applied the symbol filter in-memory because the column was
 * still typed as the BTC/ETH/SOL `SymbolEnum`; that workaround is
 * gone.
 */

export interface IndiaPaperTradeRow {
  id: string;
  /** NSE ticker (e.g. "RELIANCE", "NIFTY"). */
  symbol: string;
  direction: "LONG" | "SHORT";
  status: IndiaPaperTradeStatus;
  /** Raw `source` column — `in:<strategyId>:<tf>`. */
  source: string;
  /** Parsed strategy id. Falls back to "MOMENTUM" for malformed legacy
   *  rows so the journal still renders something readable. */
  strategyId: IndiaScalpStrategyId;
  /** Parsed timeframe; defaults to "5m" for malformed legacy rows. */
  strategyTimeframe: IndiaScalpTimeframe;
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

export interface IndiaJournalQuery {
  symbol?: string;
  status?: IndiaPaperTradeStatus;
  /** When provided, restricts rows to these India strategies. */
  strategyIds?: ReadonlyArray<IndiaScalpStrategyId>;
  /** When provided, restricts rows to these exact `in:<id>:<tf>` source
   *  strings. Takes precedence over `strategyIds`. */
  sources?: ReadonlyArray<string>;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 200;

const ALL_INDIA_SOURCES: ReadonlyArray<string> = ALL_INDIA_STRATEGY_IDS.flatMap(
  (id) => INDIA_SCALP_TIMEFRAMES.map((tf) => `in:${id}:${tf}`),
);

/**
 * NSE tickers are stored uppercase by convention (the F&O paper-trader
 * always writes `RELIANCE`, `NIFTY`, …). We normalise the caller-
 * supplied symbol the same way so the Prisma equality filter doesn't
 * miss rows because of a hand-typed `nifty` from a URL or a stray
 * lowercase `tab` from an admin tool.
 */
function normaliseSymbol(symbol: string | undefined): string | undefined {
  if (!symbol) return undefined;
  const trimmed = symbol.trim();
  return trimmed.length === 0 ? undefined : trimmed.toUpperCase();
}

/**
 * Build the journal `where` clause shared by `listIndiaPaperTrades` /
 * `countIndiaPaperTrades`. Pulled out so the two helpers can never
 * drift — both `findMany` and `count` must agree on which rows belong
 * to a paginated page so the UI's total-count footer stays honest.
 *
 * The schema migration that flipped `PaperTrade.symbol` from
 * `SymbolEnum` to a free-form `String` (`prisma/migrations/20260518...
 * _papertrade_symbol_string`) means the symbol filter now lives at the
 * Prisma layer where it belongs — Postgres can use the
 * `PaperTrade_symbol_openedAt_idx` index instead of us paging the
 * full result set into Node and filtering it in memory.
 */
function indiaJournalWhere(query: IndiaJournalQuery) {
  const symbol = normaliseSymbol(query.symbol);
  return {
    ...(symbol ? { symbol } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...indiaSourceFilter(query),
  };
}

export async function listIndiaPaperTrades(
  query: IndiaJournalQuery = {},
  prisma?: PrismaClient,
): Promise<IndiaPaperTradeRow[]> {
  const db = prisma ?? getPrisma();
  const rawLimit =
    typeof query.limit === "number" && Number.isFinite(query.limit)
      ? Math.trunc(query.limit)
      : 50;
  const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset =
    typeof query.offset === "number" && Number.isFinite(query.offset)
      ? Math.max(0, Math.trunc(query.offset))
      : 0;

  const rows = await db.paperTrade.findMany({
    where: indiaJournalWhere(query),
    orderBy: [{ openedAt: "desc" }],
    take: limit,
    skip: offset,
  });

  return rows.map(toRow);
}

export async function countIndiaPaperTrades(
  query: Pick<
    IndiaJournalQuery,
    "symbol" | "status" | "strategyIds" | "sources"
  > = {},
  prisma?: PrismaClient,
): Promise<number> {
  const db = prisma ?? getPrisma();
  return db.paperTrade.count({ where: indiaJournalWhere(query) });
}

export async function listIndiaOpenTrades(
  prisma?: PrismaClient,
  strategyIds?: ReadonlyArray<IndiaScalpStrategyId>,
  sources?: ReadonlyArray<string>,
): Promise<IndiaPaperTradeRow[]> {
  const db = prisma ?? getPrisma();
  const rows = await db.paperTrade.findMany({
    where: {
      status: "OPEN",
      ...indiaSourceFilter({ strategyIds, sources }),
    },
    orderBy: [{ openedAt: "asc" }],
  });
  return rows.map(toRow);
}

/**
 * Build the `source IN (...)` filter for an India-scoped journal query.
 * The fallback (no filter args) still restricts to India-prefixed
 * sources via `ALL_INDIA_SOURCES` so crypto rows never leak through.
 */
function indiaSourceFilter(query: {
  strategyIds?: ReadonlyArray<IndiaScalpStrategyId>;
  sources?: ReadonlyArray<string>;
}): { source: { in: string[] } } {
  if (query.sources && query.sources.length > 0) {
    const filtered = query.sources.filter((s) => s.startsWith("in:"));
    if (filtered.length > 0) return { source: { in: [...filtered] } };
  }
  if (query.strategyIds && query.strategyIds.length > 0) {
    return { source: { in: expandIndiaStrategySources(query.strategyIds) } };
  }
  return { source: { in: [...ALL_INDIA_SOURCES] } };
}

function expandIndiaStrategySources(
  ids: ReadonlyArray<IndiaScalpStrategyId>,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    for (const tf of INDIA_SCALP_TIMEFRAMES) out.push(`in:${id}:${tf}`);
  }
  return out;
}

export interface IndiaSymbolStats {
  symbol: string;
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

export interface IndiaStrategyStats {
  strategyId: IndiaScalpStrategyId;
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

export interface IndiaJournalStats {
  overall: IndiaSymbolStats;
  bySymbol: IndiaSymbolStats[];
  byStrategy: IndiaStrategyStats[];
  recentTrades: IndiaPaperTradeRow[];
}

export async function getIndiaJournalStats(
  prisma?: PrismaClient,
): Promise<IndiaJournalStats> {
  const db = prisma ?? getPrisma();
  const all = await db.paperTrade.findMany({
    where: { source: { in: [...ALL_INDIA_SOURCES] } },
    orderBy: { openedAt: "desc" },
    take: 1000,
  });

  interface SymAcc {
    stats: IndiaSymbolStats;
    grossWin: number;
    grossLoss: number;
    pnlPctSum: number;
    pnlPctCount: number;
  }
  interface StratAcc {
    stats: IndiaStrategyStats;
    grossWin: number;
    grossLoss: number;
    pnlPctSum: number;
    pnlPctCount: number;
  }
  const newSymAcc = (symbol: string): SymAcc => ({
    stats: makeSymSeed(symbol),
    grossWin: 0,
    grossLoss: 0,
    pnlPctSum: 0,
    pnlPctCount: 0,
  });
  const newStratAcc = (id: IndiaScalpStrategyId): StratAcc => ({
    stats: makeStratSeed(id),
    grossWin: 0,
    grossLoss: 0,
    pnlPctSum: 0,
    pnlPctCount: 0,
  });

  const overall = newSymAcc("ALL");
  const perSymbol = new Map<string, SymAcc>();
  const perStrategy = new Map<IndiaScalpStrategyId, StratAcc>();

  for (const row of all) {
    const sym = row.symbol;
    const parsed = parseIndiaTradeSource(row.source);
    const stratId =
      parsed && isIndiaScalpStrategyId(parsed.strategyId)
        ? parsed.strategyId
        : "MOMENTUM";

    const symBucket = perSymbol.get(sym) ?? newSymAcc(sym);
    const stratBucket = perStrategy.get(stratId) ?? newStratAcc(stratId);
    symBucket.stats.total += 1;
    stratBucket.stats.total += 1;
    overall.stats.total += 1;

    switch (row.status as IndiaPaperTradeStatus) {
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

  const finalizeSym = (a: SymAcc): IndiaSymbolStats => ({
    ...a.stats,
    avgPnlPct: a.pnlPctCount > 0 ? a.pnlPctSum / a.pnlPctCount : 0,
    winRate: winRate(a.stats),
    profitFactor: profitFactor(a.grossWin, a.grossLoss),
  });
  const finalizeStrat = (a: StratAcc): IndiaStrategyStats => ({
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

export async function setIndiaTradeNote(
  id: string,
  note: string | null,
  prisma?: PrismaClient,
): Promise<IndiaPaperTradeRow | null> {
  const db = prisma ?? getPrisma();
  // Guard against accidentally writing a note onto a crypto row that
  // shares the same id space — only update when the source is India.
  const existing = await db.paperTrade.findUnique({
    where: { id },
    select: { source: true },
  });
  if (!existing || !existing.source.startsWith("in:")) return null;
  await db.paperTrade.update({ where: { id }, data: { note: note ?? null } });
  const row = await db.paperTrade.findUnique({ where: { id } });
  return row ? toRow(row) : null;
}

export async function cancelIndiaOpenTrade(
  id: string,
  prisma?: PrismaClient,
): Promise<IndiaPaperTradeRow | null> {
  const db = prisma ?? getPrisma();
  const existing = await db.paperTrade.findUnique({
    where: { id },
    select: { status: true, source: true },
  });
  if (!existing) return null;
  if (existing.status !== "OPEN") return null;
  if (!existing.source.startsWith("in:")) return null;
  await db.paperTrade.update({
    where: { id },
    data: { status: "CANCELLED", closedAt: new Date() },
  });
  const row = await db.paperTrade.findUnique({ where: { id } });
  return row ? toRow(row) : null;
}

function makeSymSeed(symbol: string): IndiaSymbolStats {
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

function makeStratSeed(strategyId: IndiaScalpStrategyId): IndiaStrategyStats {
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
}): IndiaPaperTradeRow {
  const parsed = parseIndiaTradeSource(row.source);
  return {
    id: row.id,
    symbol: row.symbol,
    direction: row.direction as "LONG" | "SHORT",
    status: row.status as IndiaPaperTradeStatus,
    source: row.source,
    strategyId:
      parsed && isIndiaScalpStrategyId(parsed.strategyId)
        ? parsed.strategyId
        : "MOMENTUM",
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
