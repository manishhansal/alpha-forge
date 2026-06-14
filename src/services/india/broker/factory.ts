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
    case "angel":
      return angel;
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
 * Live-data preference weight for the quote/history/feed routes. First-party
 * broker adapters (Angel One, Groww) serve real-time data straight from the
 * exchange, so when a user keeps them selected alongside the public defaults
 * we auto-prefer them — no need to manually uncheck Yahoo/NSE to prioritise
 * a broker. Equal-weight sources keep their selected order (stable sort), so
 * the historical "first selected wins" behaviour is preserved for the public
 * pair (yahoo/nse). Unconfigured brokers degrade gracefully to Yahoo inside
 * their own adapter, so preferring a keyless broker is harmless.
 */
const INDIA_PICK_WEIGHT: Partial<Record<DataSourceId, number>> = {
  angel: 3,
  groww: 2,
};

function pickWeight(id: DataSourceId): number {
  return INDIA_PICK_WEIGHT[id] ?? 1;
}

/**
 * Walk a user's selection list and return the highest-priority adapter that's
 * actually wired up (see {@link INDIA_PICK_WEIGHT}). Falls back to Yahoo so a
 * brand-new user (no selections) still gets a working dashboard.
 */
export function pickBroker(
  ids: readonly DataSourceId[] | undefined,
): BrokerAdapter {
  if (ids && ids.length > 0) {
    const ordered = [...ids].sort((a, b) => pickWeight(b) - pickWeight(a));
    for (const id of ordered) {
      const a = getBrokerById(id);
      if (a) return a;
    }
  }
  return yahoo;
}

/**
 * Resolve a user's selection list into the ordered, de-duped chain of wired-up
 * adapters (highest {@link INDIA_PICK_WEIGHT} first). The selected-source-only
 * resolver walks this chain, so backfill only ever uses sources the user
 * actually picked. Falls back to a Yahoo-only chain when nothing is selected
 * so a brand-new user still gets data.
 */
export function pickBrokerChain(
  ids: readonly DataSourceId[] | undefined,
): BrokerAdapter[] {
  if (!ids || ids.length === 0) return [yahoo];
  const ordered = [...ids].sort((a, b) => pickWeight(b) - pickWeight(a));
  const out: BrokerAdapter[] = [];
  const seen = new Set<string>();
  for (const id of ordered) {
    const a = getBrokerById(id);
    if (a && !seen.has(a.id)) {
      out.push(a);
      seen.add(a.id);
    }
  }
  return out.length > 0 ? out : [yahoo];
}

export { yahoo, nse, groww, angel };
