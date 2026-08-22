/**
 * India Auto Paper-Trading Engine
 *
 * Intelligent signal selection + daily ₹1L budget management.
 *
 * ── Signal scoring ────────────────────────────────────────────────────────────
 * Each candidate signal is ranked by a composite score derived from the
 * four best predictors of intraday profitability:
 *
 *   score = 0.35 × confidence          (multi-confluence AI score, 0–1)
 *         + 0.25 × winProbability       (calibrated TP1 hit rate, 0–1)
 *         + 0.25 × gradeScore           (S=1.0, A=0.8, B=0.6, C=0.4, D=0.2)
 *         + 0.15 × rrScore             (riskReward capped at 3:1 → 0–1)
 *
 * Only signals scoring ≥ MINIMUM_SCORE are considered. Among those, at most
 * MAX_CONCURRENT_TRADES are opened per day, selected in descending score order.
 *
 * ── Budget management ─────────────────────────────────────────────────────────
 * Daily budget = ₹1,00,000 (starting capital, resets every IST session).
 * Each trade receives a notional = startingCapital / MAX_CONCURRENT_TRADES.
 * A trade is only opened if the remaining budget covers its notional and the
 * risk per trade (SL distance × notional / entry) is within MAX_RISK_PER_TRADE.
 *
 * ── Session tracking ─────────────────────────────────────────────────────────
 * IndiaDaySession is upserted on the first trade of each day and finalised
 * at session close (15:30 IST). The session records deployed capital, P&L,
 * win rate, best/worst trade, avg trade, and max drawdown.
 *
 * ── Analytics ────────────────────────────────────────────────────────────────
 * getIndiaAutoTradingAnalytics() aggregates IndiaDaySession rows across any
 * time range and returns equity curve, drawdown series, per-day breakdown,
 * Sharpe ratio, and consistency metrics.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  isNseMarketOpenIST,
  isNseSessionEndedForDateIST,
  nseCloseMsForDateIST,
} from "@/lib/india/market-hours";
import { istDateKey } from "@/features/india/daily-picks/engine";
import type { AiSignal } from "@/types/ai-signals";
import type { DailyPick } from "@/features/india/daily-picks/engine";
import { getIndiaDailyPicks } from "@/features/india/daily-picks/builder";
import { getIndiaAiSignals } from "@/features/ai-signals/india-builder";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Total intraday budget per day. Resets at 09:15 IST every session. */
export const DAILY_BUDGET = 100_000;
/** Maximum number of simultaneous open positions. */
const MAX_CONCURRENT_TRADES = 5;
/** Notional per trade = budget / max positions. */
const TRADE_NOTIONAL = DAILY_BUDGET / MAX_CONCURRENT_TRADES; // ₹20,000
/** Minimum composite score to be eligible for a trade. */
const MINIMUM_SCORE = 0.52;
/** Maximum risk per trade as a fraction of trade notional (e.g. 0.02 = 2%). */
const MAX_RISK_PER_TRADE_PCT = 0.025;
/** Source tag written to PaperTrade.source for auto-trades. */
const AUTO_TRADE_SOURCE_PREFIX = "in:AUTO";
/** Don't open more trades after this point in the session (IST minutes). */
const LAST_ENTRY_MINUTES = 14 * 60 + 45; // 14:45 IST

// ─── Scoring ──────────────────────────────────────────────────────────────────

const GRADE_SCORE: Record<string, number> = {
  S: 1.0, A: 0.8, B: 0.6, C: 0.4, D: 0.2,
};

interface ScoredCandidate {
  score:        number;
  symbol:       string;
  direction:    "LONG" | "SHORT";
  entry:        number;
  stopLoss:     number;
  target:       number;
  riskReward:   number;
  confidence:   number;
  winProbability: number;
  grade:        string;
  source:       string;  // "DAILY_PICK" | "AI_SIGNAL"
  rationale:    string[];
  meta:         Record<string, unknown>;
}

function scoreSignal(
  confidence:    number,
  winProbability: number,
  grade:         string,
  riskReward:    number,
): number {
  const gradeScore = GRADE_SCORE[grade] ?? 0.2;
  const rrScore    = Math.min(riskReward / 3, 1); // cap at 3:1
  return (
    0.35 * Math.max(0, Math.min(1, confidence)) +
    0.25 * Math.max(0, Math.min(1, winProbability)) +
    0.25 * gradeScore +
    0.15 * rrScore
  );
}

function candidateFromPick(pick: DailyPick): ScoredCandidate | null {
  if (pick.action === "WAIT") return null;
  if (!Number.isFinite(pick.entry) || pick.entry <= 0) return null;
  if (!Number.isFinite(pick.stopLoss) || pick.stopLoss <= 0) return null;
  if (!Number.isFinite(pick.target) || pick.target <= 0) return null;
  const confidence    = pick.confidence;
  const winProbability = pick.winProbability;
  const grade         = pick.grade;
  const riskReward    = pick.riskReward;
  const score         = scoreSignal(confidence, winProbability, grade, riskReward);
  if (score < MINIMUM_SCORE) return null;
  return {
    score,
    symbol:        pick.symbol.replace(/\.NS$/i, "").toUpperCase(),
    direction:     pick.direction === "BEARISH" ? "SHORT" : "LONG",
    entry:         pick.entry,
    stopLoss:      pick.stopLoss,
    target:        pick.target,
    riskReward,
    confidence,
    winProbability,
    grade,
    source:        "DAILY_PICK",
    rationale:     pick.rationale ?? [],
    meta: {
      bucket:          pick.bucket,
      grade,
      confidence,
      winProbability,
      confluenceScore: pick.confluenceScore,
      setupType:       pick.setupType,
      score,
    },
  };
}

function candidateFromAiSignal(sig: AiSignal): ScoredCandidate | null {
  if (sig.action === "WAIT" || sig.market !== "india") return null;
  if (sig.horizon !== "intraday" && sig.horizon !== "scalp") return null;
  const tp1 = sig.takeProfits?.[0]?.price;
  if (!tp1 || !Number.isFinite(tp1)) return null;
  if (!Number.isFinite(sig.entry) || sig.entry <= 0) return null;
  if (!Number.isFinite(sig.stopLoss) || sig.stopLoss <= 0) return null;
  const confidence    = sig.confidence;
  const winProbability = sig.winProbability;
  const grade         = sig.grade;
  const riskReward    = sig.riskReward;
  const score         = scoreSignal(confidence, winProbability, grade, riskReward);
  if (score < MINIMUM_SCORE) return null;
  return {
    score,
    symbol:        sig.symbol.replace(/\.NS$/i, "").toUpperCase(),
    direction:     sig.direction === "BEARISH" ? "SHORT" : "LONG",
    entry:         sig.entry,
    stopLoss:      sig.stopLoss,
    target:        tp1,
    riskReward,
    confidence,
    winProbability,
    grade,
    source:        "AI_SIGNAL",
    rationale:     sig.reasons?.slice(0, 3).map((r) => r.text) ?? [],
    meta: {
      grade,
      confidence,
      winProbability,
      horizon:    sig.horizon,
      riskLevel:  sig.riskLevel,
      score,
    },
  };
}

// ─── Budget / session helpers ─────────────────────────────────────────────────

function safeDb(): PrismaClient | null {
  try { return getPrisma(); } catch { return null; }
}

/** How many OPEN auto-trades exist today + remaining budget from today's session. */
async function getDailyBudgetState(db: PrismaClient, tradeDate: string) {
  const [openCount, session] = await Promise.all([
    db.paperTrade.count({
      where: { status: "OPEN", source: { startsWith: AUTO_TRADE_SOURCE_PREFIX } },
    }),
    db.indiaDaySession.findUnique({ where: { tradeDate } }).catch(() => null),
  ]);
  const deployed   = session?.deployed ?? 0;
  const remaining  = Math.max(0, DAILY_BUDGET - deployed);
  const canOpen    = openCount < MAX_CONCURRENT_TRADES && remaining >= TRADE_NOTIONAL;
  const slotsLeft  = MAX_CONCURRENT_TRADES - openCount;
  return { openCount, deployed, remaining, canOpen, slotsLeft, session };
}

/** Upsert (create or update) the day's session row. */
async function upsertSession(
  db: PrismaClient,
  tradeDate: string,
  update: Partial<{
    deployed:       number;
    realisedPnl:    number;
    realisedPnlPct: number;
    totalTrades:    number;
    wins:           number;
    losses:         number;
    expired:        number;
    winRate:        number | null;
    bestTradePct:   number | null;
    worstTradePct:  number | null;
    avgTradePct:    number | null;
    maxDrawdownPct: number | null;
    finalised:      boolean;
    finalisedAt:    Date | null;
    tradeIds:       string[];
  }>,
) {
  await db.indiaDaySession.upsert({
    where:  { tradeDate },
    create: { tradeDate, ...update, updatedAt: new Date() },
    update: { ...update, updatedAt: new Date() },
  });
}

// ─── Core: auto-trade tick ────────────────────────────────────────────────────

export interface AutoTradeTickResult {
  opened: number;
  skipped: number;
  reason?: string;
}

/**
 * One tick of the auto paper-trading engine. Called every minute during
 * market hours by the worker.
 *
 * 1. Fetch candidates from Daily Picks + AI Signals.
 * 2. Score and rank them.
 * 3. Open at most `slotsLeft` trades that pass the budget and risk gates.
 * 4. Update the IndiaDaySession row.
 */
export async function runAutoTradeTick(): Promise<AutoTradeTickResult> {
  const now = new Date();
  if (!isNseMarketOpenIST(now)) return { opened: 0, skipped: 0, reason: "market-closed" };

  // No new entries in the last 45 minutes of the session.
  const IST_OFFSET_MS  = 5.5 * 60 * 60 * 1000;
  const istMinutes = (now.getTime() + IST_OFFSET_MS) / 60_000 % (24 * 60);
  if (istMinutes >= LAST_ENTRY_MINUTES) {
    return { opened: 0, skipped: 0, reason: "last-entry-cutoff" };
  }

  const db = safeDb();
  if (!db) return { opened: 0, skipped: 0, reason: "db-unavailable" };

  const tradeDate = istDateKey(now);
  const budget    = await getDailyBudgetState(db, tradeDate);
  if (!budget.canOpen) return { opened: 0, skipped: 0, reason: "budget-exhausted" };

  // ── Gather candidates ──────────────────────────────────────────────────────
  const candidates: ScoredCandidate[] = [];

  try {
    const picks = await getIndiaDailyPicks();
    for (const group of picks.groups) {
      for (const pick of group.picks) {
        const c = candidateFromPick(pick);
        if (c) candidates.push(c);
      }
    }
  } catch { /* fail-soft */ }

  try {
    const aiResp = await getIndiaAiSignals();
    for (const sig of aiResp.signals) {
      const c = candidateFromAiSignal(sig);
      if (c) candidates.push(c);
    }
  } catch { /* fail-soft */ }

  if (candidates.length === 0) return { opened: 0, skipped: 0, reason: "no-candidates" };

  // ── De-duplicate by symbol (keep highest score per symbol) ─────────────────
  const bySymbol = new Map<string, ScoredCandidate>();
  for (const c of candidates) {
    const existing = bySymbol.get(c.symbol);
    if (!existing || c.score > existing.score) bySymbol.set(c.symbol, c);
  }

  // ── Sort descending by score, take top slotsLeft ───────────────────────────
  const ranked = [...bySymbol.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, budget.slotsLeft);

  // ── Open trades ────────────────────────────────────────────────────────────
  let opened = 0;
  let skipped = 0;
  const newTradeIds: string[] = [];
  let deployedThisTick = 0;

  for (const c of ranked) {
    // Risk gate: |entry - stopLoss| / entry × notional ≤ MAX_RISK
    const riskFraction = Math.abs(c.entry - c.stopLoss) / c.entry;
    if (riskFraction > MAX_RISK_PER_TRADE_PCT) { skipped++; continue; }
    if (deployedThisTick + TRADE_NOTIONAL > budget.remaining) { skipped++; break; }

    // Duplicate check
    const source = `${AUTO_TRADE_SOURCE_PREFIX}:${c.source}:1d`;
    const dup = await db.paperTrade.findFirst({
      where: { symbol: c.symbol, status: "OPEN", source: { startsWith: `${AUTO_TRADE_SOURCE_PREFIX}:` } },
      select: { id: true },
    });
    if (dup) { skipped++; continue; }

    // Open the trade
    try {
      const trade = await db.paperTrade.create({
        data: {
          symbol:    c.symbol,
          direction: c.direction,
          status:    "OPEN",
          source,
          rationale: c.rationale,
          meta:      c.meta as Record<string, string | number | boolean | null>,
          notional:  TRADE_NOTIONAL,
          entry:     c.entry,
          stopLoss:  c.stopLoss,
          target:    c.target,
          riskReward: c.riskReward,
          atr:       0,
          openedAt:  now,
        },
        select: { id: true },
      });
      newTradeIds.push(trade.id);
      deployedThisTick += TRADE_NOTIONAL;
      opened++;
    } catch {
      skipped++;
    }
  }

  // ── Update session ─────────────────────────────────────────────────────────
  if (opened > 0) {
    const allIds = [...(budget.session?.tradeIds ?? []), ...newTradeIds];
    await upsertSession(db, tradeDate, {
      deployed:    (budget.session?.deployed ?? 0) + deployedThisTick,
      totalTrades: (budget.session?.totalTrades ?? 0) + opened,
      tradeIds:    allIds,
    });
  }

  return { opened, skipped };
}

// ─── EOD finalisation ─────────────────────────────────────────────────────────

/**
 * Called at session end (15:30 IST). Reads all auto-trades for today,
 * computes final session stats, marks the IndiaDaySession as finalised,
 * and closes any still-OPEN trades as EXPIRED.
 */
export async function finaliseAutoTradingSession(): Promise<void> {
  const db = safeDb();
  if (!db) return;

  const now       = new Date();
  const tradeDate = istDateKey(now);
  if (!isNseSessionEndedForDateIST(tradeDate, now)) return;

  const session = await db.indiaDaySession.findUnique({ where: { tradeDate } }).catch(() => null);
  if (!session || session.finalised) return;

  // Fetch all auto-trades opened today
  const closeMs     = nseCloseMsForDateIST(tradeDate) ?? now.getTime();
  const closedAt    = new Date(closeMs);
  const tradeIds    = session.tradeIds;

  // Close any still-OPEN trades at last-known price
  const openTrades = await db.paperTrade.findMany({
    where: { id: { in: tradeIds }, status: "OPEN" },
    select: { id: true, symbol: true, entry: true, direction: true, notional: true },
  });

  // Batch-fetch prices
  const priceMap = new Map<string, number>();
  if (openTrades.length > 0) {
    try {
      const { yahoo } = await import("@/services/india/yahoo");
      const quotes = await yahoo.getQuotes([...new Set(openTrades.map((t) => t.symbol))]);
      for (const q of quotes) {
        if (q.price != null) priceMap.set(q.symbol.replace(/\.NS$/i, "").toUpperCase(), q.price);
      }
    } catch { /* fail-soft */ }
  }

  for (const t of openTrades) {
    const exitPrice = priceMap.get(t.symbol) ?? t.entry;
    const isLong    = t.direction === "LONG";
    const pnlPct    = isLong ? (exitPrice - t.entry) / t.entry * 100 : (t.entry - exitPrice) / t.entry * 100;
    const pnlUsd    = (pnlPct / 100) * t.notional;
    await db.paperTrade.update({
      where: { id: t.id },
      data:  { status: "EXPIRED", exitPrice, pnlPct, pnlUsd, closedAt },
    });
  }

  // Compute session statistics from all trades
  const allTrades = await db.paperTrade.findMany({
    where: { id: { in: tradeIds }, status: { not: "OPEN" } },
    select: { status: true, pnlPct: true, pnlUsd: true },
  });

  let wins = 0, losses = 0, expired = 0;
  let realisedPnl = 0;
  let bestTradePct: number | null = null;
  let worstTradePct: number | null = null;
  const pnlPcts: number[] = [];

  for (const t of allTrades) {
    if (t.status === "WIN")    wins++;
    else if (t.status === "LOSS")   losses++;
    else if (t.status === "EXPIRED") expired++;
    if (t.pnlUsd != null) realisedPnl += t.pnlUsd;
    if (t.pnlPct != null) {
      pnlPcts.push(t.pnlPct);
      if (bestTradePct == null || t.pnlPct > bestTradePct) bestTradePct = t.pnlPct;
      if (worstTradePct == null || t.pnlPct < worstTradePct) worstTradePct = t.pnlPct;
    }
  }

  const resolved       = wins + losses;
  const winRate        = resolved > 0 ? wins / resolved : null;
  const avgTradePct    = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : null;
  const realisedPnlPct = (realisedPnl / DAILY_BUDGET) * 100;

  // Simple max-drawdown from equity curve
  let maxDrawdownPct: number | null = null;
  if (pnlPcts.length > 1) {
    let peak  = 0;
    let equity = DAILY_BUDGET;
    let maxDD  = 0;
    for (const p of pnlPcts) {
      equity += (p / 100) * TRADE_NOTIONAL;
      if (equity > peak + DAILY_BUDGET) peak = equity - DAILY_BUDGET;
      const dd = peak - (equity - DAILY_BUDGET);
      if (dd > maxDD) maxDD = dd;
    }
    maxDrawdownPct = (maxDD / DAILY_BUDGET) * 100;
  }

  await upsertSession(db, tradeDate, {
    realisedPnl,
    realisedPnlPct,
    wins,
    losses,
    expired,
    winRate,
    bestTradePct,
    worstTradePct,
    avgTradePct,
    maxDrawdownPct,
    finalised:   true,
    finalisedAt: closedAt,
  });
}

// ─── Analytics query ──────────────────────────────────────────────────────────

export type AnalyticsRange =
  | "1d" | "7d" | "15d" | "30d" | "6mo" | "1y" | "all";

export interface DaySessionSummary {
  tradeDate:      string;
  totalTrades:    number;
  wins:           number;
  losses:         number;
  expired:        number;
  winRate:        number | null;
  realisedPnl:    number;
  realisedPnlPct: number;
  avgTradePct:    number | null;
  bestTradePct:   number | null;
  worstTradePct:  number | null;
  maxDrawdownPct: number | null;
  finalised:      boolean;
  deployed:       number;
}

export interface AutoTradingAnalytics {
  range:           AnalyticsRange;
  generatedAt:     number;
  days:            DaySessionSummary[];

  // Aggregate stats
  totalDays:       number;
  totalTrades:     number;
  totalWins:       number;
  totalLosses:     number;
  totalExpired:    number;
  overallWinRate:  number | null;
  totalPnl:        number;        // ₹
  totalPnlPct:     number;        // % of starting capital summed
  avgDailyPnl:     number;        // avg ₹ per day
  avgDailyPnlPct:  number;        // avg % per day
  bestDay:         DaySessionSummary | null;
  worstDay:        DaySessionSummary | null;
  profitDays:      number;
  lossDays:        number;
  breakEvenDays:   number;
  consistency:     number;        // % of profitable days
  maxDrawdownPct:  number | null; // worst single-day drawdown

  // Equity curve — running sum of daily P&L starting from 0
  equityCurve:     Array<{ date: string; equity: number; pnlPct: number }>;

  // Sharpe ratio estimate (daily returns)
  sharpeRatio:     number | null;
}

function rangeToStartDate(range: AnalyticsRange): Date | null {
  const now = new Date();
  switch (range) {
    case "1d":  return new Date(now.getTime() - 1  * 86_400_000);
    case "7d":  return new Date(now.getTime() - 7  * 86_400_000);
    case "15d": return new Date(now.getTime() - 15 * 86_400_000);
    case "30d": return new Date(now.getTime() - 30 * 86_400_000);
    case "6mo": return new Date(now.getTime() - 180 * 86_400_000);
    case "1y":  return new Date(now.getTime() - 365 * 86_400_000);
    case "all": return null;
  }
}

export async function getAutoTradingAnalytics(
  range: AnalyticsRange = "30d",
  db?: PrismaClient,
): Promise<AutoTradingAnalytics> {
  const prisma     = db ?? safeDb();
  const now        = Date.now();
  const startDate  = rangeToStartDate(range);
  const startKey   = startDate
    ? istDateKey(startDate)
    : "2000-01-01";

  let rows: DaySessionSummary[] = [];
  if (prisma) {
    try {
      const raw = await prisma.indiaDaySession.findMany({
        where: { tradeDate: { gte: startKey } },
        orderBy: { tradeDate: "asc" },
      });
      rows = raw.map((r) => ({
        tradeDate:      r.tradeDate,
        totalTrades:    r.totalTrades,
        wins:           r.wins,
        losses:         r.losses,
        expired:        r.expired,
        winRate:        r.winRate,
        realisedPnl:    r.realisedPnl,
        realisedPnlPct: r.realisedPnlPct,
        avgTradePct:    r.avgTradePct,
        bestTradePct:   r.bestTradePct,
        worstTradePct:  r.worstTradePct,
        maxDrawdownPct: r.maxDrawdownPct,
        finalised:      r.finalised,
        deployed:       r.deployed,
      }));
    } catch { /* fail-soft */ }
  }

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const totalTrades   = rows.reduce((s, d) => s + d.totalTrades, 0);
  const totalWins     = rows.reduce((s, d) => s + d.wins, 0);
  const totalLosses   = rows.reduce((s, d) => s + d.losses, 0);
  const totalExpired  = rows.reduce((s, d) => s + d.expired, 0);
  const resolved      = totalWins + totalLosses;
  const overallWinRate = resolved > 0 ? totalWins / resolved : null;
  const totalPnl      = rows.reduce((s, d) => s + d.realisedPnl, 0);
  const totalPnlPct   = rows.reduce((s, d) => s + d.realisedPnlPct, 0);
  const totalDays     = rows.length;
  const avgDailyPnl   = totalDays > 0 ? totalPnl / totalDays : 0;
  const avgDailyPnlPct = totalDays > 0 ? totalPnlPct / totalDays : 0;
  const profitDays    = rows.filter((d) => d.realisedPnl > 0).length;
  const lossDays      = rows.filter((d) => d.realisedPnl < 0).length;
  const breakEvenDays = rows.filter((d) => d.realisedPnl === 0).length;
  const consistency   = totalDays > 0 ? (profitDays / totalDays) * 100 : 0;
  const maxDrawdownPct = rows.length > 0
    ? Math.max(...rows.map((d) => d.maxDrawdownPct ?? 0))
    : null;

  const bestDay  = rows.reduce<DaySessionSummary | null>(
    (best, d) => !best || d.realisedPnl > best.realisedPnl ? d : best, null
  );
  const worstDay = rows.reduce<DaySessionSummary | null>(
    (worst, d) => !worst || d.realisedPnl < worst.realisedPnl ? d : worst, null
  );

  // ── Equity curve ───────────────────────────────────────────────────────────
  let cumEquity = 0;
  const equityCurve = rows.map((d) => {
    cumEquity += d.realisedPnl;
    return { date: d.tradeDate, equity: cumEquity, pnlPct: d.realisedPnlPct };
  });

  // ── Sharpe ratio (simplified daily, annualised) ────────────────────────────
  let sharpeRatio: number | null = null;
  if (rows.length >= 5) {
    const returns  = rows.map((d) => d.realisedPnlPct);
    const mean     = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const stdDev   = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpeRatio = (mean / stdDev) * Math.sqrt(252); // annualised
    }
  }

  return {
    range,
    generatedAt: now,
    days: rows,
    totalDays,
    totalTrades,
    totalWins,
    totalLosses,
    totalExpired,
    overallWinRate,
    totalPnl,
    totalPnlPct,
    avgDailyPnl,
    avgDailyPnlPct,
    bestDay,
    worstDay,
    profitDays,
    lossDays,
    breakEvenDays,
    consistency,
    maxDrawdownPct,
    equityCurve,
    sharpeRatio,
  };
}
