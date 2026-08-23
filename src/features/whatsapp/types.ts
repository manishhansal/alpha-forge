/**
 * NotificationEvent union type for WhatsApp trading notifications.
 *
 * Each variant carries a typed payload that the formatter functions consume
 * to build the final WhatsApp message. The union is discriminated on `type`
 * so TypeScript can narrow to the correct interface in switch/if chains.
 *
 * References:
 *   - DailyPick / DailyPickBucket — src/features/india/daily-picks/engine.ts
 *   - AiSignal                    — src/types/ai-signals.ts
 *   - ScannerType                 — src/types/india/scanner.ts
 */

import type { DailyPick, DailyPickBucket } from "@/features/india/daily-picks/engine";
import type { AiSignal } from "@/types/ai-signals";
import type { ScannerType } from "@/types/india/scanner";

// ─── Event type discriminant ─────────────────────────────────────────────────

/**
 * String union of all notification event types recognised by the
 * WhatsApp_Notifier. Maps 1-to-1 to the five platform trigger surfaces.
 */
export type NotificationEventType =
  | "DAILY_PICKS_NEW"
  | "AI_SIGNAL_NEW"
  | "SCANNER_HIT_NEW"
  | "SIGNALS_BOARD_NEW"
  | "PAPER_TRADE_OPENED"
  | "PAPER_TRADE_WIN"
  | "PAPER_TRADE_LOSS"
  | "PAPER_TRADE_EXPIRED";

// ─── Exchange label ───────────────────────────────────────────────────────────

/**
 * Primary Indian stock exchanges.  Used throughout the notification payloads
 * to stamp the exchange label on every message (Requirement 9.3).
 */
export type IndiaExchange = "NSE" | "BSE";

// ─── Per-event interfaces ─────────────────────────────────────────────────────

/**
 * Emitted by the `india-daily-picks` worker job when new picks are frozen for
 * the first time for a given `tradeDate` and `bucket` (`res.persisted === true`).
 *
 * Requirements: 4.1
 */
export interface DailyPicksEvent {
  type: "DAILY_PICKS_NEW";
  /** The frozen daily pick, including all price levels and metadata. */
  pick: DailyPick;
  /**
   * ISO-format trade date string (YYYY-MM-DD, IST) — matches
   * `DailyPick.tradeDate` but surfaced top-level for the cooldown key.
   */
  tradeDate: string;
  /** The bucket this pick belongs to (e.g. "MOMENTUM", "INDICES_SCALP"). */
  bucket: DailyPickBucket;
  /** Unix epoch ms at which the picks were frozen. Used for the IST timestamp in the message. */
  generatedAt: number;
}

/**
 * Emitted by the `/api/in/ai-signals` route when a signal has
 * `action !== "WAIT"` and `confidenceScore >= 60`.
 *
 * Requirements: 5.1
 */
export interface AiSignalEvent {
  type: "AI_SIGNAL_NEW";
  /** Full AI signal payload including entry/SL/TP levels, rationale, and metadata. */
  signal: AiSignal;
}

/**
 * Snapshot of a single scanner hit, carrying only the fields needed to
 * format a WhatsApp notification.  The full `ScannerHit` type in
 * `src/types/india/scanner.ts` has many optional fields — this snapshot
 * captures the required ones plus the scanner identity.
 *
 * Requirements: 6.1
 */
export interface ScannerHitSnapshot {
  /** NSE ticker WITHOUT the `.NS` suffix (e.g. "RELIANCE", "HDFCBANK"). */
  symbol: string;
  /** Exchange this instrument trades on. */
  exchange: IndiaExchange;
  /** Internal scanner type key (e.g. "oi-buildup", "range-expansion"). */
  scannerType: ScannerType;
  /** Last traded price at detection time (₹). */
  price: number;
  /** Day change percentage at detection time. */
  changePct: number;
  /**
   * Human-readable key metric for the hit (e.g. OI build-up kind, PCR value,
   * IV spike %).  Corresponds to `ScannerHit.metricLabel + ScannerHit.metric`
   * or `ScannerHit.kind` depending on the scanner type.
   */
  keyMetric: string;
}

/**
 * Emitted by the scanner delta detection logic when a new hit appears in
 * the current scan result that was absent from the previous one.
 *
 * Requirements: 6.1
 */
export interface ScannerHitEvent {
  type: "SCANNER_HIT_NEW";
  hit: ScannerHitSnapshot;
}

/**
 * Snapshot of a Signals Board entry, carrying the fields needed to format a
 * WhatsApp notification.  The board merges all six scanner types into one
 * ranked feed and adds a strength score used for the 70th-percentile gate.
 *
 * Requirements: 7.1
 */
export interface SignalsBoardEntry {
  /** NSE ticker WITHOUT the `.NS` suffix. */
  symbol: string;
  /** Exchange this instrument trades on. */
  exchange: IndiaExchange;
  /**
   * Source type label (e.g. "oi-buildup", "momentum") — the raw scanner type
   * that surfaced this entry into the unified feed.
   */
  sourceType: string;
  /** Trade direction derived from the scanner signal. */
  direction: "LONG" | "SHORT";
  /** Current price (₹). */
  price: number;
  /** Day change percentage. */
  changePct: number;
  /** Key metric value for the signal (same semantics as `ScannerHitSnapshot.keyMetric`). */
  keyMetric: string;
  /**
   * Composite strength score used to rank entries in the feed and gate
   * the 70th-percentile threshold check.
   */
  strengthScore: number;
}

/**
 * Emitted by the `/api/in/signals` route when a new Signals Board entry
 * has a strength score above the 70th percentile of the current feed.
 *
 * Requirements: 7.1
 */
export interface SignalsBoardEvent {
  type: "SIGNALS_BOARD_NEW";
  entry: SignalsBoardEntry;
}

/**
 * Minimal snapshot of an `in:`-prefixed PaperTrade row required for all four
 * paper-trade notification variants.  Avoids dragging in the full Prisma
 * model — only the fields the formatter needs are captured here.
 *
 * - `exitPrice`, `pnlPct`, `resolvedAt` are optional because they are absent
 *   on the OPENED event and populated by WIN/LOSS/EXPIRED events.
 *
 * Requirements: 8.1–8.4
 */
export interface IndiaPaperTradeSnapshot {
  /** Prisma `PaperTrade.id` (cuid). */
  id: string;
  /** NSE ticker WITHOUT the `.NS` suffix. */
  symbol: string;
  /** Exchange this instrument trades on. */
  exchange: IndiaExchange;
  /** Trade direction. */
  direction: "LONG" | "SHORT";
  /**
   * Strategy source tag — `PaperTrade.source`, e.g. "in:DAILY_PICK:1d" or
   * "in:AI_SIGNAL:1d".  The formatter derives the human-readable strategy
   * name from this field.
   */
  source: string;
  /** Entry price (₹). */
  entry: number;
  /** Stop-loss price (₹). */
  stopLoss: number;
  /** Take-profit / target price (₹). */
  target: number;
  /** Risk-reward ratio (TP1 vs SL). */
  riskReward: number;
  /** Unix epoch ms when the position was opened. */
  openedAt: number;
  /** Exit price (₹). Present on WIN / LOSS / EXPIRED events. */
  exitPrice?: number;
  /** P&L as a signed percentage. Present on WIN / LOSS / EXPIRED events. */
  pnlPct?: number;
  /** Unix epoch ms when the position was resolved. Present on WIN / LOSS / EXPIRED events. */
  resolvedAt?: number;
}

/**
 * Emitted by the `india-scalper` job on every `PaperTrade.status` transition
 * for `in:`-prefixed rows.
 *
 * Requirements: 8.1–8.4
 */
export interface PaperTradeEvent {
  type:
    | "PAPER_TRADE_OPENED"
    | "PAPER_TRADE_WIN"
    | "PAPER_TRADE_LOSS"
    | "PAPER_TRADE_EXPIRED";
  trade: IndiaPaperTradeSnapshot;
}

// ─── Union type ───────────────────────────────────────────────────────────────

/**
 * Discriminated union of all notification event types.  Every public surface
 * that dispatches a WhatsApp notification produces one of these variants.
 *
 * The `type` field acts as the discriminant — TypeScript narrows correctly in
 * switch statements:
 *
 * ```typescript
 * switch (event.type) {
 *   case "DAILY_PICKS_NEW":    // event is DailyPicksEvent
 *   case "AI_SIGNAL_NEW":      // event is AiSignalEvent
 *   case "SCANNER_HIT_NEW":    // event is ScannerHitEvent
 *   case "SIGNALS_BOARD_NEW":  // event is SignalsBoardEvent
 *   case "PAPER_TRADE_OPENED":
 *   case "PAPER_TRADE_WIN":
 *   case "PAPER_TRADE_LOSS":
 *   case "PAPER_TRADE_EXPIRED": // event is PaperTradeEvent
 * }
 * ```
 */
export type NotificationEvent =
  | DailyPicksEvent
  | AiSignalEvent
  | ScannerHitEvent
  | SignalsBoardEvent
  | PaperTradeEvent;
