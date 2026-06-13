import { IndiaSignalsBoard } from "@/components/india/signals/india-signals-board";
import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { getBestTimeStatus } from "@/features/india/best-time/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Signals · NSE F&O",
  description:
    "Aggregated F&O signal feed — Momentum, Volume Breakout, Range Expansion, OI Build-up, PCR and IV-spike scanners merged into one ranked board.",
};

/**
 * The India "Signals" surface unifies every scanner type the existing
 * `/api/in/scanner` engine already exposes — Momentum, Volume Breakout,
 * Range Expansion, OI Build-up, PCR and IV-spike. The client component
 * fans out one fetch per scanner type and merges the rows into a single
 * ranked feed, with a per-type filter strip.
 */
export default function IndiaSignalsPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Signals · NSE F&amp;O
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Six F&amp;O scanners merged into a single ranked feed —
          range-expansion candidates, momentum leaders, volume breakouts, OI
          build-ups, PCR extremes and IV spikes. Filter by source to focus on
          the setup you care about.
        </p>
      </header>

      <IndiaBestTimeBanner initial={bestTimeInitial} />

      <IndiaSignalsBoard />
    </div>
  );
}
