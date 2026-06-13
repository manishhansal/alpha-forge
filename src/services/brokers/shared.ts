import { TRACKED_SYMBOLS } from "@/lib/constants";
import { env } from "@/lib/env";
import type { SymbolId } from "@/types/market";

import type { BrokerId } from "./types";

/**
 * Universal accessor for the active broker id that works in both server and
 * client components. Reads `NEXT_PUBLIC_ACTIVE_BROKER` (which is mirrored
 * from `ACTIVE_BROKER` on the server side via the env loader). Default:
 * `delta`.
 */
export function getActiveBrokerIdShared(): BrokerId {
  return env.NEXT_PUBLIC_ACTIVE_BROKER;
}

const DISPLAY_NAME: Record<BrokerId, string> = {
  binance: "Binance",
  delta: "Delta Exchange India",
};

export function getBrokerDisplayName(id?: BrokerId): string {
  return DISPLAY_NAME[id ?? getActiveBrokerIdShared()];
}

/**
 * Resolve the native pair string for a tracked symbol on the active (or
 * specified) broker — usable from any component without needing the full
 * server adapter or client adapter import.
 */
export function getBrokerPair(
  symbol: SymbolId,
  kind: "spot" | "futures",
  brokerId?: BrokerId,
): string {
  const id = brokerId ?? getActiveBrokerIdShared();
  const meta = TRACKED_SYMBOLS.find((s) => s.id === symbol);
  if (!meta) return "";
  return meta.brokers[id][kind];
}
