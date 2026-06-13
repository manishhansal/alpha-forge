import { BestTimeDashboard } from "@/components/best-time/best-time-dashboard";
import { getBestTimeStatus } from "@/features/best-time/engine";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Best Time to Trade",
  description:
    "IST-aware trading window guide for BTC, ETH and SOL — Golden Zone, Prime Futures, Range Scalp, Worst Zone and per-style insights.",
};

export default function BestTimePage() {
  // SSR the snapshot so the page paints with the correct active window and
  // verdict instantly; the client component re-derives every minute against
  // the user's wall clock.
  const initial = getBestTimeStatus();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Best Time to Trade</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          IST-anchored trading window guide for BTC, ETH and SOL — built around when liquidity,
          volatility and institutional flow actually show up on Binance, Bybit and Delta.
        </p>
      </header>

      <BestTimeDashboard initial={initial} />
    </div>
  );
}
