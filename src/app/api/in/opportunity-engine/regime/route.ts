/**
 * GET /api/in/opportunity-engine/regime
 *
 * Returns the current market regime classification with strategy compatibility matrix.
 *
 * Response:
 *   {
 *     regime: MarketRegimeState,
 *     directionScore: number,
 *     confidence: number,
 *     vixRegime: string,
 *     strategyCompatibility: { [strategyId]: { compatible, compatibility, edgeMultiplier } },
 *     reasons: string[],
 *     generatedAt: number
 *   }
 */

import { NextResponse } from "next/server";
import { classifyMarketRegime, STRATEGY_REGIME_MATRIX } from "@/lib/opportunity-engine";
import { getIndiaAiSignals } from "@/features/ai-signals/india-builder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let _cache: { result: unknown; generatedAt: number } | null = null;
const CACHE_TTL_MS = 2 * 60_000; // 2 minutes

export async function GET() {
  const now = Date.now();

  if (_cache && now - _cache.generatedAt < CACHE_TTL_MS) {
    return NextResponse.json(_cache.result, {
      headers: { "X-Cache": "HIT" },
    });
  }

  try {
    // Fetch market context from AI signals
    const aiResp = await getIndiaAiSignals().catch(() => null);
    const ctx = aiResp?.context;

    const evaluation = classifyMarketRegime({
      niftyDailyCandles: [],
      niftyChangePct: (ctx as unknown as { niftyChangePct?: number | null })?.niftyChangePct ?? null,
      bankniftyChangePct: (ctx as unknown as { bankniftyChangePct?: number | null })?.bankniftyChangePct ?? null,
      indiaVix: ctx?.indiaVix ?? null,
      indiaVixPrevClose: null,
      advancingCount: null,
      decliningCount: null,
      isOpeningPeriod: false,
      nowMs: now,
    });

    // Build strategy compatibility map
    const strategyCompatibility: Record<string, {
      compatible: boolean;
      compatibility: string;
      edgeMultiplier: number;
    }> = {};

    for (const [stratId, regimeMatrix] of Object.entries(STRATEGY_REGIME_MATRIX)) {
      const multiplier = regimeMatrix[evaluation.regime] ?? 0.7;
      strategyCompatibility[stratId] = {
        compatible: multiplier >= 0.8,
        compatibility:
          multiplier >= 1.4 ? "STRONGLY_SUPPORTED" :
          multiplier >= 1.0 ? "SUPPORTED" :
          multiplier >= 0.8 ? "NEUTRAL" :
          multiplier >= 0.5 ? "ADVERSE" : "STRONGLY_ADVERSE",
        edgeMultiplier: multiplier,
      };
    }

    const result = {
      regime: evaluation.regime,
      directionScore: evaluation.directionScore,
      confidence: evaluation.confidence,
      adx: evaluation.adx,
      atrPercentile: evaluation.atrPercentile,
      breadthRatio: evaluation.breadthRatio,
      vixRegime: evaluation.vixRegime,
      niftyTrendLabel: evaluation.niftyTrendLabel,
      strategyCompatibility,
      reasons: evaluation.reasons,
      generatedAt: now,
    };

    _cache = { result, generatedAt: now };
    return NextResponse.json(result, { headers: { "X-Cache": "MISS" } });
  } catch (err) {
    return NextResponse.json(
      { error: "Regime classification failed", detail: String(err) },
      { status: 500 },
    );
  }
}
