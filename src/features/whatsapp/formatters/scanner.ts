/**
 * WhatsApp message formatters for Scanner Hit notification events.
 *
 * Exports two functions:
 *   - `formatScannerHitMessage`  — single scanner hit (Requirement 6.2)
 *   - `formatScannerBatchMessage` — batch summary when > 5 hits arrive in one
 *     tick (Requirement 6.5, flooding guard from design doc)
 *
 * Both functions include the standard footer (Requirement 9.5) and format
 * prices with `formatINR` / `isIndexSymbol` (Requirements 9.1, 9.2).
 * The human-readable scanner type label is produced by `scannerTypeLabel`
 * (Requirement 6.4).
 */

import type { ScannerHitEvent } from "@/features/whatsapp/types";
import type { ScannerHitSnapshot } from "@/features/whatsapp/types";
import {
  formatINR,
  formatISTTime,
  isIndexSymbol,
  messageFooter,
  scannerTypeLabel,
} from "./shared";

// ─── Single-hit formatter ─────────────────────────────────────────────────────

/**
 * Format a WhatsApp notification for a single scanner hit event.
 *
 * Output shape:
 * ```
 * 📊 Scanner Alert — Range Expansion
 *
 * RELIANCE  •  NSE
 * Price: ₹2,345.50
 * Change: +1.23%
 * OI Change: 12.5%
 *
 * 10:32 IST
 * AlphaForge • NSE F&O • 10:32 IST
 * ```
 *
 * Requirements: 6.2, 6.4, 9.1–9.5
 *
 * @param event - The `SCANNER_HIT_NEW` notification event
 */
export function formatScannerHitMessage(event: ScannerHitEvent): string {
  const { symbol, exchange, scannerType, price, changePct, keyMetric } =
    event.hit;

  const typeLabel = scannerTypeLabel(scannerType);
  const priceStr = formatINR(price, isIndexSymbol(symbol));
  const changePrefix = changePct >= 0 ? "+" : "";
  const changeStr = `${changePrefix}${changePct.toFixed(2)}%`;
  const timeStr = formatISTTime(Date.now());

  const lines: string[] = [
    `📊 Scanner Alert — ${typeLabel}`,
    "",
    `${symbol}  •  ${exchange}`,
    `Price: ${priceStr}`,
    `Change: ${changeStr}`,
    `${keyMetric}`,
    "",
    `${timeStr}`,
    messageFooter(),
  ];

  return lines.join("\n");
}

// ─── Batch summary formatter ──────────────────────────────────────────────────

/**
 * Format a single summary WhatsApp message when more than 5 scanner hits
 * arrive in one tick (flooding guard — Requirement 6.5, design doc §Error Handling).
 *
 * Output shape:
 * ```
 * 📊 Scanner Alert — Range Expansion
 *
 * 6 new hits: RELIANCE, HDFCBANK, TCS, ICICIBANK, WIPRO, INFY
 * NSE
 *
 * 10:32 IST
 * AlphaForge • NSE F&O • 10:32 IST
 * ```
 *
 * Requirements: 6.2, 6.4, 6.5, 9.3–9.5
 *
 * @param hits        - Array of scanner hit snapshots (all of the same type)
 * @param scannerType - The internal scanner type key (e.g. "range-expansion")
 */
export function formatScannerBatchMessage(
  hits: ScannerHitSnapshot[],
  scannerType: string,
): string {
  const typeLabel = scannerTypeLabel(scannerType);
  const symbols = hits.map((h) => h.symbol).join(", ");
  const count = hits.length;

  // Exchange is uniform across a single scanner batch — use the first hit's
  // exchange, defaulting to "NSE" when the array is empty (defensive).
  const exchange = hits[0]?.exchange ?? "NSE";

  const timeStr = formatISTTime(Date.now());

  const lines: string[] = [
    `📊 Scanner Alert — ${typeLabel}`,
    "",
    `${count} new hits: ${symbols}`,
    `${exchange}`,
    "",
    `${timeStr}`,
    messageFooter(),
  ];

  return lines.join("\n");
}
