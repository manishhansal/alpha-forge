/**
 * Normalization utilities for the Indian Market Data layer.
 *
 * All timestamps are stored internally as UTC. Convert to IST only at the
 * UI boundary using `utcToIst()`.
 *
 * IST = UTC + 05:30 (no DST).
 */

import type { Exchange, Interval, OHLCVCandle, ProviderId } from "./types";

// ── UTC ↔ IST conversion ─────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000; // +05:30

/**
 * Convert a UTC ISO-8601 string to an IST ISO-8601 string.
 * Use ONLY at the UI boundary — keep UTC internally.
 */
export function utcToIst(utcIso: string): string {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return utcIso;
  return new Date(ms + IST_OFFSET_MS).toISOString().replace("Z", "+05:30");
}

/**
 * Convert an IST ISO-8601 string (with "+05:30" offset) to a UTC ISO-8601 string.
 *
 * `Date.parse()` in JavaScript correctly handles timezone offsets — a string
 * like "2024-01-01T05:30:00.000+05:30" is already interpreted as UTC midnight.
 * We simply let the runtime do the work.
 */
export function istToUtc(istIso: string): string {
  const ms = Date.parse(istIso);
  if (!Number.isFinite(ms)) return istIso;
  return new Date(ms).toISOString();
}

/**
 * SmartAPI getCandleData expects `YYYY-MM-DD HH:mm` in IST.
 * Convert a UTC epoch ms to that string.
 */
export function toSmartApiDateTime(utcMs: number): string {
  const ist = new Date(utcMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const mo = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${hh}:${mm}`;
}

/**
 * Parse a SmartAPI `YYYY-MM-DD HH:mm` IST string to UTC epoch ms.
 */
export function fromSmartApiDateTime(istStr: string): number {
  // Parse as UTC, then subtract IST offset to get true UTC.
  const ms = Date.parse(istStr.replace(" ", "T") + ":00Z");
  return ms - IST_OFFSET_MS;
}

/**
 * Parse a Upstox ISO-8601 timestamp (already UTC) to UTC epoch ms.
 * Upstox timestamps are in UTC with "Z" suffix.
 */
export function fromUpstoxTimestamp(ts: string): number {
  return Date.parse(ts);
}

// ── NSE expiry string normalisation ──────────────────────────────────────────

const MONTH_ABBR = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/**
 * Parse a raw NSE/SmartAPI expiry string to UTC epoch ms.
 *
 * Accepts:
 *   - "28MAY2026"   (SmartAPI ScripMaster)
 *   - "28-MAY-2026" (NSE canonical)
 *   - "28-MAY-26"   (two-digit year)
 *   - "2026-05-28"  (ISO-8601 — already normalised, pass through)
 */
export function parseExpiryToUtcMs(raw: string): number {
  if (!raw) return Infinity;

  // ISO-8601 YYYY-MM-DD — already UTC date
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Date.UTC(
      Number(raw.slice(0, 4)),
      Number(raw.slice(5, 7)) - 1,
      Number(raw.slice(8, 10)),
    );
  }

  const cleaned = raw.replace(/-/g, "").toUpperCase();
  const m = /^(\d{1,2})([A-Z]{3})(\d{2,4})$/.exec(cleaned);
  if (!m) return Infinity;

  const day = Number(m[1]);
  const month = MONTH_ABBR.indexOf(m[2]);
  if (month < 0) return Infinity;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return Date.UTC(year, month, day);
}

/**
 * Normalise any expiry format to ISO-8601 `YYYY-MM-DD` (UTC date).
 * Returns the input unchanged when it cannot be parsed.
 */
export function normaliseExpiry(raw: string): string {
  const ms = parseExpiryToUtcMs(raw);
  if (!Number.isFinite(ms)) return raw;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dy = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

/**
 * Format a UTC epoch ms back to the NSE canonical "DD-MMM-YYYY" display format.
 */
export function formatExpiryDmy(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTH_ABBR[d.getUTCMonth()] ?? "???";
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

// ── Symbol normalisation ──────────────────────────────────────────────────────

/**
 * Strip the ".NS" or ".BO" Yahoo Finance suffix from a symbol.
 * Returns the NSE-canonical form (e.g. "RELIANCE.NS" → "RELIANCE").
 */
export function stripYahooSuffix(symbol: string): string {
  return symbol.replace(/\.(NS|BO)$/i, "");
}

/**
 * Add the Yahoo Finance ".NS" suffix for NSE equities.
 * Index proxies (^NSEI etc.) are returned unchanged.
 */
export function toYahooSymbol(symbol: string): string {
  if (symbol.startsWith("^") || symbol.includes(".")) return symbol;
  return `${symbol}.NS`;
}

// ── Candle normalisation ──────────────────────────────────────────────────────

/** SmartAPI getCandleData tuple: [isoTimestamp, o, h, l, c, v]. */
export type AngelCandleTuple = [string, number, number, number, number, number];

/**
 * Parse SmartAPI candle tuples into canonical `OHLCVCandle[]`.
 * Timestamps are converted from IST to UTC epoch seconds.
 * Malformed rows are silently skipped.
 */
export function normaliseCandlesFromAngel(
  rows: AngelCandleTuple[],
  provider: ProviderId = "angel_one",
): OHLCVCandle[] {
  void provider; // reserved for future provenance tracking
  const out: OHLCVCandle[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    // Angel timestamps are IST, but Date.parse treats them as UTC if no offset.
    // SmartAPI format is "YYYY-MM-DD HH:mm" (no Z/offset) — it's IST.
    const rawMs = Date.parse(r[0]);
    if (!Number.isFinite(rawMs)) continue;
    // Subtract IST offset to get true UTC.
    const utcSec = Math.floor((rawMs - IST_OFFSET_MS) / 1_000);
    const open = r[1], high = r[2], low = r[3], close = r[4], volume = r[5];
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    out.push({ time: utcSec, open, high, low, close, volume: volume ?? 0 });
  }
  return out;
}

/** Upstox candle row from the historical API. */
export type UpstoxCandleRow = {
  timestamp: string; // ISO-8601 UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
};

/**
 * Normalise Upstox candle rows into canonical `OHLCVCandle[]`.
 */
export function normaliseCandlesFromUpstox(
  rows: UpstoxCandleRow[],
): OHLCVCandle[] {
  const out: OHLCVCandle[] = [];
  for (const r of rows) {
    const ms = Date.parse(r.timestamp);
    if (!Number.isFinite(ms)) continue;
    out.push({
      time: Math.floor(ms / 1_000),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      ...(r.oi != null ? { oi: r.oi } : {}),
    });
  }
  return out;
}

// ── Interval mapping ──────────────────────────────────────────────────────────

/** Map a canonical `Interval` to a SmartAPI getCandleData enum string.
 *  Returns null for intervals SmartAPI doesn't support (1w, 1M, 3m, 10m). */
export function intervalToSmartApi(interval: Interval): string | null {
  const map: Partial<Record<Interval, string>> = {
    "1m": "ONE_MINUTE",
    "3m": "THREE_MINUTE",
    "5m": "FIVE_MINUTE",
    "10m": "TEN_MINUTE",
    "15m": "FIFTEEN_MINUTE",
    "30m": "THIRTY_MINUTE",
    "1h": "ONE_HOUR",
    "1d": "ONE_DAY",
  };
  return map[interval] ?? null;
}

/** Map a canonical `Interval` to the Upstox historical API interval string. */
export function intervalToUpstox(interval: Interval): string | null {
  const map: Partial<Record<Interval, string>> = {
    "1m": "1minute",
    "3m": "3minute",
    "5m": "5minute",
    "10m": "10minute",
    "15m": "15minute",
    "30m": "30minute",
    "1h": "1hour",
    "1d": "day",
    "1w": "week",
    "1M": "month",
  };
  return map[interval] ?? null;
}

/** Map a canonical `Interval` to a Yahoo Finance chart interval string. */
export function intervalToYahoo(
  interval: Interval,
): "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "1wk" | "1mo" {
  const map: Record<Interval, "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "1wk" | "1mo"> = {
    "1m": "1m",
    "3m": "5m",    // no 3m on Yahoo, round up
    "5m": "5m",
    "10m": "15m",  // no 10m on Yahoo, round up
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "1d": "1d",
    "1w": "1wk",
    "1M": "1mo",
  };
  return map[interval];
}

// ── Exchange mapping ──────────────────────────────────────────────────────────

/** Map our canonical `Exchange` to a SmartAPI exchange string. */
export function exchangeToSmartApi(exchange: Exchange): string {
  const map: Record<Exchange, string> = {
    NSE: "NSE",
    NFO: "NFO",
    BSE: "BSE",
    BFO: "BFO",
    MCX: "MCX",
    CDS: "CDS",
  };
  return map[exchange];
}

/** Map our canonical `Exchange` to an Upstox exchange string. */
export function exchangeToUpstox(exchange: Exchange): string {
  const map: Record<Exchange, string> = {
    NSE: "NSE_EQ",
    NFO: "NSE_FO",
    BSE: "BSE_EQ",
    BFO: "BSE_FO",
    MCX: "MCX_FO",
    CDS: "NSE_CD",
  };
  return map[exchange];
}

// ── Number helpers ────────────────────────────────────────────────────────────

/** Return `v` if it is a finite number, else null. */
export function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Convert paisa (integer 100ths of a rupee) to INR. */
export function paisaToRupee(paisa: number): number {
  return paisa / 100;
}
