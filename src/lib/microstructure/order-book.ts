/**
 * order-book.ts — Canonical order-book types for the Microstructure Engine.
 *
 * Wraps the existing market-data DepthLevel / MarketDepth types and adds
 * richer derived fields (mid-price, spread, total bid/ask quantities) so
 * every downstream sub-module can work from a single snapshot object.
 *
 * This module owns NO state — every function is pure and side-effect free.
 */

import type { DepthLevel, MarketDepth } from "@/lib/market-data/types";

// ── Re-export the canonical depth level so consumers import from one place ──

export type { DepthLevel };

// ── OrderBookSnapshot ─────────────────────────────────────────────────────────

/**
 * Enriched snapshot derived from a MarketDepth tick.
 *
 * All prices in INR. Quantities are number of shares / contracts.
 */
export interface OrderBookSnapshot {
  symbol: string;
  token: string;

  /** Best bid price (highest bid). */
  bestBid: number;
  /** Best ask price (lowest ask). */
  bestAsk: number;
  /** Absolute spread = bestAsk - bestBid. */
  spread: number;
  /** Spread as fraction of mid-price. */
  spreadFraction: number;
  /** Mid price = (bestBid + bestAsk) / 2. */
  midPrice: number;

  /** Ordered bid levels — index 0 = best bid. */
  bids: DepthLevel[];
  /** Ordered ask levels — index 0 = best ask. */
  asks: DepthLevel[];

  /** Sum of quantity across all bid levels. */
  totalBidQty: number;
  /** Sum of quantity across all ask levels. */
  totalAskQty: number;

  /**
   * Number of bid levels actually present.
   * NSE provides up to 5; may be fewer for illiquid instruments.
   */
  bidLevels: number;
  /** Number of ask levels actually present. */
  askLevels: number;

  /** UTC epoch milliseconds when this snapshot was captured. */
  timestampMs: number;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build an OrderBookSnapshot from a raw MarketDepth tick.
 *
 * Defensively handles missing or empty bid/ask arrays so downstream modules
 * never have to null-guard the individual fields.
 */
export function buildOrderBookSnapshot(
  depth: MarketDepth,
  timestampMs: number = Date.now(),
): OrderBookSnapshot {
  const bids = Array.isArray(depth.bids) ? depth.bids : [];
  const asks = Array.isArray(depth.asks) ? depth.asks : [];

  const bestBid = bids.length > 0 ? bids[0].price : 0;
  const bestAsk = asks.length > 0 ? asks[0].price : 0;
  const midPrice =
    bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
  const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
  const spreadFraction = midPrice > 0 ? spread / midPrice : 0;

  const totalBidQty = bids.reduce((s, l) => s + l.quantity, 0);
  const totalAskQty = asks.reduce((s, l) => s + l.quantity, 0);

  return {
    symbol: depth.symbol,
    token: depth.token,
    bestBid,
    bestAsk,
    spread,
    spreadFraction,
    midPrice,
    bids,
    asks,
    totalBidQty,
    totalAskQty,
    bidLevels: bids.length,
    askLevels: asks.length,
    timestampMs,
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Sum bid quantities across the top N levels.
 * Returns 0 if the book has fewer than 1 level.
 */
export function bidQtyTopN(snapshot: OrderBookSnapshot, n: number): number {
  return snapshot.bids.slice(0, n).reduce((s, l) => s + l.quantity, 0);
}

/**
 * Sum ask quantities across the top N levels.
 */
export function askQtyTopN(snapshot: OrderBookSnapshot, n: number): number {
  return snapshot.asks.slice(0, n).reduce((s, l) => s + l.quantity, 0);
}

/**
 * Compute the mid-price shift (in price units) between two snapshots.
 * Positive = price moved up; negative = price moved down.
 */
export function midPriceDelta(prev: OrderBookSnapshot, curr: OrderBookSnapshot): number {
  return curr.midPrice - prev.midPrice;
}

/**
 * Return true when the book is considered "empty" — e.g. no bids or asks
 * are present (circuit-breaker, market-halt, or data gap).
 */
export function isEmptyBook(snapshot: OrderBookSnapshot): boolean {
  return snapshot.bestBid === 0 || snapshot.bestAsk === 0;
}
