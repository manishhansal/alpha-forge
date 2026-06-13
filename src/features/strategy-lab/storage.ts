import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { parseStrategy } from "@/features/strategy-lab/parser";
import {
  PERIOD_FROM_DB,
  PERIOD_INTERVAL,
  PERIOD_TO_DB,
  type BacktestResult,
  type ParsedStrategy,
  type StrategyPeriod,
} from "@/features/strategy-lab/types";
import type { SymbolId } from "@/types/market";

/**
 * CRUD + persistence helpers for the Strategy Lab.
 *
 * Strategies are user-scoped. Backtests link back to the strategy when run
 * for a saved one (`strategyId` non-null) and float free for ad-hoc
 * pre-save runs (so users can iterate on the prompt without polluting the
 * saved list). Live paper trades are always tied to a saved strategy.
 */

const INTERVAL_MINUTES: Record<string, number> = {
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

export interface SavedStrategy {
  id: string;
  name: string;
  prompt: string;
  parsed: ParsedStrategy;
  symbols: SymbolId[];
  liveEnabled: boolean;
  liveStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BacktestRow {
  id: string;
  strategyId: string | null;
  symbol: SymbolId;
  period: StrategyPeriod;
  interval: string;
  generatedAt: number;
  result: BacktestResult;
}

function toSavedStrategy(row: {
  id: string;
  name: string;
  prompt: string;
  parsed: unknown;
  symbols: string[];
  liveEnabled: boolean;
  liveStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SavedStrategy {
  const parsed = (row.parsed as ParsedStrategy | null) ?? parseStrategy(row.prompt);
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    parsed,
    symbols: row.symbols as SymbolId[],
    liveEnabled: row.liveEnabled,
    liveStartedAt: row.liveStartedAt ? row.liveStartedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export interface CreateStrategyInput {
  userId: string;
  name: string;
  prompt: string;
  symbols: SymbolId[];
}

export async function createStrategy(
  input: CreateStrategyInput,
  prisma?: PrismaClient,
): Promise<SavedStrategy> {
  const db = prisma ?? getPrisma();
  // Use a sensible default interval (1h) for re-parsing when persisting —
  // each backtest run will re-parse with the correct one anyway.
  const parsed = parseStrategy(input.prompt, { intervalMinutes: 60 });
  const created = await db.strategy.create({
    data: {
      userId: input.userId,
      name: input.name.trim() || "Untitled strategy",
      prompt: input.prompt,
      parsed: parsed as unknown as object,
      symbols: input.symbols,
    },
  });
  return toSavedStrategy(created);
}

export async function listUserStrategies(
  userId: string,
  prisma?: PrismaClient,
): Promise<SavedStrategy[]> {
  const db = prisma ?? getPrisma();
  const rows = await db.strategy.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return rows.map(toSavedStrategy);
}

export async function getUserStrategy(
  userId: string,
  id: string,
  prisma?: PrismaClient,
): Promise<SavedStrategy | null> {
  const db = prisma ?? getPrisma();
  const row = await db.strategy.findFirst({ where: { id, userId } });
  return row ? toSavedStrategy(row) : null;
}

export async function deleteStrategy(
  userId: string,
  id: string,
  prisma?: PrismaClient,
): Promise<boolean> {
  const db = prisma ?? getPrisma();
  const res = await db.strategy.deleteMany({ where: { id, userId } });
  return res.count > 0;
}

export async function setStrategyLive(
  userId: string,
  id: string,
  live: boolean,
  prisma?: PrismaClient,
): Promise<SavedStrategy | null> {
  const db = prisma ?? getPrisma();
  const owned = await db.strategy.findFirst({ where: { id, userId } });
  if (!owned) return null;
  const updated = await db.strategy.update({
    where: { id },
    data: {
      liveEnabled: live,
      liveStartedAt: live ? (owned.liveStartedAt ?? new Date()) : null,
    },
  });
  return toSavedStrategy(updated);
}

export async function updateStrategyPrompt(
  userId: string,
  id: string,
  patch: { name?: string; prompt?: string; symbols?: SymbolId[] },
  prisma?: PrismaClient,
): Promise<SavedStrategy | null> {
  const db = prisma ?? getPrisma();
  const owned = await db.strategy.findFirst({ where: { id, userId } });
  if (!owned) return null;
  const promptNext = patch.prompt ?? owned.prompt;
  const parsed = parseStrategy(promptNext, { intervalMinutes: 60 });
  const updated = await db.strategy.update({
    where: { id },
    data: {
      name: patch.name ?? owned.name,
      prompt: promptNext,
      parsed: parsed as unknown as object,
      symbols: patch.symbols ?? (owned.symbols as SymbolId[]),
    },
  });
  return toSavedStrategy(updated);
}

// ───────────────────────────────────────────────────────────────────────────
// Backtest persistence.
// ───────────────────────────────────────────────────────────────────────────
export interface SaveBacktestInput {
  strategyId: string | null;
  prompt: string;
  symbol: SymbolId;
  period: StrategyPeriod;
  result: BacktestResult;
}

export async function saveBacktest(
  input: SaveBacktestInput,
  prisma?: PrismaClient,
): Promise<BacktestRow> {
  const db = prisma ?? getPrisma();
  const interval = PERIOD_INTERVAL[input.period];
  // Replace prior saved-strategy snapshot for the same (strategy, symbol,
  // period) tuple so the saved view always shows the freshest run.
  if (input.strategyId) {
    await db.strategyBacktest.deleteMany({
      where: {
        strategyId: input.strategyId,
        symbol: input.symbol,
        period: PERIOD_TO_DB[input.period],
      },
    });
  }
  const row = await db.strategyBacktest.create({
    data: {
      strategyId: input.strategyId,
      prompt: input.prompt,
      symbol: input.symbol,
      period: PERIOD_TO_DB[input.period],
      interval,
      stats: input.result.stats as unknown as object,
      equityCurve: input.result.equityCurve as unknown as object,
      trades: input.result.trades as unknown as object,
    },
  });
  return {
    id: row.id,
    strategyId: row.strategyId,
    symbol: row.symbol as SymbolId,
    period: input.period,
    interval: row.interval,
    generatedAt: row.generatedAt.getTime(),
    result: input.result,
  };
}

export async function listStrategyBacktests(
  userId: string,
  strategyId: string,
  prisma?: PrismaClient,
): Promise<BacktestRow[]> {
  const db = prisma ?? getPrisma();
  const owned = await db.strategy.findFirst({ where: { id: strategyId, userId } });
  if (!owned) return [];
  const rows = await db.strategyBacktest.findMany({
    where: { strategyId },
    orderBy: { generatedAt: "desc" },
  });
  return rows.map(toBacktestRow);
}

function toBacktestRow(row: {
  id: string;
  strategyId: string | null;
  prompt: string;
  symbol: string;
  period: string;
  interval: string;
  stats: unknown;
  equityCurve: unknown;
  trades: unknown;
  generatedAt: Date;
}): BacktestRow {
  const period = PERIOD_FROM_DB[row.period as keyof typeof PERIOD_FROM_DB] ?? "1M";
  const parsed = parseStrategy(row.prompt, {
    intervalMinutes: INTERVAL_MINUTES[row.interval] ?? 60,
  });
  return {
    id: row.id,
    strategyId: row.strategyId,
    symbol: row.symbol as SymbolId,
    period,
    interval: row.interval,
    generatedAt: row.generatedAt.getTime(),
    result: {
      stats: row.stats as BacktestResult["stats"],
      equityCurve: (row.equityCurve as BacktestResult["equityCurve"]) ?? [],
      trades: (row.trades as BacktestResult["trades"]) ?? [],
      parsed,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Live paper-trade list.
// ───────────────────────────────────────────────────────────────────────────
export interface StrategyPaperTradeRow {
  id: string;
  strategyId: string;
  symbol: SymbolId;
  direction: "LONG" | "SHORT";
  status: "OPEN" | "WIN" | "LOSS" | "EXPIRED" | "CANCELLED";
  notional: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  rationale: string[];
  exitPrice: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  closeReason: string | null;
  openedAt: number;
  closedAt: number | null;
}

export async function listStrategyPaperTrades(
  userId: string,
  strategyId: string,
  prisma?: PrismaClient,
): Promise<StrategyPaperTradeRow[]> {
  const db = prisma ?? getPrisma();
  const owned = await db.strategy.findFirst({ where: { id: strategyId, userId } });
  if (!owned) return [];
  const rows = await db.strategyPaperTrade.findMany({
    where: { strategyId },
    orderBy: { openedAt: "desc" },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    strategyId: r.strategyId,
    symbol: r.symbol as SymbolId,
    direction: r.direction as "LONG" | "SHORT",
    status: r.status as StrategyPaperTradeRow["status"],
    notional: r.notional,
    entry: r.entry,
    stopLoss: r.stopLoss,
    target: r.target,
    riskReward: r.riskReward,
    rationale: r.rationale,
    exitPrice: r.exitPrice,
    pnlPct: r.pnlPct,
    pnlUsd: r.pnlUsd,
    closeReason: r.closeReason,
    openedAt: r.openedAt.getTime(),
    closedAt: r.closedAt ? r.closedAt.getTime() : null,
  }));
}

export interface StrategyLiveStats {
  totalTrades: number;
  open: number;
  wins: number;
  losses: number;
  expired: number;
  cancelled: number;
  winRate: number;
  totalPnlUsd: number;
  avgPnlPct: number;
}

export async function getStrategyLiveStats(
  userId: string,
  strategyId: string,
  prisma?: PrismaClient,
): Promise<StrategyLiveStats> {
  const trades = await listStrategyPaperTrades(userId, strategyId, prisma);
  const open = trades.filter((t) => t.status === "OPEN").length;
  const wins = trades.filter((t) => t.status === "WIN").length;
  const losses = trades.filter((t) => t.status === "LOSS").length;
  const expired = trades.filter((t) => t.status === "EXPIRED").length;
  const cancelled = trades.filter((t) => t.status === "CANCELLED").length;
  const closed = wins + losses;
  const totalPnlUsd = trades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const pnlSamples = trades.filter((t) => t.pnlPct !== null).map((t) => t.pnlPct ?? 0);
  const avgPnlPct =
    pnlSamples.length > 0 ? pnlSamples.reduce((s, v) => s + v, 0) / pnlSamples.length : 0;
  return {
    totalTrades: trades.length,
    open,
    wins,
    losses,
    expired,
    cancelled,
    winRate: closed > 0 ? wins / closed : 0,
    totalPnlUsd,
    avgPnlPct,
  };
}
