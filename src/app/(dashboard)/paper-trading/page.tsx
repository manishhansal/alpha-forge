import { Suspense } from "react";

import { JournalCard } from "@/components/scalper/journal-card";
import { JournalDataProvider } from "@/components/scalper/journal-data-context";
import { OpenPositionsCard } from "@/components/scalper/open-positions-card";
import { StatsPanel } from "@/components/scalper/stats-panel";
import { StrategyProvider } from "@/components/scalper/strategy-context";
import { Skeleton } from "@/components/ui/skeleton";
import { JOURNAL_PAGE_SIZE } from "@/features/scalping/journal-constants";
import {
  countPaperTrades,
  getJournalStats,
  listOpenTrades,
  listPaperTrades,
} from "@/features/scalping/journal";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Paper Trading" };

/**
 * Crypto Paper Trading surface — the read-only audit half of the old
 * Scalper page. Open positions (live MTM), the full journal (server-
 * paginated), and the per-strategy + per-symbol performance breakdown
 * all live here.
 *
 * Picking which strategies fire (and watching the live signal feed) is
 * the sibling `/strategies` page; the strategy filter is shared via the
 * same Zustand-backed StrategyProvider so toggling a strategy on either
 * page is reflected on the other.
 */
export default function PaperTradingPage() {
  return (
    <StrategyProvider>
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Paper Trading · journal &amp; positions
          </h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Live MTM on every open paper trade plus the full journal +
            per-strategy and per-symbol performance breakdown. The worker
            keeps generating paper trades for every strategy in the
            background — pick which strategies you want signals from on
            the <span className="font-semibold">Strategies</span> page.
          </p>
        </header>

        <Suspense fallback={<PaperTradingFallback />}>
          <PaperTradingSection />
        </Suspense>
      </div>
    </StrategyProvider>
  );
}

async function PaperTradingSection() {
  // Paginate the journal server-side: prefetch only the first page so SSR
  // matches what the client will render after hydration.
  const [items, open, stats, total] = await Promise.all([
    listPaperTrades({ limit: JOURNAL_PAGE_SIZE, offset: 0 }),
    listOpenTrades(),
    getJournalStats(),
    countPaperTrades({}),
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
    limit: JOURNAL_PAGE_SIZE,
    offset: 0,
  };

  return (
    <JournalDataProvider initial={initialJournal}>
      <div className="flex flex-col gap-4">
        <OpenPositionsCard />
        <JournalCard />
        <StatsPanel stats={stats} />
      </div>
    </JournalDataProvider>
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
