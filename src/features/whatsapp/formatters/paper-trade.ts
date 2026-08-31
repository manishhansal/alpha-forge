/**
 * WhatsApp message formatter for Paper Trading notification events.
 *
 * Handles four event types:
 *   - PAPER_TRADE_OPENED  → position entry details
 *   - PAPER_TRADE_WIN     → closed at profit
 *   - PAPER_TRADE_LOSS    → closed at loss
 *   - PAPER_TRADE_EXPIRED → position expired before hitting SL or TP
 *
 * Strategy name derivation from `source`:
 *   "in:DAILY_PICK:1d"  → "Daily Pick 1d"
 *   "in:AI_SIGNAL:1d"   → "AI Signal 1d"
 *   Format: split on ":", take index 1 (strategy key) + index 2 (timeframe),
 *   title-case the strategy key words (replace underscores with spaces).
 *
 * Requirements: 8.5, 8.6, 8.7, 8.8, 9.1–9.5
 */

import type { PaperTradeEvent, IndiaPaperTradeSnapshot } from "../types";
import {
  formatINR,
  formatISTDateTime,
  formatDuration,
  messageFooter,
  isIndexSymbol,
} from "./shared";

// ─── Strategy name derivation ─────────────────────────────────────────────────

/**
 * Derive a human-readable strategy name from the PaperTrade `source` field.
 *
 * The source field follows the pattern "in:{STRATEGY_KEY}:{timeframe}", e.g.:
 *   "in:DAILY_PICK:1d"  → "Daily Pick 1d"
 *   "in:AI_SIGNAL:1d"   → "AI Signal 1d"
 *   "in:MOMENTUM:5m"    → "Momentum 5m"
 *
 * Derivation steps:
 *   1. Split on ":" — take the middle segment (index 1) as strategy key
 *   2. Replace underscores with spaces
 *   3. Title-case each word (first letter uppercase, rest lowercase)
 *   4. Append the timeframe segment (index 2) if present
 *
 * Falls back to the raw `source` string if parsing fails.
 *
 * @param source - PaperTrade.source, e.g. "in:DAILY_PICK:1d"
 */
function deriveStrategyName(source: string): string {
  const parts = source.split(":");

  // Expect at least "in:{STRATEGY_KEY}" (2+ segments)
  if (parts.length < 2) return source;

  const strategyKey = parts[1];
  const timeframe = parts[2]; // may be undefined

  // Convert DAILY_PICK → "Daily Pick"
  const humanStrategy = strategyKey
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

  if (timeframe) {
    return `${humanStrategy} ${timeframe}`;
  }

  return humanStrategy;
}

// ─── P&L percentage formatting ────────────────────────────────────────────────

/**
 * Format P&L percentage with explicit sign.
 *
 * - forcePositive (WIN): "+3.45%"
 * - forceNegative (LOSS): "-2.10%" (uses absolute value, prepends "-")
 * - neither (EXPIRED): signed based on actual value
 *
 * @param pnlPct        - Signed P&L percentage (e.g. 3.45 or -2.1)
 * @param forcePositive - When true, always render with "+" prefix
 * @param forceNegative - When true, always render with "-" prefix and abs value
 */
function formatPnlPct(
  pnlPct: number,
  forcePositive?: boolean,
  forceNegative?: boolean,
): string {
  const abs = Math.abs(pnlPct).toFixed(2);

  if (forcePositive) return `+${abs}%`;
  if (forceNegative) return `-${abs}%`;

  // Generic signed rendering (used for EXPIRED)
  if (pnlPct >= 0) return `+${abs}%`;
  return `-${abs}%`;
}

// ─── Individual event formatters ──────────────────────────────────────────────

/**
 * Format a PAPER_TRADE_OPENED message.
 *
 * Header: 📋 Paper Trade Opened
 * Body:   symbol • exchange, direction, strategy, entry, SL, target, R:R, openedAt
 * Footer: standard AlphaForge footer
 *
 * Requirements: 8.5, 9.1–9.5
 */
function formatOpened(trade: IndiaPaperTradeSnapshot): string {
  const { symbol, exchange, direction, source, entry, stopLoss, target, riskReward, openedAt } = trade;
  const isIndex = isIndexSymbol(symbol);

  const strategyName = deriveStrategyName(source);
  const rrFormatted = riskReward.toFixed(1);

  const lines = [
    `📋 Paper Trade Opened`,
    `${symbol} • ${exchange}`,
    ``,
    `Direction: ${direction}`,
    `Strategy: ${strategyName}`,
    ``,
    `Entry:   ${formatINR(entry, isIndex)}`,
    `SL:      ${formatINR(stopLoss, isIndex)}`,
    `Target:  ${formatINR(target, isIndex)}`,
    `R:R ${rrFormatted}`,
    ``,
    `Opened: ${formatISTDateTime(openedAt)}`,
    ``,
    messageFooter(),
  ];

  return lines.join("\n");
}

/**
 * Format a PAPER_TRADE_WIN message.
 *
 * Header: 🟢 WIN
 * Body:   symbol • exchange, direction, exit price, P&L % (positive), duration
 * Footer: standard AlphaForge footer
 *
 * Requirements: 8.6, 8.8, 9.1–9.5
 */
function formatWin(trade: IndiaPaperTradeSnapshot): string {
  const { symbol, exchange, direction, exitPrice, pnlPct, openedAt, resolvedAt } = trade;
  const isIndex = isIndexSymbol(symbol);

  const exitPriceStr = exitPrice !== undefined
    ? formatINR(exitPrice, isIndex)
    : "—";

  const pnlStr = pnlPct !== undefined
    ? formatPnlPct(pnlPct, true)
    : "+0.00%";

  const durationStr = resolvedAt !== undefined
    ? `Held ${formatDuration(openedAt, resolvedAt)}`
    : "";

  const lines = [
    `🟢 WIN`,
    `${symbol} • ${exchange}`,
    ``,
    `Direction: ${direction}`,
    `Exit:      ${exitPriceStr}`,
    `P&L:       ${pnlStr}`,
    ...(durationStr ? [`Duration:  ${durationStr}`] : []),
    ``,
    messageFooter(),
  ];

  return lines.join("\n");
}

/**
 * Format a PAPER_TRADE_LOSS message.
 *
 * Header: 🔴 LOSS
 * Body:   symbol • exchange, direction, exit price, P&L % (negative), duration
 * Footer: standard AlphaForge footer
 *
 * Requirements: 8.6, 8.8, 9.1–9.5
 */
function formatLoss(trade: IndiaPaperTradeSnapshot): string {
  const { symbol, exchange, direction, exitPrice, pnlPct, openedAt, resolvedAt } = trade;
  const isIndex = isIndexSymbol(symbol);

  const exitPriceStr = exitPrice !== undefined
    ? formatINR(exitPrice, isIndex)
    : "—";

  const pnlStr = pnlPct !== undefined
    ? formatPnlPct(pnlPct, false, true)
    : "-0.00%";

  const durationStr = resolvedAt !== undefined
    ? `Held ${formatDuration(openedAt, resolvedAt)}`
    : "";

  const lines = [
    `🔴 LOSS`,
    `${symbol} • ${exchange}`,
    ``,
    `Direction: ${direction}`,
    `Exit:      ${exitPriceStr}`,
    `P&L:       ${pnlStr}`,
    ...(durationStr ? [`Duration:  ${durationStr}`] : []),
    ``,
    messageFooter(),
  ];

  return lines.join("\n");
}

/**
 * Format a PAPER_TRADE_EXPIRED message.
 *
 * Header: ⏰ Expired
 * Body:   symbol • exchange, direction, entry price, final price, P&L % (signed)
 * Footer: standard AlphaForge footer
 *
 * Requirements: 8.7, 9.1–9.5
 */
function formatExpired(trade: IndiaPaperTradeSnapshot): string {
  const { symbol, exchange, direction, entry, exitPrice, pnlPct } = trade;
  const isIndex = isIndexSymbol(symbol);

  const finalPriceStr = exitPrice !== undefined
    ? formatINR(exitPrice, isIndex)
    : "—";

  const pnlStr = pnlPct !== undefined
    ? formatPnlPct(pnlPct)
    : "0.00%";

  const lines = [
    `⏰ Expired`,
    `${symbol} • ${exchange}`,
    ``,
    `Direction:   ${direction}`,
    `Entry:       ${formatINR(entry, isIndex)}`,
    `Final Price: ${finalPriceStr}`,
    `P&L:         ${pnlStr}`,
    ``,
    messageFooter(),
  ];

  return lines.join("\n");
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Format a WhatsApp notification message for any Paper Trade event type.
 *
 * Dispatches to the appropriate sub-formatter based on `event.type`:
 *   - "PAPER_TRADE_OPENED"  → position entry details with strategy and R:R
 *   - "PAPER_TRADE_WIN"     → profit close with signed P&L and duration
 *   - "PAPER_TRADE_LOSS"    → loss close with signed P&L and duration
 *   - "PAPER_TRADE_EXPIRED" → expired position with entry vs final price
 *
 * All prices use `formatINR(price, isIndexSymbol(symbol))` for correct
 * Indian notation. All messages end with the standard `messageFooter()`.
 *
 * @param event - A PaperTradeEvent with a discriminated `type` field
 * @returns Formatted WhatsApp message string ready for dispatch
 *
 * Requirements: 8.5, 8.6, 8.7, 8.8, 9.1–9.5
 */
export function formatPaperTradeMessage(event: PaperTradeEvent): string {
  const { trade } = event;

  switch (event.type) {
    case "PAPER_TRADE_OPENED":
      return formatOpened(trade);
    case "PAPER_TRADE_WIN":
      return formatWin(trade);
    case "PAPER_TRADE_LOSS":
      return formatLoss(trade);
    case "PAPER_TRADE_EXPIRED":
      return formatExpired(trade);
    default: {
      // TypeScript exhaustiveness guard — unreachable at runtime
      const _exhaustive: never = event.type;
      return "";
    }
  }
}
