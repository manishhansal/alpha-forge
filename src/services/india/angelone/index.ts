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
  Interval,
  OptionChain,
  OptionChainAnalytics,
  OptionChainRow,
  OptionGreeks,
  OptionLeg,
  Quote,
} from "@/types/india";
import type { BrokerAdapter } from "../broker/types";
import { cache } from "../cache";
import { yahoo } from "../yahoo";
import {
  parseGainersLosers,
  parseGreekRows,
  parseOiBuildup,
  parsePcr,
  type DerivExpiryType,
  type DerivGainerLoser,
  type DerivOiBuildup,
  type DerivPcr,
  type GainersLosersDataType,
  type OiBuildupDataType,
} from "./derivatives";
import {
  SMART_EXCHANGE_TYPE,
  SMART_MODE,
  SmartStreamClient,
  changePctFromTick,
  type SmartTick,
} from "./smartstream";
import {
  parseFunds,
  parseHoldings,
  parsePositions,
  type AccountFunds,
  type HoldingsResult,
  type Position,
} from "./portfolio";

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

/** The four SmartAPI credentials needed to log in. */
export interface AngelCredentials {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
}

interface SmartApiConfig extends AngelCredentials {
  /** Optional fixed local IP for headers. */
  localIp: string;
  publicIp: string;
  macAddress: string;
}

/** Wrap a credential set with the request-header IPs SmartAPI expects. */
function buildConfig(creds: AngelCredentials): SmartApiConfig {
  return {
    ...creds,
    localIp: process.env.SMARTAPI_LOCAL_IP ?? "127.0.0.1",
    publicIp: process.env.SMARTAPI_PUBLIC_IP ?? "127.0.0.1",
    macAddress: process.env.SMARTAPI_MAC_ADDRESS ?? "00:00:00:00:00:00",
  };
}

function readEnvCredentials(): AngelCredentials | null {
  const apiKey = process.env.SMARTAPI_API_KEY;
  const clientCode = process.env.SMARTAPI_CLIENT_CODE;
  const pin = process.env.SMARTAPI_PIN;
  const totpSecret = process.env.SMARTAPI_TOTP_SECRET;
  if (!apiKey || !clientCode || !pin || !totpSecret) return null;
  return { apiKey, clientCode, pin, totpSecret };
}

/** True when Angel One credentials are present in the **environment**. The
 *  per-user DB credentials (entered via the API-keys UI) are resolved
 *  asynchronously by {@link resolveConfig} and aren't reflected here. */
export function isAngelConfigured(): boolean {
  return readEnvCredentials() !== null;
}

/**
 * Resolve a usable SmartAPI config for the current request. Environment
 * credentials win (they cover the worker + unauthenticated paths); otherwise
 * we lazily load the per-user DB resolver, which reads the encrypted Angel One
 * key the signed-in user saved in their profile. Returns `null` when neither
 * source has a complete credential set, so callers can fall back to Yahoo/NSE.
 */
async function resolveConfig(): Promise<SmartApiConfig | null> {
  const envCreds = readEnvCredentials();
  if (envCreds) return buildConfig(envCreds);
  try {
    const mod = await import("@/features/settings/angel-credentials");
    const dbCreds = await mod.getAngelConfigForRequest();
    return dbCreds ? buildConfig(dbCreds) : null;
  } catch {
    return null;
  }
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

/**
 * Browser-like User-Agent for SmartAPI requests. Angel One's API gateway
 * (Akamai) returns a bare `HTTP 403` — before the JSON envelope — for requests
 * that arrive without a recognised User-Agent, which is exactly what Node's
 * `fetch` (undici) sends by default. Spoofing a normal UA clears the WAF block.
 * Overridable via `SMARTAPI_USER_AGENT` if Angel ever tightens this.
 */
const SMARTAPI_USER_AGENT =
  process.env.SMARTAPI_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function smartApiHeaders(cfg: SmartApiConfig, jwt?: string): HeadersInit {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": SMARTAPI_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
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

/** Authenticated GET (account-data endpoints: RMS / holdings / positions). */
async function smartApiGet<T>(
  cfg: SmartApiConfig,
  path: string,
  jwt: string,
): Promise<T> {
  const res = await timedFetch(`${SMARTAPI_BASE}${path}`, {
    method: "GET",
    headers: smartApiHeaders(cfg, jwt),
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
  /** SmartStream (WebSocket 2.0) feed token, captured at login. */
  feedToken: string;
  expiresAt: number; // epoch ms
}

// JWT cache keyed per client code so two accounts (e.g. env vs a UI-entered
// user key) never share a session token.
const sessions = new Map<string, SessionState>();

// Auth-failure backoff keyed per client code. A failed login caches no session,
// so without this every quote/candle poll would re-hit the login endpoint
// (every few seconds) — hammering Angel's gateway, risking an IP ban, and
// spamming logs. After a failure we suppress further login attempts for a short
// window and reuse the recorded error.
const LOGIN_FAILURE_COOLDOWN_MS = 5 * 60_000;
const loginFailures = new Map<string, { until: number; message: string }>();

/** End-of-day expiry (midnight IST) — SmartAPI sessions die at 00:00 IST. */
function midnightIstMs(): number {
  // IST = UTC+05:30. Compute the next 00:00 IST in epoch ms.
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1_000);
  istNow.setUTCHours(24, 0, 0, 0); // next UTC-midnight in IST clock
  return istNow.getTime() - 5.5 * 60 * 60 * 1_000;
}

async function login(cfg: SmartApiConfig): Promise<string> {
  const cached = sessions.get(cfg.clientCode);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.jwt;

  // Within the failure cooldown? Fail fast with the recorded error instead of
  // re-hammering the login endpoint on every poll.
  const failure = loginFailures.get(cfg.clientCode);
  if (failure && Date.now() < failure.until) {
    throw new Error(failure.message);
  }

  try {
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
    const next: SessionState = {
      jwt: data.jwtToken,
      feedToken: data.feedToken ?? "",
      expiresAt: midnightIstMs(),
    };
    sessions.set(cfg.clientCode, next);
    loginFailures.delete(cfg.clientCode);
    return next.jwt;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    loginFailures.set(cfg.clientCode, {
      until: Date.now() + LOGIN_FAILURE_COOLDOWN_MS,
      message,
    });
    throw e;
  }
}

// ── Scrip Master (instrument dump) ─────────────────────────────────────────
//
// The dump is ~10MB / 60k rows. We cache the relevant subset (option contracts
// only) for 12h to avoid re-downloading and re-filtering on every request.

export interface AngelScripRow {
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

interface ScripSubsets {
  /** NFO option contracts (OPTIDX / OPTSTK) — option-chain synthesis. */
  options: AngelScripRow[];
  /** NSE cash equities (the "-EQ" series) — quote + historical token lookup. */
  cash: AngelScripRow[];
}

/**
 * Download the ScripMaster once and split it into the two subsets we need
 * (options for the chain, cash equities for quotes/history). Cached together
 * so a quote request and an option-chain request never trigger two ~10MB
 * downloads of the same dump.
 */
async function getScripSubsets(): Promise<ScripSubsets> {
  // `:v2` busts the cached NFO-only subset so BSE (BFO) option contracts —
  // needed for the SENSEX / BANKEX chains — are picked up immediately.
  return cache.memo("angel:scripmaster:subsets:v2", SCRIP_MASTER_TTL_MS, async () => {
    const res = await timedFetch(SCRIP_MASTER_URL, { cache: "no-store" }, 30_000);
    if (!res.ok) throw new Error(`ScripMaster: HTTP ${res.status}`);
    const all = (await res.json()) as AngelScripRow[];
    const options: AngelScripRow[] = [];
    const cash: AngelScripRow[] = [];
    for (const r of all) {
      if (!r) continue;
      // Index/stock options on both NSE (NFO) and BSE (BFO) — the BSE segment
      // is what carries SENSEX / BANKEX contracts.
      if (
        (r.exch_seg === "NFO" || r.exch_seg === "BFO") &&
        NFO_OPTION_TYPES.has(r.instrumenttype)
      ) {
        options.push(r);
      } else if (r.exch_seg === "NSE" && /-EQ$/.test(r.symbol ?? "")) {
        cash.push(r);
      }
    }
    return { options, cash };
  });
}

/** Download + cache the option-contract subset of the Scrip Master. */
async function getOptionContracts(): Promise<AngelScripRow[]> {
  return (await getScripSubsets()).options;
}

// ── Token resolution (quotes / historical) ──────────────────────────────────

export type AngelExchange = "NSE" | "BSE" | "NFO";

export interface AngelToken {
  token: string;
  exchange: AngelExchange;
}

/**
 * Hardcoded index tokens — index instruments are stable on Angel One and are
 * cleaner to resolve directly than by scanning the ScripMaster (where the
 * index rows carry display names like "Nifty 50" rather than "NIFTY").
 */
export const INDEX_TOKENS: Record<string, AngelToken> = {
  NIFTY: { token: "26000", exchange: "NSE" },
  BANKNIFTY: { token: "26009", exchange: "NSE" },
  FINNIFTY: { token: "26037", exchange: "NSE" },
  MIDCPNIFTY: { token: "26074", exchange: "NSE" },
  INDIAVIX: { token: "26017", exchange: "NSE" },
};

/**
 * Maps the Yahoo-style index proxy tickers used across the app to the Angel
 * One index name keyed in {@link INDEX_TOKENS}.
 */
export const SYMBOL_TO_INDEX: Record<string, keyof typeof INDEX_TOKENS> = {
  "^NSEI": "NIFTY",
  "^NSEBANK": "BANKNIFTY",
  "^CNXFIN": "FINNIFTY",
  "^NSEMDCP50": "MIDCPNIFTY",
  "^INDIAVIX": "INDIAVIX",
  NIFTY: "NIFTY",
  BANKNIFTY: "BANKNIFTY",
  FINNIFTY: "FINNIFTY",
  MIDCPNIFTY: "MIDCPNIFTY",
};

/** Build a `NAME → token` map from the NSE cash-equity ScripMaster subset. */
export function buildEqTokenMap(rows: AngelScripRow[]): Map<string, AngelToken> {
  const out = new Map<string, AngelToken>();
  for (const r of rows) {
    if (r?.exch_seg !== "NSE" || !/-EQ$/.test(r.symbol ?? "")) continue;
    const name = (r.name ?? "").toUpperCase();
    if (!name || out.has(name)) continue;
    out.set(name, { token: r.token, exchange: "NSE" });
  }
  return out;
}

/**
 * Resolve an app-internal symbol (index proxy like `^NSEI`, or a bare NSE
 * stock like `RELIANCE` / `RELIANCE.NS`) to an Angel One `{ token, exchange }`.
 * Returns `null` when the symbol can't be served by Angel One (e.g. `^BSESN`),
 * so callers fall back to Yahoo for that symbol.
 */
export function resolveAngelToken(
  symbol: string,
  eqTokenMap: Map<string, AngelToken>,
): AngelToken | null {
  const idxKey = SYMBOL_TO_INDEX[symbol] ?? SYMBOL_TO_INDEX[symbol.toUpperCase()];
  if (idxKey) return INDEX_TOKENS[idxKey];
  if (symbol.startsWith("^")) return null;
  const name = symbol.replace(/\.NS$/i, "").toUpperCase();
  return eqTokenMap.get(name) ?? null;
}

/** Map our cash/derivative exchange tag to a SmartStream exchange-type code. */
const SMART_EXCHANGE_TYPE_BY_EXCHANGE: Record<AngelExchange, number> = {
  NSE: SMART_EXCHANGE_TYPE.NSE_CM,
  NFO: SMART_EXCHANGE_TYPE.NSE_FO,
  BSE: SMART_EXCHANGE_TYPE.BSE_CM,
};

/**
 * Map a decoded SmartStream tick onto the canonical {@link Quote}. The WS Quote
 * frame ships the previous `close`, so `changePct` is derived locally (the poll
 * path got it straight from the FULL-quote `percentChange`).
 */
export function quoteFromTick(symbol: string, tick: SmartTick): Quote {
  const close = tick.close ?? null;
  return {
    symbol,
    name: null,
    price: tick.ltp,
    change: close != null ? tick.ltp - close : null,
    changePct: changePctFromTick(tick.ltp, close),
    prevClose: close,
    open: tick.open ?? null,
    high: tick.high ?? null,
    low: tick.low ?? null,
    volume: tick.volume ?? null,
    oi: tick.oi ?? null,
    source: "angel",
    fetchedAt: new Date().toISOString(),
  };
}

// ── Quote + candle mapping (pure, testable) ─────────────────────────────────

/** A row from the SmartAPI FULL-mode market-quote response (`data.fetched[]`). */
export interface AngelQuoteRow {
  exchange?: string;
  tradingSymbol?: string;
  symbolToken: string;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  /** Previous day's close. */
  close?: number;
  netChange?: number;
  percentChange?: number;
  tradeVolume?: number;
  opnInterest?: number;
  /** 52-week high / low (note: SmartAPI keys these with a leading digit). */
  "52WeekHigh"?: number;
  "52WeekLow"?: number;
  /** Daily price-band circuit limits. */
  upperCircuit?: number;
  lowerCircuit?: number;
  /** Total buying / selling quantity across the order book. */
  totBuyQuan?: number;
  totSellQuan?: number;
}

/** A single OHLCV tuple from SmartAPI getCandleData: `[isoTs, o, h, l, c, v]`. */
export type AngelCandleTuple = [string, number, number, number, number, number];

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Placeholder quote used when neither Angel One nor Yahoo could resolve a
 *  symbol — keeps the consumer's array length aligned with the request. */
function emptyAngelQuote(symbol: string): Quote {
  return {
    symbol,
    name: null,
    price: null,
    change: null,
    changePct: null,
    prevClose: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Order-book pressure from total buy vs sell quantity, normalised to [-1, 1].
 * +1 = all bids (buy pressure, bullish), -1 = all asks. Null when either total
 * is missing or they sum to zero (no book).
 */
export function orderBookImbalance(
  totalBuy: number | null | undefined,
  totalSell: number | null | undefined,
): number | null {
  const buy = num(totalBuy);
  const sell = num(totalSell);
  if (buy == null || sell == null) return null;
  const sum = buy + sell;
  if (sum <= 0) return null;
  return (buy - sell) / sum;
}

/**
 * Per-token intraday OI change vs a session-open baseline.
 *
 * SmartAPI's quote endpoint doesn't ship a change-in-OI field and per-token
 * historical OI is rate-limit-prohibitive (1 req/s × hundreds of strikes), so
 * we approximate ΔOI by diffing the live OI against the first OI reading we
 * captured this session (the baseline, held in cache until midnight IST).
 *
 *   - No baseline yet (first fetch of the day) → every change is 0.
 *   - A strike absent from the baseline (newly listed) → 0, not its full OI.
 */
export function computeOiChanges(
  currentOiByToken: Record<string, number>,
  baselineOiByToken: Record<string, number> | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [token, oi] of Object.entries(currentOiByToken)) {
    if (!baselineOiByToken) {
      out[token] = 0;
      continue;
    }
    const base = baselineOiByToken[token];
    out[token] = base == null ? 0 : oi - base;
  }
  return out;
}

/** Map a FULL-mode quote row into the canonical broker-agnostic `Quote`. */
export function quoteFromQuoteRow(symbol: string, row: AngelQuoteRow): Quote {
  const totalBuyQty = num(row.totBuyQuan);
  const totalSellQty = num(row.totSellQuan);
  return {
    symbol,
    name: row.tradingSymbol ?? null,
    price: num(row.ltp),
    change: num(row.netChange),
    changePct: num(row.percentChange),
    prevClose: num(row.close),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    volume: num(row.tradeVolume),
    oi: num(row.opnInterest),
    weekHigh52: num(row["52WeekHigh"]),
    weekLow52: num(row["52WeekLow"]),
    upperCircuit: num(row.upperCircuit),
    lowerCircuit: num(row.lowerCircuit),
    totalBuyQty,
    totalSellQty,
    orderBookImbalance: orderBookImbalance(totalBuyQty, totalSellQty),
    source: "angel",
    fetchedAt: new Date().toISOString(),
  };
}

/** Parse SmartAPI candle tuples into `Candle[]`, skipping malformed rows. */
export function candlesFromCandleData(rows: AngelCandleTuple[]): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const ts = Date.parse(r[0]);
    const open = num(r[1]);
    const high = num(r[2]);
    const low = num(r[3]);
    const close = num(r[4]);
    if (!Number.isFinite(ts) || open == null || high == null || low == null || close == null) {
      continue;
    }
    out.push({
      time: Math.floor(ts / 1_000),
      open,
      high,
      low,
      close,
      volume: num(r[5]) ?? undefined,
    });
  }
  return out;
}

/** Map an app `Interval` to a SmartAPI getCandleData enum, or null if weekly
 *  (SmartAPI has no weekly candle — callers fall back to Yahoo). */
export function intervalToSmartApi(interval: Interval): string | null {
  switch (interval) {
    case "1m":
      return "ONE_MINUTE";
    case "5m":
      return "FIVE_MINUTE";
    case "15m":
      return "FIFTEEN_MINUTE";
    case "30m":
      return "THIRTY_MINUTE";
    case "1h":
      return "ONE_HOUR";
    case "1d":
      return "ONE_DAY";
    case "1w":
    default:
      return null;
  }
}

/** `from`/`to` window (epoch ms) for a getCandleData range string. */
export function rangeToFromMs(range: string, now = Date.now()): number {
  const m = /^(\d+)(m|d|mo|y)$/.exec(range);
  if (!m) return now - 30 * 86_400_000;
  const n = Number(m[1]);
  const unit = m[2];
  const ms =
    unit === "m"
      ? n * 60_000
      : unit === "d"
        ? n * 86_400_000
        : unit === "mo"
          ? n * 30 * 86_400_000
          : n * 365 * 86_400_000;
  return now - ms;
}

/** SmartAPI getCandleData expects `YYYY-MM-DD HH:mm` in IST. */
export function toSmartApiDateTime(ms: number): string {
  const ist = new Date(ms + 5.5 * 60 * 60 * 1_000);
  const y = ist.getUTCFullYear();
  const mo = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${hh}:${mm}`;
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
  byExpiry: Map<string, AngelScripRow[]>; // DD-MMM-YYYY → option rows for this expiry
}

function indexContractsForUnderlying(
  rows: AngelScripRow[],
  upper: string,
): ContractIndex {
  const matching = rows.filter((r) => (r.name ?? "").toUpperCase() === upper);
  const byExpiry = new Map<string, AngelScripRow[]>();
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

/**
 * FULL-mode bulk quote for option legs, grouped by their exchange segment so
 * NSE (`NFO`) and BSE (`BFO`) legs are requested under the correct key. Returns
 * a map keyed by `symbolToken`. Used by the chain synthesiser so SENSEX/BANKEX
 * (BSE) chains quote correctly alongside the NSE indices.
 */
async function bulkQuoteOptionLegs(
  cfg: SmartApiConfig,
  jwt: string,
  legs: AngelScripRow[],
): Promise<Map<string, QuoteFullRow>> {
  const out = new Map<string, QuoteFullRow>();
  const byExch = new Map<string, string[]>();
  for (const l of legs) {
    const ex = l.exch_seg === "BFO" ? "BFO" : "NFO";
    const list = byExch.get(ex) ?? [];
    list.push(l.token);
    byExch.set(ex, list);
  }
  for (const [ex, tokens] of byExch) {
    for (let i = 0; i < tokens.length; i += QUOTE_BATCH_SIZE) {
      const batch = tokens.slice(i, i + QUOTE_BATCH_SIZE);
      const data = await smartApiPost<{ fetched: QuoteFullRow[] }>(
        cfg,
        "/rest/secure/angelbroking/market/v1/quote/",
        { mode: "FULL", exchangeTokens: { [ex]: batch } },
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
  }
  return out;
}

/**
 * FULL-mode quote for an arbitrary set of `{ token, exchange }` instruments
 * (cash equities + indices). Returns a map keyed by `${exchange}:${token}`.
 * Batched at the SmartAPI 50-token cap, grouped per exchange.
 */
async function bulkQuoteTokens(
  cfg: SmartApiConfig,
  jwt: string,
  instruments: AngelToken[],
): Promise<Map<string, AngelQuoteRow>> {
  const out = new Map<string, AngelQuoteRow>();
  const byExchange = new Map<AngelExchange, string[]>();
  for (const ins of instruments) {
    const list = byExchange.get(ins.exchange) ?? [];
    list.push(ins.token);
    byExchange.set(ins.exchange, list);
  }
  for (const [exchange, tokens] of byExchange) {
    for (let i = 0; i < tokens.length; i += QUOTE_BATCH_SIZE) {
      const batch = tokens.slice(i, i + QUOTE_BATCH_SIZE);
      const data = await smartApiPost<{ fetched: AngelQuoteRow[] }>(
        cfg,
        "/rest/secure/angelbroking/market/v1/quote/",
        { mode: "FULL", exchangeTokens: { [exchange]: batch } },
        jwt,
      );
      for (const r of data?.fetched ?? []) {
        out.set(`${r.exchange ?? exchange}:${r.symbolToken}`, r);
      }
      if (i + QUOTE_BATCH_SIZE < tokens.length) {
        await new Promise((r) => setTimeout(r, 1_100));
      }
    }
  }
  return out;
}

/** SmartAPI getCandleData call → raw OHLCV tuples. */
async function fetchCandleData(
  cfg: SmartApiConfig,
  jwt: string,
  ins: AngelToken,
  smartInterval: string,
  fromMs: number,
  toMs: number,
): Promise<AngelCandleTuple[]> {
  const data = await smartApiPost<AngelCandleTuple[]>(
    cfg,
    "/rest/secure/angelbroking/historical/v1/getCandleData",
    {
      exchange: ins.exchange,
      symboltoken: ins.token,
      interval: smartInterval,
      fromdate: toSmartApiDateTime(fromMs),
      todate: toSmartApiDateTime(toMs),
    },
    jwt,
  );
  return Array.isArray(data) ? data : [];
}

async function fetchGreeks(
  cfg: SmartApiConfig,
  jwt: string,
  underlying: string,
  expiryDmy: string,
): Promise<Map<string, OptionGreeks>> {
  try {
    const data = await smartApiPost<unknown>(
      cfg,
      "/rest/secure/angelbroking/marketData/v1/optionGreek",
      { name: underlying, expirydate: toSmartApiExpiry(expiryDmy) },
      jwt,
    );
    return parseGreekRows(data);
  } catch (e) {
    // Non-fatal: chain still renders without greeks.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[angelone] optionGreek failed for ${underlying}: ${msg}`);
    return new Map<string, OptionGreeks>();
  }
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
  // Prefer a live SmartAPI quote (index tokens are hardcoded; stock tokens
  // come from the cached cash subset). Fall back to Yahoo when the symbol
  // can't be resolved on Angel One.
  try {
    const { cash } = await getScripSubsets();
    const ins = resolveAngelToken(upper, buildEqTokenMap(cash));
    if (ins) {
      const quotes = await bulkQuoteTokens(cfg, jwt, [ins]);
      const row = quotes.get(`${ins.exchange}:${ins.token}`);
      const ltp = row ? num(row.ltp) : null;
      if (ltp != null) return ltp;
    }
  } catch {
    // fall through to Yahoo
  }
  try {
    const q = await yahoo.getQuote(upper);
    return q?.price ?? null;
  } catch {
    return null;
  }
}

// ── Adapter ────────────────────────────────────────────────────────────────

/**
 * Controls cross-source fallback inside the adapter. The selected-source-only
 * resolver passes `allowFallback: false` so Angel One never silently reaches
 * for Yahoo when the user didn't select it; unservable symbols come back empty
 * and the resolver tries the next *selected* source instead.
 */
export interface AngelFetchOptions {
  allowFallback?: boolean;
}

export class AngelOneAdapter implements BrokerAdapter {
  readonly id = "angel" as const;

  get isLive(): boolean {
    return isAngelConfigured();
  }

  async getQuote(symbol: string): Promise<Quote> {
    const [q] = await this.getQuotes([symbol]);
    return q ?? (await yahoo.getQuote(symbol));
  }

  /**
   * Live FULL-mode quotes from SmartAPI. By default, symbols Angel One can't
   * resolve (or the whole batch if SmartAPI is unconfigured / errors)
   * transparently fall back to Yahoo so a partial registry never blanks the
   * dashboard. Pass `{ allowFallback: false }` to suppress that and get empty
   * placeholders instead (used by the selected-source-only resolver).
   */
  async getQuotes(symbols: string[], opts?: AngelFetchOptions): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const allowFallback = opts?.allowFallback ?? true;
    const cfg = await resolveConfig();
    if (!cfg) {
      return allowFallback ? yahoo.getQuotes(symbols) : symbols.map(emptyAngelQuote);
    }

    return cache.memo(
      `angel:quotes:${allowFallback ? "fb" : "strict"}:${symbols.join(",")}`,
      5_000,
      async () => {
        try {
          const jwt = await login(cfg);
          const { cash } = await getScripSubsets();
          const eqMap = buildEqTokenMap(cash);

          const resolved = new Map<string, AngelToken>();
          const unresolved: string[] = [];
          for (const s of symbols) {
            const ins = resolveAngelToken(s, eqMap);
            if (ins) resolved.set(s, ins);
            else unresolved.push(s);
          }

          const rows =
            resolved.size > 0
              ? await bulkQuoteTokens(cfg, jwt, [...resolved.values()])
              : new Map<string, AngelQuoteRow>();

          // Yahoo backfill for anything Angel One couldn't resolve — only when
          // fallback is allowed.
          const fallback = new Map<string, Quote>();
          if (allowFallback && unresolved.length > 0) {
            const yq = await yahoo.getQuotes(unresolved);
            unresolved.forEach((s, i) => fallback.set(s, yq[i]));
          }

          return symbols.map((s) => {
            const ins = resolved.get(s);
            const row = ins ? rows.get(`${ins.exchange}:${ins.token}`) : undefined;
            if (row && num(row.ltp) != null) return quoteFromQuoteRow(s, row);
            return fallback.get(s) ?? emptyAngelQuote(s);
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`angelone.getQuotes:`, msg);
          return allowFallback ? yahoo.getQuotes(symbols) : symbols.map(emptyAngelQuote);
        }
      },
    );
  }

  async getHistorical(
    req: HistoricalRequest,
    opts?: AngelFetchOptions,
  ): Promise<Candle[]> {
    const allowFallback = opts?.allowFallback ?? true;
    const smartInterval = intervalToSmartApi(req.interval);
    // SmartAPI has no weekly candle — defer to Yahoo for that interval.
    if (!smartInterval) return allowFallback ? yahoo.getHistorical(req) : [];
    const cfg = await resolveConfig();
    if (!cfg) return allowFallback ? yahoo.getHistorical(req) : [];

    const cacheKey = `angel:hist:${allowFallback ? "fb" : "strict"}:${req.symbol}:${req.interval}:${req.range}`;
    return cache.memo(cacheKey, 30_000, async () => {
      try {
        const jwt = await login(cfg);
        const { cash } = await getScripSubsets();
        const ins = resolveAngelToken(req.symbol, buildEqTokenMap(cash));
        if (!ins) return allowFallback ? yahoo.getHistorical(req) : [];

        const now = Date.now();
        const tuples = await fetchCandleData(
          cfg,
          jwt,
          ins,
          smartInterval,
          rangeToFromMs(req.range, now),
          now,
        );
        const candles = candlesFromCandleData(tuples);
        // Empty SmartAPI window (e.g. holiday / off-hours) → Yahoo backfill
        // unless the caller restricted us to the selected source.
        if (candles.length > 0) return candles;
        return allowFallback ? await yahoo.getHistorical(req) : [];
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`angelone.getHistorical(${req.symbol}):`, msg);
        return allowFallback ? yahoo.getHistorical(req) : [];
      }
    });
  }

  async getOptionChain(symbol: string, expiry?: string): Promise<OptionChain> {
    const upper = symbol.toUpperCase();
    const cacheKey = `angel:oc:${upper}:${expiry ?? "nearest"}`;

    return cache.memo(cacheKey, 20_000, async () => {
      const cfg = await resolveConfig();
      if (!cfg) {
        throw new Error(
          "Angel One SmartAPI not configured — set the SMARTAPI_* env vars or save an Angel One key in your profile.",
        );
      }
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

      // 2. Bulk-quote every leg in this expiry (rate-limit-aware), grouped by
      // exchange segment so BSE (BFO) legs — SENSEX / BANKEX — quote correctly.
      const quotes = await bulkQuoteOptionLegs(cfg, jwt, legs);

      // 2b. Intraday ΔOI vs the session-open baseline. The first chain fetch of
      // the day seeds the baseline (changes all 0); later fetches diff against
      // it so the chain reports real build-up/unwinding instead of a flat 0.
      const currentOiByToken: Record<string, number> = {};
      for (const [token, q] of quotes) {
        currentOiByToken[token] = q.opnInterest ?? 0;
      }
      const baselineKey = `angel:oc:oibaseline:${upper}:${chosenExpiry}`;
      const baseline =
        (await cache.get<Record<string, number>>(baselineKey)) ?? null;
      const oiChanges = computeOiChanges(currentOiByToken, baseline);
      if (!baseline) {
        const ttl = Math.max(60_000, midnightIstMs() - Date.now());
        await cache.set(baselineKey, currentOiByToken, ttl);
      }

      // 3. Greeks (best-effort, fills IV).
      const greeks = await fetchGreeks(cfg, jwt, upper, chosenExpiry);

      // 4. Pivot legs → rows.
      const byStrike = new Map<
        number,
        { ce?: AngelScripRow; pe?: AngelScripRow }
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
        row: AngelScripRow | undefined,
        type: "CE" | "PE",
        strike: number,
      ): OptionLeg | null => {
        if (!row) return null;
        const q = quotes.get(row.token);
        const g = greeks.get(`${strike}:${type}`) ?? null;
        return {
          strike,
          type,
          oi: q?.opnInterest ?? 0,
          changeInOi: oiChanges[row.token] ?? 0,
          volume: q?.tradeVolume ?? 0,
          iv: g?.iv ?? null,
          ltp: q?.ltp ?? null,
          bid: null,
          ask: null,
          delta: g?.delta ?? null,
          gamma: g?.gamma ?? null,
          theta: g?.theta ?? null,
          vega: g?.vega ?? null,
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

  // ── First-party derivatives market-data (gainers/losers · PCR · OI buildup) ──
  //
  // These three SmartAPI endpoints live under /marketData/v1 and return
  // exchange-grade derivative-segment signals. Each method returns an empty
  // list (never throws) when SmartAPI is unconfigured or the call fails, so the
  // scanner can transparently fall back to its Yahoo/NSE-derived path.

  /**
   * Top gainers / losers in the F&O segment for an expiry bucket. `dataType`
   * selects OI vs price gainers/losers. Cached 20s (matches the scanner TTLs).
   */
  async getTopGainersLosers(
    dataType: GainersLosersDataType,
    expiry: DerivExpiryType = "NEAR",
  ): Promise<DerivGainerLoser[]> {
    const cfg = await resolveConfig();
    if (!cfg) return [];
    return cache.memo(`angel:gl:${dataType}:${expiry}`, 20_000, async () => {
      try {
        const jwt = await login(cfg);
        const data = await smartApiPost<unknown>(
          cfg,
          "/rest/secure/angelbroking/marketData/v1/gainersLosers",
          { datatype: dataType, expirytype: expiry },
          jwt,
        );
        return parseGainersLosers(data);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`angelone.getTopGainersLosers(${dataType}):`, msg);
        return [];
      }
    });
  }

  /** First-party Put-Call Ratio per F&O underlying. Cached 20s. */
  async getPutCallRatio(): Promise<DerivPcr[]> {
    const cfg = await resolveConfig();
    if (!cfg) return [];
    return cache.memo("angel:pcr:all", 20_000, async () => {
      try {
        const jwt = await login(cfg);
        const data = await smartApiPost<unknown>(
          cfg,
          "/rest/secure/angelbroking/marketData/v1/putCallRatio",
          {},
          jwt,
        );
        return parsePcr(data);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`angelone.getPutCallRatio:`, msg);
        return [];
      }
    });
  }

  /**
   * OI build-up list for a single direction (`datatype`) and expiry bucket.
   * Every returned row is tagged with the canonical `OiBuildupKind`.
   */
  async getOiBuildup(
    datatype: OiBuildupDataType,
    expiry: DerivExpiryType = "NEAR",
  ): Promise<DerivOiBuildup[]> {
    const cfg = await resolveConfig();
    if (!cfg) return [];
    return cache.memo(`angel:oib:${datatype}:${expiry}`, 20_000, async () => {
      try {
        const jwt = await login(cfg);
        const data = await smartApiPost<unknown>(
          cfg,
          "/rest/secure/angelbroking/marketData/v1/OIBuildup",
          { datatype, expirytype: expiry },
          jwt,
        );
        return parseOiBuildup(data, datatype);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`angelone.getOiBuildup(${datatype}):`, msg);
        return [];
      }
    });
  }

  // ── Account data (read-only portfolio / margin) ───────────────────────────
  //
  // These power a live "broker account" surface beside Paper Trading. They
  // return `null` when Angel One isn't configured (or on any error) so callers
  // can show a "connect Angel One" empty state instead of crashing. Live order
  // placement is intentionally NOT implemented.

  /** Funds & margin (RMS). Null when Angel One is unconfigured / errored. */
  async getFunds(): Promise<AccountFunds | null> {
    const cfg = await resolveConfig();
    if (!cfg) return null;
    return cache.memo("angel:funds", 10_000, async () => {
      try {
        const jwt = await login(cfg);
        const data = await smartApiGet<unknown>(
          cfg,
          "/rest/secure/angelbroking/user/v1/getRMS",
          jwt,
        );
        return parseFunds(data);
      } catch (e: unknown) {
        console.error(
          "angelone.getFunds:",
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
    });
  }

  /** Demat holdings + portfolio summary. Null when unconfigured / errored. */
  async getHoldings(): Promise<HoldingsResult | null> {
    const cfg = await resolveConfig();
    if (!cfg) return null;
    return cache.memo("angel:holdings", 30_000, async () => {
      try {
        const jwt = await login(cfg);
        const data = await smartApiGet<unknown>(
          cfg,
          "/rest/secure/angelbroking/portfolio/v1/getAllHolding",
          jwt,
        );
        return parseHoldings(data);
      } catch (e: unknown) {
        console.error(
          "angelone.getHoldings:",
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
    });
  }

  /** Net open day/carry-forward positions. Null when unconfigured / errored. */
  async getPositions(): Promise<Position[] | null> {
    const cfg = await resolveConfig();
    if (!cfg) return null;
    return cache.memo("angel:positions", 10_000, async () => {
      try {
        const jwt = await login(cfg);
        const data = await smartApiGet<unknown>(
          cfg,
          "/rest/secure/angelbroking/order/v1/getPosition",
          jwt,
        );
        return parsePositions(data);
      } catch (e: unknown) {
        console.error(
          "angelone.getPositions:",
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
    });
  }

  /**
   * Live feed via the SmartStream WebSocket 2.0 binary tick stream. Resolves
   * the user's credentials + feed token, maps each symbol to its Angel token,
   * opens a single socket and emits a {@link Quote} per decoded frame. Any
   * setup failure (no credentials, no feed token, no resolvable tokens) — and
   * the unconfigured-Angel case — degrades transparently to {@link subscribeFeed}
   * (the 5s FULL-quote poll, itself backed by Yahoo when needed), so the caller
   * always receives a working unsubscribe handle.
   */
  async subscribeFeedWs(
    symbols: string[],
    onTick: (q: Quote) => void,
    intervalMs = 5_000,
  ): Promise<() => void> {
    if (symbols.length === 0) return () => {};
    try {
      const cfg = await resolveConfig();
      if (cfg) {
        await login(cfg); // populates the session (jwt + feedToken)
        const session = sessions.get(cfg.clientCode);
        const jwt = session?.jwt;
        const feedToken = session?.feedToken;
        if (jwt && feedToken) {
          const { cash } = await getScripSubsets();
          const eqMap = buildEqTokenMap(cash);
          const tokensByExchangeType: Record<number, string[]> = {};
          const tokenToSymbol = new Map<string, string>();
          for (const symbol of symbols) {
            const resolved = resolveAngelToken(symbol, eqMap);
            if (!resolved) continue;
            const exType = SMART_EXCHANGE_TYPE_BY_EXCHANGE[resolved.exchange];
            if (!exType) continue;
            (tokensByExchangeType[exType] ??= []).push(resolved.token);
            tokenToSymbol.set(resolved.token, symbol);
          }
          if (tokenToSymbol.size > 0) {
            const client = new SmartStreamClient({
              credentials: {
                apiKey: cfg.apiKey,
                clientCode: cfg.clientCode,
                jwt,
                feedToken,
              },
              tokensByExchangeType,
              mode: SMART_MODE.QUOTE,
              onTick: (tick: SmartTick) => {
                const symbol = tokenToSymbol.get(tick.token);
                if (symbol) onTick(quoteFromTick(symbol, tick));
              },
              onError: (e: unknown) =>
                console.error(
                  "angelone.smartstream:",
                  e instanceof Error ? e.message : String(e),
                ),
            });
            client.start();
            return () => client.stop();
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("angelone.subscribeFeedWs setup:", msg);
    }
    return this.subscribeFeed(symbols, onTick, intervalMs);
  }

  /**
   * Live feed via SmartAPI quote polling — the resilient fallback for
   * {@link subscribeFeedWs}. Polls the FULL-mode quote endpoint (reusing the
   * same auth + token plumbing) and matches the gateway's diff-based contract.
   * Unconfigured credentials transparently fall back to the Yahoo poller.
   */
  subscribeFeed(
    symbols: string[],
    onTick: (q: Quote) => void,
    intervalMs = 5_000,
  ): () => void {
    if (symbols.length === 0) return () => {};
    // `getQuotes` resolves credentials itself and falls back to Yahoo when
    // Angel One isn't configured, so the polling loop works in every case.
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const quotes = await this.getQuotes(symbols);
        if (cancelled) return;
        for (const q of quotes) onTick(q);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`angelone.subscribeFeed:`, msg);
      }
    };
    void tick();
    const id = setInterval(tick, Math.max(1_500, intervalMs));
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }
}

export const angel = new AngelOneAdapter();
