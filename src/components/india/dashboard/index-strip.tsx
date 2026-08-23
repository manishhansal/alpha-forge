"use client";

import * as React from "react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import { NumberMorph } from "@/components/trading/NumberMorph";
import { cn } from "@/lib/utils";
import type { IndexQuote } from "@/types/india/market";

// ── Mini 20-bar sparkline ──────────────────────────────────────────────────

interface SparklineProps {
  /** 20 data points (or fewer — will be rendered proportionally) */
  values: number[];
  positive: boolean;
  width?: number;
  height?: number;
}

function Sparkline({ values, positive, width = 80, height = 24 }: SparklineProps) {
  if (!values || values.length < 2) {
    // Flat placeholder
    return (
      <svg width={width} height={height} aria-hidden>
        <line
          x1={0} y1={height / 2}
          x2={width} y2={height / 2}
          stroke="var(--color-fg-subtle)"
          strokeWidth={1}
          opacity={0.4}
        />
      </svg>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const color = positive ? "var(--color-data-positive)" : "var(--color-data-negative)";

  return (
    <svg
      width={width}
      height={height}
      aria-label="price sparkline"
      role="img"
      className="overflow-visible"
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Index Strip ───────────────────────────────────────────────────────────

export interface IndexStripProps {
  /** Symbol to show — e.g. "NIFTY 50", "NIFTY BANK", "NIFTY FIN SERVICE" */
  indexName: string;
  /** Short display label */
  label: string;
  /** Pre-computed historical values for sparkline (optional) */
  sparklineValues?: number[];
  className?: string;
}

/**
 * Renders a single index strip with live price, change, and sparkline.
 * Sources data from `useIndiaMarketStore` — no additional fetching.
 */
export function IndexStrip({ indexName, label, sparklineValues, className }: IndexStripProps) {
  const indices = useIndiaMarketStore((s) => s.snapshot?.indices ?? []);

  const idx: IndexQuote | undefined = indices.find(
    (i) => i.name?.toUpperCase() === indexName.toUpperCase(),
  );

  const price = idx?.price ?? 0;
  const change = idx?.change ?? 0;
  const changePct = idx?.changePct ?? 0;
  const positive = changePct >= 0;

  // Fabricate a trivial sparkline from prevClose → price if no real data
  const spark: number[] =
    sparklineValues && sparklineValues.length > 1
      ? sparklineValues
      : idx?.prevClose != null && price > 0
        ? [idx.prevClose, price]
        : [];

  const ArrowIcon = positive ? ArrowUpRight : ArrowDownRight;
  const toneColor = positive ? "var(--color-data-positive)" : "var(--color-data-negative)";

  return (
    <div
      className={cn(
        "flex h-full items-center gap-3 rounded-[var(--radius-panel)] px-4",
        "border border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]",
        className,
      )}
    >
      {/* Label */}
      <div className="min-w-[72px]">
        <p
          className="text-[10px] uppercase tracking-widest"
          style={{ color: "var(--color-fg-subtle)", fontFamily: "var(--font-label)" }}
        >
          {label}
        </p>
      </div>

      {/* Price */}
      <div className="flex-1">
        <NumberMorph
          value={price}
          decimals={2}
          className="text-base font-semibold"
        />
      </div>

      {/* Change */}
      <div
        className="flex items-center gap-1 text-xs font-semibold tabular-nums"
        style={{ color: toneColor }}
      >
        <ArrowIcon size={13} aria-hidden />
        <span>
          {positive ? "+" : ""}{change.toFixed(2)}
          {" "}
          ({positive ? "+" : ""}{changePct.toFixed(2)}%)
        </span>
      </div>

      {/* Sparkline */}
      <div className="shrink-0">
        <Sparkline values={spark} positive={positive} width={72} height={22} />
      </div>
    </div>
  );
}
