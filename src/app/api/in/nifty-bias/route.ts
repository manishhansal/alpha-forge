import { NextResponse } from "next/server";
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

interface NiftyBiasQuoteSummary {
  price?: {
    regularMarketPrice?: number;
  };
  summaryDetail?: {
    previousClose?: number;
    fiftyDayAverage?: number;
  };
}

export async function GET() {
  try {
    const q = (await yahooFinance.quoteSummary("^NSEI", {
      modules: ["price", "summaryDetail"],
    })) as NiftyBiasQuoteSummary;

    const price =
      q?.price?.regularMarketPrice ?? q?.summaryDetail?.previousClose ?? 0;
    const avg50 = q?.summaryDetail?.fiftyDayAverage ?? 0;

    const bias =
      price && avg50 ? (price > avg50 ? "BULLISH" : "BEARISH") : "-";

    return NextResponse.json({
      bias,
      price: Number(price).toFixed(2),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Nifty API Error:", msg);

    return NextResponse.json({
      bias: "ERROR",
      price: "-",
    });
  }
}
