import "server-only";

import { z } from "zod";

const DERIBIT_REST = "https://www.deribit.com/api/v2";

async function safeFetch<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Deribit request failed: ${res.status} ${res.statusText} (${url})`);
  }
  const json: unknown = await res.json();
  return schema.parse(json);
}

const bookSummaryEntrySchema = z.object({
  instrument_name: z.string(),
  mid_price: z.number().nullable(),
  bid_price: z.number().nullable(),
  ask_price: z.number().nullable(),
  last: z.number().nullable(),
  mark_price: z.number().nullable(),
  mark_iv: z.number().nullable().optional(),
  open_interest: z.number().nullable(),
  volume: z.number().nullable(),
  volume_usd: z.number().nullable().optional(),
  underlying_index: z.string().nullable().optional(),
  underlying_price: z.number().nullable().optional(),
  base_currency: z.string(),
  quote_currency: z.string(),
});

const bookSummaryResponseSchema = z.object({
  result: z.array(bookSummaryEntrySchema),
});

export type DeribitOptionType = "C" | "P";

export interface DeribitOptionInstrument {
  instrumentName: string;
  baseCurrency: string;
  expiryTs: number;
  strike: number;
  optionType: DeribitOptionType;
  markPrice: number;
  markIv: number;
  openInterest: number;
  volume: number;
  volumeUsd: number;
  underlyingPrice: number;
  last: number;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export interface ParsedInstrument {
  baseCurrency: string;
  expiryTs: number;
  strike: number;
  optionType: DeribitOptionType;
}

/** Parse e.g. "BTC-31MAY26-100000-C" → { base, expiryTs, strike, optionType }. */
export function parseInstrumentName(name: string): ParsedInstrument | null {
  const parts = name.split("-");
  if (parts.length !== 4) return null;
  const [base, expiryStr, strikeStr, type] = parts;
  if (type !== "C" && type !== "P") return null;
  const m = expiryStr.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const monthIdx = MONTHS[m[2]];
  if (monthIdx === undefined) return null;
  const year = 2000 + Number(m[3]);
  // Deribit options expire at 08:00 UTC on the expiry date
  const expiryTs = Date.UTC(year, monthIdx, day, 8, 0, 0);
  const strike = Number(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { baseCurrency: base, expiryTs, strike, optionType: type };
}

export type DeribitCurrency = "BTC" | "ETH" | "SOL";

export async function fetchOptionsBookSummary(
  currency: DeribitCurrency,
): Promise<DeribitOptionInstrument[]> {
  const url = `${DERIBIT_REST}/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
  const data = await safeFetch(url, bookSummaryResponseSchema);
  return data.result.flatMap((row) => {
    const parsed = parseInstrumentName(row.instrument_name);
    if (!parsed) return [];
    return [
      {
        instrumentName: row.instrument_name,
        baseCurrency: parsed.baseCurrency,
        expiryTs: parsed.expiryTs,
        strike: parsed.strike,
        optionType: parsed.optionType,
        markPrice: row.mark_price ?? 0,
        markIv: row.mark_iv ?? 0,
        openInterest: row.open_interest ?? 0,
        volume: row.volume ?? 0,
        volumeUsd: row.volume_usd ?? 0,
        underlyingPrice: row.underlying_price ?? 0,
        last: row.last ?? 0,
      },
    ];
  });
}

const indexPriceSchema = z.object({
  result: z.object({
    index_price: z.number(),
  }),
});

export async function fetchIndexPrice(currency: DeribitCurrency): Promise<number> {
  const indexName = `${currency.toLowerCase()}_usd`;
  const url = `${DERIBIT_REST}/public/get_index_price?index_name=${indexName}`;
  const data = await safeFetch(url, indexPriceSchema);
  return data.result.index_price;
}
