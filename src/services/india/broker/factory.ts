import type { BrokerAdapter } from "./types";
import type { DataSourceId } from "@/features/settings/data-sources-shared";
import { yahoo } from "../yahoo";
import { nse } from "../nse";
import { groww } from "../groww";
import { angel, isAngelConfigured } from "../angelone";

/**
 * Returns the active broker adapter, picked from the BROKER env var. Used as
 * the fallback resolver when no per-user selection is available:
 *   - "yahoo"  → public Yahoo Finance (default)
 *   - "groww"  → Groww Trade API (transparent fallback to Yahoo if no keys)
 *   - "nse"    → NSE direct (only useful for option-chain via getOptionChain)
 *
 * Future adapters (Zerodha, Upstox, Angel One, Shoonya) plug in here.
 */
export function getBroker(): BrokerAdapter {
  const id = (process.env.INDIA_BROKER ?? process.env.BROKER ?? "yahoo").toLowerCase();
  switch (id) {
    case "groww":
      return groww;
    case "nse":
      return nse;
    case "yahoo":
    default:
      return yahoo;
  }
}

/**
 * Always returns the adapter that knows how to fetch option chains.
 * Preference order:
 *   1. The user's explicit `id` if it resolves to a real adapter.
 *   2. Angel One SmartAPI if its env credentials are present (most reliable
 *      free option-chain source — first-party API, no scraping).
 *   3. NSE library (`stock-nse-india`) as the universal fallback.
 *
 * The `/api/in/option-chain` route still iterates the user's wider selection
 * list after the primary fails, so this just sets the first attempt.
 */
export function getOptionChainBroker(id?: DataSourceId): BrokerAdapter {
  if (id) {
    const explicit = getBrokerById(id);
    if (explicit) return explicit;
  }
  if (isAngelConfigured()) return angel;
  return nse;
}

/**
 * Resolve any catalog id to a concrete adapter. Unknown / not-yet-wired ids
 * (bse, zerodha…) return `null` so callers can fall through to whatever
 * default makes sense for their use case rather than swallow the request.
 */
export function getBrokerById(id?: DataSourceId | null): BrokerAdapter | null {
  switch (id) {
    case "yahoo":
      return yahoo;
    case "nse":
      return nse;
    case "groww":
      return groww;
    case "angel":
      return angel;
    // bse + zerodha are catalogued in the UI but not yet implemented; the
    // resolver returns null so the caller can fall back to a default.
    default:
      return null;
  }
}

/**
 * Walk a user's selection list and return the first adapter that's actually
 * wired up. Falls back to Yahoo so a brand-new user (no selections) still
 * gets a working dashboard.
 */
export function pickBroker(
  ids: readonly DataSourceId[] | undefined,
): BrokerAdapter {
  if (ids) {
    for (const id of ids) {
      const a = getBrokerById(id);
      if (a) return a;
    }
  }
  return yahoo;
}

export { yahoo, nse, groww, angel };
