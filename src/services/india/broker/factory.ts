import type { BrokerAdapter } from "./types";
import type { DataSourceId } from "@/features/settings/data-sources-shared";
import { yahoo } from "../yahoo";
import { groww } from "../groww";
import { angel, isAngelConfigured } from "../angelone";
import { OpenAlgoAdapter } from "./openalgo-adapter";

// NOTE: The `nse` adapter was removed 2026-09-03.
// Direct NSE data acquisition is prohibited. Use ProviderRegistry instead.
// The stub below prevents compile errors in code not yet migrated.
import { nse } from "../nse";

/**
 * Lazily construct the OpenAlgo adapter from environment variables.
 * Returns null when OPENALGO_BASE_URL or OPENALGO_API_KEY are not set.
 */
function getOpenAlgoAdapter(): BrokerAdapter | null {
  const baseUrl = process.env.OPENALGO_BASE_URL;
  const apiKey = process.env.OPENALGO_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return new OpenAlgoAdapter(baseUrl, apiKey);
}

/**
 * Returns the active broker adapter.
 *
 * Valid values for INDIA_BROKER: yahoo (default) | groww | angel | openalgo
 *
 * "nse" is no longer a valid INDIA_BROKER value. Direct NSE data acquisition
 * was removed 2026-09-03. Passing "nse" falls through to yahoo.
 */
export function getBroker(): BrokerAdapter {
  const id = (process.env.INDIA_BROKER ?? process.env.BROKER ?? "yahoo").toLowerCase();
  switch (id) {
    case "groww":
      return groww;
    case "angel":
      return angel;
    case "openalgo": {
      const adapter = getOpenAlgoAdapter();
      if (!adapter) throw new Error("OPENALGO_BASE_URL and OPENALGO_API_KEY must be set when INDIA_BROKER=openalgo");
      return adapter;
    }
    case "nse":
      // NSE direct acquisition removed. Fallthrough to yahoo.
      console.warn("[broker/factory] INDIA_BROKER=nse is no longer supported. Falling back to yahoo.");
      return yahoo;
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
 *      first-party API, no scraping required).
 *   3. Yahoo Finance (no option chain support — will throw; failover runs).
 *
 * For production option chain access, use ProviderRegistry.getOptionChain()
 * which routes through DATA_SERVICE → ANGEL_ONE → UPSTOX.
 */
export function getOptionChainBroker(id?: DataSourceId): BrokerAdapter {
  if (id) {
    const explicit = getBrokerById(id);
    if (explicit) return explicit;
  }
  if (isAngelConfigured()) return angel;
  return yahoo;
}

/**
 * Resolve any catalog id to a concrete adapter. Unknown / not-yet-wired ids
 * (bse, zerodha, nse) return `null` so callers can fall through to whatever
 * default makes sense for their use case rather than swallow the request.
 */
export function getBrokerById(id?: DataSourceId | null): BrokerAdapter | null {
  switch (id) {
    case "yahoo":
      return yahoo;
    case "nse":
      // NSE direct adapter removed — return null so callers fall back to yahoo/angel
      return null;
    case "groww":
      return groww;
    case "angel":
      return angel;
    case "openalgo":
      return getOpenAlgoAdapter();
    // bse + zerodha are catalogued in the UI but not yet implemented; the
    // resolver returns null so the caller can fall back to a default.
    default:
      return null;
  }
}

/**
 * Live-data preference weight for the quote/history/feed routes.
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
 * actually wired up. Falls back to Yahoo so a brand-new user (no selections)
 * still gets a working dashboard.
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
 * adapters (highest weight first). Falls back to Yahoo-only chain.
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
