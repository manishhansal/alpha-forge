/**
 * Angel One SmartAPI broker adapter — option-chain primary.
 *
 * SmartAPI doesn't expose a single "option chain" endpoint; we synthesise one
 * by combining three calls:
 *
 *   1. ScripMaster (cached 24h)  — the full instrument dump. We filter it
 *      down to OPTIDX/OPTSTK rows for the requested underlying + expiry to
 *      get the per-strike CE/PE tokens.
 *   2. Quote API (batched 50/req) — OI, LTP, traded volume per token.
 *   3. Option Greeks API (1 call) — IV per strike (the Quote API doesn't
 *      ship IV).
 *
 * Auth is `clientcode + password + TOTP` → JWT cached until midnight IST.
 *
 * When `SMARTAPI_*` env vars are missing the adapter throws a clear "not
 * configured" error so the route-level fallback chain picks up the NSE
 * library backup transparently.
 */

import { createHmac } from "node:crypto";
import type {
  Candle,
  HistoricalRequest,
  OptionChain,
  OptionChainAnalytics,
  OptionChainRow,
  OptionLeg,
  Quote,
} from "@/types/india";
import type { BrokerAdapter } from "../broker/types";
import { cache } from "../cache";
import { yahoo } from "../yahoo";

/** RFC-4648 Base32 decoder (no padding, alphabet A-Z + 2-7). Used to convert
 *  the SmartAPI TOTP secret (shown when 2FA is enabled) into raw bytes. */
function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, "").toUpperCase().replace(/\s+/g, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** RFC-6238 TOTP. 30s step, 6 digits, HMAC-SHA1 — Angel One uses these
 *  defaults (matches Google Authenticator). Returns a zero-padded code. */
function generateTotp(secretBase32: string, atMs = Date.now()): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1_000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

// ── Constants ───────────────────────────────────────────────────────────────

const SMARTAPI_BASE = "https://apiconnect.angelone.in";
const SCRIP_MASTER_URL =
  "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
const SMARTAPI_TIMEOUT_MS = 10_000;
const SCRIP_MASTER_TTL_MS = 12 * 60 * 60 * 1_000; // 12h
const QUOTE_BATCH_SIZE = 50; // SmartAPI hard cap

const INDEX_UNDERLYINGS = new Set([
  "NIFTY",
  "BANKNIFTY",
  "FINNIFTY",
  "MIDCPNIFTY",
]);

// ── Config + diagnostics ────────────────────────────────────────────────────

interface SmartApiConfig {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
  /** Optional fixed local IP for headers. */
  localIp: string;
  publicIp: string;
  macAddress: string;
}

function readConfig(): SmartApiConfig | null {
  const apiKey = process.env.SMARTAPI_API_KEY;
  const clientCode = process.env.SMARTAPI_CLIENT_CODE;
  const pin = process.env.SMARTAPI_PIN;
  const totpSecret = process.env.SMARTAPI_TOTP_SECRET;
  if (!apiKey || !clientCode || !pin || !totpSecret) return null;
  return {
    apiKey,
    clientCode,
    pin,
    totpSecret,
    localIp: process.env.SMARTAPI_LOCAL_IP ?? "127.0.0.1",
    publicIp: process.env.SMARTAPI_PUBLIC_IP ?? "127.0.0.1",
    macAddress: process.env.SMARTAPI_MAC_ADDRESS ?? "00:00:00:00:00:00",
  };
}

export function isAngelConfigured(): boolean {
  return readConfig() !== null;
}

function requireConfig(): SmartApiConfig {
  const c = readConfig();
  if (!c) {
    throw new Error(
      "Angel One SmartAPI not configured — set SMARTAPI_API_KEY, SMARTAPI_CLIENT_CODE, SMARTAPI_PIN, SMARTAPI_TOTP_SECRET in your environment.",
    );
  }
  return c;
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

function smartApiHeaders(cfg: SmartApiConfig, jwt?: string): HeadersInit {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": cfg.localIp,
    "X-ClientPublicIP": cfg.publicIp,
    "X-MACAddress": cfg.macAddress,
    "X-PrivateKey": cfg.apiKey,
  };
  if (jwt) base.Authorization = `Bearer ${jwt}`;
  return base;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs = SMARTAPI_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: unknown) {
    const err = e as { name?: string };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(`SmartAPI ${url} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}

interface SmartApiEnvelope<T> {
  status: boolean;
  message: string;
  errorcode?: string;
  data: T;
}

async function smartApiPost<T>(
  cfg: SmartApiConfig,
  path: string,
  body: unknown,
  jwt?: string,
): Promise<T> {
  const res = await timedFetch(`${SMARTAPI_BASE}${path}`, {
    method: "POST",
    headers: smartApiHeaders(cfg, jwt),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`SmartAPI ${path}: HTTP ${res.status}`);
  const env = (await res.json()) as SmartApiEnvelope<T>;
  if (!env.status) {
    throw new Error(
      `SmartAPI ${path} failed: ${env.message ?? "unknown"} (${env.errorcode ?? "?"})`,
    );
  }
  return env.data;
}

// ── Auth (login + JWT caching) ──────────────────────────────────────────────

interface LoginResponse {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
}

interface SessionState {
  jwt: string;
  expiresAt: number; // epoch ms
}

let session: SessionState | null = null;

/** End-of-day expiry (midnight IST) — SmartAPI sessions die at 00:00 IST. */
function midnightIstMs(): number {
  // IST = UTC+05:30. Compute the next 00:00 IST in epoch ms.
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1_000);
  istNow.setUTCHours(24, 0, 0, 0); // next UTC-midnight in IST clock
  return istNow.getTime() - 5.5 * 60 * 60 * 1_000;
}

async function login(cfg: SmartApiConfig): Promise<string> {
  if (session && Date.now() < session.expiresAt - 60_000) return session.jwt;

  const totp = generateTotp(cfg.totpSecret);
  const data = await smartApiPost<LoginResponse>(
    cfg,
    "/rest/auth/angelbroking/user/v1/loginByPassword",
    {
      clientcode: cfg.clientCode,
      password: cfg.pin,
      totp,
      state: "alphaforge",
    },
  );
  if (!data?.jwtToken) {
    throw new Error("SmartAPI login: missing jwtToken in response");
  }
  session = { jwt: data.jwtToken, expiresAt: midnightIstMs() };
  return session.jwt;
}

// ── Scrip Master (instrument dump) ─────────────────────────────────────────
//
// The dump is ~10MB / 60k rows. We cache the relevant subset (option contracts
// only) for 12h to avoid re-downloading and re-filtering on every request.

interface ScripMasterRow {
  /** Trading symbol e.g. "NIFTY28MAY2624000CE" */
  symbol: string;
  /** Numeric exchange token, as a string. */
  token: string;
  /** Underlying name, e.g. "NIFTY", "RELIANCE". */
  name: string;
  /** Expiry, format varies — usually DD-MMM-YY or DDMMMYYYY. */
  expiry: string;
  /** Strike in paisa (i.e. ×100). For options only. */
  strike: string;
  /** "OPTIDX" | "OPTSTK" | "FUTIDX" | "FUTSTK" | "EQ" | ... */
  instrumenttype: string;
  /** "NSE" | "NFO" | "BSE" | "MCX" | "CDS". Options live in NFO. */
  exch_seg: string;
  lotsize?: string;
}

const NFO_OPTION_TYPES = new Set(["OPTIDX", "OPTSTK"]);

/** Download + cache the option-contract subset of the Scrip Master. */
async function getOptionContracts(): Promise<ScripMasterRow[]> {
  return cache.memo("angel:scripmaster:options", SCRIP_MASTER_TTL_MS, async () => {
    const res = await timedFetch(SCRIP_MASTER_URL, { cache: "no-store" }, 30_000);
    if (!res.ok) throw new Error(`ScripMaster: HTTP ${res.status}`);
    const all = (await res.json()) as ScripMasterRow[];
    return all.filter(
      (r) => r?.exch_seg === "NFO" && NFO_OPTION_TYPES.has(r?.instrumenttype),
    );
  });
}

/** SmartAPI expiry format normaliser — accepts DD-MMM-YYYY (our canonical) and
 *  returns DDMMMYYYY uppercase, the format SmartAPI uses internally. */
function toSmartApiExpiry(s: string): string {
  return s.replace(/-/g, "").toUpperCase();
}

/** Best-effort parse of a Scrip Master expiry into milliseconds for sorting. */
function parseScripExpiryMs(s: string): number {
  // Format observed: "28MAY2026" or "28-MAY-26" or "28May2026".
  const cleaned = s.replace(/-/g, "").toUpperCase();
  const m = /^(\d{1,2})([A-Z]{3})(\d{2,4})$/.exec(cleaned);
  if (!m) return Infinity;
  const day = Number(m[1]);
  const months = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ];
  const month = months.indexOf(m[2]);
  if (month < 0) return Infinity;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return Date.UTC(year, month, day);
}

/** Format an epoch ms back to DD-MMM-YYYY (our canonical chip format). */
function fmtExpiryDmy(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${day}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

interface ContractIndex {
  expiries: string[]; // sorted ascending, in DD-MMM-YYYY format
  byExpiry: Map<string, ScripMasterRow[]>; // DD-MMM-YYYY → option rows for this expiry
}

function indexContractsForUnderlying(
  rows: ScripMasterRow[],
  upper: string,
): ContractIndex {
  const matching = rows.filter((r) => (r.name ?? "").toUpperCase() === upper);
  const byExpiry = new Map<string, ScripMasterRow[]>();
  for (const r of matching) {
    const ms = parseScripExpiryMs(r.expiry);
    if (!Number.isFinite(ms)) continue;
    const key = fmtExpiryDmy(ms);
    let list = byExpiry.get(key);
    if (!list) {
      list = [];
      byExpiry.set(key, list);
    }
    list.push(r);
  }
  const expiries = Array.from(byExpiry.keys()).sort(
    (a, b) => parseScripExpiryMs(a) - parseScripExpiryMs(b),
  );
  return { expiries, byExpiry };
}

// ── Live data: Quote (OI/LTP) + Greeks (IV) ─────────────────────────────────

interface QuoteFullRow {
  symbolToken: string;
  tradingSymbol: string;
  ltp: number;
  opnInterest?: number;
  tradeVolume?: number;
}

async function bulkQuote(
  cfg: SmartApiConfig,
  jwt: string,
  tokens: string[],
): Promise<Map<string, QuoteFullRow>> {
  const out = new Map<string, QuoteFullRow>();
  for (let i = 0; i < tokens.length; i += QUOTE_BATCH_SIZE) {
    const batch = tokens.slice(i, i + QUOTE_BATCH_SIZE);
    const data = await smartApiPost<{ fetched: QuoteFullRow[] }>(
      cfg,
      "/rest/secure/angelbroking/market/v1/quote/",
      { mode: "FULL", exchangeTokens: { NFO: batch } },
      jwt,
    );
    for (const r of data?.fetched ?? []) {
      out.set(r.symbolToken, r);
    }
    // Rate limit: 1 req / sec on the FULL-mode quote endpoint.
    if (i + QUOTE_BATCH_SIZE < tokens.length) {
      await new Promise((r) => setTimeout(r, 1_100));
    }
  }
  return out;
}

interface GreekRow {
  strikePrice: string;
  optionType: "CE" | "PE";
  impliedVolatility: string;
}

async function fetchGreeks(
  cfg: SmartApiConfig,
  jwt: string,
  underlying: string,
  expiryDmy: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const data = await smartApiPost<GreekRow[]>(
      cfg,
      "/rest/secure/angelbroking/marketData/v1/optionGreek",
      { name: underlying, expirydate: toSmartApiExpiry(expiryDmy) },
      jwt,
    );
    for (const g of data ?? []) {
      const k = `${Number(g.strikePrice)}:${g.optionType}`;
      const iv = Number(g.impliedVolatility);
      if (Number.isFinite(iv)) out.set(k, iv);
    }
  } catch (e) {
    // Non-fatal: chain still renders without IV.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[angelone] optionGreek failed for ${underlying}: ${msg}`);
  }
  return out;
}

// ── Analytics (shared with NSE adapter) ─────────────────────────────────────
//
// Duplicated here intentionally to keep the angelone module self-contained;
// the NSE module's `computeAnalytics` lives behind its own module-local helper.

function computeAnalytics(
  rows: OptionChainRow[],
  spot: number | null,
): OptionChainAnalytics {
  let totalCeOi = 0;
  let totalPeOi = 0;
  let totalCeOiChange = 0;
  let totalPeOiChange = 0;
  let totalCeVol = 0;
  let totalPeVol = 0;
  let maxCeOi = -1;
  let maxPeOi = -1;
  let maxCeOiStrike: number | null = null;
  let maxPeOiStrike: number | null = null;
  for (const r of rows) {
    if (r.ce) {
      totalCeOi += r.ce.oi;
      totalCeOiChange += r.ce.changeInOi;
      totalCeVol += r.ce.volume;
      if (r.ce.oi > maxCeOi) {
        maxCeOi = r.ce.oi;
        maxCeOiStrike = r.strike;
      }
    }
    if (r.pe) {
      totalPeOi += r.pe.oi;
      totalPeOiChange += r.pe.changeInOi;
      totalPeVol += r.pe.volume;
      if (r.pe.oi > maxPeOi) {
        maxPeOi = r.pe.oi;
        maxPeOiStrike = r.strike;
      }
    }
  }
  const pcrOi = totalCeOi > 0 ? totalPeOi / totalCeOi : null;
  const pcrVolume = totalCeVol > 0 ? totalPeVol / totalCeVol : null;

  let atmIv: number | null = null;
  if (spot != null && rows.length > 0) {
    const sorted = [...rows].sort(
      (a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot),
    );
    const ivs: number[] = [];
    for (const r of sorted.slice(0, 5)) {
      if (r.ce?.iv) ivs.push(r.ce.iv);
      if (r.pe?.iv) ivs.push(r.pe.iv);
    }
    atmIv = ivs.length > 0 ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  }

  let maxPain: number | null = null;
  if (rows.length > 0) {
    let bestStrike = rows[0].strike;
    let bestPain = Infinity;
    for (const test of rows) {
      let pain = 0;
      for (const r of rows) {
        if (r.ce && test.strike > r.strike) {
          pain += (test.strike - r.strike) * r.ce.oi;
        }
        if (r.pe && test.strike < r.strike) {
          pain += (r.strike - test.strike) * r.pe.oi;
        }
      }
      if (pain < bestPain) {
        bestPain = pain;
        bestStrike = test.strike;
      }
    }
    maxPain = bestStrike;
  }

  return {
    pcrOi,
    pcrVolume,
    maxCeOiStrike,
    maxPeOiStrike,
    totalCeOi,
    totalPeOi,
    totalCeOiChange,
    totalPeOiChange,
    atmIv,
    maxPain,
  };
}

// ── Underlying spot (so the page can render even on partial chain) ──────────

async function fetchUnderlyingSpot(
  cfg: SmartApiConfig,
  jwt: string,
  upper: string,
): Promise<number | null> {
  // We don't carry an NSE-equity token registry here; SmartAPI requires a
  // numeric token. Index spots can be derived from the option leg LTPs +
  // strike (out-of-the-money skew) but that's noisy. Cheapest fix: fall back
  // to yahoo quote which is already available.
  try {
    const q = await yahoo.getQuote(upper.startsWith("^") ? upper : upper);
    return q?.price ?? null;
  } catch {
    return null;
  }
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class AngelOneAdapter implements BrokerAdapter {
  readonly id = "angel" as const;

  get isLive(): boolean {
    return isAngelConfigured();
  }

  /** SmartAPI's per-token quote works but requires NSE-equity tokens; we
   *  punt to Yahoo for non-option quote requests to keep the surface small. */
  async getQuote(symbol: string): Promise<Quote> {
    return yahoo.getQuote(symbol);
  }
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    return yahoo.getQuotes(symbols);
  }
  async getHistorical(req: HistoricalRequest): Promise<Candle[]> {
    return yahoo.getHistorical(req);
  }

  async getOptionChain(symbol: string, expiry?: string): Promise<OptionChain> {
    const upper = symbol.toUpperCase();
    const cacheKey = `angel:oc:${upper}:${expiry ?? "nearest"}`;

    return cache.memo(cacheKey, 20_000, async () => {
      const cfg = requireConfig();
      const jwt = await login(cfg);

      // 1. Resolve the expiry list from the cached scrip master.
      const contracts = await getOptionContracts();
      const { expiries, byExpiry } = indexContractsForUnderlying(
        contracts,
        upper,
      );
      if (expiries.length === 0) {
        throw new Error(
          `SmartAPI ScripMaster has no option contracts for ${upper}.`,
        );
      }

      // Pick the requested expiry, or the nearest upcoming one.
      const todayMs = Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      );
      const upcoming =
        expiries.find((e) => parseScripExpiryMs(e) >= todayMs) ?? expiries[0];
      const chosenExpiry = expiry ?? upcoming;

      const legs = byExpiry.get(chosenExpiry);
      if (!legs || legs.length === 0) {
        throw new Error(
          `SmartAPI: no contracts found for ${upper} expiry ${chosenExpiry}.`,
        );
      }

      // 2. Bulk-quote every leg in this expiry (rate-limit-aware).
      const tokens = legs.map((l) => l.token);
      const quotes = await bulkQuote(cfg, jwt, tokens);

      // 3. Greeks (best-effort, fills IV).
      const greeks = await fetchGreeks(cfg, jwt, upper, chosenExpiry);

      // 4. Pivot legs → rows.
      const byStrike = new Map<
        number,
        { ce?: ScripMasterRow; pe?: ScripMasterRow }
      >();
      for (const l of legs) {
        const strike = Number(l.strike) / 100; // ScripMaster ships strikes ×100
        if (!Number.isFinite(strike)) continue;
        const side: "CE" | "PE" | null = /CE$/.test(l.symbol)
          ? "CE"
          : /PE$/.test(l.symbol)
            ? "PE"
            : null;
        if (!side) continue;
        let slot = byStrike.get(strike);
        if (!slot) {
          slot = {};
          byStrike.set(strike, slot);
        }
        if (side === "CE") slot.ce = l;
        else slot.pe = l;
      }

      const toLeg = (
        row: ScripMasterRow | undefined,
        type: "CE" | "PE",
        strike: number,
      ): OptionLeg | null => {
        if (!row) return null;
        const q = quotes.get(row.token);
        const iv = greeks.get(`${strike}:${type}`) ?? null;
        return {
          strike,
          type,
          oi: q?.opnInterest ?? 0,
          changeInOi: 0, // SmartAPI quote doesn't ship intraday ΔOI
          volume: q?.tradeVolume ?? 0,
          iv,
          ltp: q?.ltp ?? null,
          bid: null,
          ask: null,
        };
      };

      const rows: OptionChainRow[] = Array.from(byStrike.entries())
        .map(([strike, { ce, pe }]) => ({
          strike,
          ce: toLeg(ce, "CE", strike),
          pe: toLeg(pe, "PE", strike),
        }))
        .sort((a, b) => a.strike - b.strike);

      const spot = await fetchUnderlyingSpot(cfg, jwt, upper);
      const analytics = computeAnalytics(rows, spot);

      // Round-trip note: BANKNIFTY in ScripMaster is "BANKNIFTY"; UI sends
      // the same. INDEX_UNDERLYINGS gate is just a hint that this branch is
      // valid for indices (no special handling needed).
      void INDEX_UNDERLYINGS;

      return {
        symbol: upper,
        spot,
        expiry: chosenExpiry,
        expiries,
        rows,
        analytics,
        fetchedAt: new Date().toISOString(),
      } satisfies OptionChain;
    });
  }
}

export const angel = new AngelOneAdapter();
