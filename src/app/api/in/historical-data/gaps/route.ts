/**
 * GET /api/in/historical-data/gaps
 *
 * Proxies data gap information from data-service2.0.
 *
 * The `DataGap` table was dropped from the AlphaForge database as part of
 * the data-service2.0 centralization refactor (Phase 2). Gap detection and
 * recovery tracking now live exclusively in data-service2.0.
 *
 * Query params are forwarded to data-service2.0 as-is:
 *   symbol    — filter by NSE symbol
 *   timeframe — filter by interval
 *   status    — filter by recovery status (PENDING | RECOVERED | UNRESOLVED)
 *   limit     — max results (default 100)
 */

import "server-only";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const symbol    = params.get("symbol") ?? undefined;
  const timeframe = params.get("timeframe") ?? undefined;
  const status    = params.get("status") ?? undefined;
  const limit     = params.get("limit") ?? "100";

  if (timeframe === "3m") {
    return NextResponse.json(
      { error: "3m is not a supported interval (permanently removed V8)", gaps: [] },
      { status: 400 }
    );
  }

  const baseUrl =
    process.env.DATA_SERVICE_2_URL ??
    process.env.DATA_SERVICE_URL ??
    "http://localhost:8200";

  // Build the upstream URL with forwarded query params
  const upstream = new URL(`${baseUrl}/v1/india/historical/gaps`);
  if (symbol)    upstream.searchParams.set("symbol", symbol);
  if (timeframe) upstream.searchParams.set("timeframe", timeframe);
  if (status)    upstream.searchParams.set("status", status);
  upstream.searchParams.set("limit", limit);

  try {
    const headers: HeadersInit = { Accept: "application/json" };
    const apiKey = process.env.DATA_SERVICE_API_KEY;
    if (apiKey) {
      (headers as Record<string, string>)["X-API-KEY"] = apiKey;
    }

    const res = await fetch(upstream.toString(), {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        {
          error: `data-service2.0 returned ${res.status}`,
          detail: text,
          upstream: upstream.toString(),
        },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json({
      ...data,
      _proxiedFrom: upstream.toString(),
      note3m: "3m gaps are excluded. 3m is permanently out of scope (V8).",
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Gaps proxy failed",
        detail: (err as Error).message,
        upstream: upstream.toString(),
        hint: "Ensure data-service2.0 is running and DATA_SERVICE_2_URL is configured.",
      },
      { status: 502 }
    );
  }
}
