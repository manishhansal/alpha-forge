import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { getStrategyMeta } from "@/features/scalping/strategies/catalog";
import type {
  PaperTradeStatus,
  ScalpStrategyId,
  ScalpTimeframe,
} from "@/features/scalping/types";

/**
 * Compact strategy chip used in the open-positions and journal tables —
 * shows the strategy label plus the bar timeframe the trade was opened
 * on. Kept in a shared file so the two card components stay in sync if
 * we tweak the chip later.
 */
export function StrategyChip({
  strategyId,
  timeframe,
}: {
  strategyId: ScalpStrategyId;
  timeframe: ScalpTimeframe;
}) {
  const meta = getStrategyMeta(strategyId);
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
      title={`${meta.label} · ${meta.description}`}
    >
      <Badge variant={meta.badge} className="whitespace-nowrap px-1.5 py-0.5">
        <span className="whitespace-nowrap text-[10px] uppercase tracking-wider leading-none">
          {meta.label}
        </span>
      </Badge>
      <span className="text-[10px] font-mono uppercase text-[var(--color-fg-subtle)]">
        {timeframe}
      </span>
    </span>
  );
}

export function statusBadge(status: PaperTradeStatus) {
  switch (status) {
    case "OPEN":
      return <Badge variant="info">Open</Badge>;
    case "WIN":
      return <Badge variant="bull">Win</Badge>;
    case "LOSS":
      return <Badge variant="bear">Loss</Badge>;
    case "EXPIRED":
      return <Badge variant="warning">Expired</Badge>;
    case "CANCELLED":
      return <Badge variant="outline">Cancelled</Badge>;
  }
}

export function pnlClass(n: number | null): string {
  if (n === null || n === 0) return "text-[var(--color-fg-muted)]";
  return n > 0 ? "text-[var(--color-bull)] num" : "text-[var(--color-bear)] num";
}

export function Th({
  children,
  align,
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align,
  className,
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-2 ${align === "right" ? "text-right num" : "text-left"} ${className ?? ""}`}
    >
      {children}
    </td>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-[var(--color-fg-muted)]">
      <span className="uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[11px] text-[var(--color-fg)]"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
