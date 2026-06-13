"use client";

import { IndiaTickerBar } from "@/components/india/ticker/india-ticker-bar";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { useActiveMarket } from "@/lib/market-mode";
import { cn, formatPercent, formatPrice } from "@/lib/utils";
import { useMarketStore } from "@/store/marketStore";
import type { SymbolId } from "@/types/market";

function TickerCell({ symbol }: { symbol: SymbolId }) {
  const ticker = useMarketStore((s) => s.tickers[symbol]);
  const meta = TRACKED_SYMBOLS.find((s) => s.id === symbol)!;
  const change = ticker?.changePct24h ?? 0;
  const positive = change >= 0;

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      <span
        className="inline-flex h-1.5 w-1.5 rounded-full"
        style={{ background: meta.color }}
      />
      <span className="font-semibold text-[var(--color-fg)]">{symbol}</span>
      <span className="num text-[var(--color-fg-muted)]">
        {ticker ? `$${formatPrice(ticker.price)}` : "—"}
      </span>
      <span
        className={cn(
          "num text-[11px]",
          ticker ? (positive ? "text-bull" : "text-bear") : "text-[var(--color-fg-subtle)]",
        )}
      >
        {ticker ? formatPercent(change) : ""}
      </span>
    </div>
  );
}

function CryptoTickerBar() {
  return (
    <div className="flex items-center divide-x divide-[var(--color-border)] overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]/60">
      {TRACKED_SYMBOLS.map((s) => (
        <TickerCell key={s.id} symbol={s.id} />
      ))}
    </div>
  );
}

/**
 * Top-of-page live ticker. The URL (via `useActiveMarket`) is the source of
 * truth for which market we're rendering — crypto shows BTC/ETH/SOL streamed
 * from the active broker; Indian shows NIFTY indices polled from
 * `/api/in/market-snapshot`.
 */
export function MarketTickerBar() {
  const market = useActiveMarket();
  if (market === "india") return <IndiaTickerBar />;
  return <CryptoTickerBar />;
}
