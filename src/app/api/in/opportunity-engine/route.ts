/**
 * GET /api/in/opportunity-engine
 *
 * Runs the full 12-stage Opportunity Pipeline against the current live
 * AI signals and returns a ranked list of OpportunityV1 objects.
 *
 * This endpoint is the primary entry point for the new opportunity engine.
 * It does NOT open trades — it evaluates and ranks opportunities for display
 * and downstream consumption.
 *
 * Query params:
 *   limit     — max opportunities to return (default: 20, max: 50)
 *   strategy  — filter by strategy ID
 *   direction — filter by direction (LONG | SHORT)
 *   tier      — filter by quality tier (A_PLUS | A | B | C | REJECT)
 *   minEV     — minimum net expected value (default: 0)
 *
 * Response shape:
 *   {
 *     opportunities: OpportunityV1[],
 *     ranked: OpportunityRankEntry[],
 *     funnel: OpportunityFunnel,
 *     regime: RegimeEvaluation,
 *     generatedAt: number
 *   }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getIndiaAiSignals } from "@/features/ai-signals/india-builder";
import {
  runOpportunityPipeline,
  rankOpportunities,
  classifyMarketRegime,
  type OpportunityPipelineInput,
  type ReturnSeries,
} from "@/lib/opportunity-engine";
import type { OpportunityV1, OpportunityFunnel, QualityTier } from "@/lib/opportunity-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 60-second cache — opportunity evaluations are expensive
let _cache: { result: unknown; generatedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const limit = Math.min(50, Math.max(1, Number(params.get("limit") ?? "20") || 20));
  const strategyFilter = params.get("strategy") ?? null;
  const directionFilter = params.get("direction")?.toUpperCase() ?? null;
  const tierFilter = params.get("tier")?.toUpperCase() ?? null;
  const minEV = Number(params.get("minEV") ?? "0") || 0;

  const now = Date.now();

  // Return cache if fresh and no specific filters
  if (
    _cache &&
    now - _cache.generatedAt < CACHE_TTL_MS &&
    !strategyFilter && !directionFilter && !tierFilter && minEV === 0
  ) {
    return NextResponse.json(_cache.result, {
      headers: { "X-Cache": "HIT", "X-Cache-Age": String(Math.round((now - _cache.generatedAt) / 1000)) },
    });
  }

  try {
    // Fetch live signals
    const aiResp = await getIndiaAiSignals();
    const signals = aiResp.signals ?? [];

    if (signals.length === 0) {
      return NextResponse.json({
        opportunities: [],
        ranked: [],
        funnel: buildEmptyFunnel(),
        regime: null,
        message: "No signals available from India AI engine",
        generatedAt: now,
      });
    }

    // Empty NIFTY returns stub (full wiring would fetch from registry)
    const niftyReturns: ReturnSeries = {
      symbol: "NIFTY", returns: [], avgVolume20d: null, currentVolume: null,
    };

    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istMs = now + IST_OFFSET_MS;
    const istHour = Math.floor((istMs % 86_400_000) / 3_600_000);
    const istMin = Math.floor((istMs % 3_600_000) / 60_000);
    const sessionOpenMs = now - ((istHour - 9) * 3600000 + (istMin - 15) * 60000);

    const tradeDate = new Date(istMs).toISOString().slice(0, 10);

    // Run pipeline on each signal
    const opportunities: OpportunityV1[] = [];
    let candidateCount = 0;
    let rejectedCount = 0;
    let approvedCount = 0;
    let watchCount = 0;

    for (const sig of signals.slice(0, 30)) { // cap at 30 for performance
      if (sig.action === "WAIT" || sig.market !== "india") continue;
      candidateCount++;

      const tp1 = sig.takeProfits?.[0]?.price ?? sig.entry * 1.01;
      const tp2 = sig.takeProfits?.[1]?.price ?? tp1 * 1.01;

      const pipelineInput: OpportunityPipelineInput = {
        instrument: sig.symbol.replace(/\.NS$/i, "").toUpperCase(),
        instrumentName: sig.displayName ?? sig.symbol,
        exchange: "NSE",
        segment: "FUTURES",
        lotSize: 1,
        currentPrice: sig.entry,
        dailyCandles: [],
        intradayCandles: [],
        atr: Math.abs(sig.entry - sig.stopLoss) * 1.3,
        rsi: null,
        sma20: null,
        sma50: null,
        vwap: null,
        avgVolume20d: null,
        currentVolume: null,
        niftyDailyCandles: [],
        niftyChangePct: (aiResp.context as { niftyChangePct?: number | null })?.niftyChangePct ?? null,
        bankniftyChangePct: (aiResp.context as { bankniftyChangePct?: number | null })?.bankniftyChangePct ?? null,
        indiaVix: aiResp.context?.indiaVix ?? null,
        indiaVixPrevClose: null,
        advancingCount: null,
        decliningCount: null,
        optionChain: null,
        oiChange: null,
        pcrOi: null,
        strategyId: "INDIA_AI_SIGNALS",
        signalSource: "META",
        rawConfidence: sig.confidence,
        direction: sig.direction === "BEARISH" ? "SHORT" : "LONG",
        mlProbability: null,
        mlRegimeScore: aiResp.context?.regimeScore ?? null,
        signalEntry: sig.entry,
        signalStopLoss: sig.stopLoss,
        signalTarget1: tp1,
        signalTarget2: tp2,
        signalTarget3: tp2 * (sig.direction !== "BEARISH" ? 1.01 : 0.99),
        portfolioState: {
          capitalINR: 100_000,
          currentExposurePct: 0,
          currentDrawdownPct: 0,
          dailyPnlPct: 0,
          correlatedPositions: 0,
          openRiskPct: 0,
          isKillSwitchActive: false,
          isDailyLossBreach: false,
        },
        universeReturns: [],
        niftyReturns,
        sessionOpenMs,
        nowMs: now,
        tradeDate,
        dataAgeMs: 60_000,
      };

      try {
        const result = runOpportunityPipeline(pipelineInput);
        const opp = result.opportunity;

        if (opp.decision === "REJECT" || opp.decision === "ABSTAIN") rejectedCount++;
        else if (opp.decision === "WATCH" || opp.decision === "WAIT") watchCount++;
        else approvedCount++;

        // Apply filters
        if (strategyFilter && opp.strategy !== strategyFilter) continue;
        if (directionFilter && opp.direction !== directionFilter) continue;
        if (tierFilter && opp.qualityTier !== tierFilter) continue;
        if (opp.scores.netExpectedValue < minEV) continue;

        opportunities.push(opp);
      } catch (err) {
        // Individual signal failure — skip, don't fail the whole response
        console.warn(`[opportunity-engine] pipeline error for ${sig.symbol}:`, err);
      }
    }

    // Rank approved opportunities
    const approvedOnly = opportunities.filter(o => o.decision === "STRONG_BUY" || o.decision === "BUY");
    const ranked = rankOpportunities(approvedOnly, limit);

    // All results sorted by final score
    const allSorted = opportunities
      .sort((a, b) => b.scores.finalScore - a.scores.finalScore)
      .slice(0, limit);

    // Build funnel
    const funnel: OpportunityFunnel = {
      sessionDate: tradeDate,
      marketEventsDetected: signals.length,
      candidatesGenerated: candidateCount,
      qualifiedOpportunities: approvedCount + watchCount,
      riskApproved: approvedCount,
      executionFeasible: approvedCount,
      tradesOpened: 0, // not opening trades in this endpoint
      winners: 0,
      profitableAlpha: 0,
      detectionToQualification: candidateCount > 0 ? (approvedCount + watchCount) / candidateCount : 0,
      qualificationToApproval: (approvedCount + watchCount) > 0 ? approvedCount / (approvedCount + watchCount) : 0,
      approvalToExecution: 0,
      executionToWin: 0,
      rejectionsByCode: {} as OpportunityFunnel["rejectionsByCode"],
      softPenaltiesByCode: {} as OpportunityFunnel["softPenaltiesByCode"],
    };

    // Compute regime from available data
    let regimeData = null;
    try {
      regimeData = classifyMarketRegime({
        niftyDailyCandles: [],
        niftyChangePct: (aiResp.context as { niftyChangePct?: number | null })?.niftyChangePct ?? null,
        bankniftyChangePct: (aiResp.context as { bankniftyChangePct?: number | null })?.bankniftyChangePct ?? null,
        indiaVix: aiResp.context?.indiaVix ?? null,
        indiaVixPrevClose: null,
        advancingCount: null,
        decliningCount: null,
        isOpeningPeriod: false,
        nowMs: now,
      });
    } catch { /* fail soft */ }

    const result = {
      opportunities: allSorted,
      ranked,
      funnel,
      regime: regimeData ? {
        regime: regimeData.regime,
        directionScore: regimeData.directionScore,
        confidence: regimeData.confidence,
        vixRegime: regimeData.vixRegime,
        reasons: regimeData.reasons.slice(0, 3),
      } : null,
      summary: {
        total: opportunities.length,
        approved: approvedCount,
        rejected: rejectedCount,
        watching: watchCount,
        topTier: opportunities.filter(o => o.qualityTier === "A_PLUS" || o.qualityTier === "A").length,
      },
      generatedAt: now,
    };

    if (!strategyFilter && !directionFilter && !tierFilter && minEV === 0) {
      _cache = { result, generatedAt: now };
    }

    return NextResponse.json(result, {
      headers: { "X-Cache": "MISS" },
    });
  } catch (err) {
    console.error("[opportunity-engine] route error:", err);
    return NextResponse.json(
      { error: "Opportunity engine evaluation failed", detail: String(err) },
      { status: 500 },
    );
  }
}

function buildEmptyFunnel(): OpportunityFunnel {
  return {
    sessionDate: new Date().toISOString().slice(0, 10),
    marketEventsDetected: 0, candidatesGenerated: 0, qualifiedOpportunities: 0,
    riskApproved: 0, executionFeasible: 0, tradesOpened: 0, winners: 0, profitableAlpha: 0,
    detectionToQualification: 0, qualificationToApproval: 0,
    approvalToExecution: 0, executionToWin: 0,
    rejectionsByCode: {} as OpportunityFunnel["rejectionsByCode"],
    softPenaltiesByCode: {} as OpportunityFunnel["softPenaltiesByCode"],
  };
}
