"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface ConfidenceBarProps {
  value: number;        // 0–100
  showLabel?: boolean;
  height?: number;      // px, default 6
  className?: string;
  loading?: boolean;
}

export function ConfidenceBar({
  value,
  showLabel = false,
  height = 6,
  className,
  loading = false,
}: ConfidenceBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  if (loading) {
    return (
      <div
        className={cn("animate-pulse rounded-full bg-[var(--color-surface)]", className)}
        style={{ height: `${height}px`, width: "100%" }}
        aria-hidden="true"
      />
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        className="relative flex-1 overflow-hidden rounded-full"
        style={{
          height: `${height}px`,
          backgroundColor: "color-mix(in oklch, var(--data-neutral) 20%, transparent)",
        }}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Confidence: ${clamped}%`}
      >
        <div
          data-testid="confidence-bar-fill"
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${clamped}%`,
            background: `linear-gradient(90deg, var(--color-data-neutral), color-mix(in oklch, var(--data-positive) ${clamped}%, var(--data-neutral)))`,
          }}
        />
      </div>
      {showLabel && (
        <span
          className="text-xs tabular-nums"
          style={{ color: "var(--color-fg-muted)", fontFamily: "var(--font-data)" }}
        >
          {clamped}
        </span>
      )}
    </div>
  );
}
