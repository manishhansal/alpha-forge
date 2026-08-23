"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface BentoGridProps {
  children: React.ReactNode;
  /** Number of columns (default: 12) */
  cols?: number;
  /** Tailwind gap class (default: "gap-4") */
  gap?: string;
  className?: string;
}

/**
 * A 12-column CSS grid container for Bento-style dashboard layouts.
 * Below 768px, all BentoCell children reflow to full-width stacked layout
 * via the `[data-bento-cell]` CSS rule in globals.css.
 */
export function BentoGrid({ children, cols = 12, gap = "gap-4", className }: BentoGridProps) {
  return (
    <div
      className={cn("grid w-full", gap, className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  );
}

export interface BentoCellProps {
  /** Columns to span (1–12). On mobile (<768px), always full width. */
  colSpan?: number;
  /** Rows to span (default: 1) */
  rowSpan?: number;
  className?: string;
  children: React.ReactNode;
}

export function BentoCell({ colSpan = 1, rowSpan = 1, className, children }: BentoCellProps) {
  return (
    <div
      data-bento-cell
      className={cn("min-w-0", className)}
      style={{
        gridColumn: `span ${colSpan}`,
        gridRow: rowSpan > 1 ? `span ${rowSpan}` : undefined,
      }}
    >
      {children}
    </div>
  );
}
