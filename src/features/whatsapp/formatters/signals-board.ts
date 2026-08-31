/**
 * WhatsApp message formatter for Signals Board notifications.
 *
 * Formats `SIGNALS_BOARD_NEW` events — emitted when a unified Signals Board
 * entry has a strength score above the 70th percentile of the current feed.
 *
 * Message layout:
 *   {emoji} {SYMBOL} — {DIRECTION}
 *   {exchange} • {sourceTypeLabel}
 *
 *   Price:   ₹{price}
 *   Change:  {±changePct}%
 *   Signal:  {keyMetric}
 *
 *   Detected: {HH:MM IST}
 *
 *   AlphaForge • NSE F&O • {HH:MM IST}
 *
 * Requirements: 7.2, 7.4, 9.1–9.5
 */

import type { SignalsBoardEvent } from "@/features/whatsapp/types";
import {
  actionEmoji,
  formatINR,
  formatISTTime,
  isIndexSymbol,
  messageFooter,
  scannerTypeLabel,
} from "./shared";

/**
 * Format a `SIGNALS_BOARD_NEW` notification event into a WhatsApp message string.
 *
 * Includes:
 * - Header: direction emoji + symbol + direction label (Requirement 7.2)
 * - Exchange and human-readable source type label (Requirements 7.2, 9.3)
 * - Current price in ₹ with Indian notation (Requirements 7.2, 9.1–9.2)
 * - Day change percentage with explicit sign (Requirement 7.2)
 * - Key metric value (Requirement 7.2)
 * - IST detection time in `HH:MM IST` format (Requirement 7.4)
 * - Standard footer `AlphaForge • NSE F&O • HH:MM IST` (Requirement 9.5)
 *
 * @param event - The `SIGNALS_BOARD_NEW` notification event
 * @returns Formatted WhatsApp message string
 */
export function formatSignalsBoardMessage(event: SignalsBoardEvent): string {
  const { entry } = event;
  const { symbol, exchange, sourceType, direction, price, changePct, keyMetric } = entry;

  const emoji = actionEmoji(direction);
  const sourceLabel = scannerTypeLabel(sourceType);
  const priceStr = formatINR(price, isIndexSymbol(symbol));

  // Format day change with explicit sign
  const sign = changePct >= 0 ? "+" : "";
  const changeStr = `${sign}${changePct.toFixed(2)}%`;

  // IST detection time (current wall-clock time, Requirement 7.4)
  const detectedAt = formatISTTime(Date.now());

  const lines: string[] = [
    `${emoji} ${symbol} — ${direction}`,
    `${exchange} • ${sourceLabel}`,
    ``,
    `Price:    ${priceStr}`,
    `Change:   ${changeStr}`,
    `Signal:   ${keyMetric}`,
    ``,
    `Detected: ${detectedAt}`,
    ``,
    messageFooter(),
  ];

  return lines.join("\n");
}
