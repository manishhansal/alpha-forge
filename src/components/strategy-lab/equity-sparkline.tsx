"use client";

import { useMemo } from "react";

import type { EquityPoint } from "@/features/strategy-lab/types";

interface Props {
  curve: EquityPoint[];
  height?: number;
}

/**
 * Minimal SVG sparkline of the equity curve. We avoid pulling in a chart
 * library here because the data is already down-sampled to ≤200 points and
 * the visualisation is purely indicative (the trade table holds the
 * ground truth).
 */
export function EquitySparkline({ curve, height = 120 }: Props) {
  const path = useMemo(() => buildPath(curve, height), [curve, height]);

  if (curve.length < 2) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] text-[11px] text-[var(--color-fg-subtle)]"
        style={{ height }}
      >
        Not enough data points to draw the equity curve.
      </div>
    );
  }

  const start = curve[0].equity;
  const end = curve[curve.length - 1].equity;
  const stroke = end >= start ? "var(--color-bull)" : "var(--color-bear)";
  const fill = end >= start
    ? "color-mix(in oklch, var(--color-bull) 12%, transparent)"
    : "color-mix(in oklch, var(--color-bear) 12%, transparent)";

  return (
    <svg
      viewBox={`0 0 ${path.width} ${path.height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label="Equity curve"
    >
      <path d={path.area} fill={fill} stroke="none" />
      <path d={path.line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
      <line
        x1={0}
        x2={path.width}
        y1={path.zeroY}
        y2={path.zeroY}
        stroke="var(--color-border)"
        strokeDasharray="2 3"
        strokeWidth={1}
      />
    </svg>
  );
}

interface ChartPath {
  width: number;
  height: number;
  line: string;
  area: string;
  zeroY: number;
}

function buildPath(curve: EquityPoint[], height: number): ChartPath {
  const width = 600;
  if (curve.length === 0) return { width, height, line: "", area: "", zeroY: height };
  const ys = curve.map((p) => p.equity);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const start = curve[0].equity;
  const padding = 6;
  const usableH = height - padding * 2;
  const range = Math.max(max - min, 1e-9);

  const x = (i: number) => (curve.length === 1 ? 0 : (i / (curve.length - 1)) * width);
  const y = (v: number) => padding + (1 - (v - min) / range) * usableH;

  let line = `M ${x(0).toFixed(2)} ${y(curve[0].equity).toFixed(2)}`;
  for (let i = 1; i < curve.length; i += 1) {
    line += ` L ${x(i).toFixed(2)} ${y(curve[i].equity).toFixed(2)}`;
  }
  const area =
    line +
    ` L ${x(curve.length - 1).toFixed(2)} ${(height - padding).toFixed(2)}` +
    ` L ${x(0).toFixed(2)} ${(height - padding).toFixed(2)} Z`;

  return { width, height, line, area, zeroY: y(start) };
}
