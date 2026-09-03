/**
 * DataSourceBadge — pill-shaped indicator showing the currently-active
 * market data provider and its most recent call latency.
 *
 * Polls `GET /api/in/provider-health` 30 seconds after each response
 * (not on a fixed interval). Renders nothing until a valid provider
 * name is received, and renders nothing when the provider is unknown.
 *
 * Cancels the in-flight request via AbortController on unmount to
 * prevent state updates on unmounted components.
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.6, 12.7, 12.8
 */

"use client";

import * as React from "react";
import type { ProviderId } from "@/lib/market-data/types";

// ── Types ────────────────────────────────────────────────────────────────────

/** Shape returned by GET /api/in/provider-health */
type ProviderHealthMap = Record<string, { available: boolean; latency_ms: number }>;

/** The ordered priority list used to select the "active" provider. */
const PROVIDER_PRIORITY: readonly ProviderId[] = [
  "scrapling",
  "angel_one",
  "upstox",
  "nse",
  "yahoo",
];

/**
 * Background colour (as a CSS variable) for each known provider.
 * Requirement 12.2:
 *   scrapling / angel_one → var(--color-data-positive)
 *   upstox / nse          → var(--color-data-neutral)
 *   yahoo                 → var(--color-data-negative)
 */
const PROVIDER_BG: Record<ProviderId, string> = {
  scrapling:  "var(--color-data-positive)",
  angel_one:  "var(--color-data-positive)",
  upstox:     "var(--color-data-neutral)",
  nse:        "var(--color-data-neutral)",
  yahoo:      "var(--color-data-negative)",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Converts a provider identifier to a human-readable title-case string.
 * Underscores are replaced with spaces and each word is capitalised.
 *   "angel_one"  → "Angel One"
 *   "scrapling"  → "Scrapling"
 *   "nse"        → "Nse"   (kept intentionally per spec — raw title-case)
 */
function toTitleCase(id: string): string {
  return id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Returns the active provider from a health map.
 * "Active" means `available: true` AND earliest in PROVIDER_PRIORITY order.
 * Returns `null` when no provider is available.
 */
function resolveActiveProvider(
  health: ProviderHealthMap,
): { id: ProviderId; latency_ms: number } | null {
  for (const id of PROVIDER_PRIORITY) {
    const entry = health[id];
    if (entry?.available === true) {
      return { id, latency_ms: Math.max(0, Math.floor(entry.latency_ms)) };
    }
  }
  return null;
}

// ── Component ────────────────────────────────────────────────────────────────

interface ActiveProvider {
  id: ProviderId;
  latency_ms: number;
}

/**
 * Pill-shaped badge displaying the active market-data provider.
 *
 * Renders as a `<span>` with no wrapper element when not ready or
 * when the provider is unknown — the parent layout is unaffected.
 */
export function DataSourceBadge(): React.ReactElement | null {
  const [active, setActive] = React.useState<ActiveProvider | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const abortRef = { controller: new AbortController() };

    async function poll(): Promise<void> {
      // Create a fresh AbortController for each request.
      abortRef.controller = new AbortController();

      try {
        const res = await fetch("/api/in/provider-health", {
          signal: abortRef.controller.signal,
        });

        if (!res.ok || cancelled) return;

        const data: ProviderHealthMap = await res.json();
        if (cancelled) return;

        const resolved = resolveActiveProvider(data);

        // Requirement 12.7: unknown provider → render nothing (set null)
        if (resolved !== null) {
          setActive(resolved);
        } else {
          setActive(null);
        }
      } catch {
        // AbortError on unmount — ignore. Other errors → skip this cycle.
      }

      if (!cancelled) {
        // Requirement 12.6: next poll 30 seconds AFTER the response,
        // not on a fixed clock interval.
        timeoutId = setTimeout(poll, 30_000);
      }
    }

    // Start the first poll immediately.
    poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      abortRef.controller.abort();
    };
  }, []);

  // Requirement 12.3 / 12.7: render nothing when provider is unknown or pending.
  if (active === null) return null;

  const bgColor = PROVIDER_BG[active.id];
  const label = `${toTitleCase(active.id)} ● ${active.latency_ms}ms`;

  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium text-white"
      style={{ backgroundColor: bgColor }}
      data-testid="data-source-badge"
      data-provider={active.id}
      title={`Active market data provider: ${toTitleCase(active.id)}`}
      aria-label={`Market data provider: ${label}`}
    >
      {label}
    </span>
  );
}
