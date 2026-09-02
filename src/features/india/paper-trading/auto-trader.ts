/**
 * India Auto Paper-Trading Engine
 *
 * Intelligent signal selection + daily ₹1L budget management.
 *
 * ── Opportunity Engine Integration (v2) ───────────────────────────────────────
 * Signals are now routed through the full 12-stage Opportunity Pipeline before
 * a trade is opened. The pipeline enforces:
 *
 *   1. Market regime compatibility (Strategy × Regime matrix)
 *   2. Hard gates: data freshness, R:R, EV, spread, portfolio limits
 *   3. Expected value after all 7 cost components
 *   4. Quality tier grading (A+/A/B/C/D/REJECT)
 *   5. Risk-aware quality-adjusted position sizing
 *   6. Drawdown-aware risk control
 *   7. Daily risk budget management
 *
 * The legacy scoring formula is still used as a pre-filter, but the
 * OpportunityPipeline makes the final APPROVE / REJECT / ABSTAIN decision.
 * This ensures: Detection ≠ Approval ≠ Execution ≠ Sizing.
 *
 * ── Signal scoring (pre-filter, unchanged) ───────────────────────────────────
 *   score = 0.35 × confidence + 0.25 × winProbability
 *         + 0.25 × gradeScore + 0.15 × rrScore
 * Only signals scoring ≥ MINIMUM_SCORE pass to the Opportunity Pipeline.
 *
 * ── Budget management ─────────────────────────────────────────────────────────
 * Daily budget = ₹1,00,000 (starting capital, resets every IST session).
 * Actual trade notional is now set by the OpportunityPipeline's position
 * sizing engine (quality × EV × regime × drawdown multipliers).
 * Hard cap: max 5 positions × ₹20,000 per position.
 *
 * ── Session tracking ─────────────────────────────────────────────────────────
 * IndiaDaySession records deployed capital, P&L, and per-opportunity metadata
 * including quality tier, net EV, rejection codes, and regime.
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
import {
  runOpportunityPipeline,
  rankOpportunities,
  classifyDrawdownTier,
  computeDailyRiskBudget,
  type OpportunityPipelineInput,
  type ReturnSeries,
} from "@/lib/opportunity-engine";
import type { OpportunityV1 } from "@/lib/opportunity-engine";
// OPP-001 FIX: import candle-fetching infrastructure so the opportunity pipeline
// receives real OHLCV bars rather than empty arrays.
import { bootstrapRegistry } from "@/lib/market-data/registry";
import { getHistoricalCandlesByRange } from "@/lib/market-data/services/historical.service";
import type { OHLCVCandle } from "@/lib/market-data/types";
import { mapWithConcurrency } from "@/lib/map-with-concurrency";
// AUDIT-001 FIX: wire lifecycle-event persistence so the signal audit trail
// is written to the DB and survives worker restarts.
import { emitLifecycleEvent } from "@/lib/signal-intelligence/lifecycle-persist";

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
/** Whether to run all candidates through the Opportunity Pipeline. */
const ENABLE_OPPORTUNITY_PIPELINE = true;
/** Source tag written to PaperTrade.source for auto-trades — uses the real
 *  strategy IDs so the journal and open-positions card show them correctly. */
const AUTO_TRADE_SOURCE_DAILY_PICK = "in:DAILY_PICK:1d";
const AUTO_TRADE_SOURCE_AI_SIGNAL  = "in:AI_SIGNAL:1d";

/** Prefix used to identify ANY auto-trader trade when searching for duplicates.
 *  Both DAILY_PICK and AI_SIGNAL sources belong to the auto-trader. */
const AUTO_TRADE_SOURCES = [AUTO_TRADE_SOURCE_DAILY_PICK, AUTO_TRADE_SOURCE_AI_SIGNAL] as const;
/** Don't open more trades after this point in the session (IST minutes). */
const LAST_ENTRY_MINUTES = 14 * 60 + 45; // 14:45 IST

// ─── Candle-derived indicator helpers (OPP-001) ───────────────────────────────
// Used to populate real ATR, RSI, SMA into the opportunity pipeline input
// instead of the previous stubs (empty arrays / null). Mirrors the helpers
// in the opportunity-engine route.

function _computeAtr(candles: OHLCVCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]; const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const win = trs.slice(-period);
  return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
}
function _computeSma(candles: OHLCVCandle[], period: number): number | null {
  if (candles.length < period) return null;
  const sl = candles.slice(-period);
  return sl.reduce((s, c) => s + c.close, 0) / period;
}
function _computeRsi(candles: OHLCVCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const sl = candles.slice(-(period + 1));
  let gains = 0; let losses = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i].close - sl[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period; const avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}
function _computeAvgVol(candles: OHLCVCandle[], days = 20): number | null {
  if (candles.length < days) return null;
  return candles.slice(-days).reduce((s, c) => s + (c.volume ?? 0), 0) / days;
}

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
      where: { status: "OPEN", source: { in: [...AUTO_TRADE_SOURCES] } },
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
  /** Opportunity engine results for observability */
  opportunityResults?: Array<{
    symbol: string;
    decision: string;
    qualityTier: string;
    netEV: number;
    rejectionStage: string | null;
    rejections: string[];
  }>;
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
  const preSorted = [...bySymbol.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, budget.slotsLeft * 2); // evaluate 2× slots to account for pipeline rejections

  // ── Opportunity Pipeline (v2) ──────────────────────────────────────────────
  // Route candidates through the full 12-stage pipeline when enabled.
  // The pipeline enforces hard gates, EV, regime, and quality grading.
  let ranked: ScoredCandidate[];
  const opportunityResults: AutoTradeTickResult["opportunityResults"] = [];
  const approvedOpportunities: OpportunityV1[] = [];

  if (ENABLE_OPPORTUNITY_PIPELINE) {
    // RISK-001 FIX: use real portfolio state from the live IndiaDaySession
    // rather than hardcoded 0% drawdown. This ensures the drawdown halt,
    // correlation limits, and risk-adjusted sizing all use actual session data.
    const livePnlPct = budget.session
      ? (budget.session.realisedPnl ?? 0) / DAILY_BUDGET * 100
      : 0;
    const liveDrawdownPct = budget.session?.maxDrawdownPct ?? 0;

    // Build a minimal portfolio state for the pipeline
    const drawdownState = classifyDrawdownTier(liveDrawdownPct);
    const dailyBudget = computeDailyRiskBudget(
      budget.session ? DAILY_BUDGET : DAILY_BUDGET,
      budget.deployed,
      livePnlPct,
      budget.session?.totalTrades ?? 0,
    );

    if (!dailyBudget.allowNewTrades) {
      return { opened: 0, skipped: preSorted.length, reason: dailyBudget.reason };
    }

    // OPP-001 FIX: pre-fetch real daily candles for every candidate instrument + NIFTY.
    // Candles are fetched once before the pipeline loop — each iteration only
    // does a fast map lookup. Concurrency cap of 6 avoids provider rate-limits.
    await bootstrapRegistry().catch(() => null); // idempotent; fail-soft

    const uniqueCandidateSymbols = [...new Set(preSorted.map((c) => c.symbol))];
    const [niftyDailyCandles, ...perSymbolCandlesArr] = await Promise.all([
      getHistoricalCandlesByRange("NIFTY", "1d", "1y", "NSE", { tolerateInvalidCandles: true }).catch(() => [] as OHLCVCandle[]),
      ...await mapWithConcurrency(
        uniqueCandidateSymbols,
        6,
        (sym) => getHistoricalCandlesByRange(sym, "1d", "1y", "NSE", { tolerateInvalidCandles: true })
          .catch(() => [] as OHLCVCandle[]),
      ),
    ]);
    const dailyCandleMap = new Map<string, OHLCVCandle[]>(
      uniqueCandidateSymbols.map((sym, i) => [sym, perSymbolCandlesArr[i] ?? []]),
    );
    const niftyCloses = niftyDailyCandles.map((c) => c.close);
    const niftyReturns: ReturnSeries = {
      symbol: "NIFTY",
      returns: niftyCloses.slice(1).map((c, i) => niftyCloses[i] > 0 ? (c - niftyCloses[i]) / niftyCloses[i] : 0),
      avgVolume20d: _computeAvgVol(niftyDailyCandles) ?? null,
      currentVolume: niftyDailyCandles.at(-1)?.volume ?? null,
    };

    const pipelineResults: Array<{ candidate: ScoredCandidate; opportunity: OpportunityV1; shouldTrade: boolean }> = [];

    for (const c of preSorted) {
      try {
        const dailyCandles = dailyCandleMap.get(c.symbol) ?? [];
        const realAtr    = _computeAtr(dailyCandles)    ?? Math.abs(c.entry - c.stopLoss) * 1.3;
        const realRsi    = _computeRsi(dailyCandles)    ?? null;
        const realSma20  = _computeSma(dailyCandles, 20) ?? null;
        const realSma50  = _computeSma(dailyCandles, 50) ?? null;
        const realAvgVol = _computeAvgVol(dailyCandles)  ?? null;

        const pipelineInput: OpportunityPipelineInput = {
          instrument: c.symbol,
          instrumentName: c.symbol,
          exchange: "NSE",
          segment: "FUTURES",
          lotSize: 1,
          currentPrice: c.entry,
          // OPP-001 FIX: real candle data
          dailyCandles,
          intradayCandles: [],
          atr: realAtr,
          rsi: realRsi,
          sma20: realSma20,
          sma50: realSma50,
          vwap: null,
          avgVolume20d: realAvgVol,
          currentVolume: dailyCandles.at(-1)?.volume ?? null,
          // OPP-001 FIX: real NIFTY daily candles for regime detection
          niftyDailyCandles,
          niftyChangePct: null,
          bankniftyChangePct: null,
          indiaVix: null,
          indiaVixPrevClose: null,
          advancingCount: null,
          decliningCount: null,
          optionChain: null,
          oiChange: null,
          pcrOi: null,
          strategyId: c.source === "DAILY_PICK" ? "INDIA_AI_SIGNALS" : "MOMENTUM",
          signalSource: c.source,
          rawConfidence: c.confidence,
          direction: c.direction,
          mlProbability: null,
          mlRegimeScore: null,
          signalEntry: c.entry,
          signalStopLoss: c.stopLoss,
          signalTarget1: c.target,
          signalTarget2: c.target * (c.direction === "LONG" ? 1.015 : 0.985),
          signalTarget3: c.target * (c.direction === "LONG" ? 1.03 : 0.97),
          portfolioState: {
            capitalINR: DAILY_BUDGET,
            currentExposurePct: (budget.deployed / DAILY_BUDGET) * 100,
            currentDrawdownPct: liveDrawdownPct,  // RISK-001 FIX: real session drawdown
            dailyPnlPct: livePnlPct,               // RISK-001 FIX: real session P&L
            correlatedPositions: budget.openCount,
            openRiskPct: (budget.deployed / DAILY_BUDGET) * MAX_RISK_PER_TRADE_PCT * 100,
            isKillSwitchActive: false,
            isDailyLossBreach: liveDrawdownPct < -5, // 5% daily loss breach threshold
          },
          universeReturns: [],
          niftyReturns,
          sessionOpenMs: now.getTime() - istMinutes * 60000 + 9 * 3600000 + 15 * 60000,
          nowMs: now.getTime(),
          tradeDate,
          dataAgeMs: 60_000, // assume 1-minute old data
        };

        const result = runOpportunityPipeline(pipelineInput);
        opportunityResults.push({
          symbol: c.symbol,
          decision: result.opportunity.decision,
          qualityTier: result.opportunity.qualityTier,
          netEV: result.opportunity.scores.netExpectedValue,
          rejectionStage: result.rejectionStage,
          rejections: result.opportunity.hardRejections,
        });

        if (result.shouldTrade) {
          pipelineResults.push({ candidate: c, opportunity: result.opportunity, shouldTrade: true });
          approvedOpportunities.push(result.opportunity);
        } else {
          // AUDIT-001 FIX: persist REJECTED lifecycle event for pipeline-rejected candidates.
          emitLifecycleEvent(db, {
            signalId:    result.opportunity.opportunityId ?? `${c.symbol}-${tradeDate}-${Date.now()}`,
            fromState:   "RISK_CHECK",
            toState:     "REJECTED",
            reason:      result.rejectionStage
              ? `Pipeline rejected at ${result.rejectionStage}: ${result.opportunity.hardRejections.slice(0, 2).join(", ")}`
              : `Quality gate: tier=${result.opportunity.qualityTier}`,
            strategyId:  result.opportunity.strategy ?? "INDIA_AI_SIGNALS",
            instrument:  c.symbol,
            sessionDate: tradeDate,
            sourceType:  c.source === "DAILY_PICK" ? "DAILY_PICK" : "AI_SIGNAL",
            metadata: {
              decision:     result.opportunity.decision,
              qualityTier:  result.opportunity.qualityTier,
              netEV:        result.opportunity.scores.netExpectedValue,
              rejectionStage: result.rejectionStage ?? null,
            },
          });
        }
      } catch {
        // Pipeline failure: fall back to legacy scoring for this candidate
        pipelineResults.push({ candidate: c, opportunity: {} as OpportunityV1, shouldTrade: true });
      }
    }

    // Rank approved opportunities by pipeline final score
    if (approvedOpportunities.length > 0) {
      const rankedEntries = rankOpportunities(approvedOpportunities, budget.slotsLeft);
      const selectedIds = new Set(rankedEntries.filter(e => e.selected).map(e => e.instrument));
      ranked = pipelineResults
        .filter(r => r.shouldTrade && (approvedOpportunities.length === 0 || selectedIds.has(r.candidate.symbol)))
        .map(r => r.candidate)
        .slice(0, budget.slotsLeft);
    } else {
      // All pipeline-rejected: nothing to trade
      ranked = [];
    }
  } else {
    // Legacy path: no pipeline, use legacy scoring
    ranked = preSorted.slice(0, budget.slotsLeft);
  }

  // ── Open trades ────────────────────────────────────────────────────────────
  let opened = 0;
  let skipped = 0;
  const newTradeIds: string[] = [];
  let deployedThisTick = 0;

  for (const c of ranked) {
    // Risk gate (legacy): |entry - stopLoss| / entry ≤ MAX_RISK
    const riskFraction = Math.abs(c.entry - c.stopLoss) / c.entry;
    if (riskFraction > MAX_RISK_PER_TRADE_PCT) { skipped++; continue; }
    if (deployedThisTick + TRADE_NOTIONAL > budget.remaining) { skipped++; break; }

    // Duplicate check — skip if any auto trade already open for this symbol
    const source = c.source === "DAILY_PICK"
      ? AUTO_TRADE_SOURCE_DAILY_PICK
      : AUTO_TRADE_SOURCE_AI_SIGNAL;
    const dup = await db.paperTrade.findFirst({
      where: { symbol: c.symbol, status: "OPEN", source: { in: [...AUTO_TRADE_SOURCES] } },
      select: { id: true },
    });
    if (dup) { skipped++; continue; }

    // Use pipeline-recommended size when available, otherwise fixed notional
    const approvedOpp = approvedOpportunities.find(o => o.instrument === c.symbol);
    const tradeNotional = (ENABLE_OPPORTUNITY_PIPELINE && approvedOpp && approvedOpp.recommendedSizeINR > 0)
      ? Math.min(approvedOpp.recommendedSizeINR, TRADE_NOTIONAL * 1.5) // cap at 1.5× base
      : TRADE_NOTIONAL;

    // Open the trade
    try {
      const trade = await db.paperTrade.create({
        data: {
          symbol:    c.symbol,
          direction: c.direction,
          status:    "OPEN",
          source,
          rationale: [
            ...c.rationale,
            ...(approvedOpp ? [
              `OpportunityEngine: ${approvedOpp.qualityTier}`,
              `NetEV: ${approvedOpp.scores.netExpectedValue.toFixed(3)}%`,
              `Regime: ${approvedOpp.marketRegime}`,
            ] : []),
          ],
          meta: {
            ...c.meta,
            opportunityId: approvedOpp?.opportunityId ?? null,
            qualityTier: approvedOpp?.qualityTier ?? null,
            netEV: approvedOpp?.scores.netExpectedValue ?? null,
            regime: approvedOpp?.marketRegime ?? null,
            pipelineEnabled: ENABLE_OPPORTUNITY_PIPELINE,
          } as Record<string, string | number | boolean | null>,
          notional:  tradeNotional,
          entry:     c.entry,
          stopLoss:  c.stopLoss,
          target:    c.target,
          riskReward: c.riskReward,
          atr:       0,
          // USD-001 FIX: auto-trader trades are INR-denominated.
          currency:  "INR",
          openedAt:  now,
        },
        select: { id: true },
      });
      newTradeIds.push(trade.id);
      deployedThisTick += tradeNotional;
      opened++;

      // AUDIT-001 FIX: persist PAPER_EXECUTED lifecycle event for this signal.
      // The signalId is the auto-trader's internal opportunity ID (or trade ID
      // when no opportunity was produced by the pipeline). This gives every
      // paper trade an auditable lifecycle record in the DB.
      emitLifecycleEvent(db, {
        signalId:    approvedOpp?.opportunityId ?? trade.id,
        fromState:   "APPROVED",
        toState:     "PAPER_EXECUTED",
        reason:      `Auto-trader opened trade — score=${c.score.toFixed(3)}, source=${c.source}`,
        strategyId:  approvedOpp ? (approvedOpp.strategy ?? "INDIA_AI_SIGNALS") : c.source,
        instrument:  c.symbol,
        sessionDate: tradeDate,
        sourceType:  c.source === "DAILY_PICK" ? "DAILY_PICK" : "AI_SIGNAL",
        metadata: {
          tradeId:      trade.id,
          score:        c.score,
          qualityTier:  approvedOpp?.qualityTier ?? null,
          netEV:        approvedOpp?.scores.netExpectedValue ?? null,
          regime:       approvedOpp?.marketRegime ?? null,
          tradeNotional,
        },
      });
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

  return { opened, skipped, opportunityResults };
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
      data:  { status: "EXPIRED", exitPrice, pnlPct, pnlUsd, currency: "INR", closedAt }, // USD-001 FIX
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
