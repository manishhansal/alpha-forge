// Option-chain types — modeled after NSE option-chain JSON but kept
// broker-agnostic so the same shape is produced by Groww / Zerodha adapters.

export type OptionType = "CE" | "PE";

/** Per-strike option greeks (live-only — sourced from Angel One optionGreek). */
export type OptionGreeks = {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
};

export type OptionLeg = {
  strike: number;
  type: OptionType;
  /** Open interest (contracts) */
  oi: number;
  /** Change in OI from previous day's close (contracts) */
  changeInOi: number;
  /** Total traded volume today (contracts) */
  volume: number;
  /** Implied volatility (annualised %) */
  iv: number | null;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  /** Option delta (∂price/∂spot). Null when the greeks feed is unavailable. */
  delta?: number | null;
  /** Option gamma (∂delta/∂spot). */
  gamma?: number | null;
  /** Option theta (∂price/∂time, per day). */
  theta?: number | null;
  /** Option vega (∂price/∂IV). */
  vega?: number | null;
};

export type OptionChainRow = {
  strike: number;
  ce: OptionLeg | null;
  pe: OptionLeg | null;
};

export type OptionChain = {
  symbol: string;
  /** Underlying spot */
  spot: number | null;
  /** Selected expiry (YYYY-MM-DD or NSE display string) */
  expiry: string;
  /** All available expiries for this underlying */
  expiries: string[];
  rows: OptionChainRow[];
  /** Aggregated analytics */
  analytics: OptionChainAnalytics;
  fetchedAt: string;
};

export type OptionChainAnalytics = {
  pcrOi: number | null;
  pcrVolume: number | null;
  maxCeOiStrike: number | null;
  maxPeOiStrike: number | null;
  totalCeOi: number;
  totalPeOi: number;
  totalCeOiChange: number;
  totalPeOiChange: number;
  atmIv: number | null;
  maxPain: number | null;
};
