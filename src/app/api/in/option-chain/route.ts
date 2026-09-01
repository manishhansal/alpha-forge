import { NextResponse } from "next/server";
import { getOptionChainBroker, getBrokerById } from "@/services/india/broker/factory";
import { getActiveSelections } from "@/features/settings/active-sources";
import { nse } from "@/services/india/nse";
import { redis } from "@/lib/redis";
import {
  validateOptionChain,
  sanitizeOptionChain,
  withOptionChainFallback,
} from "@/lib/chaos/option-chain-resilience";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? "http://localhost:8100";
void ML_SERVICE_URL; // kept for any direct URL references below

import { fetchOptionChainGreeks, predictIVRegime } from "@/lib/india/ml-client";

/**
 * Attempt to enrich the option chain with real Black-76/BS greeks from the
 * ML service. Returns the enriched strikes array on success, or null if the
 * ML service is unreachable or returns an error. Never throws.
 *
 * Routes through ml-client.ts (fetchOptionChainGreeks) which respects ML_MODE.
 */
async function fetchEnrichedGreeks(
  chain: Record<string, unknown>,
): Promise<unknown[] | null> {
  return fetchOptionChainGreeks({
    chain: (chain.strikes as unknown[]) ?? [],
    spot: (chain.underlyingPrice as number) ?? 0,
    india_vix: 15.0, // use real VIX when available
    expiry_dt: (chain.expiry as string) ?? "",
  });
}

/**
 * GET /api/in/option-chain?symbol=NIFTY&expiry=YYYY-MM-DD
 *
 * Returns the option chain + PCR/IV/Max-pain analytics for the requested
 * F&O underlying. Cached server-side for 20s.
 *
 * Source preference: honours the user's `india.optionChain` setting (NSE
 * direct by default; Groww or BSE if they opted in and the adapter is
 * implemented). Falls back to NSE if the chosen adapter throws — the chain
 * is the most important Indian-market widget and we never want the page to
 * surface a hard failure when an alternate source is available.
 *
 * When the ML service is reachable, per-strike greeks are enriched with real
 * Black-76/BS values. The `iv_regime` field is always present (null until
 * Task 11.3 wires in the IV classifier).
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const expiry = searchParams.get("expiry") ?? undefined;

  const selections = await getActiveSelections();
  const primary = getOptionChainBroker(selections.india.optionChain);

  const attempts: { id: string; error: string }[] = [];

  /**
   * Merge real greeks from the ML service into a successfully-fetched chain,
   * then return the enriched response. `iv_regime: null` is always added.
   */
  async function respondWithChain(
    chain: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<ReturnType<typeof NextResponse.json>> {
    const enrichedStrikes = await fetchEnrichedGreeks(chain);

    // Attempt to classify the IV regime via the ml-client (Requirement 9.4–9.7).
    // Routes through predictIVRegime() which respects ML_MODE and centralises
    // timeout/retry logic. Falls back to null when the ML service is down.
    let iv_regime: string | null = null;
    try {
      // Build a minimal 1-row feature matrix from the current snapshot.
      // In production this should be a 20-day rolling history; the model
      // handles a 1-row input gracefully by returning the heuristic fallback.
      const atm_iv = Number(chain.atmIv ?? chain.atm_iv ?? 0);
      const pcr = Number(chain.pcr ?? chain.putCallRatio ?? 1);
      const oi_change = Number(chain.oiChange ?? chain.oi_change ?? 0);
      const vix = Number(chain.indiaVix ?? chain.india_vix ?? 15);
      const spot_change = Number(chain.underlyingChangePct ?? chain.spot_change ?? 0);
      const ivResult = await predictIVRegime({
        data: [[atm_iv, pcr, oi_change, vix, spot_change]],
      });
      const raw = ivResult?.iv_regime ?? null;
      if (raw === "CRUSH" || raw === "STABLE" || raw === "SPIKE") {
        iv_regime = raw;
      }
    } catch {
      // Graceful degradation — iv_regime stays null (Requirement 9.7)
    }

    const payload: Record<string, unknown> = {
      ...chain,
      ...extra,
      // Overwrite strikes with ML-enriched greeks when available; otherwise
      // keep the broker's original strikes (Angel One delta/gamma fallback).
      strikes: enrichedStrikes ?? chain.strikes,
      // iv_regime from the PatchTST classifier, or null when unavailable.
      iv_regime,
    };

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    // ── Chaos Scenario 15: withOptionChainFallback wraps the primary fetch.
    // On partial/empty chain it serves the last-good Redis snapshot instead
    // of surfacing a blank chain to the client.
    //
    // Normalize: some broker adapters (and test stubs) return `strikes` instead
    // of `rows`. Map to the canonical shape before validation.
    function normalizeBrokerChain(raw: unknown): import("@/types/india").OptionChain {
      const chain = raw as Record<string, unknown>;
      if (!chain.rows && Array.isArray(chain.strikes)) {
        return { ...chain, rows: chain.strikes } as import("@/types/india").OptionChain;
      }
      return chain as import("@/types/india").OptionChain;
    }

    const { chain: rawChain, fromCache, partial } = await withOptionChainFallback(
      symbol,
      expiry ?? "nearest",
      async () => normalizeBrokerChain(await primary.getOptionChain(symbol, expiry)),
      redis,
    );

    // Validate and log completeness for observability
    const validation = validateOptionChain(rawChain);
    if (!validation.valid) {
      console.warn("[option-chain] serving partial chain", {
        symbol,
        expiry,
        reason: validation.reason,
        strikeCount: validation.strikeCount,
        fromCache,
      });
    }

    // Sanitize non-finite option-level values before sending to the client
    const chain = sanitizeOptionChain(rawChain);
    return await respondWithChain(chain as unknown as Record<string, unknown>, {
      source: primary.id,
      fromCache,
      partial,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    attempts.push({ id: primary.id, error: msg });
    console.warn(`[option-chain] ${primary.id} failed for ${symbol}: ${msg}`);

    // Try the next OI-capable source from the user's selection list (skip
    // the one we just tried). NSE is always the last-resort fallback.
    const fallbacks = selections.india.selected
      .map((id) => getBrokerById(id))
      .filter((b): b is NonNullable<ReturnType<typeof getBrokerById>> =>
        Boolean(b) && b!.id !== primary.id,
      );
    if (!fallbacks.some((b) => b.id === "nse")) fallbacks.push(nse);

    for (const b of fallbacks) {
      try {
        const chain = await b.getOptionChain(symbol, expiry);
        return await respondWithChain(chain as Record<string, unknown>, {
          source: b.id,
          fallbackFrom: primary.id,
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        attempts.push({ id: b.id, error: m });
        console.warn(`[option-chain] ${b.id} failed for ${symbol}: ${m}`);
      }
    }

    return NextResponse.json(
      {
        error: attempts[0]?.error ?? "Failed to fetch option chain",
        symbol,
        attempts,
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
