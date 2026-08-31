/**
 * Strategy adapter interface — the seam between the event engine and any
 * strategy implementation (existing AlphaForge or new v2).
 *
 * The engine calls `onBar()` once per closed bar with a `StrategyContext`
 * that enforces the anti-lookahead contract. Strategies signal intent by
 * calling `ctx.emit(signal)` — they never interact with the portfolio or
 * order book directly.
 *
 * Existing AlphaForge strategies (IndiaPriceStrategyModule) can be wrapped
 * with `IndiaPriceStrategyAdapter` (see adapter/india-price-adapter.ts)
 * to run in the v2 engine without modification.
 */

import type { StrategyContext } from "../engine/event-engine";

// ── Core interface ─────────────────────────────────────────────────────────

export interface StrategyHandler {
  /** Unique strategy identifier (used for attribution). */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /**
   * Called once per bar after the MARKET_EVENT has been dispatched.
   * The strategy may call `ctx.emit()` zero or more times.
   * Must be synchronous — the engine is single-threaded.
   */
  onBar(ctx: StrategyContext): void;
  /**
   * Called once at the start of a new simulation run.
   * Use to reset any internal state (indicators, position tracking, etc.).
   */
  onReset?(): void;
  /**
   * Called when a SESSION_OPEN event fires.
   * Use to reset intra-day state.
   */
  onSessionOpen?(tradeDate: string): void;
  /**
   * Called when a SESSION_CLOSE event fires.
   * Use to clean up intra-day state.
   */
  onSessionClose?(tradeDate: string): void;
}

// ── Base class helper ──────────────────────────────────────────────────────

/**
 * Convenience base class. Strategies extend this to get sensible defaults
 * and avoid having to implement optional lifecycle methods.
 */
export abstract class BaseStrategy implements StrategyHandler {
  abstract readonly id: string;
  abstract readonly name: string;

  abstract onBar(ctx: StrategyContext): void;

  onReset(): void {}
  onSessionOpen(_tradeDate: string): void {}
  onSessionClose(_tradeDate: string): void {}
}
