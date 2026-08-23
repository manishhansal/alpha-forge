/**
 * WhatsApp message formatter for DAILY_PICKS_NEW notification events.
 *
 * Formats a single frozen DailyPick into a rich WhatsApp message covering
 * all required fields: bucket name, rank, symbol, exchange, action, price
 * levels, lot size (index instruments), confidence, grade, logic string,
 * IST freeze timestamp, and standard footer.
 *
 * Price values use Indian comma notation via `formatINR`. Index instruments
 * (INDICES_SCALP bucket or `isIndexSymbol` match) receive integer-only
 * prices and include the lot size line.
 *
 * References:
 *   - DailyPick / DailyPickBucket — src/features/india/daily-picks/engine.ts
 *   - Shared helpers             — src/features/whatsapp/formatters/shared.ts
 *   - DailyPicksEvent            — src/features/whatsapp/types.ts
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5, 9.1–9.5
 */

import { DAILY_PICK_BUCKET_META } from "@/features/india/daily-picks/engine";
import type { DailyPicksEvent } from "../types";
import {
  actionEmoji,
  formatINR,
  formatISTDateTime,
  isIndexSymbol,
  lotSizeFor,
  messageFooter,
} from "./shared";

/**
 * Format a `DAILY_PICKS_NEW` event into a WhatsApp message string.
 *
 * Message structure:
 * ```
 * {emoji} Daily Pick — {BucketLabel}
 * #{rank} · {SYMBOL} · {EXCHANGE}
 *
 * Action  : {ACTION}
 * Entry   : ₹{entry}
 * Stop    : ₹{stopLoss}
 * Target  : ₹{target}
 * Upto    : ₹{canMoveUpto}
 * Expect  : {canExpectPct}%
 * [Lot    : {lotSize}]   ← only for index instruments
 *
 * Confidence : {confidenceScore}/100  ({grade})
 * Logic      : {logic}
 *
 * Frozen: {DD-Mon-YYYY HH:MM IST}
 *
 * {footer}
 * ```
 *
 * @param event - The frozen daily-picks notification event
 */
export function formatDailyPicksMessage(event: DailyPicksEvent): string {
  const { pick, bucket, generatedAt } = event;
  const {
    rank,
    symbol,
    action,
    entry,
    stopLoss,
    target,
    canMoveUpto,
    canExpectPct,
    confidenceScore,
    grade,
    logic,
  } = pick;

  // Resolve the exchange label: prefer `pick.pair` suffix if present,
  // otherwise fall back to "NSE" (all daily picks are NSE F&O instruments).
  const exchange = pick.pair?.includes("BSE") ? "BSE" : "NSE";

  // Determine whether to use integer-only price formatting.
  const isIndex = isIndexSymbol(symbol);

  // Human-readable bucket label from the canonical metadata catalog.
  const bucketLabel =
    DAILY_PICK_BUCKET_META[bucket]?.label ?? bucket;

  // Header emoji from the action (LONG/BUY → 🟢, SHORT/SELL → 🔴).
  const emoji = actionEmoji(action);

  // Format all price values with Indian notation.
  const fEntry = formatINR(entry, isIndex);
  const fSL = formatINR(stopLoss, isIndex);
  const fTarget = formatINR(target, isIndex);
  const fUpto = formatINR(canMoveUpto, isIndex);

  // Confidence score is already 0-100 on DailyPick.
  const confDisplay = Math.round(confidenceScore);

  // canExpectPct is stored as a decimal (e.g. 2.45 means 2.45%).
  const expectDisplay = canExpectPct.toFixed(2);

  // IST freeze timestamp in the required format.
  const freezeTime = formatISTDateTime(generatedAt);

  // Build the optional lot-size line for index instruments.
  const lotLine =
    isIndex && lotSizeFor(symbol) !== undefined
      ? `\nLot      : ${lotSizeFor(symbol)}`
      : "";

  const lines = [
    `${emoji} Daily Pick — ${bucketLabel}`,
    `#${rank} · ${symbol} · ${exchange}`,
    ``,
    `Action   : ${action}`,
    `Entry    : ${fEntry}`,
    `Stop     : ${fSL}`,
    `Target   : ${fTarget}`,
    `Upto     : ${fUpto}`,
    `Expect   : ${expectDisplay}%${lotLine}`,
    ``,
    `Confidence : ${confDisplay}/100  (${grade})`,
    `Logic      : ${logic}`,
    ``,
    `Frozen: ${freezeTime}`,
    ``,
    messageFooter(),
  ];

  return lines.join("\n");
}
