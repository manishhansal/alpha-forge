/**
 * chaos/option-chain-resilience.ts
 *
 * Chaos Engineering – Scenario 15: Partial Option Chain
 *
 * Provides:
 *  - validateOptionChain()   : detect partial/missing data, compute completeness
 *  - sanitizeOptionChain()   : replace non-finite values in legs, log corruption
 *  - withOptionChainFallback(): wrap the primary fetch; fall back to the last
 *                               known good snapshot stored in Redis
 *
 * Design decisions
 * ────────────────
 * • NSE rate-limits aggressively.  The two-path fetch in nse/index.ts already
 *   retries once; here we add a Redis-backed "last good" fallback so the
 *   dashboard never shows a blank option chain.
 * • "Partial chain" is defined as: fewer than MIN_STRIKES strikes, or more than
 *   MISSING_LEG_THRESHOLD_PCT of strike rows missing both CE and PE legs.
 * • Non-finite option-level values (IV, OI, LTP) are replaced with null so
 *   the UI can render a grey placeholder rather than "NaN" text.
 */

import type { OptionChain, OptionChainRow } from "@/types/india";
import type { RedisLike } from "@/lib/redis";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum number of strike rows for a chain to be considered "complete". */
const MIN_STRIKES = 10;

/** Fraction of rows that may have both legs missing before we classify the
 *  chain as partial. 0.30 = up to 30 % can be single-leg (one-sided market
 *  is normal near expiry). */
const MISSING_LEG_THRESHOLD = 0.40;

/** Redis key for last-known-good chain snapshots. */
function lastGoodKey(symbol: string, expiry: string): string {
  return `oc:last-good:${symbol}:${expiry}`;
}

/** TTL in seconds for last-good cache (1 trading session). */
const LAST_GOOD_TTL = 8 * 60 * 60;

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ChainValidationResult {
  valid: boolean;
  partial: boolean;
  strikeCount: number;
  missingLegCount: number;
  missingLegPct: number;
  reason?: string;
}

/**
 * Assess whether an `OptionChain` is complete enough to act on.
 */
export function validateOptionChain(
  chain: OptionChain | null | undefined,
): ChainValidationResult {
  if (!chain) {
    return {
      valid: false,
      partial: false,
      strikeCount: 0,
      missingLegCount: 0,
      missingLegPct: 0,
      reason: "chain is null or undefined",
    };
  }

  const rows: OptionChainRow[] = chain.rows ?? [];
  const strikeCount = rows.length;

  if (strikeCount < MIN_STRIKES) {
    return {
      valid: false,
      partial: true,
      strikeCount,
      missingLegCount: strikeCount,
      missingLegPct: 1,
      reason: `only ${strikeCount} strikes — minimum ${MIN_STRIKES} required`,
    };
  }

  const missingLegRows = rows.filter((r) => !r.ce && !r.pe);
  const missingLegCount = missingLegRows.length;
  const missingLegPct = missingLegCount / strikeCount;

  if (missingLegPct > MISSING_LEG_THRESHOLD) {
    return {
      valid: false,
      partial: true,
      strikeCount,
      missingLegCount,
      missingLegPct,
      reason: `${(missingLegPct * 100).toFixed(1)}% of strikes missing both legs`,
    };
  }

  if (!chain.spot || !Number.isFinite(chain.spot) || chain.spot <= 0) {
    return {
      valid: false,
      partial: true,
      strikeCount,
      missingLegCount,
      missingLegPct,
      reason: `invalid spot price: ${chain.spot}`,
    };
  }

  return { valid: true, partial: false, strikeCount, missingLegCount, missingLegPct };
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

type OptionLegLike = Record<string, unknown>;

function sanitizeLeg(leg: OptionLegLike | null | undefined): OptionLegLike | null {
  if (!leg) return null;
  const out = { ...leg };
  for (const field of [
    "ltp", "iv", "oi", "oiChange", "volume", "bidQty", "askQty",
    "bid", "ask", "delta", "gamma", "theta", "vega",
  ]) {
    const v = out[field];
    if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) {
      console.warn(
        `[option-chain] non-finite/negative value sanitized: leg.${field}=${v}`,
      );
      out[field] = null;
    }
  }
  return out;
}

/**
 * Walk every strike row and sanitize non-finite/negative values in CE and PE
 * legs.  Returns a new chain object (does not mutate in place).
 */
export function sanitizeOptionChain(chain: OptionChain): OptionChain {
  const sanitizedRows = chain.rows.map((row) => ({
    ...row,
    ce: row.ce ? (sanitizeLeg(row.ce as OptionLegLike) as typeof row.ce) : row.ce,
    pe: row.pe ? (sanitizeLeg(row.pe as OptionLegLike) as typeof row.pe) : row.pe,
  }));
  return { ...chain, rows: sanitizedRows };
}

// ─── Redis last-good-snapshot fallback ───────────────────────────────────────

/**
 * Fetch the option chain using `fetchFn`.
 *
 * On success: persist the chain to Redis as the "last good" snapshot, return it.
 * On failure or partial chain: attempt to serve the last-good snapshot from Redis.
 * If no snapshot exists: rethrow the original error.
 *
 * Always validates + sanitizes the returned chain.
 */
export async function withOptionChainFallback(
  symbol: string,
  expiry: string,
  fetchFn: () => Promise<OptionChain>,
  redis: RedisLike,
): Promise<{ chain: OptionChain; fromCache: boolean; partial: boolean }> {
  let chain: OptionChain | null = null;
  let fetchError: Error | null = null;

  try {
    chain = await fetchFn();
  } catch (err) {
    fetchError = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[option-chain] primary fetch failed for ${symbol}/${expiry}: ${fetchError.message}`,
    );
  }

  // Validate freshly fetched chain
  if (chain) {
    const validation = validateOptionChain(chain);
    if (!validation.valid) {
      console.warn(
        `[option-chain] partial/invalid chain for ${symbol}/${expiry}: ${validation.reason}`,
        { strikeCount: validation.strikeCount, missingLegPct: validation.missingLegPct },
      );
      // Return partial chain with fromCache=false, partial=true so callers
      // can log and serve degraded data instead of a blank response.
      // Only fall through to Redis when we have zero usable data.
      if (validation.strikeCount === 0) {
        // No data at all — fall through to Redis fallback
        chain = null;
      } else {
        // Some data — sanitize and return as partial
        const sanitized = sanitizeOptionChain(chain);
        return { chain: sanitized, fromCache: false, partial: true };
      }
    } else {
      // Chain is good — sanitize values and persist as last-good
      const sanitized = sanitizeOptionChain(chain);
      try {
        const key = lastGoodKey(symbol, expiry);
        await redis.set(key, JSON.stringify(sanitized), "EX", LAST_GOOD_TTL);
      } catch (e) {
        console.warn(
          `[option-chain] failed to persist last-good snapshot: ${(e as Error).message}`,
        );
      }
      return { chain: sanitized, fromCache: false, partial: false };
    }
  }

  // Attempt Redis fallback
  const key = lastGoodKey(symbol, expiry);
  let cached: OptionChain | null = null;
  try {
    const raw = await redis.get(key);
    if (raw) {
      cached = JSON.parse(raw) as OptionChain;
      const validation = validateOptionChain(cached);
      console.warn(
        `[option-chain] serving last-good-snapshot for ${symbol}/${expiry}`,
        {
          fetchedAt: cached.fetchedAt,
          valid: validation.valid,
          strikeCount: validation.strikeCount,
        },
      );
      const sanitized = sanitizeOptionChain(cached);
      return { chain: sanitized, fromCache: true, partial: !validation.valid };
    }
  } catch (cacheErr) {
    console.warn(
      `[option-chain] Redis fallback failed: ${(cacheErr as Error).message}`,
    );
  }

  // Nothing to return — rethrow original error
  if (fetchError) throw fetchError;
  throw new Error(`[option-chain] no data available for ${symbol}/${expiry}`);
}
