import { IndiaSignalCenter } from "@/components/india/signal-center/india-signal-center";
import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { getBestTimeStatus } from "@/features/india/best-time/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Signal Center · India",
  description:
    "Unified Indian market signal center — all signal families (AI, Daily Picks, F&O Scanners, FnO Trend, Scalper, MSB) aggregated and deduplicated into one canonical view.",
};

/**
 * India Signal Center — unified view of all signal families.
 *
 * Aggregates: AI Signals + Daily Picks + F&O Scanners (6 types) +
 * FnO Trend (14-condition) + Scalper (9 strategies) + MSB
 *
 * Signals for the same instrument + direction are clustered into one
 * OpportunityCluster. A NIFTY LONG confirmed by AI + 2 scanners + Daily Pick
 * = 1 cluster with 4 confirmations, not 4 separate opportunities.
 */
export default function IndiaSignalCenterPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          India Signal Center
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          All Indian market signals — AI, Daily Picks, F&amp;O Scanners, FnO
          Trend, Scalper and MSB — merged and deduplicated. One opportunity per
          setup, not N duplicate cards.
        </p>
      </header>

      <IndiaBestTimeBanner initial={bestTimeInitial} />

      <IndiaSignalCenter />
    </div>
  );
}
