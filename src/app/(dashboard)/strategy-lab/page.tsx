import { StrategyLab } from "@/components/strategy-lab/strategy-lab";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Strategy Lab" };

export default function StrategyLabPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Strategy Lab</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Describe a trading idea in plain English, backtest it on 1 week to 5 years of price
          history, and forward-test the saved version against the live market with paper trades.
        </p>
      </header>

      <StrategyLab />
    </div>
  );
}
