/**
 * GET /api/v1/data/quality?symbol=RELIANCE[&interval=5m]
 *
 * Data quality gate evaluation for a symbol/interval (prompt §50/§51).
 * Returns: verdict (READY/DEGRADED/BLOCKED), quality grade, score, issues.
 *
 * Query params:
 *   symbol    (required)  — NSE symbol
 *   interval  (optional)  — default "1d"
 *
 * Response mirrors POST /data/gate on the Python data-service but is
 * accessible as a REST GET for dashboard/monitoring use cases.
 */

import { NextResponse } from "next/server";
import { isSupportedInterval } from "@/lib/market-data/types";
import { evaluateDataGate } from "@/lib/data-service/gate-client";

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
      { error: `Unsupported interval "${interval}". 3m was permanently removed.`, code: "UNSUPPORTED_INTERVAL" },
      { status: 400 },
    );
  }

  const requestedAt = new Date().toISOString();

  try {
    const gate = await evaluateDataGate({
      symbol,
      quoteAgeMs: 0, // not live — this is a quality snapshot
    });

    return NextResponse.json({
      data: {
        symbol,
        interval,
        verdict: gate.signalEngineAllowed ? "READY" : "BLOCKED",
        confidenceScore: gate.confidenceScore,
        signalEngineAllowed: gate.signalEngineAllowed,
        reason: null,
      },
      metadata: { requestedAt },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "GATE_UNAVAILABLE", symbol, requestedAt },
      { status: 503 },
    );
  }
}
