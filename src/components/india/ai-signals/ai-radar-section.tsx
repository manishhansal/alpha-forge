"use client";

import * as React from "react";
import { ScanLine } from "lucide-react";
import { AiRadar, type AiRadarRow } from "@/components/trading/AiRadar";
import { useUIStore } from "@/store/uiStore";

// Re-export so existing imports of signalToRadarRow from this file still work.
// The implementation has moved to src/lib/signal-to-radar-row.ts so it can be
// called from server components without crossing the "use client" boundary.
export { signalToRadarRow } from "@/lib/signal-to-radar-row";

// ── Component ─────────────────────────────────────────────────────────────

export interface AiRadarSectionProps {
  /** Pre-mapped radar rows from the server component. Pass [] when not available. */
  rows?: AiRadarRow[];
  loading?: boolean;
}

/**
 * Client component that manages the "Show Radar / Hide Radar" toggle
 * and renders the AiRadar table when visible.
 *
 * Reads/writes `radarVisible` from UIStore so the preference is preserved
 * across navigations within the same session.
 */
export function AiRadarSection({ rows = [], loading = false }: AiRadarSectionProps) {
  const radarVisible = useUIStore((s) => s.radarVisible);
  const toggleRadar = useUIStore((s) => s.toggleRadar);

  return (
    <div className="flex flex-col gap-4">
      {/* Toggle button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScanLine
            className="h-4 w-4"
            style={{ color: "var(--color-ai-accent)" }}
            aria-hidden
          />
          <span
            className="text-sm font-semibold"
            style={{ color: "var(--color-fg)" }}
          >
            AI Stock Radar
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
            style={{
              backgroundColor:
                "color-mix(in oklch, var(--color-ai-accent) 10%, transparent)",
              color: "var(--color-ai-accent)",
              border:
                "1px solid color-mix(in oklch, var(--color-ai-accent) 24%, transparent)",
            }}
          >
            Quick Scan
          </span>
        </div>

        <button
          type="button"
          onClick={toggleRadar}
          className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          style={{
            backgroundColor: radarVisible
              ? "color-mix(in oklch, var(--color-ai-accent) 12%, transparent)"
              : "color-mix(in oklch, var(--color-fg-muted) 8%, transparent)",
            color: radarVisible
              ? "var(--color-ai-accent)"
              : "var(--color-fg-muted)",
            border: `1px solid ${
              radarVisible
                ? "color-mix(in oklch, var(--color-ai-accent) 28%, transparent)"
                : "var(--color-panel-border)"
            }`,
          }}
          aria-pressed={radarVisible}
          aria-label={radarVisible ? "Hide AI Radar" : "Show AI Radar"}
        >
          {radarVisible ? "Hide Radar" : "Show Radar"}
        </button>
      </div>

      {/* Radar table — only mounted when visible */}
      {radarVisible && (
        <AiRadar rows={rows} loading={loading} />
      )}
    </div>
  );
}
