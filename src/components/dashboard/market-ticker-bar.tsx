"use client";

import { IndiaTickerBar } from "@/components/india/ticker/india-ticker-bar";
import { TRACKED_SYMBOLS } from "@/lib/constants";
import { useActiveMarket } from "@/lib/market-mode";
import { cn, formatPercent, formatPrice } from "@/lib/utils";
import { useMarketStore } from "@/store/marketStore";
import type { SymbolId } from "@/types/market";

/* ── crypto chip ─────────────────────────────────────────────────────── */
function TickerChip({ symbol }: { symbol: SymbolId }) {
  const ticker = useMarketStore((s) => s.tickers[symbol]);
  const meta   = TRACKED_SYMBOLS.find((s) => s.id === symbol)!;
  const change = ticker?.changePct24h ?? 0;
  const up     = change >= 0;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors",
        up
          ? "border-[color-mix(in_oklch,var(--color-bull)_20%,transparent)] bg-[color-mix(in_oklch,var(--color-bull)_6%,transparent)]"
          : "border-[color-mix(in_oklch,var(--color-bear)_20%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_6%,transparent)]",
      )}
    >
      {/* live dot */}
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-75"
          style={{
            background: meta.color,
            animation: ticker ? "neon-ping 2s ease-in-out infinite" : "none",
          }}
        />
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full"
          style={{ background: meta.color }}
        />
      </span>

      <span className="font-bold text-[var(--color-fg)] tracking-wide">{symbol}</span>

      <span className="num text-[var(--color-fg-muted)]">
        {ticker ? `$${formatPrice(ticker.price)}` : "—"}
      </span>

      <span className={cn("num text-[11px] font-semibold", up ? "text-bull" : "text-bear")}>
        {ticker ? formatPercent(change) : ""}
      </span>
    </div>
  );
}

function CryptoTickerBar() {
  return (
    <div className="relative flex items-center gap-2 overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]/50 px-4 py-2 backdrop-blur-sm">
      {/* scrolling strip — duplicate for seamless loop */}
      <div className="ticker-scroll flex items-center gap-2">
        {[...TRACKED_SYMBOLS, ...TRACKED_SYMBOLS].map((s, i) => (
          <TickerChip key={`${s.id}-${i}`} symbol={s.id} />
        ))}
      </div>
      {/* fade edges */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-10 bg-gradient-to-r from-[var(--color-bg-elevated)] to-transparent" />
      <div className="pointer-events-none absolute right-0 top-0 h-full w-10 bg-gradient-to-l from-[var(--color-bg-elevated)] to-transparent" />
    </div>
  );
}

export function MarketTickerBar() {
  const market = useActiveMarket();
  if (market === "india") return <IndiaTickerBar />;
  return <CryptoTickerBar />;
}
