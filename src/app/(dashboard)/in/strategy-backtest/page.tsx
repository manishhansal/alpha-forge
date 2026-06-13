import { Suspense } from "react";

import { IndiaBacktestPreview } from "@/components/india/strategy/india-backtest-preview";
import { Skeleton } from "@/components/ui/skeleton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Strategy Backtest · NSE F&O",
  description:
    "Multi-strategy NSE F&O backtest scaffold — pick an underlying and timeframe, see the historical OHLCV the engine will run against, and follow the roadmap to live grading.",
};

/**
 * India counterpart of the crypto Strategy Backtest page. The crypto
 * version replays five years of 4h klines for ten strategies on BTC / ETH
 * / SOL with $10k starting equity and produces a 0-100 score + grade per
 * strategy.
 *
 * For NSE we already have `fetchKlinesRange` against `/api/in/historical`
 * but the strategy modules aren't yet retargeted to NSE-specific signals
 * (gap behaviour, ATM IV, OI delta). This page lets the user inspect the
 * exact historical window the engine will train against today and shows
 * the roadmap to fully-graded backtests on F&O.
 */
export default function IndiaStrategyBacktestPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Strategy Backtest · NSE F&amp;O
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Historical F&amp;O backtest scaffold. Pick an underlying and a
          timeframe to inspect the exact OHLCV window the engine will replay
          once the F&amp;O strategy modules ship.
        </p>
      </header>

      <Suspense fallback={<Skeleton className="h-[640px] w-full rounded-xl" />}>
        <IndiaBacktestPreview />
      </Suspense>
    </div>
  );
}
