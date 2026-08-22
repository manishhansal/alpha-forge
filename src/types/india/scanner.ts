// Scanner result types. Each scanner produces a list of `ScannerHit` rows.

export type ScannerType =
  | "oi-buildup"
  | "pcr"
  | "iv-spike"
  | "volume-breakout"
  | "momentum"
  | "range-expansion"
  | "fno-bullish-trend"
  | "fno-bearish-trend";

export type OiBuildupKind =
  | "LONG_BUILDUP"
  | "SHORT_BUILDUP"
  | "LONG_UNWINDING"
  | "SHORT_COVERING";

export type ScannerHit = {
  symbol: string;
  price: number | null;
  changePct: number | null;
  volume?: number | null;
  metric: number;
  metricLabel: string;
  kind?: OiBuildupKind | string;
  note?: string;
  /** Suggested entry price (last close for screener hits). */
  entry?: number | null;
  /** ATR-based stop loss level. */
  stopLoss?: number | null;
  /** Take-profit 1 (1.6×ATR for intraday). */
  tp1?: number | null;
  /** Take-profit 2 (2.6×ATR for intraday). */
  tp2?: number | null;
  /** Take-profit 3 / stretch target (4.0×ATR for intraday). */
  tp3?: number | null;
  /** ATR(14) used to compute the levels. */
  atr?: number | null;
};

export type ScannerResult = {
  type: ScannerType;
  title: string;
  description: string;
  hits: ScannerHit[];
  fetchedAt: string;
};
