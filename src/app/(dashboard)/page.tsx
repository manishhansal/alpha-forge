import { Suspense } from "react";

import { BestTimeBanner } from "@/components/best-time/best-time-banner";
import { GlobalStats } from "@/components/dashboard/global-stats";
import { OverviewCard } from "@/components/dashboard/overview-card";
import { SentimentCard } from "@/components/dashboard/sentiment-card";
import { QuickSignals } from "@/components/signals/quick-signals";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/best-time/engine";
import { getMarketOverview } from "@/features/overview/fetch-overview";
import { getSentiment } from "@/features/sentiment/fetch-sentiment";
import { getSignals } from "@/features/signals/fetch-signals";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Overview",
  description: "Live BTC, ETH, SOL prices, sentiment, and signals",
};

async function MarketOverviewSection() {
  const overview = await getMarketOverview();
  return (
    <>
      <GlobalStats
        totalMarketCap={overview.totalMarketCap}
        totalVolume24h={overview.totalVolume24h}
        btcDominance={overview.btcDominance}
        ethDominance={overview.ethDominance}
        generatedAt={overview.generatedAt}
      />
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {overview.entries.map((entry) => (
          <OverviewCard key={entry.symbol} entry={entry} />
        ))}
      </div>
    </>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <Skeleton className="h-[88px] w-full rounded-xl" />
      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[218px] w-full rounded-xl" />
        ))}
      </div>
    </>
  );
}

// Server-render the sentiment/signals payloads alongside the overview so the
// client cards never hit `/api/*` for their first paint. The client useQuery
// hooks still take over for the 30s refetch interval (seeded with this data
// via `initialData`), but the cold-start cost — which on Turbopack dev is
// dominated by route-handler compilation — is paid once on the server in
// parallel with the overview fetch instead of being a visible loading state.
async function SentimentSection() {
  const sentiment = await getSentiment();
  return <SentimentCard initialData={sentiment} />;
}

async function QuickSignalsSection() {
  const signals = await getSignals();
  return <QuickSignals initialData={signals} />;
}

export default async function HomePage() {
  // Compute the best-time status synchronously on the server so the banner
  // paints with the correct active window and verdict — the client component
  // re-derives every minute against the user's wall clock. We only compute
  // (and render) it for signed-in visitors though: the banner is a
  // session-flavoured "should I trade right now?" prompt, not a public
  // marketing widget, so anonymous showroom visitors see the cleaner
  // header → market grid layout instead.
  const session = await auth();
  const isAuthed = Boolean(session?.user);
  const bestTimeInitial = isAuthed ? getBestTimeStatus() : null;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Market Overview</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Realtime BTC, ETH, and SOL prices via Binance WebSocket — aggregated with global market cap and dominance.
        </p>
      </header>

      {bestTimeInitial ? <BestTimeBanner initial={bestTimeInitial} /> : null}

      <Suspense fallback={<OverviewSkeleton />}>
        <MarketOverviewSection />
      </Suspense>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Suspense fallback={<Skeleton className="h-[260px] w-full rounded-xl" />}>
          <SentimentSection />
        </Suspense>
        <Suspense fallback={<Skeleton className="h-[210px] w-full rounded-xl" />}>
          <QuickSignalsSection />
        </Suspense>
      </section>
    </div>
  );
}
