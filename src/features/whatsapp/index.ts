/**
 * Public barrel for the WhatsApp notification feature.
 *
 * Import everything you need from this single entry point rather than
 * reaching into sub-modules directly.
 *
 * Requirements: 1.1, 1.7
 */

// ─── Notifier ─────────────────────────────────────────────────────────────────
export { dispatchWhatsApp, sendEvolutionMessage } from "./notifier";
export type { DispatchResult } from "./notifier";

// ─── Formatter ────────────────────────────────────────────────────────────────
export { formatMessage } from "./formatter";
export { formatDailyPicksMessage } from "./formatters/daily-picks";
export { formatAiSignalMessage } from "./formatters/ai-signal";
export { formatScannerHitMessage, formatScannerBatchMessage } from "./formatters/scanner";
export { formatSignalsBoardMessage } from "./formatters/signals-board";
export { formatPaperTradeMessage } from "./formatters/paper-trade";

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  NotificationEvent,
  NotificationEventType,
  DailyPicksEvent,
  AiSignalEvent,
  ScannerHitEvent,
  ScannerHitSnapshot,
  SignalsBoardEvent,
  SignalsBoardEntry,
  PaperTradeEvent,
  IndiaPaperTradeSnapshot,
  IndiaExchange,
} from "./types";

// ─── Preferences ─────────────────────────────────────────────────────────────
export { getWhatsAppPreferences, saveWhatsAppPreferences, WHATSAPP_EVENT_TYPES } from "./preferences";
export type { WhatsAppEventType, WhatsAppPreferences } from "./preferences";

// ─── Phone ────────────────────────────────────────────────────────────────────
export {
  validatePhone,
  encryptPhone,
  maskPhone,
  readPhone,
  savePhone,
  deletePhone,
  E164_REGEX,
} from "./phone";
