/**
 * GET /api/in/signal-quality
 *
 * Runs the full 20-phase Signal Quality Evaluation against the PaperTrade
 * and IndiaDailyPick tables, returning a `SignalQualityReport`.
 *
 * Query params:
 *   window  — evaluation window in days (default: 30, max: 90)
 *
 * The report is cached for 5 minutes — the underlying data changes at most
 * once per minute (trade resolution cadence), so a short cache is appropriate.
 */

import { NextResponse, type NextRequest } from "next/server";
import { computeSignalQualityReport } from "@/lib/signal-quality/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 5-minute in-memory cache (single-server development optimisation)
let cachedReport: { report: unknown; windowDays: number; generatedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const windowParam = req.nextUrl.searchParams.get("window");
  const windowDays = Math.min(90, Math.max(1, Number(windowParam ?? "30") || 30));

  // Return cache if fresh and same window
  if (
    cachedReport &&
    cachedReport.windowDays === windowDays &&
    Date.now() - cachedReport.generatedAt < CACHE_TTL_MS
  ) {
    return NextResponse.json(cachedReport.report, {
      headers: {
        "X-Cache": "HIT",
        "X-Cache-Age": String(Math.round((Date.now() - cachedReport.generatedAt) / 1000)),
      },
    });
  }

  try {
    const report = await computeSignalQualityReport(windowDays);

    cachedReport = { report, windowDays, generatedAt: Date.now() };

    return NextResponse.json(report, {
      headers: { "X-Cache": "MISS" },
    });
  } catch (err) {
    console.error("[signal-quality] engine error:", err);
    return NextResponse.json(
      {
        error: "Signal quality evaluation failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
