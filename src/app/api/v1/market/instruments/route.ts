/**
 * GET /api/v1/market/instruments?exchange=NSE[&instrumentType=EQ][&underlying=NIFTY]
 *
 * Canonical v1 instrument master endpoint.
 * Routes: data-service → Angel One ScripMaster
 *
 * Query params:
 *   exchange        (optional) — default "NSE"
 *   instrumentType  (optional) — EQ | FUTIDX | FUTSTK | OPTIDX | OPTSTK | ETF | IDX
 *   underlying      (optional) — filter by underlying name (for derivatives)
 *
 * Response: { data: Instrument[], metadata: { count, exchange, instrumentType, requestedAt } }
 */

import { NextResponse } from "next/server";
import { DataServiceClient } from "@/lib/data-service/client";
import type { Exchange, InstrumentType } from "@/lib/market-data/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_INSTRUMENT_TYPES: InstrumentType[] = [
  "EQ", "FUTIDX", "FUTSTK", "OPTIDX", "OPTSTK", "ETF", "IDX",
];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const exchange = (searchParams.get("exchange")?.trim() ?? "NSE") as Exchange;
  const instrumentTypeRaw = searchParams.get("instrumentType")?.trim();
  const underlying = searchParams.get("underlying")?.trim().toUpperCase() ?? undefined;

  const instrumentType = instrumentTypeRaw
    ? (instrumentTypeRaw as InstrumentType)
    : undefined;

  if (instrumentType && !VALID_INSTRUMENT_TYPES.includes(instrumentType)) {
    return NextResponse.json(
      {
        error: `Invalid instrumentType "${instrumentType}"`,
        valid: VALID_INSTRUMENT_TYPES,
        code: "INVALID_PARAM",
      },
      { status: 400 },
    );
  }

  const requestedAt = new Date().toISOString();

  try {
    const instruments = await DataServiceClient.market.instruments({
      exchange,
      ...(instrumentType ? { instrumentType } : {}),
      ...(underlying ? { underlying } : {}),
    });

    return NextResponse.json({
      data: instruments,
      metadata: {
        count: instruments.length,
        exchange,
        instrumentType: instrumentType ?? null,
        underlying: underlying ?? null,
        requestedAt,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: msg, code: "PROVIDER_ERROR", requestedAt },
      { status: 502 },
    );
  }
}
