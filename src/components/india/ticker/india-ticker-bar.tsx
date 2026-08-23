"use client";

import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useFetchPoll, getJson } from "@/hooks/india/useFetchPoll";
import { fmt, fmtPct } from "@/lib/india/format";
import { cn } from "@/lib/utils";
import type { Snapshot } from "@/types/india";

const ACCENT: Record<string, string> = {
  "NIFTY 50":      "#10b981",
  "BANK NIFTY":    "#f59e0b",
  "FIN NIFTY":     "#8b5cf6",
  "MIDCAP NIFTY":  "#06b6d4",
  SENSEX:          "#3b82f6",
  "INDIA VIX":     "#ef4444",
};

const isVix = (name: string) => name.toUpperCase().includes("VIX");

function IndexChip({
  name,
  symbol,
  price,
  changePct,
}: {
  name: string;
  symbol: string;
  price: number | null;
  changePct: number | null;
}) {
  const pct     = changePct ?? 0;
  const vix     = isVix(name);
  const positive = vix ? pct < 0 : pct >= 0;
  const dot     = ACCENT[name] ?? "#64748b";

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
  const setSnapshot = useIndiaMarketStore((s) => s.setSnapshot);

  useFetchPoll<Snapshot>(
    (signal) => getJson<Snapshot>("/api/in/market-snapshot", signal),
    (data)   => setSnapshot(data),
    { intervalMs: 15_000 },
    [],
  );

  const indices = snapshot?.indices ?? [];

  if (indices.length === 0) {
    return (
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]/50 px-4 py-2">
        {/* skeleton chips */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-7 w-24 animate-pulse rounded-lg bg-[var(--color-surface)]" />
        ))}
      </div>
    );
  }

  const chips = [...indices, ...indices]; // duplicate for seamless loop

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
