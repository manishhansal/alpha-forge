/**
 * GET /api/in/historical-data/coverage
 *
 * Historical data coverage is now managed exclusively by data-service2.0.
 * This endpoint returns a redirect to the canonical data-service2.0 API.
 *
 * After the centralization refactor, AlphaForge does not maintain a local
 * candle database. Coverage tracking belongs to data-service2.0.
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { isSupportedInterval } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const timeframe = params.get("timeframe") ?? undefined;

  if (timeframe === "3m") {
    return NextResponse.json(
      { error: "Interval '3m' is permanently unsupported." },
      { status: 400 },
    );
  }
  if (timeframe && !isSupportedInterval(timeframe)) {
    return NextResponse.json(
      { error: `Unsupported interval '${timeframe}'` },
      { status: 400 },
    );
  }

  // Coverage is tracked by data-service2.0 — proxy the status
  const dataServiceUrl =
    process.env.DATA_SERVICE_2_URL ?? process.env.DATA_SERVICE_URL ?? "http://localhost:8200";
  const symbol = params.get("symbol") ?? "";
  const upstreamUrl = new URL(`${dataServiceUrl}/v1/india/historical/gaps`);
  if (symbol) upstreamUrl.searchParams.set("symbol", symbol);
  if (timeframe) upstreamUrl.searchParams.set("interval", timeframe);

  try {
    const res = await fetch(upstreamUrl.toString(), {
      headers: {
        Accept: "application/json",
        ...(process.env.DATA_SERVICE_API_KEY
          ? { "X-API-KEY": process.env.DATA_SERVICE_API_KEY }
          : {}),
      },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "DATA_SERVICE_UNAVAILABLE", status: res.status },
        { status: 503 },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "DATA_SERVICE_UNAVAILABLE", note: "Coverage is managed by data-service2.0" },
      { status: 503 },
    );
  }
}
