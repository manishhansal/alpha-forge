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
    "The day's top F&O signals across five buckets — Indices Scalping, Opening Breakout, Highly Momentum, Highly Scalping and Highly Potential — each with entry, stop, target, how far it can move and what to expect, the time it appeared and how long it took to resolve, tracked live and archived to a daily history.",
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
      {Array.from({ length: 5 }).map((_, s) => (
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
          bucket — <span className="font-medium text-[var(--color-fg)]">Indices
          Scalping</span>, <span className="font-medium text-[var(--color-fg)]">Opening
          Breakout</span>, <span className="font-medium text-[var(--color-fg)]">Highly
          Momentum</span>, <span className="font-medium text-[var(--color-fg)]">Highly
          Scalping</span> and <span className="font-medium text-[var(--color-fg)]">Highly
          Potential</span>. Every pick carries entry, stop, target, how far it
          can move and what to expect, the time it appeared on the board and how
          long it took to take profit or loss, with the logic behind it —
          tracked live as price moves and archived to a daily history.
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
          <ul className="grid grid-cols-1 gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)] sm:grid-cols-2">
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Indices Scalping
              </span>{" "}
              — institutional index plays on NIFTY / BANKNIFTY / FINNIFTY /
              MIDCPNIFTY: heavy option-chain OI build-up, PCR and max-pain
              positioning confirming intraday demand and the broad tape.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Opening Breakout
              </span>{" "}
              — the first 5-min candle (9:15–9:19:59 IST) range break, entered
              on the retest of the broken level (resistance→support flip): stop
              below the breakout candle, 2R target, PCR / OI / max-pain
              confirmed. Appears once the opening range breaks and retests.
            </li>
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
            move under you, then tracked live — current P&amp;L, progress to
            target and the elapsed time-to-outcome update every refresh. Every
            card shows when the signal appeared on the board and, once resolved,
            how long it took to hit its target or stop. Indices feed the
            Indices-Scalping bucket and stocks feed Momentum / Scalping /
            Potential — a symbol only ever appears once across those, so the
            picks stay distinct. Opening Breakout is sourced from its own
            strategy (indices or stocks) and freezes once the opening range
            breaks and retests. As an intraday product, anything still open is
            squared off at the 15:30 close.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
