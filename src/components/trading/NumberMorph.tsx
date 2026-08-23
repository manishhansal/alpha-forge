"use client";

import * as React from "react";
import { useMotionValue, animate, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface NumberMorphProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
  /** Duration override in ms — if omitted, computed from change magnitude. */
  duration?: number;
}

/**
 * Compute animation duration based on percentage change magnitude.
 * Exported for testability (Property 5).
 */
export function durationFor(prev: number, next: number): number {
  if (prev === 0) return 240;
  const change = Math.abs((next - prev) / prev);
  if (change < 0.01) return 120;
  if (change < 0.10) return 240;
  return 360;
}

export function NumberMorph({
  value,
  prefix = "",
  suffix = "",
  decimals = 2,
  className,
  duration,
}: NumberMorphProps) {
  const reducedMotion = useReducedMotion();
  const motionValue = useMotionValue(value);
  const displayRef = React.useRef<HTMLSpanElement>(null);
  const prevValueRef = React.useRef<number>(value);

  React.useEffect(() => {
    const prev = prevValueRef.current;
    const animDuration = reducedMotion
      ? 0
      : (duration ?? durationFor(prev, value)) / 1000; // framer uses seconds

    const controls = animate(motionValue, value, {
      duration: animDuration,
      ease: "easeOut",
      onUpdate: (latest) => {
        if (displayRef.current) {
          displayRef.current.textContent =
            prefix + latest.toFixed(decimals) + suffix;
        }
      },
    });

    prevValueRef.current = value;
    return () => controls.stop();
  }, [value, decimals, prefix, suffix, duration, reducedMotion, motionValue]);

  return (
    <span
      ref={displayRef}
      data-testid="number-morph-display"
      className={cn("tabular-nums", className)}
      style={{ fontFamily: "var(--font-data)" }}
    >
      {prefix}{value.toFixed(decimals)}{suffix}
    </span>
  );
}
