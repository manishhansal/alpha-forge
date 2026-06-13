import { StrategyBacktestPanel } from "@/components/scalper/strategy-backtest-panel";
import { StrategyBacktestProvider } from "@/components/scalper/strategy-backtest-context";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata = { title: "Strategy Backtest" };

/**
 * Dedicated tab that runs every scalping strategy against historical price
 * action on $10,000 of starting equity. The bar interval (1m / 5m / 10m /
 * 15m / 1h / 4h / 1d) is user-selectable — default 5m, with the lookback
 * window scaled to keep each timeframe's candle count practical. Each
 * strategy is scored (0-100) and given a recommendation (highly recommended /
 * recommended / use cautiously / not recommended) so the user can pick the
 * strongest ones inside the Scalper page.
 */
export default function StrategyBacktestPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Strategy Backtest</h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Multi-timeframe backtest for every scalping strategy on BTC / ETH /
          SOL with $10,000 starting equity. Pick a bar interval (1m up to 1d)
          to see how each strategy holds up at that timeframe. Each strategy
          gets a 0-100 score, a letter grade, and a plain-English
          recommendation.
        </p>
      </header>

      <StrategyBacktestProvider initialInterval="5m">
        <StrategyBacktestPanel />
      </StrategyBacktestProvider>
    </div>
  );
}
