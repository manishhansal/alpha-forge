"use client";

import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useFetchPoll, getJson } from "@/hooks/india/useFetchPoll";
import { fmt, fmtPct } from "@/lib/india/format";
import type { Snapshot } from "@/types/india";

// Tiny dot accent per index — same intent as the crypto ticker's per-symbol
// brand color, just hard-coded since the Indian index list is closed.
const ACCENT: Record<string, string> = {
  "NIFTY 50": "#10b981",
  "BANK NIFTY": "#f59e0b",
  "FIN NIFTY": "#8b5cf6",
  "MIDCAP NIFTY": "#06b6d4",
  SENSEX: "#3b82f6",
  "INDIA VIX": "#ef4444",
};

const isVix = (name: string) => name.toUpperCase().includes("VIX");

/**
 * Top-of-page live ticker shown in the dashboard layout whenever the user is
 * inside the Indian-market surface (`/in/*`). It owns the
 * `/api/in/market-snapshot` poll so the bar stays live even on pages that
 * don't otherwise fetch it (Scanner, Option Chain, Watchlist, Chart).
 */
export function IndiaTickerBar() {
  const snapshot = useIndiaMarketStore((s) => s.snapshot);
  const setSnapshot = useIndiaMarketStore((s) => s.setSnapshot);

  useFetchPoll<Snapshot>(
    (signal) => getJson<Snapshot>("/api/in/market-snapshot", signal),
    (data) => setSnapshot(data),
    { intervalMs: 15_000 },
    [],
  );

  const indices = snapshot?.indices ?? [];

  return (
    <div className="flex items-center divide-x divide-[var(--color-border)] overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]/60">
      {indices.length === 0 ? (
        <div className="px-3 py-2 text-xs text-[var(--color-fg-subtle)]">
          Loading Indian indices…
        </div>
      ) : (
        indices.map((idx) => {
          const pct = idx.changePct ?? 0;
          const up = pct >= 0;
          // VIX inverts: rising VIX = risk-off (bad), so flip the tone.
          const positive = isVix(idx.name) ? !up : up;
          const dot = ACCENT[idx.name] ?? "#64748b";
          return (
            <div
              key={idx.symbol}
              className="flex items-center gap-2 px-3 py-2 text-xs whitespace-nowrap"
            >
              <span
                className="inline-flex h-1.5 w-1.5 rounded-full"
                style={{ background: dot }}
              />
              <span className="font-semibold text-[var(--color-fg)]">
                {idx.name}
              </span>
              <span className="num text-[var(--color-fg-muted)]">
                {fmt(idx.price)}
              </span>
              <span
                className={
                  idx.changePct == null
                    ? "num text-[11px] text-[var(--color-fg-subtle)]"
                    : `num text-[11px] ${positive ? "text-bull" : "text-bear"}`
                }
              >
                {idx.changePct == null ? "" : fmtPct(idx.changePct)}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
