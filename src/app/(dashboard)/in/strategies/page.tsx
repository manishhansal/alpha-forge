import { Suspense } from "react";

import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { IndiaLiveSignals } from "@/components/india/strategies/live-signals";
import { IndiaStrategyPicker } from "@/components/india/strategies/strategy-picker";
import { IndiaStrategyProvider } from "@/components/india/strategies/strategy-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/india/best-time/engine";
import { getIndiaScalpSignals } from "@/features/india/scalping/fetch-signals";
import { getIndiaStrategyScores } from "@/features/india/scalping/score-board";
import { INDIA_SCALP_STRATEGY_CATALOG } from "@/features/india/scalping/strategies/catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Strategies · NSE F&O",
  description:
    "Eight NSE F&O strategies running in parallel — Range Expansion, Momentum, Volume Breakout, OI Build-up, PCR Extreme, IV Spike, India Liquidity Edge and Max-Pain Gravity — with a live multi-timeframe signal feed pinned to the active NSE session.",
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
 * up, PCR, IV spike) plus two option-positioning ILE-Pine ports (India
 * Liquidity Edge + Max-Pain Gravity) served by the positioning engine.
 * The F&O paper-trader worker (ATR-sized SL/TP off NSE intraday OHLCV,
 * expiry-day cooldown, NSE tick rounding) books these signals into the
 * journal, and each strategy chip carries a paper-trade score derived
 * from that record.
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
  // — the client polls for fresh data every 30s thereafter. Per-strategy
  // scores blend a 5-year OHLCV backtest (price strategies) with the live
  // paper-trade record (option-chain strategies); a failure in either
  // source degrades gracefully rather than blanking the feed.
  const [signals, scores] = await Promise.all([
    getIndiaScalpSignals({ timeframe: "5m" }),
    getIndiaStrategyScores().catch(() => ({})),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <IndiaStrategyPicker scores={scores} />
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
            The F&amp;O paper-trader worker sizes each trade&apos;s stop and
            target off a real intraday ATR (snapped to the 0.05 NSE tick),
            skips fresh entries inside the expiry-day gamma cooldown, and
            resolves trades against 5m NSE candles. The score chip on each
            strategy reflects its live paper-trade record. Open positions,
            the journal and per-strategy + per-underlying performance live on
            the <span className="font-semibold">Paper Trading</span> page.
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
