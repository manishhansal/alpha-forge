"use client";

import { Badge } from "@/components/ui/badge";
import type { StrategyVerdict } from "@/lib/signal-quality/types";

const VERDICT_CONFIG: Record<
  StrategyVerdict,
  { label: string; variant: "bull" | "bear" | "warning" | "info" | "neutral" | "outline" }
> = {
  HIGH_QUALITY:      { label: "High Quality",     variant: "bull"    },
  PROMISING:         { label: "Promising",         variant: "info"    },
  NEEDS_MORE_DATA:   { label: "Needs More Data",   variant: "neutral" },
  WEAK:              { label: "Weak",              variant: "warning" },
  DEGRADED:          { label: "Degraded",          variant: "bear"    },
  DISABLE_CANDIDATE: { label: "Disable Candidate", variant: "bear"    },
};

export function VerdictBadge({ verdict }: { verdict: StrategyVerdict }) {
  const cfg = VERDICT_CONFIG[verdict];
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
