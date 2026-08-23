/**
 * Message formatter barrel for the WhatsApp notification channel.
 *
 * Re-exports one formatting function per notification event type, plus the
 * `formatMessage` dispatcher that selects the correct formatter based on the
 * event's `type` discriminant.
 *
 * Import from here rather than from individual formatter files so call sites
 * don't need to know about the internal formatter directory structure.
 *
 * Requirements: 4.2, 5.2, 6.2, 7.2, 8.5–8.7
 */

import type { NotificationEvent } from "./types";

export { formatDailyPicksMessage } from "./formatters/daily-picks";
export { formatAiSignalMessage } from "./formatters/ai-signal";
export { formatScannerHitMessage, formatScannerBatchMessage } from "./formatters/scanner";
export { formatSignalsBoardMessage } from "./formatters/signals-board";
export { formatPaperTradeMessage } from "./formatters/paper-trade";

import { formatDailyPicksMessage } from "./formatters/daily-picks";
import { formatAiSignalMessage } from "./formatters/ai-signal";
import { formatScannerHitMessage } from "./formatters/scanner";
import { formatSignalsBoardMessage } from "./formatters/signals-board";
import { formatPaperTradeMessage } from "./formatters/paper-trade";

/**
 * Dispatch to the correct formatter for any `NotificationEvent`.
 *
 * @param event - A discriminated `NotificationEvent` variant
 * @returns Formatted WhatsApp message string ready for dispatch
 */
export function formatMessage(event: NotificationEvent): string {
  switch (event.type) {
    case "DAILY_PICKS_NEW":
      return formatDailyPicksMessage(event);
    case "AI_SIGNAL_NEW":
      return formatAiSignalMessage(event);
    case "SCANNER_HIT_NEW":
      return formatScannerHitMessage(event);
    case "SIGNALS_BOARD_NEW":
      return formatSignalsBoardMessage(event);
    case "PAPER_TRADE_OPENED":
    case "PAPER_TRADE_WIN":
    case "PAPER_TRADE_LOSS":
    case "PAPER_TRADE_EXPIRED":
      return formatPaperTradeMessage(event);
    default: {
      // TypeScript exhaustiveness guard — unreachable at runtime
      const _exhaustive: never = event;
      return "";
    }
  }
}
