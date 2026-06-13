import { NextResponse } from "next/server";
import {
  FNO_INDICES,
  FNO_OPTION_UNDERLYINGS,
  FNO_STOCKS,
  SYMBOL_SECTORS,
} from "@/lib/india/fno-symbols";

export const dynamic = "force-dynamic";

/**
 * GET /api/in/fno-list
 *
 * Returns the F&O universe used everywhere in the Indian-market surface:
 * 4 index underlyings + every F&O stock (with primary sector).
 */
export async function GET() {
  return NextResponse.json({
    indices: FNO_INDICES,
    stocks: FNO_STOCKS.map((symbol) => ({
      symbol,
      sectors: SYMBOL_SECTORS[symbol] ?? [],
    })),
    optionUnderlyings: FNO_OPTION_UNDERLYINGS,
    count: {
      indices: FNO_INDICES.length,
      stocks: FNO_STOCKS.length,
    },
  });
}
