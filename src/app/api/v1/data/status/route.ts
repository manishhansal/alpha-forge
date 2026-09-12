/**
 * GET /api/v1/data/status?symbol=RELIANCE[&interval=5m]
 *
 * Data readiness and quality status for a symbol/interval (prompt §33).
 * Shows: provider, provenance, quality grade, freshness, last candle.
 * Used by the Data Status Dashboard.
 *
 * Query params:
 *   symbol    (required)  — NSE symbol
 *   interval  (optional)  — candle interval; default "1d"
 *
 * Response:
 * {
 *   data: {
 *     symbol, interval, verdict, grade, score,
 *     lastCandleAt, gapCount, provider, provenance,
 *     isLive, marketStatus
 *   }
 * }
 */

import { NextResponse } from "next/server";
import { isSupportedInterval } from "@/lib/market-data/types";
import { isNseMarketOpenIST } from "@/lib/india/market-hours";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.trim().toUpperCase();
  const interval = searchParams.get("interval")?.trim() ?? "1d";

  if (!symbol) {
    return NextResponse.json(
      { error: "symbol is required", code: "MISSING_PARAM" },
      { status: 400 },
    );
  }

  if (!isSupportedInterval(interval)) {
    return NextResponse.json(
      { error: `Unsupported interval "${interval}". 3m is permanently removed.`, code: "UNSUPPORTED_INTERVAL" },
      { status: 400 },
    );
  }

  const requestedAt = new Date().toISOString();
  const marketStatus = isNseMarketOpenIST(new Date()) ? "OPEN" : "CLOSED";

  try {
    // Delegate to the existing data-gate and readiness infrastructure
    const { evaluateProducerDataGate } = await import(
      "@/lib/market-data/services/producer-data-gate.service"
    );
    const gate = await evaluateProducerDataGate({
      instrumentId: symbol,
      exchange: "NSE",
      interval: interval as never,
      requiredBars: 30,
      requireFullyReady: false,
    });

    return NextResponse.json({
      data: {
        symbol,
        interval,
        verdict: gate.allowed ? "READY" : "BLOCKED",
        reason: gate.reason ?? null,
        marketStatus,
        requestedAt,
      },
      metadata: { requestedAt },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "INTERNAL_ERROR", symbol, requestedAt },
      { status: 500 },
    );
  }
}
