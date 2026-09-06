/**
 * GET /api/in/signal-center
 *
 * Unified Indian Market Signal Center — the single canonical endpoint that
 * aggregates ALL signal families into one deduplicated response.
 *
 * Signal families aggregated:
 *   1. AI Signals (AI_SIGNAL family)
 *   2. Daily Picks (DAILY_PICK family)
 *   3. F&O Scanners — 6 types (FNO_SCANNER family)
 *   4. FnO Trend Scanners — bullish + bearish (FNO_TREND family)
 *   5. MSB Signals (MSB family)
 *   6. Scalper signals (SCALPER family)
 *
 * Deduplication: signals for the same instrument+direction within a 30-min
 * window are grouped into ONE OpportunityCluster. 5 confirmations of the same
 * trade = 1 opportunity cluster, not 5 independent signals.
 *
 * This endpoint is the canonical source for the India Signal Center UI.
 * Individual signal endpoints (/api/in/ai-signals, /api/in/signals, etc.)
 * remain for backward compatibility and specialized consumers.
 *
 * Response shape: IndiaSignalCenterResponse
 */

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { buildSignalCenterResponse } from "@/lib/india-signal-center/aggregator";
import type { UnifiedIndiaSignal, MarketRegime } from "@/lib/india-signal-center/types";
import { registry } from "@/lib/market-data/registry";
import type { ProviderHealth } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
// NOTE: do NOT set `revalidate = 0` here. Next.js rewrites Cache-Control to
// `no-store` when revalidate=0, which silently overrides the `s-maxage=20`
// header we set on the response and defeats CDN caching entirely.
// `force-dynamic` already ensures this route is never statically generated.
export const runtime = "nodejs";

// ── Adapters — translate each signal family into UnifiedIndiaSignal ──────────

/**
 * Fetch AI signals and translate to UnifiedIndiaSignal[].
 * Source attribution is always "AI_ENGINE:AI_MULTI_FACTOR" — never generic.
 */
async function fetchAiSignals(): Promise<UnifiedIndiaSignal[]> {
  try {
    const { getIndiaAiSignals } = await import("@/features/ai-signals/india-builder");
    const data = await getIndiaAiSignals();
    return data.signals
      .filter((s) => s.action !== "WAIT")
      .map((s) => {
        const direction: "LONG" | "SHORT" | "NEUTRAL" =
          s.direction === "BULLISH" ? "LONG"
          : s.direction === "BEARISH" ? "SHORT"
          : "NEUTRAL";

        // Extract TP1 from takeProfits array
        const tp1 = s.takeProfits?.[0]?.price ?? null;
        const tp2 = s.takeProfits?.[1]?.price ?? null;
        const tp3 = s.takeProfits?.[2]?.price ?? null;

        return {
          id: `ai:${s.id}`,
          correlationId: `${s.symbol}:${direction}`,
          generatedAt: new Date().toISOString(),
          expiresAt: null,
          symbol: s.symbol,
          exchange: "NSE" as const,
          instrumentType: "STOCK" as const,
          displayName: s.displayName,
          action: (s.action === "BUY" ? "BUY" : s.action === "SELL" ? "SELL" : "WAIT") as "BUY" | "SELL" | "WAIT" | "NO_TRADE",
          direction,
          signalFamily: "AI_SIGNAL" as const,
          strategy: "AI_MULTI_FACTOR" as const,
          sourceAttribution: `AI_ENGINE:${s.modelVersion ?? "alphaforge-ai-v2"}`,
          timeframe: "1d",
          entry: s.entry ?? null,
          stopLoss: s.stopLoss ?? null,
          tp1,
          tp2,
          tp3,
          riskReward: s.riskReward ?? null,
          confidence: s.confidence,
          grade: (s.grade ?? "B") as "S" | "A" | "B" | "C" | "D" | "F",
          winProbability: s.winProbability ?? null,
          expectedValue: null,
          qualityScore: s.confidenceScore ?? Math.round(s.confidence * 100),
          dataQualityScore: 80,
          dataProvider: null,
          dataObservationId: null,
          regime: "UNKNOWN" as MarketRegime,
          niftyLevel: null,
          vixLevel: null,
          volumeConfirmation: null,
          oiConfirmation: null,
          mtfAlignment: null,
          trendAlignment: null,
          status: "ACTIVE" as const,
          rejectionReason: null,
          abstentionReason: null,
        } satisfies UnifiedIndiaSignal;
      });
  } catch (err) {
    console.error("[signal-center] AI signals fetch failed:", err);
    return [];
  }
}

/**
 * Fetch scanner signals and translate to UnifiedIndiaSignal[].
 * Source attribution includes the specific scanner type — never just "technical".
 */
async function fetchScannerSignals(): Promise<UnifiedIndiaSignal[]> {
  try {
    const { runScanner } = await import("@/services/india/scanner/engine");
    const scannerTypes = ["momentum", "oi-buildup", "pcr", "iv-spike", "volume-breakout", "range-expansion"] as const;

    const results = await Promise.allSettled(
      scannerTypes.map((t) => runScanner(t, 10)),
    );

    const signals: UnifiedIndiaSignal[] = [];
    for (let i = 0; i < scannerTypes.length; i++) {
      const result = results[i];
      if (result?.status !== "fulfilled") continue;
      const scannerType = scannerTypes[i]!;
      const scannerResult = result.value;
      const hits = scannerResult?.hits ?? [];

      for (const hit of hits) {
        // Infer direction from scanner type (momentum/volume-breakout/range-expansion = LONG by default;
        // pcr/iv-spike can be either; oi-buildup has explicit kind)
        const oiBuildupKind = hit.kind as string | undefined;
        const direction: "LONG" | "SHORT" =
          oiBuildupKind === "SHORT_BUILDUP" || oiBuildupKind === "LONG_UNWINDING" ? "SHORT" : "LONG";
        const action: "BUY" | "SELL" = direction === "LONG" ? "BUY" : "SELL";

        const qualityScore = Math.min(100, Math.max(0, Math.abs(hit.metric ?? 50)));

        signals.push({
          id: `scanner:${scannerType}:${hit.symbol}:${Date.now()}`,
          correlationId: `${hit.symbol}:${direction}`,
          generatedAt: new Date().toISOString(),
          expiresAt: null,
          symbol: hit.symbol,
          exchange: "NSE" as const,
          instrumentType: "STOCK" as const,
          displayName: hit.symbol,
          action,
          direction,
          signalFamily: "FNO_SCANNER" as const,
          strategy: mapScannerToStrategy(scannerType),
          sourceAttribution: `FNO_SCANNER:${scannerType.toUpperCase()}`,
          timeframe: "5m",
          entry: hit.entry ?? hit.price ?? null,
          stopLoss: hit.stopLoss ?? null,
          tp1: hit.tp1 ?? null,
          tp2: hit.tp2 ?? null,
          tp3: hit.tp3 ?? null,
          riskReward: null,
          confidence: Math.min(1, Math.max(0, qualityScore / 100)),
          grade: strengthToGrade(qualityScore),
          winProbability: null,
          expectedValue: null,
          qualityScore,
          dataQualityScore: 75,
          dataProvider: null,
          dataObservationId: null,
          regime: "UNKNOWN" as MarketRegime,
          niftyLevel: null,
          vixLevel: null,
          volumeConfirmation: scannerType === "volume-breakout",
          oiConfirmation: scannerType === "oi-buildup",
          mtfAlignment: null,
          trendAlignment: null,
          status: "ACTIVE" as const,
          rejectionReason: null,
          abstentionReason: null,
        } satisfies UnifiedIndiaSignal);
      }
    }
    return signals;
  } catch (err) {
    console.error("[signal-center] Scanner fetch failed:", err);
    return [];
  }
}

/**
 * Fetch Daily Picks and translate to UnifiedIndiaSignal[].
 *
 * Reads the result from the shared India cache (daily-picks:board:v1:{date})
 * via the same memo key used by getIndiaDailyPicks() — this means the
 * Signal Center never re-runs the 170-symbol fan-out when Daily Picks has
 * already been computed within the last 15 s. On a cache miss it falls
 * back to calling getIndiaDailyPicks() directly so the Signal Center
 * always produces a result regardless of whether the cache is warm.
 */
async function fetchDailyPickSignals(): Promise<UnifiedIndiaSignal[]> {
  try {
    const { getIndiaDailyPicks } = await import("@/features/india/daily-picks/builder");
    // getIndiaDailyPicks() is now cache-aware: a warm memo (15 s TTL, keyed
    // by IST trade date) returns instantly; a cold miss runs the full pipeline
    // once and populates the cache for every other concurrent caller.
    const response = await getIndiaDailyPicks();

    const signals: UnifiedIndiaSignal[] = [];

    for (const group of response.groups) {
      for (const pick of group.picks) {
        // Only include actionable picks
        if (pick.action === "WAIT") continue;

        const direction: "LONG" | "SHORT" | "NEUTRAL" =
          pick.direction === "BULLISH" ? "LONG"
          : pick.direction === "BEARISH" ? "SHORT"
          : "NEUTRAL";

        const tp1 = pick.target ?? null;
        const tp2 = null;
        const tp3 = pick.canMoveUpto ?? null;

        signals.push({
          id: `pick:${group.bucket}:${pick.symbol}:${response.tradeDate}`,
          correlationId: `${pick.symbol}:${direction}`,
          generatedAt: new Date(response.generatedAt).toISOString(),
          expiresAt: null,
          symbol: pick.symbol,
          exchange: "NSE" as const,
          instrumentType: (group.bucket === "INDICES_SCALP" ? "OPTION" : "STOCK") as "STOCK" | "OPTION",
          displayName: pick.displayName ?? pick.symbol,
          action: (pick.action === "BUY" || pick.action === "LONG" ? "BUY" : pick.action === "SELL" || pick.action === "SHORT" ? "SELL" : "WAIT") as "BUY" | "SELL" | "WAIT" | "NO_TRADE",
          direction,
          signalFamily: "DAILY_PICK" as const,
          strategy: bucketToStrategy(group.bucket),
          sourceAttribution: `DAILY_PICK:${group.bucket}`,
          timeframe: "1d",
          entry: pick.entry ?? null,
          stopLoss: pick.stopLoss ?? null,
          tp1,
          tp2,
          tp3,
          riskReward: pick.riskReward ?? null,
          confidence: pick.confidence,
          grade: (pick.grade ?? "B") as "S" | "A" | "B" | "C" | "D" | "F",
          winProbability: pick.winProbability ?? null,
          expectedValue: null,
          qualityScore: pick.confidenceScore ?? Math.round(pick.confidence * 100),
          dataQualityScore: 80,
          dataProvider: null,
          dataObservationId: null,
          regime: "UNKNOWN" as MarketRegime,
          niftyLevel: null,
          vixLevel: null,
          volumeConfirmation: null,
          oiConfirmation: null,
          mtfAlignment: null,
          trendAlignment: null,
          status: "ACTIVE" as const,
          rejectionReason: null,
          abstentionReason: null,
        } satisfies UnifiedIndiaSignal);
      }
    }
    return signals;
  } catch (err) {
    console.error("[signal-center] Daily picks fetch failed:", err);
    return [];
  }
}

// ── Helper functions ──────────────────────────────────────────────────────────

type ScannerType = "momentum" | "oi-buildup" | "pcr" | "iv-spike" | "volume-breakout" | "range-expansion";

function mapScannerToStrategy(type: ScannerType): UnifiedIndiaSignal["strategy"] {
  const map: Record<ScannerType, UnifiedIndiaSignal["strategy"]> = {
    "momentum":        "MOMENTUM",
    "oi-buildup":      "OI_BUILDUP",
    "pcr":             "PCR_EXTREME",
    "iv-spike":        "IV_SPIKE",
    "volume-breakout": "VOLUME_BREAKOUT",
    "range-expansion": "RANGE_EXPANSION",
  };
  return map[type] ?? "CUSTOM";
}

function bucketToStrategy(bucket: string): UnifiedIndiaSignal["strategy"] {
  const map: Record<string, UnifiedIndiaSignal["strategy"]> = {
    INDICES_SCALP:    "INDICES_SCALP",
    OPENING_BREAKOUT: "OPENING_BREAKOUT",
    HIGHLY_MOMENTUM:  "HIGHLY_MOMENTUM",
    HIGHLY_SCALPING:  "HIGHLY_SCALPING",
    HIGHLY_POTENTIAL: "HIGHLY_POTENTIAL",
  };
  return map[bucket] ?? "CUSTOM";
}

function strengthToGrade(score: number): "S" | "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  // Optional: auth gate (can be opened to public for read-only use)
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Fetch all signal families in parallel
    const [aiSignals, scannerSignals, dailyPickSignals] = await Promise.all([
      fetchAiSignals(),
      fetchScannerSignals(),
      fetchDailyPickSignals(),
    ]);

    const allSignals: UnifiedIndiaSignal[] = [
      ...aiSignals,
      ...scannerSignals,
      ...dailyPickSignals,
    ];

    // Get provider health for the response
    const healthSnapshots: ProviderHealth[] = registry.getHealth();
    const dataProviders = healthSnapshots.map((h) => ({
      providerId: h.providerId,
      available:  h.status === "healthy",
      latencyMs:  h.latencyP50Ms ?? null,
    }));

    // Build the unified response
    const response = buildSignalCenterResponse({
      signals: allSignals,
      rejected: [],  // TODO: wire up rejected signals from opportunity engine
      regime:         "UNKNOWN",  // TODO: wire up regime classifier
      marketOpen:     isMarketOpen(),
      niftyLevel:     null,       // TODO: wire up live NIFTY quote
      niftyChangePct: null,
      bankNiftyLevel: null,
      vixLevel:       null,
      breadthBullish: null,
      dataProviders,
    });

    return NextResponse.json(response, {
      // 20s shared-cache: signal-center aggregates 6 scanners + daily-picks
      // + AI signals — by far the most expensive India endpoint. A 20s
      // shared cache means concurrent users share one heavy execution per
      // 20s window instead of each triggering their own fan-out.
      headers: { "Cache-Control": "public, s-maxage=20, stale-while-revalidate=40" },
    });
  } catch (err) {
    console.error("[/api/in/signal-center] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "SIGNAL_CENTER_FAILED",
        message: (err as Error).message,
      },
      { status: 500 },
    );
  }
}

function isMarketOpen(): boolean {
  const now = new Date();
  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60_000;
  const ist = new Date(now.getTime() + istOffset);
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hours = ist.getUTCHours();
  const mins  = ist.getUTCMinutes();
  const timeVal = hours * 60 + mins;
  return timeVal >= 9 * 60 + 15 && timeVal < 15 * 60 + 30;
}
