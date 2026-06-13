import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import type { SymbolId, TradingSignal } from "@/types/market";

const FEATURES_VERSION = 1;
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

interface IngestStats {
  inserted: number;
  skippedSameType: number;
  skippedHold: number;
}

/**
 * Persist newly generated signals into SignalHistory, deduplicating against
 * the most recent row per symbol. We only write when:
 *   - There is no recent (< 30 min) row for the symbol, OR
 *   - The signal type changed since the last row.
 *
 * HOLD rows are skipped — they're not actionable and would clutter the table.
 * The caller drives this from the worker on a fixed cadence.
 */
export async function ingestSignals(signals: TradingSignal[], prisma?: PrismaClient): Promise<IngestStats> {
  const db = prisma ?? getPrisma();
  const stats: IngestStats = { inserted: 0, skippedSameType: 0, skippedHold: 0 };

  for (const s of signals) {
    if (s.type === "HOLD") {
      stats.skippedHold += 1;
      continue;
    }

    const latest = await db.signalHistory.findFirst({
      where: { symbol: s.symbol },
      orderBy: { generatedAt: "desc" },
      select: { id: true, type: true, generatedAt: true },
    });

    if (latest) {
      const ageMs = Date.now() - latest.generatedAt.getTime();
      if (latest.type === s.type && ageMs < DEDUP_WINDOW_MS) {
        stats.skippedSameType += 1;
        continue;
      }
    }

    await db.signalHistory.create({
      data: {
        symbol: s.symbol,
        type: s.type,
        confidence: s.confidence,
        risk: s.risk,
        entry: s.entry,
        stopLoss: s.stopLoss,
        target: s.target,
        riskReward: s.riskReward,
        rationale: s.rationale,
        features: {
          version: FEATURES_VERSION,
          ...s.features,
        },
      },
    });
    stats.inserted += 1;
  }

  return stats;
}

export interface AccuracyBreakdown {
  total: number;
  open: number;
  hitTarget: number;
  hitStop: number;
  expired: number;
  winRate: number; // hitTarget / (hitTarget + hitStop + expired-with-positive-pnl)
  avgPnlPct: number; // across all closed rows
}

export interface SymbolAccuracy extends AccuracyBreakdown {
  symbol: SymbolId;
}

export interface AccuracySummary {
  overall: AccuracyBreakdown;
  bySymbol: SymbolAccuracy[];
  recentClosed: Array<{
    id: string;
    symbol: SymbolId;
    type: string;
    outcome: string;
    pnlPct: number | null;
    generatedAt: Date;
    closedAt: Date | null;
  }>;
}

export async function getAccuracySummary(prisma?: PrismaClient): Promise<AccuracySummary> {
  const db = prisma ?? getPrisma();

  const grouped = await db.signalHistory.groupBy({
    by: ["symbol", "outcome"],
    _count: { _all: true },
    _avg: { pnlPct: true },
  });

  const symbolMap = new Map<SymbolId, AccuracyBreakdown>();
  const overall: AccuracyBreakdown = emptyBreakdown();

  for (const row of grouped) {
    const symbol = row.symbol as SymbolId;
    const breakdown = symbolMap.get(symbol) ?? emptyBreakdown();
    const count = row._count._all;
    breakdown.total += count;
    overall.total += count;

    switch (row.outcome) {
      case "OPEN":
        breakdown.open += count;
        overall.open += count;
        break;
      case "HIT_TARGET":
        breakdown.hitTarget += count;
        overall.hitTarget += count;
        break;
      case "HIT_STOP":
        breakdown.hitStop += count;
        overall.hitStop += count;
        break;
      case "EXPIRED":
        breakdown.expired += count;
        overall.expired += count;
        break;
    }
    symbolMap.set(symbol, breakdown);
  }

  for (const [, b] of symbolMap) finalize(b);
  finalize(overall);

  // avgPnlPct: re-query because groupBy keys included outcome. We want a
  // single average over all closed rows (outcome != OPEN).
  const closedAvg = await db.signalHistory.aggregate({
    _avg: { pnlPct: true },
    where: { outcome: { not: "OPEN" } },
  });
  overall.avgPnlPct = closedAvg._avg.pnlPct ?? 0;

  const perSymbolAvg = await db.signalHistory.groupBy({
    by: ["symbol"],
    _avg: { pnlPct: true },
    where: { outcome: { not: "OPEN" } },
  });
  for (const row of perSymbolAvg) {
    const b = symbolMap.get(row.symbol as SymbolId);
    if (b) b.avgPnlPct = row._avg.pnlPct ?? 0;
  }

  const recentClosed = await db.signalHistory.findMany({
    where: { outcome: { not: "OPEN" } },
    orderBy: { closedAt: "desc" },
    take: 8,
    select: {
      id: true,
      symbol: true,
      type: true,
      outcome: true,
      pnlPct: true,
      generatedAt: true,
      closedAt: true,
    },
  });

  return {
    overall,
    bySymbol: Array.from(symbolMap.entries())
      .map(([symbol, b]) => ({ symbol, ...b }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    recentClosed: recentClosed.map((r) => ({
      ...r,
      symbol: r.symbol as SymbolId,
    })),
  };
}

function emptyBreakdown(): AccuracyBreakdown {
  return { total: 0, open: 0, hitTarget: 0, hitStop: 0, expired: 0, winRate: 0, avgPnlPct: 0 };
}

function finalize(b: AccuracyBreakdown): void {
  const closed = b.hitTarget + b.hitStop + b.expired;
  b.winRate = closed > 0 ? b.hitTarget / closed : 0;
}
