import "server-only";

import { env } from "@/lib/env";

import { binanceServerAdapter } from "./binance/adapter";
import { deltaServerAdapter } from "./delta/adapter";
import type { ServerBrokerAdapter } from "./server-types";
import type { BrokerId } from "./types";

/**
 * Server-side broker selection. Reads `ACTIVE_BROKER` first (the server-only
 * variable), then falls back to the public flag so setting just
 * `NEXT_PUBLIC_ACTIVE_BROKER` already lines both layers up.
 *
 * Default: `delta` (Delta Exchange India INR-settled BTCUSD / ETHUSD /
 * SOLUSD perpetuals).
 */
export function getActiveBrokerId(): BrokerId {
  return env.ACTIVE_BROKER ?? env.NEXT_PUBLIC_ACTIVE_BROKER;
}

const SERVER_ADAPTERS: Record<BrokerId, ServerBrokerAdapter> = {
  binance: binanceServerAdapter,
  delta: deltaServerAdapter,
};

/**
 * Return the server-side adapter for a specific broker, or the currently
 * active one when no `id` is given. Server code should call this once and
 * thread the adapter through; we don't memoize at module scope because the
 * env value is fixed at boot anyway.
 */
export function getServerBroker(id?: BrokerId): ServerBrokerAdapter {
  return SERVER_ADAPTERS[id ?? getActiveBrokerId()];
}

/** Both adapters as a `Record`, for code that needs to enumerate them. */
export const SERVER_BROKERS = SERVER_ADAPTERS;
