"use client";

import * as React from "react";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useFetchPoll, getJson } from "@/hooks/india/useFetchPoll";
import { useFeedStream } from "@/hooks/india/useFeedStream";
import { fmt, fmtPct } from "@/lib/india/format";
import { cn } from "@/lib/utils";
import { FNO_INDICES, SUPPLEMENTARY_INDICES } from "@/lib/india/fno-symbols";
import type { Snapshot } from "@/types/india";

// Symbols subscribed to via SSE — all FNO + supplementary indices.
const TICKER_SYMBOLS = [
  ...FNO_INDICES.map((i) => i.symbol),
  ...SUPPLEMENTARY_INDICES.map((i) => i.symbol),
];

const ACCENT: Record<string, string> = {
  "NIFTY 50":      "#10b981",
  "BANK NIFTY":    "#f59e0b",
  "FIN NIFTY":     "#8b5cf6",
  "MIDCAP NIFTY":  "#06b6d4",
  SENSEX:          "#3b82f6",
  "INDIA VIX":     "#ef4444",
};

const isVix = (name: string | undefined | null) => !!name?.toUpperCase().includes("VIX");

function IndexChip({
  name,
  symbol,
  price,
  changePct,
}: {
  name: string | undefined | null;
  symbol: string;
  price: number | null;
  changePct: number | null;
}) {
  const pct      = changePct ?? 0;
  const vix      = isVix(name);
  const positive = vix ? pct < 0 : pct >= 0;
  const dot      = (name && ACCENT[name]) ?? "#64748b";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
        positive
          ? "border-[color-mix(in_oklch,var(--color-bull)_18%,transparent)] bg-[color-mix(in_oklch,var(--color-bull)_5%,transparent)]"
          : "border-[color-mix(in_oklch,var(--color-bear)_18%,transparent)] bg-[color-mix(in_oklch,var(--color-bear)_5%,transparent)]",
      )}
      title={symbol}
    >
      {/* live pulse dot */}
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-70"
          style={{
            background: dot,
            animation: price != null ? "neon-ping 2.4s ease-in-out infinite" : "none",
          }}
        />
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full"
          style={{ background: dot }}
        />
      </span>

      <span className="font-bold text-[var(--color-fg)] tracking-wide">{name}</span>

      <span className="num text-[var(--color-fg-muted)]">{fmt(price)}</span>

      {changePct != null && (
        <span className={cn("num text-[11px] font-semibold", positive ? "text-bull" : "text-bear")}>
          {fmtPct(changePct)}
        </span>
      )}
    </div>
  );
}

export function IndiaTickerBar() {
  const snapshot    = useIndiaMarketStore((s) => s.snapshot);
  const ticks       = useIndiaMarketStore((s) => s.ticks);
  const setSnapshot = useIndiaMarketStore((s) => s.setSnapshot);

  // ── Snapshot poll (5s) ───────────────────────────────────────────────────
  // Provides open/high/low/prevClose/change and seeds the initial price.
  // Cache headers are no-store so every request hits the origin fresh.
  useFetchPoll<Snapshot>(
    (signal) => getJson<Snapshot>("/api/in/market-snapshot", signal),
    (data)   => setSnapshot(data),
    { intervalMs: 5_000 },
    [],
  );

  // ── SSE live tick stream (5s poll interval on the server) ────────────────
  // Overlays real-time ltp + changePct from the SSE gateway onto the store.
  // This means prices update every ~5s without waiting for the next snapshot.
  useFeedStream(TICKER_SYMBOLS, 5_000);

  const indices = snapshot?.indices ?? [];

  // ── Pre-snapshot seed from SSE ticks ─────────────────────────────────────
  // If the snapshot hasn't loaded yet but the SSE stream already sent a
  // snapshot frame, the ticks map is populated. Build provisional chips from
  // the known TICKER_SYMBOLS list using those ticks so the bar is never empty
  // while the first HTTP poll is still in flight.
  const tickBasedIndices = React.useMemo(() => {
    if (indices.length > 0) return null; // snapshot is ready — not needed
    const allDefs = [
      ...FNO_INDICES.map((i) => ({ name: i.name, symbol: i.symbol })),
      ...SUPPLEMENTARY_INDICES.map((i) => ({ name: i.name, symbol: i.symbol })),
    ];
    const hasAnyTick = allDefs.some((d) => ticks[d.symbol]);
    if (!hasAnyTick) return null;
    return allDefs.map((d) => ({
      name:      d.name,
      symbol:    d.symbol,
      price:     ticks[d.symbol]?.ltp ?? null,
      changePct: ticks[d.symbol]?.changePct ?? null,
      change:    null,
      prevClose: null,
    }));
  }, [indices.length, ticks]);

  const activeIndices = indices.length > 0 ? indices : (tickBasedIndices ?? []);

  if (activeIndices.length === 0) {
    return (
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]/50 px-4 py-2">
        {/* skeleton chips */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-7 w-24 animate-pulse rounded-lg bg-[var(--color-surface)]" />
        ))}
      </div>
    );
  }

  // Merge snapshot baseline with live ticks so the display is always as
  // fresh as the latest SSE event, falling back to snapshot when no tick
  // has arrived yet for that symbol or when the tick price is 0/null.
  const mergedIndices = activeIndices.map((idx) => {
    const tick = ticks[idx.symbol];
    if (!tick) return idx;
    return {
      ...idx,
      // Guard against tick.ltp = 0 overwriting a valid snapshot price
      price:     (tick.ltp > 0 ? tick.ltp : null) ?? idx.price,
      changePct: tick.changePct ?? idx.changePct,
    };
  });

  const chips = [...mergedIndices, ...mergedIndices]; // duplicate for seamless loop

  return (
    <div className="relative flex items-center overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]/50 px-4 py-2 backdrop-blur-sm">
      <div className="ticker-scroll flex items-center gap-2">
        {chips.map((idx, i) => (
          <IndexChip
            key={`${idx.symbol}-${i}`}
            name={idx.name}
            symbol={idx.symbol}
            price={idx.price}
            changePct={idx.changePct}
          />
        ))}
      </div>
      {/* fade edges */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-12 bg-gradient-to-r from-[var(--color-bg-elevated)] to-transparent" />
      <div className="pointer-events-none absolute right-0 top-0 h-full w-12 bg-gradient-to-l from-[var(--color-bg-elevated)] to-transparent" />
    </div>
  );
}
