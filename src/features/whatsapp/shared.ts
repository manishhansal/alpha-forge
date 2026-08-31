/**
 * shared.ts — Client-safe constants and types for WhatsApp notification
 * preferences. This file intentionally has no "server-only" guard so it can
 * be imported by both server-side modules (preferences.ts, server actions) and
 * client components (whatsapp-section.tsx).
 *
 * The server-side persistence logic lives in preferences.ts (server-only).
 *
 * Requirements: 3.1, 11.2
 */

// ─── Event type catalog ──────────────────────────────────────────────────────

/**
 * The five notification event types that users can enable or disable from
 * the WhatsApp Alerts section in their profile.
 *
 * Requirements: 3.1
 */
export const WHATSAPP_EVENT_TYPES = [
  "DAILY_PICKS_NEW",
  "AI_SIGNAL_NEW",
  "SCANNER_HIT_NEW",
  "SIGNALS_BOARD_NEW",
  "PAPER_TRADE_OPENED",
] as const;

/** Union of the five user-facing WhatsApp event type strings. */
export type WhatsAppEventType = (typeof WHATSAPP_EVENT_TYPES)[number];

// ─── Preferences shape ───────────────────────────────────────────────────────

/**
 * Per-user WhatsApp notification preferences.
 *
 * Requirements: 3.2, 3.4
 */
export interface WhatsAppPreferences {
  enabledEvents: WhatsAppEventType[];
}
