import { Suspense } from "react";

import { CoinGrid } from "@/components/heatmap/coin-grid";
import { LiquidationHeatmap } from "@/components/heatmap/liquidation-heatmap";
import { SectorStrip } from "@/components/heatmap/sector-strip";
import { Skeleton } from "@/components/ui/skeleton";
import { getHeatmapOverview } from "@/features/heatmap/aggregate";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Heatmap" };

async function HeatmapContent() {
  const data = await getHeatmapOverview();
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <CoinGrid tiles={data.coins} />
        <div className="flex flex-col gap-4">
          <SectorStrip rows={data.sectors} />
        </div>
      </div>
      <LiquidationHeatmap series={data.liquidations} />
    </>
  );
}

function HeatmapSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <Skeleton className="h-[520px] w-full rounded-xl" />
        <Skeleton className="h-[280px] w-full rounded-xl" />
      </div>
      <Skeleton className="h-[420px] w-full rounded-xl" />
    </div>
  );
}

export default function HeatmapPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Heatmap</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          24h coin & sector performance plus a live price-level liquidation heatmap from the
          rolling worker buffer.
        </p>
      </header>

      <Suspense fallback={<HeatmapSkeleton />}>
        <HeatmapContent />
      </Suspense>
    </div>
  );
}
