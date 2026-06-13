import { NseIndia } from "stock-nse-india";
import type { EquityOptionChainData, EquityOptionChainItem } from "stock-nse-india";
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

// NSE blocks "non-browser" requests aggressively. To stay below the radar we:
//
//   1. Try the `stock-nse-india` library first — it has battle-tested cookie
//      handling, UA rotation, and an internal connection budget.
//   2. Fall back to a hand-rolled fetch that mimics a real Chrome session:
//      two-step cookie warm-up (root page → option-chain page), rotating UA,
//      sec-ch-ua headers, and a retry-once-on-empty with backoff.
//
// Every NSE call is capped at 8s so a shadow-throttled hang doesn't block
// the dashboard. Empty 200 OK responses (NSE's quiet shadow-ban) throw so
// the route's fallback chain runs and we don't cache garbage.

const NSE_BASE = "https://www.nseindia.com";
const NSE_TIMEOUT_MS = 8_000;

// Small pool of recent desktop UA strings — picked at random per session
// warm-up so two consecutive requests don't look identical.
const UA_POOL: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
];

function pickUa(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)] ?? UA_POOL[0];
}

function nseHeaders(ua: string): Record<string, string> {
  const isFirefox = ua.includes("Firefox");
  const platform = ua.includes("Macintosh")
    ? '"macOS"'
    : ua.includes("Linux")
      ? '"Linux"'
      : '"Windows"';
  const h: Record<string, string> = {
    "User-Agent": ua,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Referer: `${NSE_BASE}/option-chain`,
  };
  if (!isFirefox) {
    h["sec-ch-ua"] =
      '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    h["sec-ch-ua-mobile"] = "?0";
    h["sec-ch-ua-platform"] = platform;
  }
  return h;
}

type SessionState = { cookie: string; ua: string; expiresAt: number };

let session: SessionState | null = null;

// `Headers.getSetCookie()` is supported in modern Node (>=20.0.0 with the
// undici fetch shim) but is still marked optional in some lib targets.
// Cast through `unknown` so TS doesn't require us to match the dom-lib's
// signature exactly, and tolerate a missing method at runtime.
type HasGetSetCookie = { getSetCookie?: () => string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wrap a fetch call with a hard timeout. Replaces the default behaviour of
 *  hanging forever on a shadow-throttled connection. */
async function timedFetch(
  input: string,
  init: RequestInit,
  timeoutMs = NSE_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new Error(
        `NSE ${input.replace(NSE_BASE, "")} timed out after ${timeoutMs}ms — NSE is rate-limiting this IP. Retry shortly.`,
      );
    }
    throw e;
  }
}

/** Merge cookies returned by a Set-Cookie header into a single Cookie string. */
function appendCookies(prior: string, res: Response): string {
  const set = (res.headers as unknown as HasGetSetCookie).getSetCookie?.() ?? [];
  if (set.length === 0) return prior;
  const fresh = set
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
  return prior ? `${prior}; ${fresh}` : fresh;
}

/** Two-step warm-up: hit the NSE root, then the option-chain page, collecting
 *  cookies along the way. This is what a real browser does on first load. */
async function getNseCookies(): Promise<{ cookie: string; ua: string }> {
  if (session && Date.now() < session.expiresAt) {
    return { cookie: session.cookie, ua: session.ua };
  }

  const ua = pickUa();
  const headers = nseHeaders(ua);

  let cookie = "";
  // 1. Root page — sets the Akamai bm_sz / _abck baseline cookies.
  const root = await timedFetch(NSE_BASE, {
    headers: { ...headers, Accept: "text/html,application/xhtml+xml" },
    cache: "no-store",
  });
  cookie = appendCookies(cookie, root);

  // 2. Option-chain page — drops the api-specific session cookies. Reuse the
  //    cookies from step 1 so NSE sees a continuous session.
  const oc = await timedFetch(`${NSE_BASE}/option-chain`, {
    headers: {
      ...headers,
      Accept: "text/html,application/xhtml+xml",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    cache: "no-store",
  });
  cookie = appendCookies(cookie, oc);

  if (!cookie) throw new Error("NSE: no cookies returned from session warm-up");

  session = { cookie, ua, expiresAt: Date.now() + 5 * 60_000 };
  return { cookie, ua };
}

async function nseFetch<T>(path: string): Promise<T> {
  const { cookie, ua } = await getNseCookies();
  const headers = { ...nseHeaders(ua), Cookie: cookie };
  const res = await timedFetch(`${NSE_BASE}${path}`, {
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      session = null;
      const second = await getNseCookies();
      const res2 = await timedFetch(`${NSE_BASE}${path}`, {
        headers: { ...nseHeaders(second.ua), Cookie: second.cookie },
        cache: "no-store",
      });
      if (!res2.ok) throw new Error(`NSE ${path}: HTTP ${res2.status}`);
      return (await res2.json()) as T;
    }
    throw new Error(`NSE ${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ── Library-backed fetch (primary path) ─────────────────────────────────────
// `stock-nse-india` keeps its own cookie/session state and rotates UAs
// internally, which is typically enough to keep NSE happy where a naive
// fetch fails. We construct a single shared instance per Node process.

declare global {
   
  var __nseLibClient: NseIndia | undefined;
}

function getLibClient(): NseIndia {
  if (!globalThis.__nseLibClient) {
    globalThis.__nseLibClient = new NseIndia();
  }
  return globalThis.__nseLibClient;
}

/** Race a promise against an explicit timeout — `stock-nse-india` doesn't
 *  expose its own AbortSignal, so we wrap it here. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${ms}ms — NSE is rate-limiting this IP.`,
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const INDEX_UNDERLYINGS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]);

function isIndexUnderlying(symbol: string): boolean {
  return INDEX_UNDERLYINGS.has(symbol.toUpperCase());
}

type NseOcLeg = {
  strikePrice: number;
  CE?: NseLeg;
  PE?: NseLeg;
};

type NseLeg = {
  strikePrice: number;
  /** Legacy `/api/option-chain-indices` payloads use `expiryDate`. */
  expiryDate?: string | null;
  /** The v3 endpoint (used by stock-nse-india) sometimes emits the plural
   *  form `expiryDates` on each leg. */
  expiryDates?: string | null;
  openInterest: number;
  changeinOpenInterest: number;
  totalTradedVolume: number;
  impliedVolatility: number;
  lastPrice: number;
  bidprice?: number;
  askPrice?: number;
};

function legFrom(l: NseLeg | undefined, type: "CE" | "PE"): OptionLeg | null {
  if (!l) return null;
  return {
    strike: l.strikePrice,
    type,
    oi: l.openInterest ?? 0,
    changeInOi: l.changeinOpenInterest ?? 0,
    volume: l.totalTradedVolume ?? 0,
    iv: l.impliedVolatility ? l.impliedVolatility : null,
    ltp: l.lastPrice ?? null,
    bid: l.bidprice ?? null,
    ask: l.askPrice ?? null,
  };
}

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
    const atm = sorted.slice(0, 5);
    const ivs: number[] = [];
    for (const r of atm) {
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

/** Common shape produced by both fetch paths — matches NSE's native JSON
 *  schema for `/api/option-chain-indices`, which is also what
 *  `stock-nse-india`'s `getIndexOptionChain` returns. */
type RawChainPayload = {
  records?: {
    expiryDates?: string[];
    underlyingValue?: number;
    data?: NseOcLeg[];
  } | null;
};

/** Case/whitespace-insensitive normaliser for NSE expiry strings. NSE sometimes
 *  emits "19-MAY-2026" in one place and "19-May-2026" in another; v3 also drops
 *  the field entirely on legs because the request was already scoped to one
 *  expiry. */
const normExp = (s: string | null | undefined): string =>
  (s ?? "").trim().toUpperCase();

/** Convert NSE's native JSON into our broker-agnostic `OptionChain`. Shared by
 *  both the library-backed path (v3, single-expiry response) and the
 *  hand-rolled fallback (legacy, all-expiries response). */
function toOptionChain(
  upper: string,
  expiry: string | undefined,
  json: RawChainPayload,
): OptionChain {
  const expiries = json.records?.expiryDates ?? [];
  const allData = json.records?.data ?? [];
  const spot = json.records?.underlyingValue ?? null;

  if (allData.length === 0 || expiries.length === 0 || !spot) {
    throw new Error(
      `NSE returned an empty option chain for ${upper} — likely rate-limited. Retry in 30–60s or switch the option-chain source in Profile → Data sources.`,
    );
  }

  /** Pull whichever expiry field this leg carries (singular legacy or plural v3). */
  const legExp = (l: NseLeg | undefined): string =>
    normExp(l?.expiryDate ?? l?.expiryDates ?? null);

  // Keep `chosenExpiry` in the canonical DD-MMM-YYYY format used by the
  // `expiries[]` list — that's what the UI chips compare against.
  const chosenExpiry = expiry ?? expiries[0] ?? "";

  // Detect the response shape:
  //   • v3 endpoint (used by stock-nse-india) returns legs pre-filtered to a
  //     single expiry, often with `expiryDate` in DD-MM-YYYY (or missing). All
  //     legs in `records.data` already belong to the requested expiry.
  //   • Legacy `/api/option-chain-indices` returns legs across ALL expiries,
  //     each carrying its own `expiryDate` in DD-MMM-YYYY.
  // Distinct leg-expiry count tells us which we got.
  const uniqueLegExpiries = new Set(
    allData.flatMap((d) => [legExp(d.CE), legExp(d.PE)]).filter(Boolean),
  );

  const target = normExp(chosenExpiry);
  const data =
    uniqueLegExpiries.size > 1
      ? allData.filter(
          (d) => legExp(d.CE) === target || legExp(d.PE) === target,
        )
      : allData;

  const rows: OptionChainRow[] = data
    .map((d) => ({
      strike: d.strikePrice,
      ce: legFrom(d.CE, "CE"),
      pe: legFrom(d.PE, "PE"),
    }))
    .sort((a, b) => a.strike - b.strike);

  return {
    symbol: upper,
    spot,
    expiry: chosenExpiry,
    expiries,
    rows,
    analytics: computeAnalytics(rows, spot),
    fetchedAt: new Date().toISOString(),
  } satisfies OptionChain;
}

/** Parse NSE's DD-MMM-YYYY expiry into epoch ms for sorting. Returns Infinity
 *  on malformed input so unknown values sink to the end of the list. */
function parseNseExpiryMs(s: string): number {
  const [d, mon, y] = s.split("-");
  const months = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ];
  const m = months.indexOf((mon ?? "").toUpperCase());
  const day = Number(d);
  const year = Number(y);
  if (m < 0 || !Number.isFinite(day) || !Number.isFinite(year)) return Infinity;
  return Date.UTC(year, m, day);
}

/** Pivot the flat-list equity option-chain payload returned by
 *  `stock-nse-india.getEquityOptionChain` (NSE's GetQuoteApi endpoint) into
 *  our broker-agnostic `OptionChain` shape. Note: this endpoint does NOT
 *  include implied-volatility on legs, so `iv` will be null. */
function pivotEquityChain(
  upper: string,
  expiryHint: string | undefined,
  raw: EquityOptionChainData,
): OptionChain {
  const items = raw?.data ?? [];
  if (items.length === 0) {
    throw new Error(
      `NSE returned an empty equity option chain for ${upper} — likely rate-limited. Retry in 30–60s.`,
    );
  }

  // Build expiry → strike → {ce, pe} index, harvesting expiries + spot.
  const expiriesSet = new Set<string>();
  let spot: number | null = null;
  const byExpiry = new Map<
    string,
    Map<number, { ce?: EquityOptionChainItem; pe?: EquityOptionChainItem }>
  >();

  for (const it of items) {
    if (!it.expiryDate) continue;
    expiriesSet.add(it.expiryDate);
    if (spot == null && Number.isFinite(it.underlyingValue)) {
      spot = it.underlyingValue;
    }
    const strike = Number(it.strikePrice);
    if (!Number.isFinite(strike)) continue;

    let bucket = byExpiry.get(it.expiryDate);
    if (!bucket) {
      bucket = new Map();
      byExpiry.set(it.expiryDate, bucket);
    }
    let slot = bucket.get(strike);
    if (!slot) {
      slot = {};
      bucket.set(strike, slot);
    }
    const t = (it.optionType ?? "").toUpperCase();
    if (t.startsWith("CALL") || t === "CE") slot.ce = it;
    else if (t.startsWith("PUT") || t === "PE") slot.pe = it;
  }

  const expiries = Array.from(expiriesSet).sort(
    (a, b) => parseNseExpiryMs(a) - parseNseExpiryMs(b),
  );
  const chosenExpiry = expiryHint ?? expiries[0] ?? "";
  const bucket = byExpiry.get(chosenExpiry) ?? new Map();

  const legFromItem = (
    it: EquityOptionChainItem | undefined,
    type: "CE" | "PE",
  ): OptionLeg | null => {
    if (!it) return null;
    return {
      strike: Number(it.strikePrice),
      type,
      oi: it.openInterest ?? 0,
      changeInOi: it.changeinOpenInterest ?? 0,
      volume: it.totalTradedVolume ?? 0,
      iv: null, // GetQuoteApi endpoint doesn't ship IV
      ltp: it.lastPrice ?? null,
      bid: null,
      ask: null,
    };
  };

  const rows: OptionChainRow[] = Array.from(bucket.entries())
    .map(([strike, { ce, pe }]) => ({
      strike,
      ce: legFromItem(ce, "CE"),
      pe: legFromItem(pe, "PE"),
    }))
    .sort((a, b) => a.strike - b.strike);

  if (rows.length === 0) {
    throw new Error(
      `NSE equity option chain for ${upper} returned 0 rows for expiry ${chosenExpiry}.`,
    );
  }

  return {
    symbol: upper,
    spot,
    expiry: chosenExpiry,
    expiries,
    rows,
    analytics: computeAnalytics(rows, spot),
    fetchedAt: new Date().toISOString(),
  } satisfies OptionChain;
}

/** Attempt #1 — delegate to `stock-nse-india`. Its NseIndia class handles
 *  cookies, UA rotation, and retry internally. Wrapped in a hard timeout
 *  because the library doesn't expose its own AbortSignal. */
async function fetchViaLibrary(
  upper: string,
  expiry: string | undefined,
): Promise<OptionChain> {
  const client = getLibClient();
  if (isIndexUnderlying(upper)) {
    const raw = (await withTimeout(
      client.getIndexOptionChain(upper, expiry),
      NSE_TIMEOUT_MS,
      `stock-nse-india.getIndexOptionChain(${upper})`,
    )) as RawChainPayload;
    return toOptionChain(upper, expiry, raw);
  }
  // Equities: NSE's `/api/option-chain-equities` is the most-throttled
  // endpoint on the site. The `getEquityOptionChain` method routes through
  // NSE's `GetQuoteApi?functionName=getSymbolDerivativesData` instead, which
  // is what NSE's own quote pages call and is much less restricted. The
  // trade-off is no IV per leg, but we still get OI, volume, LTP, and PCR.
  try {
    const flat = (await withTimeout(
      client.getEquityOptionChain(upper),
      NSE_TIMEOUT_MS,
      `stock-nse-india.getEquityOptionChain(${upper})`,
    )) as EquityOptionChainData;
    return pivotEquityChain(upper, expiry, flat);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[nse] getEquityOptionChain failed for ${upper}: ${msg}. Trying legacy /api/option-chain-equities.`,
    );
    const raw = (await withTimeout(
      client.getDataByEndpoint(
        `/api/option-chain-equities?symbol=${encodeURIComponent(upper)}`,
      ),
      NSE_TIMEOUT_MS,
      `stock-nse-india.optionChainEquities(${upper})`,
    )) as RawChainPayload;
    return toOptionChain(upper, expiry, raw);
  }
}

/** Attempt #2 — hand-rolled session warm-up + JSON fetch, with a retry-once
 *  on empty payload (gives NSE a moment to wake up). */
async function fetchViaDirect(
  upper: string,
  expiry: string | undefined,
): Promise<OptionChain> {
  const path = isIndexUnderlying(upper)
    ? `/api/option-chain-indices?symbol=${encodeURIComponent(upper)}`
    : `/api/option-chain-equities?symbol=${encodeURIComponent(upper)}`;

  try {
    return toOptionChain(upper, expiry, await nseFetch<RawChainPayload>(path));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/empty option chain/i.test(msg)) throw e;
    // Empty payload → discard the stale session and retry once after backoff.
    session = null;
    await sleep(1_500);
    return toOptionChain(upper, expiry, await nseFetch<RawChainPayload>(path));
  }
}

export class NseAdapter implements BrokerAdapter {
  readonly id = "nse" as const;

  /** NSE adapter delegates non-option calls to Yahoo (NSE has no clean
   * public quote API for arbitrary symbols). This keeps things working. */
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
    const cacheKey = `nse:oc:${upper}:${expiry ?? "nearest"}`;

    return cache.memo(cacheKey, 20_000, async () => {
      // Library first — it's the most reliable path. Direct fetch is a
      // last-resort fallback (the path that historically gets shadow-banned).
      try {
        return await fetchViaLibrary(upper, expiry);
      } catch (libErr) {
        const libMsg = libErr instanceof Error ? libErr.message : String(libErr);
        console.warn(
          `[nse] stock-nse-india failed for ${upper}: ${libMsg}. Falling back to direct fetch.`,
        );
        try {
          return await fetchViaDirect(upper, expiry);
        } catch (directErr) {
          const dMsg =
            directErr instanceof Error ? directErr.message : String(directErr);
          throw new Error(
            `Both NSE paths failed for ${upper}. Library: ${libMsg}. Direct: ${dMsg}`,
          );
        }
      }
    });
  }
}

export const nse = new NseAdapter();
