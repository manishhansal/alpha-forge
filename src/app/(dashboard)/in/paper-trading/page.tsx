import { Suspense } from "react";

import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { IndiaJournalCard } from "@/components/india/paper-trading/journal-card";
import { IndiaJournalDataProvider } from "@/components/india/paper-trading/journal-data-context";
import { IndiaOpenPositionsCard } from "@/components/india/paper-trading/open-positions-card";
import { IndiaStatsPanel } from "@/components/india/paper-trading/stats-panel";
import { AutoTradingDashboard } from "@/components/india/paper-trading/auto-trading-dashboard";
import { IndiaStrategyProvider } from "@/components/india/strategies/strategy-context";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageTransition } from "@/components/layout/PageTransition";
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
    "Intelligent auto paper-trading with daily ₹1L budget — scores signals from Daily Picks and AI Signals, selects top trades, tracks outcomes, and provides rich time-range analytics.",
};

export default function IndiaPaperTradingPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <PageTransition>
      <IndiaStrategyProvider>
        <div className="mx-auto flex max-w-7xl flex-col gap-6">
          <PageHeader
            title="Paper Trading · NSE F&O"
            subtitle="Intelligent auto-trader scores every Daily Pick and AI Signal, opening only the highest-conviction setups within a ₹1L daily budget"
          />

          <IndiaBestTimeBanner initial={bestTimeInitial} />

          {/* ── Auto-Trading Analytics Dashboard ─────────────────────────── */}
          <AutoTradingDashboard />

          {/* ── Live positions + manual journal ──────────────────────────── */}
          <Suspense fallback={<PaperTradingFallback />}>
            <PaperTradingSection />
          </Suspense>
        </div>
      </IndiaStrategyProvider>
    </PageTransition>
  );
}

async function PaperTradingSection() {
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
