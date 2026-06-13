import { Suspense } from "react";

import { AiSignalsBoard } from "@/components/ai-signals/ai-signals-board";
import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/india/best-time/engine";
import { getIndiaAiSignals } from "@/features/ai-signals/india-builder";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "AI Signals · NSE F&O",
  description:
    "Multi-confluence AI trading signals for NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY and high-liquidity F&O leaders — PCR, IV, OI build-up, max-pain, scanner agreement, session quality, all rolled into a confidence-scored trade plan.",
};

async function IndiaAiSignalsSection() {
  const data = await getIndiaAiSignals();
  return (
    <AiSignalsBoard
      initialData={data}
      endpoint="/api/in/ai-signals"
      currency="inr"
    />
  );
}

function AiSignalsSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[100px] w-full rounded-xl" />
      <Skeleton className="h-[48px] w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[620px] w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export default function IndiaAiSignalsPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          AI Signals · NSE F&amp;O
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          The AI reads NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY and the
          highest-liquidity F&amp;O leaders across daily trend, momentum,
          option-chain positioning (PCR, IV, OI build-up, max-pain) and
          live scanner agreement, then publishes a confidence-scored trade
          plan with strike, stop, tiered targets and the exact NSE-session
          entry / exit window.
        </p>
      </header>

      <IndiaBestTimeBanner initial={bestTimeInitial} />

      <Suspense fallback={<AiSignalsSkeleton />}>
        <IndiaAiSignalsSection />
      </Suspense>

      <Card>
        <CardHeader>
          <CardTitle>How the AI computes each F&amp;O signal</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid grid-cols-1 gap-2 text-[12px] leading-relaxed text-[var(--color-fg-muted)] sm:grid-cols-2">
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Daily trend stack
              </span>{" "}
              — SMA 20/50/200 alignment, RSI(14), 5-day momentum, volume vs
              20-day average — captures the directional tape on indices and
              F&amp;O leaders.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Option-chain positioning
              </span>{" "}
              — live PCR (OI), ATM IV, ΔPE-CE OI build-up and max-pain pull
              from the NSE option chain (cookie-warmed proxy) feeds the
              derivatives leg of the score.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Live scanner agreement
              </span>{" "}
              — cross-references the existing F&amp;O scanners
              (momentum, volume breakout, range-expansion, OI build-up) so
              a strong AI long agrees with what the multi-scanner board is
              showing in real time.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                NSE session quality
              </span>{" "}
              — the India Best-Time engine forces WAIT outside 09:15-15:30
              IST and on weekends / weekly-expiry warning days, so the AI
              never publishes a setup the market can&apos;t fill.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Strike suggestion
              </span>{" "}
              — every non-WAIT signal carries the nearest ATM strike from
              the live option chain so users know exactly which contract to
              touch on.
            </li>
            <li>
              <span className="font-semibold text-[var(--color-fg)]">
                Position sizing
              </span>{" "}
              uses a 1% risk-per-trade budget against the ATR-based stop,
              with a per-horizon cap so the AI can&apos;t recommend a
              over-leveraged contract count.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
