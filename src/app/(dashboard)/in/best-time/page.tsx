import { IndiaBestTimeDashboard } from "@/components/india/best-time/india-best-time-dashboard";
import { getBestTimeStatus } from "@/features/india/best-time/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Best Time to Trade · NSE F&O",
  description:
    "IST-anchored guide to NSE F&O sessions — Pre-Open Auction, Opening Volatility, Morning Trend, Midday Lull, Afternoon Trend, Power Hour and the Closing Auction.",
};

export default function IndiaBestTimePage() {
  const initial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Best Time to Trade · NSE F&amp;O
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Session guide anchored to NSE&apos;s 09:15 – 15:30 IST cash + F&amp;O
          window. Tells you whether right now is the Power Hour, a midday lull
          or the closing auction — and which window is up next.
        </p>
      </header>

      <IndiaBestTimeDashboard initial={initial} />
    </div>
  );
}
