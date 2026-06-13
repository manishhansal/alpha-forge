import { Suspense } from "react";

import { IndiaHeatmap } from "@/components/india/heatmap/india-heatmap";
import { Skeleton } from "@/components/ui/skeleton";
import { SECTOR_STOCKS } from "@/lib/india/sectors";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Heatmap · NSE F&O" };

export default function IndiaHeatmapPage() {
  // Pass the curated sector → constituents map down so the client component
  // doesn't have to bundle it from a separate fetch. The actual quotes are
  // fetched lazily, sector-by-sector, against `/api/in/sector-stocks`.
  const sectors = Object.entries(SECTOR_STOCKS)
    .map(([name, symbols]) => ({ name, symbols }))
    .filter((s) => s.symbols.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Heatmap · NSE F&amp;O
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Sector and stock-level view of the NSE F&amp;O universe. Each tile is
          coloured by day % change — pulled live via Yahoo and cached on the
          server.
        </p>
      </header>

      <Suspense
        fallback={<Skeleton className="h-[640px] w-full rounded-xl" />}
      >
        <IndiaHeatmap sectors={sectors} />
      </Suspense>
    </div>
  );
}
