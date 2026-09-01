/**
 * drawdown.ts — Drawdown Tracking and Control
 *
 * Tracks daily and maximum drawdown against equity peaks.
 * Applies position-size reduction and trade-blocking rules when thresholds
 * are exceeded.
 *
 * Drawdown tiers (configurable):
 *   NORMAL    — full position size.
 *   CAUTION   — daily drawdown ≥ caution threshold  → reduce size to 75%.
 *   WARNING   — daily drawdown ≥ warning threshold  → reduce size to 50%.
 *   DANGER    — daily drawdown ≥ danger threshold   → reduce size to 25%.
 *   HALT      — daily drawdown ≥ halt threshold OR
 *               max drawdown ≥ max drawdown limit   → block all new trades.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DrawdownTier = "NORMAL" | "CAUTION" | "WARNING" | "DANGER" | "HALT";

export interface DrawdownState {
  /** Current equity (INR). */
  equity: number;
  /** All-time (or session-start) peak equity (INR). */
  peakEquity: number;
  /** Session-start equity (INR) — reset on each trading session open. */
  sessionStartEquity: number;
  /**
   * Maximum drawdown from peak equity (0..1).
   * Computed as (peakEquity - equity) / peakEquity.
   */
  maxDrawdown: number;
  /**
   * Daily drawdown from session-start equity (0..1).
   * Computed as (sessionStartEquity - equity) / sessionStartEquity.
   * Always 0 or positive.
   */
  dailyDrawdown: number;
  /** Active drawdown tier. */
  tier: DrawdownTier;
}

export interface DrawdownConfig {
  /**
   * Daily drawdown thresholds (fraction of session-start equity).
   * Must satisfy: caution < warning < danger < halt.
   */
  dailyCaution: number;   // Default 0.01  (1%)
  dailyWarning: number;   // Default 0.015 (1.5%)
  dailyDanger: number;    // Default 0.02  (2%)
  dailyHalt: number;      // Default 0.03  (3%)

  /**
   * Maximum (peak-to-trough) drawdown limit.
   * When crossed → HALT tier.
   */
  maxDrawdownHalt: number;  // Default 0.10 (10%)

  /**
   * Position-size multipliers for each tier.
   * HALT is 0 (no new positions).
   */
  sizingMultiplierByTier: Record<DrawdownTier, number>;
}

export const DEFAULT_DRAWDOWN_CONFIG: DrawdownConfig = {
  dailyCaution: 0.01,
  dailyWarning: 0.015,
  dailyDanger: 0.02,
  dailyHalt: 0.03,
  maxDrawdownHalt: 0.10,
  sizingMultiplierByTier: {
    NORMAL: 1.0,
    CAUTION: 0.75,
    WARNING: 0.50,
    DANGER: 0.25,
    HALT: 0.0,
  },
};

// ── Tier classification ───────────────────────────────────────────────────────

/**
 * Determine the drawdown tier given current daily and max drawdown.
 */
export function classifyDrawdownTier(
  dailyDrawdown: number,
  maxDrawdown: number,
  config: DrawdownConfig = DEFAULT_DRAWDOWN_CONFIG,
): DrawdownTier {
  if (
    dailyDrawdown >= config.dailyHalt ||
    maxDrawdown >= config.maxDrawdownHalt
  ) {
    return "HALT";
  }
  if (dailyDrawdown >= config.dailyDanger) return "DANGER";
  if (dailyDrawdown >= config.dailyWarning) return "WARNING";
  if (dailyDrawdown >= config.dailyCaution) return "CAUTION";
  return "NORMAL";
}

// ── State builder ─────────────────────────────────────────────────────────────

/**
 * Compute a fresh DrawdownState snapshot.
 *
 * @param equity             Current portfolio equity.
 * @param peakEquity         All-time (or period) peak equity.
 * @param sessionStartEquity Equity at session open today.
 * @param config             Drawdown thresholds.
 */
export function computeDrawdownState(
  equity: number,
  peakEquity: number,
  sessionStartEquity: number,
  config: DrawdownConfig = DEFAULT_DRAWDOWN_CONFIG,
): DrawdownState {
  const safePeak = Math.max(peakEquity, equity, 1);
  const safeSession = Math.max(sessionStartEquity, 1);

  const maxDrawdown = Math.max(0, (safePeak - equity) / safePeak);
  const dailyDrawdown = Math.max(0, (safeSession - equity) / safeSession);

  const tier = classifyDrawdownTier(dailyDrawdown, maxDrawdown, config);

  return {
    equity,
    peakEquity: safePeak,
    sessionStartEquity: safeSession,
    maxDrawdown,
    dailyDrawdown,
    tier,
  };
}

// ── Position size reduction ───────────────────────────────────────────────────

/**
 * Return the sizing multiplier (0..1) for the current drawdown tier.
 * 0.0 means "no new positions allowed".
 */
export function getSizingMultiplier(
  state: DrawdownState,
  config: DrawdownConfig = DEFAULT_DRAWDOWN_CONFIG,
): number {
  return config.sizingMultiplierByTier[state.tier] ?? 0;
}

// ── Trade-blocking check ──────────────────────────────────────────────────────

export interface DrawdownCheck {
  blocked: boolean;
  reason?: string;
  tier: DrawdownTier;
  /** Multiplier to apply to the base position size. */
  sizingMultiplier: number;
  dailyDrawdown: number;
  maxDrawdown: number;
}

/**
 * Evaluate whether a new trade can be opened given the current drawdown state.
 * Also returns the sizing multiplier to apply even when not blocked.
 */
export function checkDrawdown(
  state: DrawdownState,
  config: DrawdownConfig = DEFAULT_DRAWDOWN_CONFIG,
): DrawdownCheck {
  const multiplier = getSizingMultiplier(state, config);
  const blocked = multiplier === 0;

  let reason: string | undefined;
  if (blocked) {
    if (state.maxDrawdown >= config.maxDrawdownHalt) {
      reason = `Max drawdown ${(state.maxDrawdown * 100).toFixed(2)}% has reached the ${(config.maxDrawdownHalt * 100).toFixed(0)}% halt threshold — all new trades blocked`;
    } else {
      reason = `Daily drawdown ${(state.dailyDrawdown * 100).toFixed(2)}% has reached the ${(config.dailyHalt * 100).toFixed(0)}% daily halt threshold — all new trades blocked`;
    }
  } else if (state.tier !== "NORMAL") {
    reason = `Drawdown tier: ${state.tier} — position size reduced to ${(multiplier * 100).toFixed(0)}% of normal`;
  }

  return {
    blocked,
    reason,
    tier: state.tier,
    sizingMultiplier: multiplier,
    dailyDrawdown: state.dailyDrawdown,
    maxDrawdown: state.maxDrawdown,
  };
}

// ── Equity-peak tracker ───────────────────────────────────────────────────────

/**
 * Stateful helper that maintains a running equity peak and returns updated
 * DrawdownState on every equity update.
 */
export class DrawdownTracker {
  private _peak: number;
  private _sessionStart: number;
  readonly config: DrawdownConfig;

  constructor(initialEquity: number, config: DrawdownConfig = DEFAULT_DRAWDOWN_CONFIG) {
    this._peak = initialEquity;
    this._sessionStart = initialEquity;
    this.config = config;
  }

  /** Call this at the start of each trading session. */
  onSessionOpen(equity: number): void {
    this._sessionStart = equity;
  }

  /** Call on each equity update (e.g. mark-to-market or closed trade). */
  update(equity: number): DrawdownState {
    if (equity > this._peak) {
      this._peak = equity;
    }
    return computeDrawdownState(equity, this._peak, this._sessionStart, this.config);
  }

  get peakEquity(): number {
    return this._peak;
  }

  get sessionStartEquity(): number {
    return this._sessionStart;
  }
}
