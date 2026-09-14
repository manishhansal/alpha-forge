/**
 * GET /api/in/historical-data/status
 *
 * Returns a high-level status summary of the historical data infrastructure
 * by proxying live health and provider analytics from data-service2.0.
 *
 * All market-data tables (CandleBar, DataQualityScore, HistoricalBackfillJob,
 * ProviderObservation, DataReconciliation, FnoUniverseSnapshot) were dropped
 * from the AlphaForge database as part of the data-service2.0 centralization
 * refactor. This endpoint now delegates entirely to data-service2.0.
 */

import "server-only";
import { NextResponse } from "next/server";
import { getDataServiceHealth, getProviderHealth } from "@/lib/data-service/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const [health, providers] = await Promise.allSettled([
      getDataServiceHealth(),
      getProviderHealth(),
    ]);

    const healthData =
      health.status === "fulfilled" ? health.value : null;
    const providerData =
      providers.status === "fulfilled" ? providers.value : [];

    const healthError =
      health.status === "rejected"
        ? (health.reason as Error).message
        : undefined;
    const providerError =
      providers.status === "rejected"
        ? (providers.reason as Error).message
        : undefined;

    // Derive a simple overall status from what data-service2.0 reports
    const overallStatus = !healthData
      ? "DATA_SERVICE_UNAVAILABLE"
      : healthData.status === "ok"
        ? "DATA_READY"
        : "DATA_DEGRADED";

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      note: "Market data infrastructure is now owned by data-service2.0. This endpoint proxies /v1/health/live and /v1/analytics/providers.",

      overallStatus,

      dataService: {
        health: healthData,
        healthError: healthError ?? null,
      },

      providers: {
        list: providerData,
        error: providerError ?? null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Status proxy failed", detail: (err as Error).message },
      { status: 500 }
    );
  }
}
