"use client";

import { useEffect, useState } from "react";

import { useActiveMarket } from "@/lib/market-mode";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { useMarketStore } from "@/store/marketStore";

const COPY: Record<string, { label: string; tone: "bull" | "bear" | "warning" | "muted" }> = {
  open: { label: "Live", tone: "bull" },
  connecting: { label: "Connecting", tone: "warning" },
  closed: { label: "Reconnecting", tone: "warning" },
  error: { label: "Error", tone: "bear" },
  idle: { label: "Idle", tone: "muted" },
};

const TONE_CLASSES: Record<string, string> = {
  bull: "bg-[color-mix(in_oklch,var(--color-bull)_15%,transparent)] text-[var(--color-bull)] ring-[color-mix(in_oklch,var(--color-bull)_30%,transparent)]",
  bear: "bg-[color-mix(in_oklch,var(--color-bear)_15%,transparent)] text-[var(--color-bear)] ring-[color-mix(in_oklch,var(--color-bear)_30%,transparent)]",
  warning: "bg-[color-mix(in_oklch,var(--color-warning)_15%,transparent)] text-[var(--color-warning)] ring-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]",
  muted: "bg-[var(--color-surface)] text-[var(--color-fg-muted)] ring-[var(--color-border)]",
};

// India is poll-based (15s snapshot cadence). Anything fresher than this is
// "Live"; older than 2× the cadence is "Reconnecting".
const INDIA_LIVE_MS = 25_000;
const INDIA_STALE_MS = 60_000;

function useIndiaStatus(): keyof typeof COPY {
  const fetchedAt = useIndiaMarketStore((s) => s.snapshot?.fetchedAt);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);

  if (!fetchedAt) return "connecting";
  const age = now - new Date(fetchedAt).getTime();
  if (age <= INDIA_LIVE_MS) return "open";
  if (age <= INDIA_STALE_MS) return "closed";
  return "error";
}

export function ConnectionPill() {
  const market = useActiveMarket();
  const cryptoStatus = useMarketStore((s) => s.wsStatus);
  const indiaStatus = useIndiaStatus();

  const status = market === "india" ? indiaStatus : cryptoStatus;
  const meta = COPY[status] ?? COPY.idle;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${TONE_CLASSES[meta.tone]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          meta.tone === "bull"
            ? "bg-[var(--color-bull)] shadow-[0_0_8px_var(--color-bull)]"
            : meta.tone === "bear"
              ? "bg-[var(--color-bear)]"
              : meta.tone === "warning"
                ? "bg-[var(--color-warning)] animate-pulse"
                : "bg-[var(--color-fg-subtle)]"
        }`}
      />
      {meta.label}
    </span>
  );
}
