"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

const NAV_TABS = [
  { id: "leaderboard", label: "Leaderboard", href: "/research" },
  { id: "strategies", label: "Strategy Inventory", href: "/research/strategies" },
  { id: "regime-matrix", label: "Regime Matrix", href: "/research/regime-matrix" },
  { id: "monte-carlo", label: "Monte Carlo", href: "/research/monte-carlo" },
  { id: "parameter-stability", label: "Parameter Stability", href: "/research/parameter-stability" },
  { id: "signal-calibration", label: "Signal Calibration", href: "/research/signal-calibration" },
  { id: "experiments", label: "Experiments", href: "/research/experiments" },
  { id: "correlation", label: "Correlation", href: "/research/correlation" },
  { id: "promotion-pipeline", label: "Promotion Pipeline", href: "/research/promotion-pipeline" },
  { id: "alpha-decay", label: "Alpha Decay", href: "/research/alpha-decay" },
] as const;

export function ResearchNav({ activeTab }: { activeTab: string }) {
  return (
    <nav
      className="overflow-x-auto"
      aria-label="Research dashboard navigation"
    >
      <div className="flex gap-1 border-b pb-0" style={{ borderColor: "var(--color-border)" }}>
        {NAV_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              className={cn(
                "whitespace-nowrap px-3 py-2 text-sm font-medium rounded-t transition-colors",
                isActive
                  ? "border-b-2 -mb-px text-sm"
                  : "hover:opacity-80",
              )}
              style={
                isActive
                  ? { borderColor: "var(--color-accent)", color: "var(--color-accent)" }
                  : { color: "var(--color-fg-muted)" }
              }
              aria-current={isActive ? "page" : undefined}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
