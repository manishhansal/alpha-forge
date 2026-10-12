/**
 * BFF route: /api/in/smc-scanner
 *
 * Proxies GET /v2/scanners/registry from ml-service2.0 to the browser.
 * Runs server-side so ML_SERVICE_API_KEY is never exposed to the client.
 *
 * Query params forwarded to ml-service:
 *   scanner_type   — filter by scanner type
 *   include_closed — also return today's closed signals
 *   date           — closed signals date (YYYY-MM-DD IST)
 *   limit          — max records
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchSMCScannerRegistry, type SMCScannerType } from "@/lib/india/ml-client";

// Revalidate every 30 seconds (Next.js route-segment caching)
export const revalidate = 30;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;

  const data = await fetchSMCScannerRegistry({
    scanner_type: (sp.get("scanner_type") as SMCScannerType) ?? undefined,
    include_closed: sp.get("include_closed") === "true",
    date: sp.get("date") ?? undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : 2000,
  });

  if (!data) {
    return NextResponse.json(
      {
        scanned_at: null,
        n_active: 0,
        n_closed_today: 0,
        last_scan_meta: null,
        active_signals: [],
        closed_signals: [],
        error: "Scanner data unavailable — ml-service may be starting up.",
      },
      { status: 200 },
    );
  }

  return NextResponse.json(data);
}
