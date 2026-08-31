/**
 * Live feed service.
 *
 * Manages subscriptions to live market data ticks. Consumers register
 * callbacks here; the service handles provider selection, failover on
 * repeated disconnects, and tick validation.
 *
 * Provider preference: Angel One SmartStream → Upstox WebSocket → NSE polling
 * → Yahoo polling.
 */

import { registry } from "../registry";
import type { Exchange, LiveTick, SubscribeRequest, SubscriptionMode } from "../types";
import { validateTick } from "../validation/tick-validator";
import { mdLog, recordStaleData, STALE_THRESHOLDS_MS } from "../health";

export type LiveFeedSubscription = {
  /** Call this to stop receiving ticks. */
  unsubscribe: () => void;
};

export type LiveFeedOptions = {
  mode?: SubscriptionMode;
  /**
   * Drop ticks that fail validation. Default: true.
   * Set to false if you want to handle raw/invalid ticks yourself.
   */
  validateTicks?: boolean;
  /**
   * Emit stale ticks anyway but log them. Default: false (stale ticks dropped).
   */
  allowStaleTicks?: boolean;
};

/**
 * Subscribe to live ticks for a set of instruments.
 *
 * @param tokens    Array of { token, exchange } objects.
 * @param onTick    Called for each valid, non-stale tick.
 * @param onError   Called on non-fatal provider errors.
 * @param options   Feed options.
 * @returns         An object with an `unsubscribe` method.
 */
export function subscribeLiveFeed(
  tokens: Array<{ token: string; exchange: Exchange }>,
  onTick: (tick: LiveTick) => void,
  onError?: (err: unknown) => void,
  options?: LiveFeedOptions,
): LiveFeedSubscription {
  const shouldValidate = options?.validateTicks ?? true;
  const allowStale = options?.allowStaleTicks ?? false;
  const mode: SubscriptionMode = options?.mode ?? "quote";

  const req: SubscribeRequest = { tokens, mode };

  const handleTick = (tick: LiveTick) => {
    if (!shouldValidate) {
      onTick(tick);
      return;
    }

    const result = validateTick(tick);
    if (!result.valid) {
      mdLog("stale_data", {
        reason: "invalid_tick",
        error: result.error,
        token: tick.token,
        detail: result.detail,
      });
      return;
    }

    if (result.stale) {
      const age = Date.now() - tick.exchangeTimestampMs;
      recordStaleData(tick.provider, age, STALE_THRESHOLDS_MS.liveTick);
      if (!allowStale) return;
    }

    onTick(tick);
  };

  const teardown = registry.subscribe(req, handleTick, onError);

  return {
    unsubscribe: () => {
      teardown();
      registry.unsubscribe(tokens.map((t) => t.token));
    },
  };
}
