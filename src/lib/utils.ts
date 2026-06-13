import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return compactFormatter.format(value);
}

export function formatPrice(value: number, opts?: { minimumFractionDigits?: number; maximumFractionDigits?: number }): string {
  if (!Number.isFinite(value)) return "—";
  const min = opts?.minimumFractionDigits ?? (value >= 1000 ? 2 : value >= 1 ? 4 : 6);
  const max = opts?.maximumFractionDigits ?? min;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(value);
}

export function formatPercent(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(fractionDigits)}%`;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${formatPrice(value)}`;
}

export function classifyChange(change: number): "bull" | "bear" | "neutral" {
  if (change > 0.05) return "bull";
  if (change < -0.05) return "bear";
  return "neutral";
}
