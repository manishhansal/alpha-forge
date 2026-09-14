/**
 * GET /api/in/historical-data/reconciliation
 *
 * Multi-source data reconciliation is now handled entirely by data-service2.0.
 *
 * The `DataReconciliation` table was dropped from the AlphaForge database as
 * part of the data-service2.0 centralization refactor (Phase 2). All candle
 * acquisition, cross-provider comparison, and reconciliation logic now lives
 * exclusively inside data-service2.0.
 *
 * Consumers should query data-service2.0 directly for reconciliation data.
 */

import "server-only";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    status: "MIGRATED",
    message:
      "Data reconciliation is now handled by data-service2.0. " +
      "The DataReconciliation table has been removed from the AlphaForge database " +
      "as part of the data-service2.0 centralization refactor. " +
      "Query data-service2.0 directly for cross-provider reconciliation reports.",
    dataService: {
      baseUrl: process.env.DATA_SERVICE_2_URL ?? process.env.DATA_SERVICE_URL ?? "http://localhost:8200",
      reconciliationEndpoint: "/v1/analytics/reconciliation",
    },
    records: [],
    statistics: null,
  });
}
