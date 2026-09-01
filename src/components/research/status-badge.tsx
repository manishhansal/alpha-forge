"use client";

import { cn } from "@/lib/utils";
import type { StrategyLifecycleStatus, ConfidenceBand, DecayState } from "@/lib/research/types";

const STATUS_CONFIG: Record<StrategyLifecycleStatus, { label: string; color: string }> = {
  EXPERIMENTAL: { label: "Experimental", color: "#6b7280" },
  RESEARCH: { label: "Research", color: "#3b82f6" },
  BACKTEST_VALIDATED: { label: "Backtest ✓", color: "#6366f1" },
  WALK_FORWARD_VALIDATED: { label: "Walk-Fwd ✓", color: "#8b5cf6" },
  SHADOW: { label: "Shadow", color: "#a78bfa" },
  PAPER: { label: "Paper", color: "#22c55e" },
  LIVE_CANDIDATE: { label: "Live Candidate", color: "#f59e0b" },
  MANUAL_APPROVAL: { label: "Awaiting Approval", color: "#f97316" },
  LIVE: { label: "LIVE", color: "#ef4444" },
  WARNING: { label: "Warning", color: "#fbbf24" },
  DEGRADED: { label: "Degraded", color: "#f97316" },
  DISABLED: { label: "Disabled", color: "#9ca3af" },
};

export function StatusBadge({ status, className }: { status: StrategyLifecycleStatus; className?: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.EXPERIMENTAL;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        className,
      )}
      style={{
        color: cfg.color,
        backgroundColor: `${cfg.color}18`,
        ringColor: `${cfg.color}40`,
      }}
    >
      {cfg.label}
    </span>
  );
}

const CONFIDENCE_CONFIG: Record<ConfidenceBand, { label: string; color: string }> = {
  HIGH_CONFIDENCE: { label: "High Confidence", color: "#22c55e" },
  VALIDATED: { label: "Validated", color: "#3b82f6" },
  WATCH: { label: "Watch", color: "#f59e0b" },
  DEGRADED: { label: "Degraded", color: "#f97316" },
  DISABLED: { label: "Disabled", color: "#9ca3af" },
};

export function ConfidenceBadge({ band, score, className }: { band: ConfidenceBand; score?: number; className?: string }) {
  const cfg = CONFIDENCE_CONFIG[band] ?? CONFIDENCE_CONFIG.WATCH;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-mono font-medium", className)}
      style={{ color: cfg.color, backgroundColor: `${cfg.color}18` }}
    >
      {score !== undefined && <span className="font-bold">{score}</span>}
      <span>{cfg.label}</span>
    </span>
  );
}

const DECAY_CONFIG: Record<DecayState, { label: string; color: string; icon: string }> = {
  HEALTHY: { label: "Healthy", color: "#22c55e", icon: "●" },
  WARNING: { label: "Warning", color: "#fbbf24", icon: "▲" },
  DEGRADED: { label: "Degraded", color: "#f97316", icon: "▼" },
  CRITICAL: { label: "Critical", color: "#ef4444", icon: "✕" },
  DISABLED: { label: "Disabled", color: "#9ca3af", icon: "—" },
};

export function DecayStateBadge({ state, className }: { state: DecayState; className?: string }) {
  const cfg = DECAY_CONFIG[state] ?? DECAY_CONFIG.WARNING;
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs font-medium", className)}
      style={{ color: cfg.color }}
    >
      <span aria-hidden="true">{cfg.icon}</span>
      {cfg.label}
    </span>
  );
}
