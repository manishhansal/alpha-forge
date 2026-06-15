/**
 * Expiry-day index trades — builder (I/O layer).
 *
 * Surfaces the Gamma Blast / Hero Zero plays for the index that is expiring
 * *today* — and nothing on any other day. Expiry detection and premiums are
 * driven by live option chains where we have them:
 *   - NIFTY  → the NSE option chain's nearest expiry + LTPs.
 *   - SENSEX → the BSE (BFO) chain synthesised by the Angel One adapter, gated
 *              behind the Thursday weekday so the rate-limited per-strike
 *              quoting only runs on plausible expiry days. Falls back to the
 *              weekday rule + spot/VIX estimate when Angel One isn't configured.
 *
 * Post Sep-2025 SEBI realignment:
 *   - NIFTY (NSE) weekly + monthly expiry → Tuesday
 *   - SENSEX (BSE) weekly + monthly expiry → Thursday
 * (Holiday shifts to the previous trading day are handled automatically when a
 * live chain is available; the SENSEX weekday pre-gate does not model holidays.)
 *
 * Resilient: a failing data source degrades that index to an estimated-premium
 * read (or drops it) rather than failing the whole response.
 */

import "server-only";

import { getBestTimeStatus } from "@/features/india/best-time/engine";
import { istDateKey } from "@/features/india/daily-picks/engine";
import { yahoo } from "@/services/india/yahoo";
import { nse } from "@/services/india/nse";
import { angel, isAngelConfigured } from "@/services/india/angelone";
import { cache as indiaCache } from "@/services/india/cache";
import type { OptionChain } from "@/types/india";

import {
  buildIndexExpiryTrades,
  isExpiryDayFromChain,
  istWeekday,
  type ExpiryIndex,
  type ExpiryIndexBlock,
  type ExpiryOptionType,
} from "./engine";

const CACHE_TTL_MS = 30_000;

/** IST weekly-expiry weekday per index (0=Sun … 6=Sat). */
const EXPIRY_WEEKDAY: Record<ExpiryIndex, number> = {
  NIFTY: 2, // Tuesday (NSE)
  SENSEX: 4, // Thursday (BSE)
};

const STRIKE_STEP: Record<ExpiryIndex, number> = {
  NIFTY: 50,
  SENSEX: 100,
};

/** Yahoo proxy tickers for the index spot. */
const SPOT_SYMBOL: Record<ExpiryIndex, string> = {
  NIFTY: "^NSEI",
  SENSEX: "^BSESN",
};

export interface ExpiryTradesResponse {
  market: "india";
  generatedAt: number;
  tradeDate: string;
  /** True when at least one supported index expires today. */
  isExpiryDay: boolean;
  inActiveWindow: boolean;
  indexes: ExpiryIndexBlock[];
  note: string;
}

/** Hours left from `now` to the 15:30 IST expiry settlement (floored at 0.25). */
function hoursToExpiryIST(now: number): number {
  const ist = new Date(now + 5.5 * 60 * 60 * 1000);
  const minsNow = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const mins = 15 * 60 + 30 - minsNow;
  return Math.max(0.25, mins / 60);
}

/** Directional bias in [-1, 1] from the index's intraday change. */
function biasFromChange(changePct: number | null | undefined): number {
  const c = changePct ?? 0;
  return Math.max(-1, Math.min(1, c / 0.8));
}

/** Build a strike → {CE ltp, PE ltp} premium lookup from a live chain. */
function chainPremiumLookup(
  chain: OptionChain,
): (strike: number, type: ExpiryOptionType) => number | null {
  const byStrike = new Map<number, { ce: number | null; pe: number | null }>();
  for (const row of chain.rows) {
    byStrike.set(row.strike, {
      ce: row.ce?.ltp ?? null,
      pe: row.pe?.ltp ?? null,
    });
  }
  return (strike, type) => {
    const slot = byStrike.get(strike);
    if (!slot) return null;
    return type === "CE" ? slot.ce : slot.pe;
  };
}

/** Resolve the NIFTY block from the live NSE chain (authoritative expiry). */
async function buildNiftyBlock(
  now: number,
  tradeDate: string,
  vix: number | null,
): Promise<ExpiryIndexBlock | null> {
  try {
    const chain = await nse.getOptionChain("NIFTY");
    const isExpiry = isExpiryDayFromChain(chain.expiry, tradeDate);
    if (!isExpiry) return null;

    const spot = chain.spot ?? (await yahoo.getQuote("^NSEI")).price ?? 0;
    if (!spot) return null;
    const quote = await yahoo.getQuote("^NSEI");
    const bias = biasFromChange(quote.changePct);
    const ivPct = chain.analytics.atmIv ?? vix;

    const trades = buildIndexExpiryTrades({
      index: "NIFTY",
      spot,
      bias,
      step: STRIKE_STEP.NIFTY,
      ivPct,
      hoursToExpiry: hoursToExpiryIST(now),
      expiry: chain.expiry,
      dataSource: "chain",
      premiumAt: chainPremiumLookup(chain),
    });

    return {
      index: "NIFTY",
      spot,
      expiry: chain.expiry,
      bias,
      dataSource: "chain",
      trades,
      note: "Premiums from the live NSE option chain.",
    };
  } catch {
    // Chain unavailable — fall back to the Tuesday weekday rule + estimates.
    return buildEstimatedBlock("NIFTY", now, tradeDate, vix);
  }
}

/**
 * Resolve the SENSEX block from the live BSE option chain (synthesised by the
 * Angel One adapter from the BFO scrip subset). Cheap-gated on the Thursday
 * weekly-expiry weekday first so we don't pay the rate-limited per-strike
 * quoting on the other four days, then confirmed by the chain's nearest
 * expiry. Falls back to the spot + VIX estimate when Angel One isn't
 * configured or the chain is unreachable.
 */
async function buildSensexBlock(
  now: number,
  tradeDate: string,
  vix: number | null,
): Promise<ExpiryIndexBlock | null> {
  // Cheap pre-gate: the Angel chain synthesis bulk-quotes hundreds of legs at
  // 1 req/s, so only attempt it on the BSE weekly-expiry weekday.
  if (istWeekday(new Date(now)) !== EXPIRY_WEEKDAY.SENSEX) return null;
  if (!isAngelConfigured()) {
    return buildEstimatedBlock("SENSEX", now, tradeDate, vix);
  }
  try {
    const chain = await angel.getOptionChain("SENSEX");
    if (!isExpiryDayFromChain(chain.expiry, tradeDate)) return null;

    // Angel may not resolve the SENSEX index spot token — prefer the chain's
    // spot, fall back to the Yahoo ^BSESN quote (also used for the bias).
    const quote = await yahoo.getQuote("^BSESN");
    const spot = chain.spot ?? quote.price ?? 0;
    if (!spot) return null;
    const bias = biasFromChange(quote.changePct);
    const ivPct = chain.analytics.atmIv ?? vix;

    const trades = buildIndexExpiryTrades({
      index: "SENSEX",
      spot,
      bias,
      step: STRIKE_STEP.SENSEX,
      ivPct,
      hoursToExpiry: hoursToExpiryIST(now),
      expiry: chain.expiry,
      dataSource: "chain",
      premiumAt: chainPremiumLookup(chain),
    });

    return {
      index: "SENSEX",
      spot,
      expiry: chain.expiry,
      bias,
      dataSource: "chain",
      trades,
      note: "Premiums from the live BSE option chain (Angel One).",
    };
  } catch {
    // Chain unavailable — fall back to the Thursday weekday rule + estimates.
    return buildEstimatedBlock("SENSEX", now, tradeDate, vix);
  }
}

/**
 * Resolve a block from spot + VIX only (no chain). Used for SENSEX always, and
 * for NIFTY when the chain is unreachable. Gated on the index's fixed weekly-
 * expiry weekday.
 */
async function buildEstimatedBlock(
  index: ExpiryIndex,
  now: number,
  tradeDate: string,
  vix: number | null,
): Promise<ExpiryIndexBlock | null> {
  if (istWeekday(new Date(now)) !== EXPIRY_WEEKDAY[index]) return null;
  try {
    const quote = await yahoo.getQuote(SPOT_SYMBOL[index]);
    const spot = quote.price ?? 0;
    if (!spot) return null;
    const bias = biasFromChange(quote.changePct);

    const trades = buildIndexExpiryTrades({
      index,
      spot,
      bias,
      step: STRIKE_STEP[index],
      ivPct: vix,
      hoursToExpiry: hoursToExpiryIST(now),
      expiry: tradeDate,
      dataSource: "estimated",
      // No chain — engine uses the Black-Scholes ATM estimate.
    });

    return {
      index,
      spot,
      expiry: tradeDate,
      bias,
      dataSource: "estimated",
      trades,
      note:
        index === "SENSEX"
          ? "Premiums estimated from spot + India VIX (live BSE chain unavailable)."
          : "Premiums estimated (NSE chain unavailable).",
    };
  } catch {
    return null;
  }
}

/**
 * Build the expiry-trades board. Returns `isExpiryDay: false` with no index
 * blocks on a non-expiry day — the UI section then renders nothing.
 */
export async function getIndiaExpiryTrades(): Promise<ExpiryTradesResponse> {
  return indiaCache.memo("expiry-trades:v1", CACHE_TTL_MS, async () => {
    const now = Date.now();
    const tradeDate = istDateKey(new Date(now));

    const status = getBestTimeStatus();
    const inActiveWindow =
      status.active.slug !== "off" && status.active.slug !== "worst";

    let vix: number | null = null;
    try {
      vix = (await yahoo.getQuote("^INDIAVIX")).price ?? null;
    } catch {
      vix = null;
    }

    const [nifty, sensex] = await Promise.all([
      buildNiftyBlock(now, tradeDate, vix),
      buildSensexBlock(now, tradeDate, vix),
    ]);

    const indexes = [nifty, sensex].filter(
      (b): b is ExpiryIndexBlock => b != null && b.trades.length > 0,
    );

    return {
      market: "india",
      generatedAt: now,
      tradeDate,
      isExpiryDay: indexes.length > 0,
      inActiveWindow,
      indexes,
      note:
        indexes.length > 0
          ? "Expiry-day plays — defined-risk option buys. Strictly intraday, square off by 15:20."
          : "No index expires today. Gamma Blast / Hero Zero plays appear only on NIFTY (Tue) and SENSEX (Thu) expiry days.",
    };
  });
}
