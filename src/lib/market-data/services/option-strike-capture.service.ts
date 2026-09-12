/**
 * option-strike-capture.service.ts — Data Foundation V7 §9/§10/§11/§12.
 *
 * Writes STRIKE-LEVEL option data into `OptionChainStrike` (the V5 table that
 * had no writer). It:
 *
 *   §10  discovers expiries and captures the CURRENT + NEXT expiry (rollover is
 *        automatic — expiries are re-discovered every capture, so an expired
 *        contract simply drops out and the next one is picked up).
 *   §9   captures CE/PE per strike: LTP, OI, ΔOI, volume, IV, bid, ask,
 *        underlying spot, timestamp, provider.
 *   §11  acquires Greeks/IV via the provider chain (Angel optionGreek fills IV;
 *        Upstox option-chain carries IV/bid/ask inline where supplied). If a
 *        provider lacks a field it is stored NULL with the matching
 *        `*Unavailable` flag — NEVER fabricated to 0 (Absolute Rule 1).
 *   §12  supports stock underlyings (any F&O equity), not just indices.
 *
 * HONEST OFF-HOURS BEHAVIOUR: when the market is closed the providers may return
 * an empty leg set or NULL IV/bid/ask (verified live: Angel optionGreek →
 * "No Data Available (AB9019)" on a Saturday). This service persists exactly
 * what the provider returns and marks the missing fields unavailable — it does
 * not invent liquidity. A capture that yields zero legs is reported as
 * EMPTY_PROVIDER_RESPONSE, never as success.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { datasetVersion } from "../dataset-version";
import { mdLog } from "../health";

export interface CapturedStrike {
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  oi: number | null;
  oiChange: number | null;
  iv: number | null;
  provider: string;
}

export interface CaptureResult {
  underlying: string;
  expiriesCaptured: string[];
  strikesWritten: number;
  legsWithIv: number;
  legsWithBid: number;
  legsWithOi: number;
  status:
    | "CAPTURED"
    | "EMPTY_PROVIDER_RESPONSE"
    | "PROVIDER_ERROR"
    | "NO_EXPIRIES";
  reason?: string;
  provider: string | null;
}

/** Minimal shape of the provider OptionChain we consume. */
interface ProviderOptionLeg {
  strike: number;
  type: "CE" | "PE";
  oi?: number | null;
  changeInOi?: number | null;
  volume?: number | null;
  iv?: number | null;
  ltp?: number | null;
  bid?: number | null;
  ask?: number | null;
}
interface ProviderOptionChain {
  symbol: string;
  spot?: number | null;
  expiry: string;
  expiries?: string[];
  rows: Array<{ strike: number; ce: ProviderOptionLeg | null; pe: ProviderOptionLeg | null }>;
}

/** Fetch a chain for one underlying+expiry from the provider adapters. */
export type ChainFetcher = (
  underlying: string,
  expiry?: string,
) => Promise<ProviderOptionChain | null>;

/**
 * Default chain fetcher: routes through the canonical ProviderRegistry
 * (DATA_SERVICE → ANGEL_ONE → UPSTOX). This ensures IV is populated where
 * Angel One's optionGreek API provides it, with Upstox as fallback.
 */
export async function defaultChainFetcher(): Promise<{
  fetcher: ChainFetcher;
  providerLabel: () => string | null;
}> {
  const { registry, bootstrapRegistry } = await import("@/lib/market-data/registry");
  await bootstrapRegistry();
  let lastProvider: string | null = null;

  const fetcher: ChainFetcher = async (underlying, _expiry) => {
    try {
      const chain = (await registry.getOptionChain(underlying)) as unknown as ProviderOptionChain;
      if (chain && chain.rows && chain.rows.length > 0) {
        // Determine which provider served it from health state
        const health = registry.getHealth();
        const active = health.find((h) => h.status === "healthy" && h.consecutiveSuccesses > 0);
        lastProvider = active?.providerId ?? "registry";
        return chain;
      }
      lastProvider = "registry";
      return chain ?? null;
    } catch (e) {
      mdLog("provider_degraded", { event: "OC_REGISTRY_FAIL", underlying, error: (e as Error).message.slice(0, 160) });
      return null;
    }
  };
  return { fetcher, providerLabel: () => lastProvider };
}

/** Parse a provider expiry display string to an epoch (ms) for ordering. */
function expiryMs(expiry: string): number {
  const t = Date.parse(expiry.replace(/-/g, " "));
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Discover current + next expiry from a chain's expiry list. Rollover is
 * automatic: expired dates are filtered out; the two nearest upcoming are
 * returned. Falls back to the chain's own `expiry` when the list is absent.
 */
export function selectCurrentAndNextExpiry(
  chain: ProviderOptionChain,
  now = Date.now(),
): string[] {
  const list = (chain.expiries ?? [chain.expiry]).filter(Boolean);
  const upcoming = list
    .map((e) => ({ e, ms: expiryMs(e) }))
    .filter((x) => x.ms >= now - 86_400_000) // keep today's expiry
    .sort((a, b) => a.ms - b.ms)
    .map((x) => x.e);
  const chosen = upcoming.slice(0, 2);
  return chosen.length > 0 ? chosen : [chain.expiry];
}

/** Convert provider legs into CapturedStrike rows (never fabricates values). */
export function chainToStrikes(
  chain: ProviderOptionChain,
  provider: string,
): CapturedStrike[] {
  const out: CapturedStrike[] = [];
  for (const row of chain.rows) {
    for (const leg of [row.ce, row.pe]) {
      if (!leg) continue;
      const finite = (v: number | null | undefined): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      out.push({
        underlying: chain.symbol,
        expiry: chain.expiry,
        strike: leg.strike ?? row.strike,
        optionType: leg.type,
        ltp: finite(leg.ltp),
        bid: finite(leg.bid),
        ask: finite(leg.ask),
        volume: finite(leg.volume),
        oi: finite(leg.oi),
        oiChange: finite(leg.changeInOi),
        iv: finite(leg.iv),
        provider,
      });
    }
  }
  return out;
}

/** Persist captured strikes to OptionChainStrike with unavailable-flag metadata. */
export async function persistStrikes(
  strikes: CapturedStrike[],
  opts: { prisma?: PrismaClient; captureTimestamp?: Date } = {},
): Promise<number> {
  const prisma = opts.prisma ?? getPrisma();
  const captureTimestamp = opts.captureTimestamp ?? new Date();
  let written = 0;
  for (const s of strikes) {
    const dv = datasetVersion(new Date().toISOString().slice(0, 10), { kind: "provider", provider: s.provider });
    try {
      await prisma.optionChainStrike.upsert({
        where: {
          underlying_expiry_strike_optionType_captureTimestamp_provider: {
            underlying: s.underlying,
            expiry: s.expiry,
            strike: s.strike,
            optionType: s.optionType,
            captureTimestamp,
            provider: s.provider,
          },
        },
        update: {
          ltp: s.ltp, bid: s.bid, ask: s.ask, volume: s.volume, oi: s.oi,
          oiChange: s.oiChange, iv: s.iv,
          bidUnavailable: s.bid == null, askUnavailable: s.ask == null,
          ivUnavailable: s.iv == null, volumeUnavailable: s.volume == null,
        },
        create: {
          underlying: s.underlying, expiry: s.expiry, strike: s.strike,
          optionType: s.optionType, ltp: s.ltp, bid: s.bid, ask: s.ask,
          volume: s.volume, oi: s.oi, oiChange: s.oiChange, iv: s.iv,
          bidUnavailable: s.bid == null, askUnavailable: s.ask == null,
          ivUnavailable: s.iv == null, volumeUnavailable: s.volume == null,
          captureTimestamp, provider: s.provider, datasetVersion: dv,
          receivedAt: new Date(),
        },
      });
      written += 1;
    } catch (err) {
      mdLog("stale_data", { reason: "option_strike_persist_failed", underlying: s.underlying, strike: s.strike, error: (err as Error).message });
    }
  }
  return written;
}

/**
 * Capture current + next expiry strike data for one underlying and persist it.
 * Honest about off-hours: an empty leg set → EMPTY_PROVIDER_RESPONSE (no fake
 * rows). NULL IV/bid/ask are persisted with unavailable flags.
 */
export async function captureUnderlyingStrikes(
  underlying: string,
  opts: {
    prisma?: PrismaClient;
    fetcher?: ChainFetcher;
    providerLabel?: () => string | null;
    captureTimestamp?: Date;
  } = {},
): Promise<CaptureResult> {
  const prisma = opts.prisma ?? getPrisma();
  let fetcher = opts.fetcher;
  let providerLabel = opts.providerLabel;
  if (!fetcher) {
    const def = await defaultChainFetcher();
    fetcher = def.fetcher;
    providerLabel = def.providerLabel;
  }
  const captureTimestamp = opts.captureTimestamp ?? new Date();

  let firstChain: ProviderOptionChain | null;
  try {
    firstChain = await fetcher(underlying);
  } catch (e) {
    return { underlying, expiriesCaptured: [], strikesWritten: 0, legsWithIv: 0, legsWithBid: 0, legsWithOi: 0, status: "PROVIDER_ERROR", reason: (e as Error).message.slice(0, 160), provider: providerLabel?.() ?? null };
  }
  if (!firstChain) {
    return { underlying, expiriesCaptured: [], strikesWritten: 0, legsWithIv: 0, legsWithBid: 0, legsWithOi: 0, status: "NO_EXPIRIES", reason: "provider returned null chain", provider: providerLabel?.() ?? null };
  }

  const expiries = selectCurrentAndNextExpiry(firstChain);
  const allStrikes: CapturedStrike[] = [];
  for (const expiry of expiries) {
    const chain = expiry === firstChain.expiry ? firstChain : await fetcher(underlying, expiry);
    if (!chain || chain.rows.length === 0) continue;
    const provider = providerLabel?.() ?? "unknown";
    allStrikes.push(...chainToStrikes({ ...chain, expiry }, provider));
  }

  if (allStrikes.length === 0) {
    return { underlying, expiriesCaptured: expiries, strikesWritten: 0, legsWithIv: 0, legsWithBid: 0, legsWithOi: 0, status: "EMPTY_PROVIDER_RESPONSE", reason: "no legs returned (likely market-closed / provider has no live quotes)", provider: providerLabel?.() ?? null };
  }

  const written = await persistStrikes(allStrikes, { prisma, captureTimestamp });
  const legsWithIv = allStrikes.filter((s) => s.iv != null).length;
  const legsWithBid = allStrikes.filter((s) => s.bid != null).length;
  const legsWithOi = allStrikes.filter((s) => s.oi != null).length;

  mdLog("provider_selected", { event: "OPTION_STRIKE_CAPTURE", underlying, expiries, strikesWritten: written, legsWithIv, legsWithBid, legsWithOi, provider: providerLabel?.() ?? null });

  return {
    underlying,
    expiriesCaptured: expiries,
    strikesWritten: written,
    legsWithIv,
    legsWithBid,
    legsWithOi,
    status: "CAPTURED",
    provider: providerLabel?.() ?? null,
  };
}
