import { NextResponse } from "next/server";
import { getOptionChainBroker, getBrokerById } from "@/services/india/broker/factory";
import { getActiveSelections } from "@/features/settings/active-sources";
import { nse } from "@/services/india/nse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ML_SERVICE_URL = process.env.ML_SERVICE_URL ?? "http://localhost:8100";

/**
 * Attempt to enrich the option chain with real Black-76/BS greeks from the
 * ML service. Returns the enriched strikes array on success, or null if the
 * ML service is unreachable or returns an error. Never throws.
 */
async function fetchEnrichedGreeks(
  chain: Record<string, unknown>,
): Promise<unknown[] | null> {
  try {
    const mlRes = await fetch(`${ML_SERVICE_URL}/analytics/greeks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: chain.strikes,
        spot: chain.underlyingPrice,
        india_vix: 15.0, // use real VIX when available
        expiry_dt: chain.expiry,
      }),
      signal: AbortSignal.timeout(3000), // 3-second timeout
    });
    if (mlRes.ok) {
      const data = (await mlRes.json()) as { strikes?: unknown[] } | unknown[];
      // The endpoint may return the enriched strikes array directly, or wrap
      // them in a { strikes: [...] } object — handle both shapes.
      if (Array.isArray(data)) return data;
      if (data && typeof data === "object" && "strikes" in data && Array.isArray((data as Record<string, unknown>).strikes)) {
        return (data as { strikes: unknown[] }).strikes;
      }
    }
    return null;
  } catch {
    // ML service unreachable — degrade gracefully
    return null;
  }
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

    // Attempt to classify the IV regime via the ML service (Requirement 9.4–9.7).
    // Build the input from the chain data that is already available.
    // Falls back to null when the ML service is down (Requirement 9.7).
    let iv_regime: string | null = null;
    try {
      const ivRes = await fetch(`${ML_SERVICE_URL}/predict/iv-regime`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Provide available chain-derived features; the model uses the last
          // 20 days of {atm_iv, pcr, oi_change, vix, spot_change}.
          // We pass what we have from the current snapshot; the ML service
          // handles missing history gracefully.
          atm_iv: chain.atmIv ?? chain.atm_iv ?? null,
          pcr: chain.pcr ?? chain.putCallRatio ?? null,
          oi_change: chain.oiChange ?? chain.oi_change ?? null,
          vix: chain.indiaVix ?? chain.india_vix ?? null,
          spot_change: chain.underlyingChangePct ?? chain.spot_change ?? null,
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (ivRes.ok) {
        const ivData = (await ivRes.json()) as {
          iv_regime?: string;
          ivRegime?: string;
        };
        const raw = ivData.iv_regime ?? ivData.ivRegime ?? null;
        // Only accept valid classifier outputs
        if (raw === "CRUSH" || raw === "STABLE" || raw === "SPIKE") {
          iv_regime = raw;
        }
      }
    } catch {
      // ML service unreachable — iv_regime stays null (Requirement 9.7)
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
    const chain = await primary.getOptionChain(symbol, expiry);
    return await respondWithChain(chain as Record<string, unknown>, { source: primary.id });
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
