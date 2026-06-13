import { IndiaFeaturePreview } from "@/components/india/common/india-feature-preview";
import { IndiaStrategyLabIntake } from "@/components/india/strategy/india-strategy-lab-intake";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = {
  title: "Strategy Lab · NSE F&O",
  description:
    "Conversational F&O backtester scaffold — describe a NIFTY / BANKNIFTY strategy in plain English; AST parsing and forward paper-trading on NSE are in active development.",
};

/**
 * India counterpart of the crypto Strategy Lab. The crypto version turns
 * a free-form prompt into a structured rule set (RSI / MACD / EMA / SMA /
 * ATR / volume / N-bar % change), backtests it on 1w → 5y windows, returns
 * win rate / drawdown / Sharpe / equity curve / trade log, persists the
 * AST per user, and forward-tests it against live klines via the worker.
 *
 * For NSE we already have the historical fetcher and broker abstraction;
 * the missing pieces are the F&O-aware indicator pack (gap-aware, IV
 * regime, OI delta) and the per-user Postgres tables that store NSE
 * strategies. This page captures the prompt + parameters and explains
 * what's coming so the surface is honest.
 */
export default function IndiaStrategyLabPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Strategy Lab · NSE F&amp;O
        </h1>
        <p className="text-sm text-[var(--color-fg-muted)]">
          Describe a NIFTY / BANKNIFTY / F&amp;O-stock strategy in plain
          English. The intake form below captures the prompt + parameters; the
          parser, backtester and live paper-trader for NSE F&amp;O are in
          active development.
        </p>
      </header>

      <IndiaFeaturePreview
        state="planned"
        pillLabel="Conversational F&O backtester"
        liveSummary={
          <>
            The crypto Strategy Lab parses prompts like &ldquo;Buy when RSI
            drops below 30 and sell when RSI crosses above 70. Stop 2%, take
            profit 5%.&rdquo; into a structured AST and replays it against 1w
            → 5y of klines. The AST + simulator are broker-agnostic; we&apos;re
            wiring in NSE-specific indicators (ATM IV regime, India VIX bands,
            weekly-expiry guard) before flipping it on for F&amp;O.
          </>
        }
        liveBullets={[
          "Free-form prompt input with ready-made NSE F&O templates",
          "Underlying + period + intra-day timeframe selector matching the historical engine",
          "Stop / target / max-hold parameters identical to the crypto Lab",
          "Saved-strategy slot ready (will hydrate from the per-user NSE table once the parser ships)",
        ]}
        roadmap={[
          {
            title: "F&O-aware AST parser",
            detail:
              "Extends the crypto parser with NSE-specific tokens — `IV ATM > 20%`, `India VIX > 15`, `OI ΔBUILDUP`, `expiry day`, `weekly` — so prompts can reference option-chain regimes directly.",
          },
          {
            title: "Backtest pipeline on F&O bars",
            detail:
              "Same intra-bar SL/TP simulator as crypto, plus tick-size rounding, T+1 settlement guard for delivery, and an expiry-day kill-switch.",
          },
          {
            title: "Per-user NSE strategy table",
            detail:
              "Mirrors the crypto Strategy Lab's persistence (prompt + AST + last result) under an `india_strategies` table so saved F&O strategies survive across devices.",
          },
          {
            title: "Live forward-test via worker",
            detail:
              "The existing worker pipeline picks up active F&O strategies and opens paper trades on each fresh closed bar — same tie-break rules as the F&O scalper.",
          },
        ]}
        links={[
          { href: "/strategy-lab", label: "See crypto strategy lab →" },
          { href: "/in/scanner", label: "Scanner →" },
        ]}
      >
        <IndiaStrategyLabIntake />
      </IndiaFeaturePreview>
    </div>
  );
}
