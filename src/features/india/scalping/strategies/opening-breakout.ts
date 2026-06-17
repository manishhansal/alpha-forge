import "server-only";

import { FNO_INDICES } from "@/lib/india/fno-symbols";
import { cache } from "@/services/india/cache";
import { nse } from "@/services/india/nse";
import { yahoo } from "@/services/india/yahoo";
import type { OptionChainAnalytics } from "@/types/india/options";

import { buildOpeningBreakoutSignal } from "@/features/india/scalping/strategies/opening-breakout-core";
import type {
  IndiaScalpSignal,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

/**
 * IO orchestrator for the **Opening Breakout** F&O strategy. Fetches each
 * underlying's 5-min candles (Yahoo) + an option chain (NSE) for the index /
 * leader names, folds them into the pure builder in `opening-breakout-core.ts`,
 * and returns confirmed-first, confidence-ranked signals.
 *
 * Kept separate from `fetch-signals.ts` (scanner-backed) and `positioning.ts`
 * (option-positioning) so the three signal families evolve independently and
 * the pure scoring core stays unit-testable without the network.
 */

interface OrbUniverseEntry {
  /** NSE ticker without `.NS` and the `IndiaScalpSignal.symbol` value. */
  symbol: string;
  symbolName: string;
  /** Yahoo ticker used for the 5-min chart (e.g. "^NSEI", "RELIANCE"). */
  yahooSymbol: string;
  /** NSE option-chain underlying (for PCR / OI / max-pain confirmation). */
  optionUnderlying: string;
}

/**
 * Liquid F&O cash names that respect opening-range geometry. Kept compact so
 * the 5-min fan-out stays fast / within Yahoo rate limits.
 */
const ORB_STOCKS = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "SBIN",
  "AXISBANK",
  "KOTAKBANK",
  "LT",
  "ITC",
  "BHARTIARTL",
  "HINDUNILVR",
  "BAJFINANCE",
  "MARUTI",
  "TATAMOTORS",
  "ADANIENT",
] as const;

/** Names we pull an option chain for (indices + the most liquid leaders). */
const ORB_CHAIN_LEADERS = new Set<string>([
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "SBIN",
]);

const DEFAULT_LIMIT = 10;

function buildOrbUniverse(): OrbUniverseEntry[] {
  const indices: OrbUniverseEntry[] = FNO_INDICES.map((i) => ({
    symbol: i.underlying,
    symbolName: i.name,
    yahooSymbol: i.symbol,
    optionUnderlying: i.underlying,
  }));
  const stocks: OrbUniverseEntry[] = ORB_STOCKS.map((s) => ({
    symbol: s,
    symbolName: s,
    yahooSymbol: s,
    optionUnderlying: s,
  }));
  return [...indices, ...stocks];
}

export interface GetIndiaOpeningBreakoutOptions {
  timeframe: IndiaScalpTimeframe;
  /** Max signals after the confirmed-first / confidence sort. */
  limit?: number;
}

/**
 * Run the Opening Breakout scan across the F&O universe. Resilient: a single
 * failing chart / chain is skipped (the rest survive). Cached for 30s per
 * timeframe so the strategies feed + Daily Picks share one fan-out.
 */
export async function getIndiaOpeningBreakoutSignals(
  options: GetIndiaOpeningBreakoutOptions,
): Promise<IndiaScalpSignal[]> {
  const timeframe = options.timeframe;
  const all = await cache.memo(
    `scalp:opening-breakout:v2:${timeframe}`,
    30_000,
    async () => {
      const universe = buildOrbUniverse();

      // Option-chain confirmation for indices + leader stocks only.
      const chainEntries = universe.filter(
        (u) =>
          FNO_INDICES.some((i) => i.underlying === u.optionUnderlying) ||
          ORB_CHAIN_LEADERS.has(u.symbol),
      );
      const analyticsBySymbol = new Map<string, OptionChainAnalytics>();
      const chainResults = await Promise.allSettled(
        chainEntries.map((u) => nse.getOptionChain(u.optionUnderlying)),
      );
      chainResults.forEach((res, idx) => {
        if (res.status === "fulfilled") {
          analyticsBySymbol.set(
            chainEntries[idx].optionUnderlying,
            res.value.analytics,
          );
        }
      });

      const settled = await Promise.allSettled(
        universe.map(async (u) => {
          const candles = await yahoo.getHistorical({
            symbol: u.yahooSymbol,
            interval: "5m",
            range: "5d",
          });
          return buildOpeningBreakoutSignal({
            symbol: u.symbol,
            symbolName: u.symbolName,
            timeframe,
            candles,
            analytics: analyticsBySymbol.get(u.optionUnderlying) ?? null,
          });
        }),
      );

      const signals: IndiaScalpSignal[] = [];
      for (const res of settled) {
        if (res.status === "fulfilled" && res.value) signals.push(res.value);
        else if (res.status === "rejected") {
          console.warn("[india/scalping/opening-breakout]", res.reason);
        }
      }

      // Confirmed (retested) setups lead, then by confidence.
      signals.sort(
        (a, b) =>
          Number(b.confirmed) - Number(a.confirmed) ||
          b.confidence - a.confidence,
      );
      return signals;
    },
  );

  const limit = clampLimit(options.limit);
  return all.slice(0, limit);
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(50, Math.trunc(raw)));
}
