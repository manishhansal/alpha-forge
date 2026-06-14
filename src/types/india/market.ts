// Shared market-data types used across services, API routes, and UI.
// Designed to be broker-agnostic so a `BrokerAdapter` can be swapped
// (Yahoo / NSE / Groww / Zerodha / Upstox) without changing consumers.

import type { DataSourceId } from "@/features/settings/data-sources-shared";

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
  /**
   * True upstream that produced this value. Lets the route/UI show genuine
   * provenance (e.g. "angel" vs a Yahoo backfill) rather than just the adapter
   * that was selected. Undefined when no source could serve the symbol.
   */
  source?: DataSourceId;
  fetchedAt: string;
};

export type IndexQuote = Quote & {
  /** Display-friendly index name (e.g. "NIFTY 50"). */
  name: string;
};

export type Snapshot = {
  indices: IndexQuote[];
  sectors: IndexQuote[];
  /** Primary selected source for the snapshot (highest-priority pick). */
  source?: DataSourceId;
  /** Distinct upstreams that actually produced the snapshot's quotes. */
  sources?: DataSourceId[];
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
