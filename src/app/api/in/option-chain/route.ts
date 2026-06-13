import { NextResponse } from "next/server";
import { getOptionChainBroker, getBrokerById } from "@/services/india/broker/factory";
import { getActiveSelections } from "@/features/settings/active-sources";
import { nse } from "@/services/india/nse";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const expiry = searchParams.get("expiry") ?? undefined;

  const selections = await getActiveSelections();
  const primary = getOptionChainBroker(selections.india.optionChain);

  const attempts: { id: string; error: string }[] = [];

  try {
    const chain = await primary.getOptionChain(symbol, expiry);
    return NextResponse.json(
      { ...chain, source: primary.id },
      { headers: { "Cache-Control": "no-store" } },
    );
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
        return NextResponse.json(
          { ...chain, source: b.id, fallbackFrom: primary.id },
          { headers: { "Cache-Control": "no-store" } },
        );
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
