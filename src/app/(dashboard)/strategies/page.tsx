import { Suspense } from "react";

import { BestTimeBanner } from "@/components/best-time/best-time-banner";
import { LiveSignals } from "@/components/scalper/live-signals";
import { StrategyBacktestProvider } from "@/components/scalper/strategy-backtest-context";
import { StrategyProvider } from "@/components/scalper/strategy-context";
import { StrategyPicker } from "@/components/scalper/strategy-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/best-time/engine";
import { getScalpSignals } from "@/features/scalping/fetch-signals";
import { SCALP_STRATEGY_CATALOG } from "@/features/scalping/strategies/catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Strategies" };

/**
 * Crypto Strategies surface — the configuration + live-signal half of the
 * old Scalper page. The strategy picker, the live multi-timeframe signal
 * feed and the strategy reference card all live here so users can decide
 * which strategies they want to subscribe to.
 *
 * Trade outcomes (open positions, journal, per-strategy performance) live
 * on the sibling `/paper-trading` page so the read-only audit trail is
 * decoupled from picking strategies.
 */
export default function StrategiesPage() {
  // SSR the best-time snapshot so traders immediately see whether they're
  // inside the Golden Zone / Prime Futures window before they pick a
  // strategy — the client-side banner re-ticks every minute thereafter.
  const bestTimeInitial = getBestTimeStatus();

  return (
    <StrategyProvider>
      <StrategyBacktestProvider>
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <header className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">
              Strategies · live signals
            </h1>
            <p className="text-sm text-[var(--color-fg-muted)]">
              {SCALP_STRATEGY_CATALOG.length} scalping strategies running in
              parallel. Toggle the ones you want signals and paper trades
              from — the worker keeps generating P&amp;L for every strategy in
              the background so the journal stays a transparent track record
              regardless of your filter. Each strategy chip shows its
              5-year backtest score so you can prefer the ones with a proven
              edge. Open positions, journal and performance sit on the
              dedicated <span className="font-semibold">Paper Trading</span> page.
            </p>
          </header>

          <BestTimeBanner initial={bestTimeInitial} />

          <Suspense fallback={<SignalsFallback />}>
            <SignalsSection />
          </Suspense>
        </div>
      </StrategyBacktestProvider>
    </StrategyProvider>
  );
}

async function SignalsSection() {
  const signals = await getScalpSignals({ timeframe: "5m" });

  return (
    <div className="flex flex-col gap-4">
      <StrategyPicker />
      <LiveSignals initial={signals} />
      <HowItWorksCard />
    </div>
  );
}

function HowItWorksCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold normal-case tracking-tight text-[var(--color-fg)]">
          How the strategies work
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
          {SCALP_STRATEGY_CATALOG.map((s, i) => (
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
            Every signal opens one paper trade with the strategy&apos;s own
            ATR-sized stop and target. The worker (
            <code className="font-mono">npm run worker:dev</code>) walks 1m
            klines and closes the trade on the first touch of either level.
            Tie-break: a candle that touches both is recorded as a stop. Open
            positions and the full journal live on the{" "}
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
