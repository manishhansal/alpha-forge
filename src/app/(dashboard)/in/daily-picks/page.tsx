import { Suspense } from "react";

import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { DailyPicksBoard } from "@/components/india/daily-picks/daily-picks-board";
import { DailyPicksHistory } from "@/components/india/daily-picks/daily-picks-history";
import { ExpiryTradesSection } from "@/components/india/daily-picks/expiry-trades-section";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/india/best-time/engine";
import { getIndiaDailyPicks } from "@/features/india/daily-picks/builder";
import { getIndiaExpiryTrades } from "@/features/india/expiry-trades/builder";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Daily Picks · NSE F&O",
  description:
    "The day's top three F&O signals across three buckets — Highly Momentum, Highly Scalping and Highly Potential stocks — each with entry, stop, target, how far it can move and what to expect, tracked live and archived to a daily history.",
};

async function DailyPicksSection() {
  const data = await getIndiaDailyPicks();
  return <DailyPicksBoard initialData={data} />;
}

async function ExpiryTrades() {
  const data = await getIndiaExpiryTrades();
  if (!data.isExpiryDay) return null;
  return <ExpiryTradesSection initialData={data} />;
}

function DailyPicksSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <Skeleton className="h-[88px] w-full rounded-xl" />
      {Array.from({ length: 3 }).map((_, s) => (
        <div key={s} className="flex flex-col gap-3">
          <Skeleton className="h-[40px] w-64 rounded-lg" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[360px] w-full rounded-xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function IndiaDailyPicksPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Daily Picks · NSE F&amp;O
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          The day&apos;s standout signals, distilled to the top three in each
          bucket — <span className="font-medium text-[var(--color-fg)]">Highly
          Momentum</span>, <span className="font-medium text-[var(--color-fg)]">Highly
          Scalping</span> and <span className="font-medium text-[var(--color-fg)]">Highly
          Potential</span> stocks. Every pick carries entry, stop, target, how
          far it can move and what to expect, with the logic behind it — tracked
          live as price moves and archived to a daily history.
        </p>
      </header>

      <IndiaBestTimeBanner initial={bestTimeInitial} />

      <Suspense fallback={null}>
        <ExpiryTrades />
      </Suspense>

      <Suspense fallback={<DailyPicksSkeleton />}>
        <DailyPicksSection />
      </Suspense>

      <Card>
        <CardHeader>
          <CardTitle>Past picks &amp; outcomes</CardTitle>
        </CardHeader>
        <CardContent>
          <DailyPicksHistory />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How the Daily Picks are chosen</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)] sm:grid-cols-3">
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Highly Momentum
              </span>{" "}
              — the strongest directional names: SMA trend stack, 5-day
              momentum and volume thrust all pushing the same way.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Highly Scalping
              </span>{" "}
              — the cleanest intraday setups: enough expected range, sharp
              risk:reward, live scanner agreement and a short horizon.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Highly Potential
              </span>{" "}
              — the highest-conviction, biggest-payoff trades by confidence,
              win-probability and blended reward.
            </li>
          </ul>
          <p className="mt-3 text-[11px] text-[var(--color-fg-subtle)]">
            Picks are frozen once per trading day so entry / stop / target never
            move under you, then tracked live — current P&amp;L and progress to
            target update every refresh. A symbol only ever appears in one
            bucket, so all nine picks are distinct.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
