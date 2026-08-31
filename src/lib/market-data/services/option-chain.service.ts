/**
 * Option chain service.
 *
 * Single entry point for fetching option chains. Consumers call this — never
 * call Angel One, Upstox, or NSE directly.
 *
 * Routing: Angel One → Upstox → NSE. Yahoo is never used for F&O.
 */

import { registry } from "../registry";
import type { OptionChain, ProviderId } from "../types";
import type { ProviderCallOptions } from "../provider";
import { mdLog } from "../health";

export type OptionChainOptions = ProviderCallOptions & {
  /**
   * If provided, only try providers in this list (in order). Overrides the
   * default priority chain. Useful for testing or explicit provider pinning.
   */
  preferProviders?: ProviderId[];
};

/**
 * Fetch the option chain for an F&O underlying.
 *
 * @param underlying  NSE symbol (e.g. "NIFTY", "BANKNIFTY", "RELIANCE").
 * @param expiry      Optional ISO-8601 date string. When omitted, nearest expiry.
 * @throws            When all option-chain-capable providers fail.
 */
export async function getOptionChain(
  underlying: string,
  expiry?: string,
  opts?: OptionChainOptions,
): Promise<OptionChain> {
  return registry.getOptionChain(underlying, expiry, opts);
}

/**
 * Fetch the nearest-expiry option chain.
 */
export async function getNearestExpiryOptionChain(
  underlying: string,
  opts?: OptionChainOptions,
): Promise<OptionChain> {
  return getOptionChain(underlying, undefined, opts);
}

/**
 * Fetch option chains for multiple underlyings concurrently.
 * Returns null for underlyings where all providers failed.
 */
export async function getOptionChains(
  underlyings: string[],
  expiry?: string,
  opts?: OptionChainOptions,
): Promise<Array<OptionChain | null>> {
  return Promise.all(
    underlyings.map(async (u) => {
      try {
        return await getOptionChain(u, expiry, opts);
      } catch (err) {
        mdLog("provider_failure", {
          operationId: "getOptionChains",
          underlying: u,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );
}
