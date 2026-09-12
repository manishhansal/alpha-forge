/**
 * /in/data-status — Historical Data Status Dashboard (V8)
 *
 * Shows:
 *   - F&O Universe (current stocks, lifecycle status)
 *   - Data Coverage matrix (per symbol × timeframe)
 *   - Provider statistics (authenticated vs open-source)
 *   - Gap summary
 *   - Reconciliation statistics
 *   - 3m removal audit (must be zero new acquisitions)
 *
 * This page reads from the live DB — never a static report.
 * Displays clear authentication badges (BROKER_AUTHENTICATED vs OPEN_SOURCE).
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { DataStatusDashboard } from "@/components/india/data-status/DataStatusDashboard";

export const metadata: Metadata = {
  title: "Historical Data Status | AlphaForge",
  description: "F&O universe coverage, provider statistics, data provenance and quality",
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DataStatusPage() {
  return (
    <div className="container mx-auto px-4 py-6 max-w-screen-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Historical Data Status</h1>
        <p className="text-sm text-neutral-400 mt-1">
          Live coverage · Provider authentication · Provenance · Reconciliation · Gap recovery
        </p>
      </div>
      <Suspense fallback={<DataStatusSkeleton />}>
        <DataStatusDashboard />
      </Suspense>
    </div>
  );
}

function DataStatusSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-32 rounded-lg bg-neutral-800 animate-pulse"
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
