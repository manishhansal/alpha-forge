import { Suspense } from "react";

import { BestTimeBanner } from "@/components/best-time/best-time-banner";
import { AccuracyPanel } from "@/components/signals/accuracy-panel";
import { SignalCard } from "@/components/signals/signal-card";
import { SentimentCard } from "@/components/dashboard/sentiment-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAccuracySummary } from "@/features/backtesting/history";
import { getBestTimeStatus } from "@/features/best-time/engine";
import { getSentiment } from "@/features/sentiment/fetch-sentiment";
import { getSignals } from "@/features/signals/fetch-signals";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Signals" };

async function SignalsList() {
  const data = await getSignals();
  return (
    <>
      <p className="text-[11px] text-[var(--color-fg-subtle)]">
        Generated {new Date(data.generatedAt).toLocaleString()} · refreshes every 30s
      </p>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {data.signals.map((s) => (
          <SignalCard key={s.id} signal={s} />
        ))}
      </div>
    </>
  );
}

async function AccuracySection() {
  // Resolve the data outside JSX so the React 19 lint rule
  // `react-hooks/error-boundaries` is satisfied — JSX inside try/catch
  // doesn't actually catch render errors, only data-fetch errors.
  const summary = await getAccuracySummary().catch((err: Error) => err);
  if (summary instanceof Error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Historical accuracy</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-[12px] text-[var(--color-fg-muted)]">
            Accuracy stats unavailable: {summary.message}
          </p>
        </CardContent>
      </Card>
    );
  }
  return <AccuracyPanel summary={summary} />;
}

function SignalsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-[420px] w-full rounded-xl" />
      ))}
    </div>
  );
}

function AccuracySkeleton() {
  return <Skeleton className="h-[280px] w-full rounded-xl" />;
}

// Server-prefetch sentiment so the sidebar tile renders with data on first
// paint instead of sitting as an empty dark skeleton waiting on the
// (Turbopack-lazy-compiled) `/api/sentiment` route from the browser.
async function SentimentSidebar() {
  const sentiment = await getSentiment();
  return <SentimentCard initialData={sentiment} />;
}

export default function SignalsPage() {
  // SSR the best-time snapshot so the dashboard paints with the correct
  // active window — the client takes over and ticks every minute thereafter.
  const bestTimeInitial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Trading Signals</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Per-symbol weighted-score engine combining trend, momentum, derivatives bias, liquidations,
          and sentiment. Each signal includes ATR-sized stop, target, and risk-reward.
        </p>
      </header>

      <BestTimeBanner initial={bestTimeInitial} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-3">
          <Suspense fallback={<SignalsSkeleton />}>
            <SignalsList />
          </Suspense>

          <Suspense fallback={<AccuracySkeleton />}>
            <AccuracySection />
          </Suspense>

          <Card>
            <CardHeader>
              <CardTitle>How signals are computed</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
                The engine weights nine inputs into a single score in <span className="num">[-1, 1]</span>:
                RSI(14), MACD(12,26,9), EMA 20/50 cross, funding rate, OI 1h delta, long/short ratio,
                volume breakout vs 20-bar avg, liquidation imbalance, and Fear &amp; Greed. A score
                above <span className="num">+0.45</span> with derivative-heavy inputs becomes
                <span className="font-semibold text-[var(--color-bull)]"> LONG</span>; below
                <span className="num"> -0.45</span> with derivatives becomes
                <span className="font-semibold text-[var(--color-bear)]"> SHORT</span>. Trend-only
                conviction maps to <span className="font-semibold text-[var(--color-bull)]">BUY</span> /
                <span className="font-semibold text-[var(--color-bear)]"> SELL</span>. Inconclusive →
                <span className="font-semibold"> HOLD</span>. Stop = entry ± 1.5×ATR(14), target = entry ± 3×ATR(14).
                The worker (<code className="font-mono">npm run worker:dev</code>) persists each new
                signal into <code className="font-mono">SignalHistory</code> and back-tests outcomes
                against subsequent 1m klines.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Suspense fallback={<Skeleton className="h-[260px] w-full rounded-xl" />}>
            <SentimentSidebar />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
