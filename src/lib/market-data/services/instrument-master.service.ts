/**
 * Instrument master service.
 *
 * Provides token lookup and instrument metadata for NSE/NFO instruments.
 * Angel One (ScripMaster) is the primary source; the service caches the
 * result for 12h per the market-cache TTL.
 */

import { registry } from "../registry";
import type { Exchange, Instrument, InstrumentMasterFilter, InstrumentType } from "../types";
import type { ProviderCallOptions } from "../provider";

/**
 * Fetch instrument master rows matching the given filter.
 *
 * Returns an empty array when no provider can serve the request.
 */
export async function getInstruments(
  filter?: InstrumentMasterFilter,
  opts?: ProviderCallOptions,
): Promise<Instrument[]> {
  try {
    return await registry.getInstrumentMaster(filter, opts);
  } catch {
    return [];
  }
}

/**
 * Find a single instrument by trading symbol and exchange.
 * Returns null when not found.
 */
export async function findInstrument(
  tradingSymbol: string,
  exchange: Exchange,
  opts?: ProviderCallOptions,
): Promise<Instrument | null> {
  const instruments = await getInstruments({ exchange }, opts);
  return instruments.find((i) => i.tradingSymbol === tradingSymbol) ?? null;
}

/**
 * Find all option contracts for an underlying + expiry combination.
 * Returns CE and PE contracts sorted by strike.
 */
export async function getOptionInstruments(
  underlying: string,
  expiry: string,
  exchange: Extract<Exchange, "NFO" | "BFO"> = "NFO",
  opts?: ProviderCallOptions,
): Promise<Instrument[]> {
  const instruments = await getInstruments(
    { exchange, underlying, instrumentType: "OPTIDX" },
    opts,
  );
  const equityOptions = await getInstruments(
    { exchange, underlying, instrumentType: "OPTSTK" },
    opts,
  );

  return [...instruments, ...equityOptions]
    .filter((i) => i.expiry === expiry)
    .sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0));
}

/**
 * Find all futures for an underlying + expiry combination.
 */
export async function getFutureInstruments(
  underlying: string,
  exchange: Extract<Exchange, "NFO" | "BFO"> = "NFO",
  opts?: ProviderCallOptions,
): Promise<Instrument[]> {
  const idx = await getInstruments(
    { exchange, underlying, instrumentType: "FUTIDX" },
    opts,
  );
  const stk = await getInstruments(
    { exchange, underlying, instrumentType: "FUTSTK" },
    opts,
  );
  return [...idx, ...stk].sort((a, b) => {
    const aMs = a.expiry ? Date.parse(a.expiry) : Infinity;
    const bMs = b.expiry ? Date.parse(b.expiry) : Infinity;
    return aMs - bMs;
  });
}
