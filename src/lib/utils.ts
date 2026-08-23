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

/**
 * Format an epoch-ms timestamp as a wall-clock time string.
 * Uses the viewer's LOCAL timezone but pins en-GB locale (24h, no AM/PM)
 * so the output is identical on Node.js server and browser.
 * Safe to call in both SSR and client contexts.
 *
 * Output: "HH:MM:SS"  e.g. "13:28:06"
 */
export function fmtTime(ts: number | string | Date | null | undefined): string {
  if (ts == null) return "—";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-GB"); // en-GB always 24h: "13:28:06"
}

/**
 * Format an epoch-ms timestamp as a compact date+time string.
 * Pins en-GB locale so output matches between server and browser.
 *
 * Output: "DD/MM/YYYY, HH:MM:SS"  e.g. "15/08/2025, 13:28:06"
 */
export function fmtDateTime(ts: number | string | Date | null | undefined): string {
  if (ts == null) return "—";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB"); // en-GB: always 24h, DD/MM/YYYY
}
