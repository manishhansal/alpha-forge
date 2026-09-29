import { Suspense } from "react";

import { BrainCircuit } from "lucide-react";

import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
import {
  MLSignalsBoard,
  MLSignalsBoardSkeleton,
} from "@/components/india/ml-signals/ml-signals-board";
import { fetchMLLatestSignals } from "@/lib/india/ml-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "ML Signals · NSE F&O",
  description:
    "Live LightGBM scoring for all 218 NSE F&O symbols — ranked by conviction, updated every 5 minutes during market hours.",
};

async function MLSignalsSection() {
  const data = await fetchMLLatestSignals();

  const subtitle = data?.session_date
    ? `${data.session_date} · ${data.model_version ?? "LightGBM"} · ${data.market_open ? "Market open" : "Market closed"}`
    : "LightGBM · fs-2.0.0 · 218 symbols";

  return (
    <>
      <PageHeader
        title="ML Signals"
        subtitle={subtitle}
        action={
          <span className="flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--color-bull)_10%,transparent)] px-3 py-1 text-xs font-medium text-[var(--color-bull)] ring-1 ring-inset ring-[color-mix(in_oklch,var(--color-bull)_25%,transparent)]">
            <BrainCircuit className="h-3 w-3" />
            Shadow stage
          </span>
        }
      />
      <MLSignalsBoard
        initialData={data}
        endpoint="/api/in/ml-signals"
        intervalMs={30_000}
      />
    </>
  );
}

export default function MLSignalsPage() {
  return (
    <PageTransition>
      <Suspense fallback={<MLSignalsBoardSkeleton />}>
        <MLSignalsSection />
      </Suspense>
    </PageTransition>
  );
}
