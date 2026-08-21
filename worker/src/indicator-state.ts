/**
 * worker/src/indicator-state.ts
 *
 * Manages Redis-backed persistence of streaming indicator state so that
 * restarted workers can warm-start in ≤ 5 bars rather than recomputing
 * full history from scratch.
 *
 * Design contract (Requirements 1.4, 1.5, 1.6):
 *   - `saveIndicatorState(key, handle)` serialises the indicator handle
 *     via `dumpState()` and stores the JSON blob in Redis with a TTL.
 *   - `loadIndicatorState(key, config)` reads the blob and calls
 *     `restoreState()`, returning a live handle ready to feed bars into.
 *   - Both functions are best-effort — a Redis failure is warned and
 *     swallowed so the worker always makes forward progress.
 *
 * Usage in worker jobs:
 *   On each tick, after fetching fresh candles for a (symbol × timeframe):
 *     1. `loadIndicatorState` — get (or create) a handle.
 *     2. Feed new bars via `feedBar`.
 *     3. `saveIndicatorState` — persist the updated handle for the next tick.
 */

import {
  createIndicators,
  dumpState,
  restoreState,
  type IndicatorConfig,
  type IndicatorHandle,
  type SerializedState,
} from "@/features/indicators";

import { createLogger } from "./log";
import { getRedis } from "./redis";

const log = createLogger("worker:indicator-state");

/** TTL for stored indicator state (24 hours). A worker restart well within
 *  this window gets an exact warm-start; after the TTL the state is dropped
 *  and the first tick recomputes from the full candle window. */
const STATE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Build a Redis key for an indicator state snapshot.
 * e.g. `indicator:state:scalper:BTCUSDT:5m`
 */
export function indicatorStateKey(
  namespace: string,
  symbol: string,
  timeframe: string,
): string {
  return `indicator:state:${namespace}:${symbol}:${timeframe}`;
}

/**
 * Persist an indicator handle to Redis.
 * Best-effort — Redis failures are logged and swallowed.
 */
export async function saveIndicatorState(
  key: string,
  handle: IndicatorHandle,
): Promise<void> {
  try {
    const state = dumpState(handle);
    const redis = getRedis();
    await redis.set(key, JSON.stringify(state), "EX", STATE_TTL_SECONDS);
  } catch (err) {
    log.warn("saveIndicatorState failed", {
      key,
      err: (err as Error).message,
    });
  }
}

/**
 * Restore an indicator handle from Redis.
 * Returns a freshly-created handle if no state is found or Redis fails.
 */
export async function loadIndicatorState(
  key: string,
  config: IndicatorConfig,
): Promise<IndicatorHandle> {
  try {
    const redis = getRedis();
    const raw = await redis.get(key);
    if (raw) {
      const state = JSON.parse(raw) as SerializedState;
      const handle = restoreState(state, config);
      log.info("restored indicator state", { key });
      return handle;
    }
  } catch (err) {
    log.warn("loadIndicatorState failed — creating fresh handle", {
      key,
      err: (err as Error).message,
    });
  }
  return createIndicators(config);
}
