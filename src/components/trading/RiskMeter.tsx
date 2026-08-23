"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface RiskMeterProps {
  value: number;         // 0–100
  orientation?: "horizontal" | "vertical";
  showLabel?: boolean;
  className?: string;
}

const SEGMENTS = [
  { threshold: 33,  class: "risk-segment-low",  color: "var(--color-data-positive)" },
  { threshold: 66,  class: "risk-segment-mid",  color: "var(--color-warning)" },
  { threshold: 100, class: "risk-segment-high", color: "var(--color-data-negative)" },
];

function getSegmentIndex(value: number): number {
  if (value <= 33) return 0;
  if (value <= 66) return 1;
  return 2;
}

export function RiskMeter({ value, orientation = "horizontal", showLabel = true, className }: RiskMeterProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const activeIndex = getSegmentIndex(clamped);
  const { color: activeColor } = SEGMENTS[activeIndex];

  if (orientation === "vertical") {
    return (
      <div className={cn("flex flex-col items-center gap-1.5", className)}>
        <div className="flex flex-col-reverse gap-1 w-3" style={{ height: "80px" }}>
          {SEGMENTS.map((seg, i) => (
            <div
              key={seg.class}
              data-active-segment={i === activeIndex ? "" : undefined}
              className={cn("flex-1 rounded-full transition-opacity duration-300", i === activeIndex ? seg.class : "")}
              style={{
                backgroundColor: i <= activeIndex ? seg.color : "var(--color-panel-border)",
                opacity: i <= activeIndex ? 1 : 0.3,
              }}
            />
          ))}
        </div>
        {showLabel && (
          <span className="text-xs tabular-nums font-medium" style={{ color: activeColor, fontFamily: "var(--font-data)" }}>
            {clamped}%
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex gap-1">
        {SEGMENTS.map((seg, i) => {
          const segWidth = i === 0 ? 33 : i === 1 ? 33 : 34; // % widths
          const fillPct = i < activeIndex
            ? 100
            : i === activeIndex
            ? Math.min(100, ((clamped - (i === 0 ? 0 : i === 1 ? 33 : 66)) / segWidth) * 100)
            : 0;
          return (
            <div
              key={seg.class}
              className="relative flex-1 overflow-hidden rounded-full"
              style={{ height: "6px", backgroundColor: "var(--color-panel-border)" }}
            >
              <div
                data-active-segment={i === activeIndex ? "" : undefined}
                className={cn("h-full rounded-full transition-all duration-300", i === activeIndex ? seg.class : "")}
                style={{ width: `${fillPct}%`, backgroundColor: seg.color }}
              />
            </div>
          );
        })}
      </div>
      {showLabel && (
        <span className="text-xs tabular-nums font-medium" style={{ color: activeColor, fontFamily: "var(--font-data)" }}>
          Risk: {clamped}%
        </span>
      )}
    </div>
  );
}
