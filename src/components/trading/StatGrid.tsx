"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface StatItem {
  label: string;
  value: string | number;
  positive?: boolean;
  negative?: boolean;
  className?: string;
}

export interface StatGridProps {
  items: StatItem[];
  cols: 2 | 3 | 4;
  className?: string;
  loading?: boolean;
}

const COL_CLASSES = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
} as const;

export function StatGrid({ items, cols, className, loading = false }: StatGridProps) {
  if (loading) {
    return (
      <div className={cn("grid gap-3", COL_CLASSES[cols], className)}>
        {Array.from({ length: cols * 2 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <div className="h-2.5 w-12 animate-pulse rounded bg-[var(--color-surface)]" />
            <div className="h-4 w-16 animate-pulse rounded bg-[var(--color-surface)]" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("grid gap-3", COL_CLASSES[cols], className)}>
      {items.map((item, i) => (
        <div key={i} className={cn("space-y-0.5", item.className)}>
          <p
            className="text-[10px] uppercase tracking-widest"
            style={{ color: "var(--color-fg-subtle)", fontFamily: "var(--font-label)" }}
          >
            {item.label}
          </p>
          <p
            className="text-sm font-medium tabular-nums"
            style={{
              fontFamily: "var(--font-data)",
              color: item.positive
                ? "var(--color-data-positive)"
                : item.negative
                ? "var(--color-data-negative)"
                : "var(--color-fg)",
            }}
          >
            {typeof item.value === "number" ? item.value.toString() : item.value}
          </p>
        </div>
      ))}
    </div>
  );
}
