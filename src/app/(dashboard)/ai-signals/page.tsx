import { Suspense } from "react";

import { BestTimeBanner } from "@/components/best-time/best-time-banner";
import { AiSignalsBoard } from "@/components/ai-signals/ai-signals-board";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/best-time/engine";
import { getCryptoAiSignals } from "@/features/ai-signals/crypto-builder";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "AI Signals · Crypto",
  description:
    "Multi-confluence AI trading signals for BTC, ETH and SOL — confidence-scored, ATR-sized, with tiered take-profits, timing windows, and human-readable reasoning.",
};

async function AiSignalsSection() {
  const data = await getCryptoAiSignals();
  return <AiSignalsBoard initialData={data} endpoint="/api/ai-signals" currency="usd" />;
}

function AiSignalsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[100px] w-full rounded-xl" />
      <Skeleton className="h-[48px] w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[620px] w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function AiSignalsPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          AI Signals · Crypto
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          The AI reads BTC / ETH / SOL across price action, derivatives
          positioning, liquidation flow, sentiment, and macro session
          quality — then publishes a confidence-scored trade plan with a
          tiered take-profit ladder, ATR-sized stop, position sizing
          recommendation, and the exact entry / exit window.
        </p>
      </header>

      <BestTimeBanner initial={bestTimeInitial} />

      <Suspense fallback={<AiSignalsSkeleton />}>
        <AiSignalsSection />
      </Suspense>

      <Card>
        <CardHeader>
          <CardTitle>How the AI computes each signal</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)] sm:grid-cols-2">
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                9 confluence factors
              </span>{" "}
              — RSI(14), MACD histogram, EMA 20/50 spread, volume thrust,
              funding rate, OI 1h Δ, long/short ratio, liquidation imbalance,
              Fear &amp; Greed, plus an IST session-quality bonus.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Composite score
              </span>{" "}
              in [-1, 1] becomes a confidence in [0, 1] scaled by the share
              of factors that were actually available. S-grade (≥85%)
              demands aligned bullish / bearish stacks.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Tiered take-profits
              </span>{" "}
              at 1× / 2× / 3× ATR-based multiples (50% / 30% / 20% scale-out)
              with an ATR-sized stop on the opposite side.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Position sizing
              </span>{" "}
              assumes a 1% per-trade risk budget. Tighter stops auto-cap so
              hair-thin invalidations don&apos;t leverage you up.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Win probability
              </span>{" "}
              is a calibrated [0.3, 0.85] logistic — strong signals climb to
              ~78%, marginal sit near coin-flip, none ever pretend to be
              certain.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Timing window
              </span>{" "}
              comes from the Best-Time engine (IST). Outside the active
              window every signal forces WAIT — no liquidity, no entry.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
