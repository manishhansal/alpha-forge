// Shared market-data types used across services, API routes, and UI.
// Designed to be broker-agnostic so a `BrokerAdapter` can be swapped
// (Yahoo / NSE / Groww / Zerodha / Upstox) without changing consumers.

export type Quote = {
  symbol: string;
  name?: string | null;
  price: number | null;
  change: number | null;
  changePct: number | null;
  prevClose: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  fetchedAt: string;
};

export type IndexQuote = Quote & {
  /** Display-friendly index name (e.g. "NIFTY 50"). */
  name: string;
};

export type Snapshot = {
  indices: IndexQuote[];
  sectors: IndexQuote[];
  fetchedAt: string;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type Interval = "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "1w";

export type HistoricalRequest = {
  symbol: string;
  interval: Interval;
  /** Lookback range, e.g. "1d", "5d", "1mo", "6mo", "1y", "5y" */
  range: string;
};

export type FeedTick = {
  symbol: string;
  ltp: number;
  changePct: number | null;
  volume?: number | null;
  ts: number;
};

export type FeedDiff = {
  /** Only changed symbols since last tick. */
  ticks: FeedTick[];
  ts: number;
};

export type WatchlistItem = {
  symbol: string;
  display?: string;
  addedAt: number;
};
