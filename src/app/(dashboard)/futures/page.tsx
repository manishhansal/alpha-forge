import { Suspense } from "react";

import { FundingTable } from "@/components/futures/funding-table";
import { FuturesTickerBar } from "@/components/futures/futures-ticker";
import { LiquidationFeed } from "@/components/futures/liquidation-feed";
import { LongShortGauge } from "@/components/futures/long-short-gauge";
import { OiCards } from "@/components/futures/oi-cards";
import { TopMoversCard } from "@/components/futures/top-movers";
import { SentimentCard } from "@/components/dashboard/sentiment-card";
import { Skeleton } from "@/components/ui/skeleton";
import { getFuturesOverview } from "@/features/futures/aggregate";
import { getSentiment } from "@/features/sentiment/fetch-sentiment";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Futures" };

async function FuturesOverviewSection() {
  const data = await getFuturesOverview();
  return (
    <>
      <FuturesTickerBar initial={data.tickers24h} initialGeneratedAt={data.generatedAt} />
      <OiCards symbols={data.symbols} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FundingTable symbols={data.symbols} />
        <LongShortGauge symbols={data.symbols} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TopMoversCard title="Top Gainers (Perp · 24h)" movers={data.topGainers} tone="bull" />
        <TopMoversCard title="Top Losers (Perp · 24h)" movers={data.topLosers} tone="bear" />
      </div>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[120px] w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[152px] w-full rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-[260px] w-full rounded-xl" />
        <Skeleton className="h-[260px] w-full rounded-xl" />
      </div>
    </div>
  );
}

async function SentimentSidebar() {
  const sentiment = await getSentiment();
  return <SentimentCard initialData={sentiment} />;
}

export default function FuturesPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Futures</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Funding, open interest, long/short bias, top movers, and live liquidation flow across BTC · ETH · SOL.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          <Suspense fallback={<OverviewSkeleton />}>
            <FuturesOverviewSection />
          </Suspense>
        </div>
        <div className="flex flex-col gap-4">
          <Suspense fallback={<Skeleton className="h-[260px] w-full rounded-xl" />}>
            <SentimentSidebar />
          </Suspense>
          <LiquidationFeed />
        </div>
      </div>
    </div>
  );
}
