import { Suspense } from "react";

import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { IndiaJournalCard } from "@/components/india/paper-trading/journal-card";
import { IndiaJournalDataProvider } from "@/components/india/paper-trading/journal-data-context";
import { IndiaOpenPositionsCard } from "@/components/india/paper-trading/open-positions-card";
import { IndiaStatsPanel } from "@/components/india/paper-trading/stats-panel";
import { IndiaStrategyProvider } from "@/components/india/strategies/strategy-context";
import { Skeleton } from "@/components/ui/skeleton";
import { getBestTimeStatus } from "@/features/india/best-time/engine";
import { INDIA_JOURNAL_PAGE_SIZE } from "@/features/india/scalping/journal-constants";
import {
  countIndiaPaperTrades,
  getIndiaJournalStats,
  listIndiaOpenTrades,
  listIndiaPaperTrades,
} from "@/features/india/scalping/journal";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Paper Trading · NSE F&O",
  description:
    "Open positions, journal and per-strategy / per-underlying performance for the NSE F&O paper-trading engine — NIFTY, BANKNIFTY and F&O stock leaders.",
};

/**
 * India counterpart of `/paper-trading`. Mirrors the crypto Paper
 * Trading page 1:1 — best-time banner, open-positions table, server-
 * paginated journal, and per-symbol + per-strategy performance panel.
 *
 * Data scope is India F&O via `getIndia*` helpers — every read filters
 * `PaperTrade.source` on the `in:` prefix so India and crypto journals
 * stay fully isolated in the same Postgres table. The journal will be
 * empty until the F&O paper-trader worker books its first trade
 * (that's a separate roadmap item); the UI shell is identical to
 * crypto from day one so the moment a trade lands the cards fill out.
 */
export default function IndiaPaperTradingPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <IndiaStrategyProvider>
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Paper Trading · NSE F&amp;O
          </h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Live MTM on every open F&amp;O paper trade plus the full journal
            + per-strategy and per-underlying performance breakdown for
            NIFTY, BANKNIFTY and the F&amp;O stock leaders. Pick which
            strategies you want signals from on the{" "}
            <span className="font-semibold">Strategies</span> page.
          </p>
        </header>

        <IndiaBestTimeBanner initial={bestTimeInitial} />

        <Suspense fallback={<PaperTradingFallback />}>
          <PaperTradingSection />
        </Suspense>
      </div>
    </IndiaStrategyProvider>
  );
}

async function PaperTradingSection() {
  // Prefetch only the first page so SSR matches the client's first
  // render after hydration. Every helper here is India-scoped.
  const [items, open, stats, total] = await Promise.all([
    listIndiaPaperTrades({ limit: INDIA_JOURNAL_PAGE_SIZE, offset: 0 }),
    listIndiaOpenTrades(),
    getIndiaJournalStats(),
    countIndiaPaperTrades({}),
  ]);

  const initialJournal = {
    items: items.map((t) => ({
      ...t,
      openedAt: t.openedAt.toISOString(),
      closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    })),
    open: open.map((t) => ({
      ...t,
      openedAt: t.openedAt.toISOString(),
      closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    })),
    total,
    limit: INDIA_JOURNAL_PAGE_SIZE,
    offset: 0,
  };

  return (
    <IndiaJournalDataProvider initial={initialJournal}>
      <div className="flex flex-col gap-4">
        <IndiaOpenPositionsCard />
        <IndiaJournalCard />
        <IndiaStatsPanel stats={stats} />
      </div>
    </IndiaJournalDataProvider>
  );
}

function PaperTradingFallback() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[260px] w-full rounded-xl" />
      <Skeleton className="h-[420px] w-full rounded-xl" />
      <Skeleton className="h-[260px] w-full rounded-xl" />
    </div>
  );
}
