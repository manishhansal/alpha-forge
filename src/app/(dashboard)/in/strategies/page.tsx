import { Suspense } from "react";

import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { IndiaLiveSignals } from "@/components/india/strategies/live-signals";
import { IndiaStrategyPicker } from "@/components/india/strategies/strategy-picker";
import { IndiaStrategyProvider } from "@/components/india/strategies/strategy-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/india/best-time/engine";
import { getIndiaScalpSignals } from "@/features/india/scalping/fetch-signals";
import { INDIA_SCALP_STRATEGY_CATALOG } from "@/features/india/scalping/strategies/catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Strategies · NSE F&O",
  description:
    "Six NSE F&O strategies running in parallel — Range Expansion, Momentum, Volume Breakout, OI Build-up, PCR Extreme and IV Spike — with a live multi-timeframe signal feed pinned to the active NSE session.",
};

/**
 * India counterpart of `/strategies`. Mirrors the crypto Strategies
 * page one-for-one: best-time banner, multi-strategy picker, live
 * signal feed, and a "how the strategies work" reference card. Each
 * strategy chip drives the same paper-trading lanes consumed by the
 * sibling `/in/paper-trading` page (open positions, journal, stats).
 *
 * Data scope is India F&O — six strategies derived from the existing
 * NSE scanners (range expansion, momentum, volume breakout, OI build-
 * up, PCR, IV spike) so signals are live today. The proper F&O paper-
 * trader (ATR sizing, expiry-day cooldown, NSE tick rounding) is on
 * the roadmap but does not block the structural mirror.
 */
export default function IndiaStrategiesPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <IndiaStrategyProvider>
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Strategies · NSE F&amp;O
          </h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            {INDIA_SCALP_STRATEGY_CATALOG.length} F&amp;O strategies running
            in parallel against the live NSE F&amp;O universe. Toggle the
            ones you want signals from — open positions, the journal and
            per-strategy / per-underlying performance sit on the dedicated{" "}
            <span className="font-semibold">Paper Trading</span> page.
          </p>
        </header>

        <IndiaBestTimeBanner initial={bestTimeInitial} />

        <Suspense fallback={<SignalsFallback />}>
          <SignalsSection />
        </Suspense>
      </div>
    </IndiaStrategyProvider>
  );
}

async function SignalsSection() {
  // SSR the first signal batch so the cards paint on the initial render
  // — the client polls for fresh data every 30s thereafter.
  const signals = await getIndiaScalpSignals({ timeframe: "5m" });

  return (
    <div className="flex flex-col gap-4">
      <IndiaStrategyPicker />
      <IndiaLiveSignals initial={signals} />
      <HowItWorksCard />
    </div>
  );
}

function HowItWorksCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          How the F&amp;O strategies work
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
          {INDIA_SCALP_STRATEGY_CATALOG.map((s, i) => (
            <li key={s.id}>
              <span className="font-semibold text-[var(--color-fg)]">
                {i + 1}. {s.label}.
              </span>{" "}
              {s.description}
            </li>
          ))}
          <li className="mt-2 border-t border-[var(--color-border)] pt-2">
            <span className="font-semibold text-[var(--color-fg)]">
              Risk &amp; resolution.
            </span>{" "}
            Each signal carries a synthetic 0.5%-band stop / 1.0%-band target
            (2:1 RR) until the proper F&amp;O paper-trader ships with ATR-
            sized sizing, expiry-day cooldowns and NSE tick rounding. Open
            positions, the journal and per-strategy + per-underlying
            performance live on the{" "}
            <span className="font-semibold">Paper Trading</span> page.
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

function SignalsFallback() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-12 w-full rounded-xl" />
      <Skeleton className="h-[480px] w-full rounded-xl" />
    </div>
  );
}
