import "server-only";

import {
  brokerPairToSymbolId,
  LIQUIDATION_WINDOW_MS,
  REDIS_KEYS,
  SYMBOLS_BY_BINANCE,
  TRACKED_SYMBOLS,
} from "@/lib/constants";
import { redis } from "@/lib/redis";
import { getServerBroker } from "@/services/brokers/registry";
import type { SymbolId } from "@/types/market";

/**
 * On-wire payload stored as members of the per-symbol sorted set.
 * Kept tiny (no symbol — that's already in the key).
 */
export interface BufferedLiquidationEvent {
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  notionalUsd: number;
  ts: number;
}

export interface LiquidationBucket {
  symbol: SymbolId;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  totalNotionalUsd: number;
  imbalance: number;
  count: number;
  windowMs: number;
}

function parseEvents(raw: string[]): BufferedLiquidationEvent[] {
  const out: BufferedLiquidationEvent[] = [];
  for (const r of raw) {
    try {
      out.push(JSON.parse(r) as BufferedLiquidationEvent);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function bucketFromEvents(symbol: SymbolId, events: BufferedLiquidationEvent[]): LiquidationBucket {
  let buy = 0;
  let sell = 0;
  for (const e of events) {
    if (e.side === "BUY") buy += e.notionalUsd;
    else sell += e.notionalUsd;
  }
  const total = buy + sell;
  // Sign convention matches src/features/signals/engine.ts#liquidationContribution:
  //   imbalance > 0 → shorts being liquidated (bullish for price)
  //   imbalance < 0 → longs being liquidated (bearish for price)
  // A force "BUY" on the order book is a short position being closed, hence positive.
  const imbalance = total > 0 ? (buy - sell) / total : 0;
  return {
    symbol,
    buyNotionalUsd: buy,
    sellNotionalUsd: sell,
    totalNotionalUsd: total,
    imbalance,
    count: events.length,
    windowMs: LIQUIDATION_WINDOW_MS,
  };
}

/**
 * Load the per-symbol liquidation bucket over the last `LIQUIDATION_WINDOW_MS`.
 * Returns `null` if the buffer is empty (e.g. worker not running, or the
 * active broker doesn't expose a public liquidation stream) so callers can
 * treat the contribution as "unavailable" rather than artificially zero.
 */
export async function getLiquidationBucket(symbol: SymbolId): Promise<LiquidationBucket | null> {
  const broker = getServerBroker();
  if (!broker.capabilities.liquidations) return null;
  const pair = broker.pairs.futures[symbol];
  if (!pair) return null;
  const key = REDIS_KEYS.liquidationBuffer(pair);
  const minScore = Date.now() - LIQUIDATION_WINDOW_MS;
  let raw: string[];
  try {
    raw = await redis.zrangeByScore(key, minScore, "+inf");
  } catch (err) {
    console.warn(`[liquidations] zrangebyscore failed for ${key}:`, (err as Error).message);
    return null;
  }
  if (raw.length === 0) return null;
  return bucketFromEvents(symbol, parseEvents(raw));
}

/**
 * Get just the imbalance scalar in [-1, 1] — what `computeSignal()` consumes.
 */
export async function getLiquidationImbalance(symbol: SymbolId): Promise<number | null> {
  const bucket = await getLiquidationBucket(symbol);
  return bucket ? bucket.imbalance : null;
}

/** Convenience: bucket for every tracked symbol. */
export async function getAllLiquidationBuckets(): Promise<Record<SymbolId, LiquidationBucket | null>> {
  const entries = await Promise.all(
    TRACKED_SYMBOLS.map(async (s) => [s.id, await getLiquidationBucket(s.id)] as const),
  );
  return Object.fromEntries(entries) as Record<SymbolId, LiquidationBucket | null>;
}

/** Look up a tracked symbol from the Binance futures pair the worker WS reports. */
export function trackedFromBinanceFutures(pair: string): SymbolId | null {
  return SYMBOLS_BY_BINANCE[pair]?.id ?? null;
}

/**
 * Broker-aware reverse lookup: takes a native pair string from whichever
 * exchange the worker WS subscriber is connected to and returns the tracked
 * `SymbolId`. New code should prefer this over `trackedFromBinanceFutures`.
 */
export function trackedFromBrokerPair(
  brokerId: "binance" | "delta",
  pair: string,
): SymbolId | null {
  return brokerPairToSymbolId(brokerId, pair);
}
