import { IndiaNewsFeed } from "@/components/india/news/india-news-feed";
import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { getBestTimeStatus } from "@/features/india/best-time/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "News · NSE F&O",
  description:
    "Real-time India and global market news powered by SentinelPulse — enriched with ML sentiment, event classification, and F&O impact scoring, folded into a live market breadth and regime read.",
};

/**
 * The India "News" surface scrapes Moneycontrol (India) + global business RSS
 * feeds, ranks the headlines most likely to move the F&O tape (tagged by
 * stock / sector / index), reads each headline's bull/bear sentiment via a
 * deterministic lexicon engine, and folds the impactful set into an overall
 * market sentiment + risk-on / risk-off ratio.
 */
export default function IndiaNewsPage() {
  const bestTimeInitial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">News · NSE F&amp;O</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Real-time India and global headlines processed by SentinelPulse — ML
          sentiment, event classification, and F&O impact scoring, folded into
          a live market breadth and risk-on / risk-off regime read.
        </p>
      </header>

      <IndiaBestTimeBanner initial={bestTimeInitial} />

      <IndiaNewsFeed />
    </div>
  );
}
