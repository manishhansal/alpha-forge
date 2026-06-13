/**
 * Shared types for the AI Signals feature.
 *
 * Designed to work across both markets — the crypto surface (BTC / ETH / SOL)
 * and the Indian F&O surface (NIFTY / BANKNIFTY / FINNIFTY + F&O stocks) —
 * so the same `<AiSignalCard>` component can render either market's output.
 *
 * The signal is intentionally richer than the legacy `TradingSignal` in
 * `@/types/market`:
 *   - tiered take-profits (TP1/TP2/TP3) with allocations
 *   - explicit entry zone (not just a single price)
 *   - timing window (when to enter, when to exit-by)
 *   - confluence breakdown with categorised factors
 *   - calibrated win-probability + position-sizing suggestion
 *   - human-readable rationale + invalidation criteria
 *   - optional strike price for derivatives-style suggestions
 */

export type AiMarket = "crypto" | "india";

export type AiAction = "LONG" | "SHORT" | "BUY" | "SELL" | "WAIT";

export type AiDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

/**
 * How long the signal is meant to live. Maps to a different risk profile
 * (tighter stops for scalp, wider for swing) and a different "valid-for"
 * window in the timing block.
 */
export type AiHorizon = "scalp" | "intraday" | "swing" | "positional";

export type AiRiskLevel = "low" | "medium" | "high";

/**
 * Letter grade derived from the composite confidence score. S = exceptional
 * conviction (≥85), A = strong (≥75), B = solid (≥60), C = marginal (≥45),
 * D = weak / wait.
 */
export type AiGrade = "S" | "A" | "B" | "C" | "D";

export type AiFactorCategory =
  | "technical"
  | "derivatives"
  | "sentiment"
  | "macro"
  | "news"
  | "chart"
  | "flow";

/**
 * A single weighted input into the composite score. Score is in [-1, 1]:
 *   +1 = maximally bullish, -1 = maximally bearish, 0 = neutral/unavailable.
 */
export interface AiConfluenceFactor {
  id: string;
  category: AiFactorCategory;
  label: string;
  description: string;
  weight: number;
  score: number;
  contribution: number;
  available: boolean;
}

/**
 * One leg of a tiered take-profit ladder. Allocations across all TPs in a
 * signal sum to 1 (100% of the position) so the UI can show "scale out X%
 * here, Y% there, Z% there".
 */
export interface AiTakeProfit {
  level: 1 | 2 | 3;
  price: number;
  percent: number;
  allocation: number;
}

export interface AiTimingWindow {
  generatedAt: number;
  enterBy: number;
  exitBy: number;
  validForMs: number;
  bestEntryNote: string;
  bestExitNote: string;
}

/**
 * Marker used by the UI to render a category chip on each rationale row.
 * The string is a short human-readable phrase (e.g. "Strong momentum").
 */
export interface AiReason {
  category: AiFactorCategory;
  text: string;
  bullish: boolean;
}

export interface AiSignal {
  id: string;
  symbol: string;
  displayName: string;
  market: AiMarket;
  /** Broker pair / display ticker (e.g. "BTCUSDT", "NIFTY 50"). */
  pair: string;
  action: AiAction;
  direction: AiDirection;
  horizon: AiHorizon;

  /** Live/last-known mark price of the underlying instrument. */
  underlyingPrice: number;
  /** Suggested entry. For LONG = lower bound, for SHORT = upper bound. */
  entry: number;
  /** Tight zone around `entry` where filling is acceptable. */
  entryZone: { min: number; max: number };
  /**
   * Optional strike price suggestion for derivatives-style trades.
   *   - crypto: the rounded futures entry (acts as a strike for option-style suggestions)
   *   - india: the nearest ATM option strike for the relevant expiry
   */
  strike: number | null;
  stopLoss: number;
  takeProfits: AiTakeProfit[];

  /** TP1 vs SL (the primary read on whether this trade is worth taking). */
  riskReward: number;
  /** Allocation-weighted RR across all TPs. */
  riskRewardBlended: number;
  /** Magnitude of the expected move from entry to TP3 (always positive). */
  expectedMovePct: number;
  /** Suggested allocation of total equity (assumes the user risks 1%). */
  positionSizingPct: number;
  riskLevel: AiRiskLevel;

  /** Composite [0, 1] confidence in the signal's direction. */
  confidence: number;
  /** 0–100 representation used by the UI ring. */
  confidenceScore: number;
  grade: AiGrade;
  /** Calibrated win-probability in [0, 1] (TP1 hit before SL). */
  winProbability: number;

  timing: AiTimingWindow;

  confluences: AiConfluenceFactor[];
  bullishCount: number;
  bearishCount: number;
  reasons: AiReason[];
  invalidationCriteria: string;

  modelVersion: string;
  /** Free-form one-liner the AI shows above the rationale. */
  summary: string;
}

/**
 * Top-level health/regime read used by the response wrapper. Lets the UI
 * paint a "market regime" badge (Risk-on / Risk-off / Mixed) above the
 * signals grid.
 */
export type AiMarketRegime = "risk-on" | "risk-off" | "mixed" | "compressed";

export interface AiMarketContext {
  market: AiMarket;
  regime: AiMarketRegime;
  regimeScore: number;
  headline: string;
  bullets: string[];
  /**
   * Whether the current wall-clock falls inside a "good time to trade"
   * window (crypto: Best-Time engine; india: NSE session map). Drives the
   * "Wait for session" gate on the WAIT action and feeds the timing window.
   */
  inActiveWindow: boolean;
  windowLabel: string;
  /** Free-form data feed-status string (e.g. "live", "stale 2m"). */
  dataFreshness: string;
  /**
   * Absolute UTC ms timestamp of the next trading-session open. Populated
   * by markets that have a closed-state (e.g. NSE F&O) when the active
   * window is "off" / outside hours — lets the UI reframe signals as
   * "queued for the next session" instead of "live right now".
   * Always null for 24/7 markets (crypto).
   */
  nextSessionOpensAt?: number | null;
  /**
   * Human-readable label for the next session — typically a day phrase
   * like "tomorrow", "Monday", "today" plus the wall-clock open time
   * (e.g. "tomorrow at 09:15 IST"). Paired with `nextSessionOpensAt`.
   */
  nextSessionLabel?: string | null;
}

export interface AiSignalsResponse {
  market: AiMarket;
  generatedAt: number;
  modelVersion: string;
  context: AiMarketContext;
  signals: AiSignal[];
  /**
   * Lightweight stats so the UI can show a summary strip:
   *   - {bullish: 2, bearish: 0, wait: 1, avgConfidence: 0.68}
   */
  stats: {
    bullish: number;
    bearish: number;
    wait: number;
    avgConfidence: number;
    topGrade: AiGrade | null;
  };
}
