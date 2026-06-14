import { IndiaNewsFeed } from "@/components/india/news/india-news-feed";
import { IndiaBestTimeBanner } from "@/components/india/best-time/india-best-time-banner";
import { getBestTimeStatus } from "@/features/india/best-time/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "News · NSE F&O",
  description:
    "Top Moneycontrol + global market news that moves F&O stocks and sectors, with an overall market-sentiment read and a risk-on / risk-off ratio.",
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
          Top Moneycontrol and global headlines filtered to what moves F&amp;O
          stocks and sectors — each scored for sentiment and folded into an
          overall market read with a risk-on / risk-off ratio.
        </p>
      </header>

      <IndiaBestTimeBanner initial={bestTimeInitial} />

      <IndiaNewsFeed />
    </div>
  );
}
