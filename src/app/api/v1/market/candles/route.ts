/**
 * GET /api/v1/market/candles
 *
 * Canonical v1 historical OHLCV candles endpoint.
 * Routes through DataServiceClient → ProviderRegistry → withFailover.
 *
 * Query params:
 *   symbol    (required)  — NSE trading symbol
 *   exchange  (optional)  — default "NSE"
 *   interval  (required)  — one of: 1m 5m 10m 15m 30m 1h 1d 1w 1M  (3m rejected)
 *   from      (required)  — ISO-8601 UTC datetime string
 *   to        (required)  — ISO-8601 UTC datetime string
 *
 * Response: { data: OHLCVCandle[], metadata: { symbol, exchange, interval, from, to, count, requestedAt } }
 */

import { NextResponse } from "next/server";
import { DataServiceClient } from "@/lib/data-service/client";
import { isSupportedInterval } from "@/lib/market-data/types";
import type { Exchange } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_EXCHANGES: Exchange[] = ["NSE", "NFO", "BSE", "BFO", "MCX", "CDS"];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.trim();
  const exchange = (searchParams.get("exchange")?.trim() ?? "NSE") as Exchange;
  const interval = searchParams.get("interval")?.trim() ?? "";
  const from = searchParams.get("from")?.trim();
  const to = searchParams.get("to")?.trim();

  // Validate required params
  if (!symbol) return NextResponse.json({ error: "symbol is required", code: "MISSING_PARAM" }, { status: 400 });
  if (!from) return NextResponse.json({ error: "from is required (ISO-8601 UTC)", code: "MISSING_PARAM" }, { status: 400 });
  if (!to) return NextResponse.json({ error: "to is required (ISO-8601 UTC)", code: "MISSING_PARAM" }, { status: 400 });

  // Validate interval — 3m is permanently removed
  if (!isSupportedInterval(interval)) {
    return NextResponse.json(
      {
        error: `Unsupported interval "${interval}". Supported: 1m 5m 10m 15m 30m 1h 1d 1w 1M. Note: 3m was permanently removed.`,
        code: "UNSUPPORTED_INTERVAL",
      },
      { status: 400 },
    );
  }

  if (!VALID_EXCHANGES.includes(exchange)) {
    return NextResponse.json(
      { error: `Invalid exchange "${exchange}"`, code: "INVALID_PARAM" },
      { status: 400 },
    );
  }

  // Validate date range parseable
  if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
    return NextResponse.json(
      { error: "from and to must be valid ISO-8601 UTC datetime strings", code: "INVALID_PARAM" },
      { status: 400 },
    );
  }

  const requestedAt = new Date().toISOString();

  try {
    const candles = await DataServiceClient.market.candles({
      symbol,
      exchange,
      interval,
      from,
      to,
    });

    return NextResponse.json({
      data: candles,
      metadata: {
        symbol,
        exchange,
        interval,
        from,
        to,
        count: candles.length,
        requestedAt,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "PROVIDER_ERROR", symbol, interval, requestedAt },
      { status: 502 },
    );
  }
}
