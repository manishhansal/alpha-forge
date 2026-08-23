/**
 * Shared formatting utilities for WhatsApp trading notification messages.
 *
 * All price values use Indian comma notation (rightmost group of 3, then
 * groups of 2 from right). All timestamps are in IST (UTC+5:30).
 *
 * Index instrument catalog is sourced from the existing FNO_INDICES constant
 * in `src/lib/india/fno-symbols.ts` (single source of truth). Lot sizes are
 * sourced from `INDEX_LOT_SIZE` in the daily-picks option-projection module.
 */

import { FNO_INDICES, SUPPLEMENTARY_INDICES } from "@/lib/india/fno-symbols";
import { INDEX_LOT_SIZE } from "@/features/india/daily-picks/option-projection";

// ─── Index symbol catalog ────────────────────────────────────────────────────

/**
 * Set of all known NSE/BSE index underlying names that the platform tracks.
 * Combines F&O-eligible indices (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY)
 * with supplementary broad-market indices (SENSEX, INDIA VIX).
 *
 * Used by `isIndexSymbol` to decide whether to render integer-only prices
 * and include lot-size information in notification messages.
 */
const INDEX_SYMBOL_SET: ReadonlySet<string> = new Set([
  // F&O index underlyings from the canonical catalog
  ...FNO_INDICES.map((i) => i.underlying),
  // Supplementary indices (SENSEX, INDIA VIX) by their display name
  ...SUPPLEMENTARY_INDICES.map((i) => i.name.toUpperCase()),
  // Canonical short names for supplementary indices
  "SENSEX",
  "INDIAVIX",
  "INDIA VIX",
]);

// ─── Indian number notation ──────────────────────────────────────────────────

/**
 * Format an integer part using Indian comma grouping:
 *   rightmost group of 3 digits, then groups of 2 from right.
 *
 * Examples:
 *   formatIndianInt(23450)   → "23,450"
 *   formatIndianInt(123456)  → "1,23,456"
 *   formatIndianInt(1234567) → "12,34,567"
 *   formatIndianInt(99)      → "99"
 */
function formatIndianInt(n: number): string {
  // Work with the integer part only
  const intStr = Math.floor(Math.abs(n)).toString();

  if (intStr.length <= 3) return intStr;

  // Last 3 digits form the first group from the right
  const lastThree = intStr.slice(-3);
  const remaining = intStr.slice(0, -3);

  if (remaining.length === 0) return lastThree;

  // Remaining digits are grouped in pairs from right
  const pairs: string[] = [];
  let i = remaining.length;
  while (i > 0) {
    const start = Math.max(0, i - 2);
    pairs.unshift(remaining.slice(start, i));
    i = start;
  }

  return pairs.join(",") + "," + lastThree;
}

/**
 * Format a price value with Indian rupee notation.
 *
 * - Index instruments (`isIndex: true`): no decimal places, integer-only
 *   (e.g. NIFTY at 23450 → "₹23,450")
 * - Equity instruments (`isIndex: false`): always 2 decimal places
 *   (e.g. RELIANCE at 2345.5 → "₹2,345.50")
 *
 * Uses Indian comma grouping: rightmost group of 3, then groups of 2.
 *
 * @param price - The price value (must be non-negative for typical use)
 * @param isIndex - Whether the instrument is an NSE index
 */
export function formatINR(price: number, isIndex: boolean): string {
  if (!Number.isFinite(price)) {
    return `₹${isIndex ? "0" : "0.00"}`;
  }

  const absPrice = Math.abs(price);
  const sign = price < 0 ? "-" : "";

  if (isIndex) {
    // Integer-only notation for index instruments
    return `${sign}₹${formatIndianInt(absPrice)}`;
  }

  // Two-decimal notation for equity instruments
  const integerPart = Math.floor(absPrice);
  const decimalPart = Math.round((absPrice - integerPart) * 100);
  const decStr = decimalPart.toString().padStart(2, "0");

  return `${sign}₹${formatIndianInt(integerPart)}.${decStr}`;
}

// ─── IST timestamp formatting ─────────────────────────────────────────────────

/** IST offset in milliseconds: UTC+5:30 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Short month names for date formatting */
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Convert a Unix epoch (milliseconds) to an IST Date object.
 * Returns a Date whose UTC fields represent the IST wall-clock time.
 */
function toISTDate(epochMs: number): Date {
  return new Date(epochMs + IST_OFFSET_MS);
}

/**
 * Format a Unix epoch timestamp as "DD-Mon-YYYY HH:MM IST".
 *
 * Example: 1737007500000 → "16-Jan-2025 09:15 IST"
 *
 * The time component is always exactly UTC+5:30 ahead of the UTC time
 * encoded in the epoch.
 *
 * @param epochMs - Unix timestamp in milliseconds
 */
export function formatISTDateTime(epochMs: number): string {
  const d = toISTDate(epochMs);

  const day = d.getUTCDate().toString().padStart(2, "0");
  const month = MONTH_NAMES[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hours = d.getUTCHours().toString().padStart(2, "0");
  const minutes = d.getUTCMinutes().toString().padStart(2, "0");

  return `${day}-${month}-${year} ${hours}:${minutes} IST`;
}

/**
 * Format a Unix epoch timestamp as "HH:MM IST" (intraday short form).
 *
 * Example: 1737007500000 → "09:15 IST"
 *
 * @param epochMs - Unix timestamp in milliseconds
 */
export function formatISTTime(epochMs: number): string {
  const d = toISTDate(epochMs);

  const hours = d.getUTCHours().toString().padStart(2, "0");
  const minutes = d.getUTCMinutes().toString().padStart(2, "0");

  return `${hours}:${minutes} IST`;
}

// ─── Duration formatting ─────────────────────────────────────────────────────

/**
 * Format the duration between two epoch timestamps as "Xh Ym".
 *
 * Always shows both hours and minutes. If the duration is less than 1 hour,
 * hours is "0h". Minutes are always shown (e.g. "0h 5m", "1h 0m", "2h 30m").
 *
 * @param fromMs - Start time in Unix milliseconds
 * @param toMs   - End time in Unix milliseconds
 */
export function formatDuration(fromMs: number, toMs: number): string {
  const diffMs = Math.abs(toMs - fromMs);
  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}h ${minutes}m`;
}

// ─── Message footer ───────────────────────────────────────────────────────────

/**
 * Standard footer appended to every WhatsApp notification message.
 * Uses the current IST wall-clock time at the moment of call.
 *
 * Format: "AlphaForge • NSE F&O • HH:MM IST"
 */
export function messageFooter(): string {
  const timeStr = formatISTTime(Date.now());
  return `AlphaForge • NSE F&O • ${timeStr}`;
}

// ─── Action emoji ─────────────────────────────────────────────────────────────

/**
 * Map a trade action string to its header emoji.
 *
 * - LONG / BUY → 🟢
 * - SHORT / SELL → 🔴
 * - Any other value → empty string (defensive fallback)
 *
 * @param action - Trade action (case-insensitive)
 */
export function actionEmoji(action: string): string {
  const upper = action.toUpperCase();
  if (upper === "LONG" || upper === "BUY") return "🟢";
  if (upper === "SHORT" || upper === "SELL") return "🔴";
  return "";
}

// ─── Index symbol detection ───────────────────────────────────────────────────

/**
 * Returns `true` when `symbol` is a known NSE/BSE index underlying name.
 *
 * The check is case-insensitive and covers:
 * - All F&O index underlyings from `FNO_INDICES` (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY)
 * - Supplementary indices (SENSEX, INDIA VIX)
 *
 * Used to determine price formatting (integer vs 2-decimal) and whether to
 * include lot-size information in notification messages.
 *
 * @param symbol - NSE/BSE instrument symbol or underlying name
 */
export function isIndexSymbol(symbol: string): boolean {
  return INDEX_SYMBOL_SET.has(symbol.toUpperCase());
}

// ─── Lot size lookup ──────────────────────────────────────────────────────────

/**
 * Return the standard NSE F&O lot size for a known index underlying.
 * Returns `undefined` for equity symbols or unknown identifiers.
 *
 * Lot sizes are sourced from `INDEX_LOT_SIZE` in the option-projection
 * module (the existing platform source of truth):
 *   NIFTY=75, BANKNIFTY=30, FINNIFTY=65, MIDCPNIFTY=120
 *
 * @param symbol - NSE index underlying name (e.g. "NIFTY", "BANKNIFTY")
 */
export function lotSizeFor(symbol: string): number | undefined {
  const upper = symbol.toUpperCase();
  const size = INDEX_LOT_SIZE[upper];
  return size !== undefined ? size : undefined;
}

// ─── Scanner type labels ──────────────────────────────────────────────────────

/**
 * Human-readable labels for the six NSE F&O scanner types.
 * Maps internal hyphen-case type keys to display strings.
 */
const SCANNER_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "range-expansion": "Range Expansion",
  "momentum": "Momentum",
  "volume-breakout": "Volume Breakout",
  "oi-buildup": "OI Build-up",
  "pcr": "PCR",
  "iv-spike": "IV Spike",
});

/**
 * Return the human-readable label for a scanner type.
 *
 * Maps internal type keys (e.g. "oi-buildup") to display strings
 * (e.g. "OI Build-up"). Falls back to the raw type string if the key is
 * not in the catalog, so new scanner types degrade gracefully.
 *
 * @param type - Internal scanner type key
 */
export function scannerTypeLabel(type: string): string {
  return SCANNER_TYPE_LABELS[type] ?? type;
}
