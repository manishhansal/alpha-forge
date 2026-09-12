/**
 * Upstox API — SECONDARY Indian Market Data Provider
 *
 * Role in the provider chain:  DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO
 * NSE is NOT in the chain. Direct NSE data acquisition is prohibited.
 *
 * This file is the complete, self-contained Upstox adapter.  It implements
 * every method of MarketDataProvider and never leaks Upstox-specific types
 * beyond this module boundary.
 *
 * Capabilities:
 *   ✓ Historical candles  (NSE EQ + NFO, all supported intervals)
 *   ✓ Live quotes         (single + bulk, REST)
 *   ✓ WebSocket stream    (v3 feed — authorize via /v3/feed/market-data-feed/authorize)
 *   ✓ Option chain        (full Greeks, bid/ask, OI, IV, delta, gamma, theta, vega)
 *   ✓ Instrument resolution (NSE symbol → Upstox instrument key)
 *   ✗ Instrument master   (Upstox has no full dump; Angel One owns this)
 *
 * Authentication strategy (server-side only — tokens NEVER reach the browser):
 *   1. UPSTOX_ANALYTICS_TOKEN  — long-lived read-only token; preferred for all
 *      non-trading data paths (candles, quotes, option chain).  Rotate via
 *      the Upstox Developer Console independently of OAuth.
 *   2. In-memory OAuth2 access token  — from /api/in/providers/upstox/callback BFF.
 *      Exchanged server-side; stored in server memory only via upstox-token-state.ts.
 *   3. Legacy fallback: UPSTOX_ACCESS_TOKEN  — accepted for backward compat
 *      with deployments that already set this value directly.
 *
 * When none of the above are configured the provider is silently unconfigured.
 * All methods return empty / null and the failover engine routes to Yahoo.
 *
 * Cache keys (Redis via market-cache facade):
 *   md:candles:upstox:{exchange}:{symbol}:{interval}:{from}:{to}  TTL 30s / 4h
 *   md:quote:upstox:{symbol}                                       TTL 3s
 *   md:oc:upstox:{underlying}:{expiry}                             TTL 15s
 *   md:provider-health:upstox                                      TTL 5s
 *
 * WebSocket:
 *   The Upstox v2 WS authorize endpoint was discontinued (HTTP 410 UDAPI1153).
 *   We authorize against the v3 endpoint (/v3/feed/market-data-feed/authorize),
 *   which returns `data.authorizedRedirectUri` and works with the Analytics
 *   Token.  The v3 feed streams binary Protobuf FeedResponse frames, decoded
 *   in-process by the dependency-free reader in ./upstox-proto.ts (no protobufjs
 *   runtime / generated schema needed).  Control acks arrive as JSON and take
 *   the JSON fallback path.
 *
 * SECURITY: Do NOT add NEXT_PUBLIC_ environment variables for any Upstox credential.
 * Do NOT import from this file in client components or client-side code.
 */

import WebSocket from "ws";

import type { MarketDataProvider, ProviderCallOptions } from "../provider";
import type {
  Exchange,
  HistoricalCandleRequest,
  Instrument,
  InstrumentMasterFilter,
  LiveTick,
  MDQuote,
  OHLCVCandle,
  OptionChain,
  OptionChainRow,
  OptionContract,
  ProviderId,
  ProviderHealth,
  SubscribeRequest,
} from "../types";
import {
  getProviderHealth,
  isTickStale,
  mdLog,
  recordFailure,
  recordStaleData,
  recordSuccess,
  failureKindToErrorCode,
} from "../health";
import { MarketDataError, type MarketDataErrorCode } from "../types";
import {
  memoCandles,
  memoOptionChain,
  memoQuote,
  memoQuoteBatch,
} from "../cache/market-cache";
import {
  finiteOrNull,
  intervalToUpstox,
  intervalToUpstoxV3,
  normaliseExpiry,
  normaliseCandlesFromUpstox,
} from "../normalizer";
import { filterValidCandles } from "../validation/candle-validator";
import { decodeFeedResponse } from "./upstox-proto";

// ── Provider constant ─────────────────────────────────────────────────────────

const PROVIDER_ID: ProviderId = "upstox";
const UPSTOX_BASE = "https://api.upstox.com";
// v2 authorize is DISCONTINUED (HTTP 410 UDAPI1153 "use /v3/feed/market-data-feed",
// verified live). v3 authorize returns 200 with `data.authorizedRedirectUri` and
// works with the Analytics Token.
const UPSTOX_WS_AUTH_URL = "https://api.upstox.com/v3/feed/market-data-feed/authorize";
const TIMEOUT_MS = 10_000;

// ── TTLs (ms) — exported so tests can assert against them ────────────────────

export const UPSTOX_CACHE_TTL = {
  liveQuote:      3_000,
  intradayCandle: 30_000,
  dailyCandle:    4 * 60 * 60_000,
  optionChain:    15_000,
  providerHealth: 5_000,
} as const;

// ── Auth config ───────────────────────────────────────────────────────────────

// ── OAuth2 token state (in-memory; no persistence required) ──────────────────

interface OAuthState {
  accessToken: string | null;
  expiresAt: number | null;   // UTC epoch ms
  refreshing: boolean;
}

const _oauthState: OAuthState = {
  accessToken: null,
  expiresAt:   null,
  refreshing:  false,
};

/**
 * Return the best available bearer token for market-data read requests.
 *
 * Priority:
 *   1. UPSTOX_ANALYTICS_TOKEN   — long-lived, read-only, preferred for data paths.
 *   2. In-memory refreshed access token  (from OAuth2 token exchange).
 *   3. UPSTOX_ACCESS_TOKEN      — legacy direct env var (backward compat).
 *
 * Returns null when nothing is configured.
 */
function getReadToken(): string | null {
  return (
    process.env.UPSTOX_ANALYTICS_TOKEN ??
    _oauthState.accessToken ??
    process.env.UPSTOX_ACCESS_TOKEN ??
    null
  );
}

/**
 * Async token resolver — extends the sync {@link getReadToken} with a 4th
 * fallback tier that reads the signed-in user's Analytics Token from the
 * encrypted `UserSetting.apiKeysEncrypted` store (entered via Profile → API
 * Keys → "Upstox Analytics API").
 *
 * Priority:
 *   1. UPSTOX_ANALYTICS_TOKEN  (env — fastest, zero I/O)
 *   2. In-memory OAuth2 access token
 *   3. UPSTOX_ACCESS_TOKEN     (env legacy)
 *   4. Per-user DB token       (loaded lazily via upstox-credentials.ts)
 *
 * Returns null when no token source is available; callers must handle the
 * null case (provider returns empty / null and the registry fails over to
 * Yahoo Finance).
 */
async function resolveReadToken(): Promise<string | null> {
  // Fast path — check env vars first (synchronous, no I/O).
  const envToken = getReadToken();
  if (envToken) return envToken;

  // V5 fix: process-scoped worker override — populated at worker/CLI startup
  // from the stored per-user Analytics Token (no session needed). This lets the
  // worker/backfill use a frontend-configured Upstox token.
  try {
    const { getWorkerUpstoxToken } = await import("@/lib/market-data/worker-credentials");
    const workerToken = getWorkerUpstoxToken();
    if (workerToken) return workerToken;
  } catch {
    /* worker-credentials unavailable — fall through */
  }

  // Slow path — load the per-user DB token only when env vars are absent.
  // The lazy import avoids pulling NextAuth + Prisma into every code path
  // that imports this provider module (e.g. worker, data-service scripts).
  try {
    const mod = await import("@/features/settings/upstox-credentials");
    const creds = await mod.getUpstoxTokenForRequest();
    return creds?.analyticsToken ?? null;
  } catch {
    return null;
  }
}

export function isUpstoxConfigured(): boolean {
  return Boolean(
    process.env.UPSTOX_ANALYTICS_TOKEN ??
    _oauthState.accessToken ??
    process.env.UPSTOX_ACCESS_TOKEN ??
    (process.env.UPSTOX_CLIENT_ID && process.env.UPSTOX_CLIENT_SECRET),
  );
}

/**
 * Async availability check used by the provider's data methods.
 *
 * Unlike the sync {@link isUpstoxConfigured} (env-only), this also consults the
 * signed-in user's per-user Analytics Token stored in the encrypted DB
 * (`UserSetting.apiKeysEncrypted`, entered via Profile → API Keys). Without
 * this, a user who configured Upstox purely from the frontend — with no env
 * vars set — would have every provider method short-circuit and silently fail
 * over to Yahoo, even though {@link resolveReadToken} could have loaded their
 * DB token at the HTTP layer.
 *
 * Fast path: returns true immediately on any env-configured source (no I/O).
 * Slow path: resolves the DB token (async `auth()` + Prisma read) only when no
 * env source is present. Returns false when no token source is available.
 */
async function isUpstoxAvailable(): Promise<boolean> {
  // Fast path — env / OAuth / client-credential sources (synchronous, no I/O).
  if (isUpstoxConfigured()) return true;

  // Slow path — per-user DB token (requires auth() + Prisma).
  const token = await resolveReadToken();
  return token !== null;
}

/**
 * Reset the in-memory OAuth state. Used in tests to prevent bleed between test cases.
 * @internal
 */
export function _resetOAuthStateForTests(): void {
  _oauthState.accessToken = null;
  _oauthState.expiresAt   = null;
  _oauthState.refreshing  = false;
}

/**
 * Exchange a one-time authorization code for an access token via Upstox OAuth2.
 * This is called by your OAuth callback route — not invoked automatically here.
 * The resulting token is stored in _oauthState for subsequent data requests.
 *
 * @param code         Authorization code from Upstox OAuth redirect.
 * @param redirectUri  Must match the URI registered in the Upstox Developer Console.
 */
export async function exchangeUpstoxCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId     = process.env.UPSTOX_CLIENT_ID;
  const clientSecret = process.env.UPSTOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Upstox: UPSTOX_CLIENT_ID / UPSTOX_CLIENT_SECRET not configured");
  }

  const body = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    "authorization_code",
  });

  const res = await fetch(`${UPSTOX_BASE}/v2/login/authorization/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Api-Version": "2.0" },
    body:    body.toString(),
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Upstox OAuth: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  _oauthState.accessToken = data.access_token;
  _oauthState.expiresAt   = Date.now() + data.expires_in * 1_000 - 60_000; // 60s buffer
  _oauthState.refreshing  = false;

  mdLog("provider_selected", {
    providerId: PROVIDER_ID,
    event: "oauth_token_exchanged",
    expiresIn: data.expires_in,
  });

  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/**
 * Store a pre-obtained access token (e.g. loaded from a secret manager at startup).
 */
export function setUpstoxAccessToken(token: string, expiresInSeconds = 86_400): void {
  _oauthState.accessToken = token;
  _oauthState.expiresAt   = Date.now() + expiresInSeconds * 1_000 - 60_000;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function upstoxGet<T>(
  path: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
  token?: string,
): Promise<T> {
  const bearerToken = token ?? await resolveReadToken();
  if (!bearerToken) {
    throw new Error("Upstox: no bearer token available (set UPSTOX_ANALYTICS_TOKEN or configure via Profile → API Keys)");
  }

  const url = new URL(`${UPSTOX_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method:  "GET",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept:        "application/json",
      "Api-Version": "2.0",
    },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    cache:  "no-store",
  });

  if (res.status === 401) {
    throw new Error(`Upstox ${path}: HTTP 401 unauthorized`);
  }
  if (!res.ok) {
    throw new Error(`Upstox ${path}: HTTP ${res.status}`);
  }

  const envelope = (await res.json()) as { status: string; data: T; errors?: unknown };
  if (envelope.status !== "success") {
    throw new Error(`Upstox ${path}: status=${envelope.status}`);
  }
  return envelope.data;
}

// ── Instrument key helpers ────────────────────────────────────────────────────

/**
 * Well-known index instrument keys for Upstox.
 * These never change and do not require an instrument master lookup.
 */
const INDEX_KEYS: Record<string, string> = {
  NIFTY:        "NSE_INDEX|Nifty 50",
  BANKNIFTY:    "NSE_INDEX|Nifty Bank",
  FINNIFTY:     "NSE_INDEX|Nifty Fin Service",
  MIDCPNIFTY:   "NSE_INDEX|Nifty MidCap Select",
  NIFTYNXT50:   "NSE_INDEX|Nifty Next 50",
  SENSEX:       "BSE_INDEX|SENSEX",
  BANKEX:       "BSE_INDEX|BANKEX",
  "^NSEI":      "NSE_INDEX|Nifty 50",
  "^NSEBANK":   "NSE_INDEX|Nifty Bank",
  "^CNXFIN":    "NSE_INDEX|Nifty Fin Service",
  "^NSEMDCP50": "NSE_INDEX|Nifty MidCap Select",
};

/**
 * Convert a canonical NSE symbol + exchange to an Upstox instrument key.
 *
 * Upstox instrument key format:
 *   NSE_EQ|{ISIN}    — NSE equity (resolved from ISIN when available)
 *   NSE_EQ|{symbol}  — NSE equity by trading symbol (fallback)
 *   NSE_FO|{symbol}  — NSE F&O
 *   BSE_EQ|{symbol}  — BSE equity
 *   NSE_INDEX|{name} — Index
 */
export function toUpstoxInstrumentKey(symbol: string, exchange: Exchange): string {
  // Strip Yahoo suffix before lookup
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  // Index lookup (highest priority — these are exchange-agnostic)
  if (INDEX_KEYS[clean]) return INDEX_KEYS[clean]!;
  if (exchange === "NSE" && INDEX_KEYS[symbol]) return INDEX_KEYS[symbol]!;

  // Segment routing
  switch (exchange) {
    case "NFO": return `NSE_FO|${clean}`;
    case "BSE": return `BSE_EQ|${clean}`;
    case "BFO": return `BSE_FO|${clean}`;
    case "MCX": return `MCX_FO|${clean}`;
    default:    return `NSE_EQ|${clean}`;
  }
}

/**
 * Async instrument-key resolver — the CORRECT path for equities.
 *
 * Upstox rejects symbol-based equity keys (`NSE_EQ|RELIANCE` → HTTP 400
 * "Invalid Instrument key") and requires the ISIN-based key
 * (`NSE_EQ|INE002A01018`). Indices (`NSE_INDEX|…`) and F&O keys are already
 * correct via the sync builder, so we only need to resolve the ISIN for NSE/BSE
 * equities. Falls back to the sync symbol form when the master is unavailable.
 */
export async function resolveUpstoxInstrumentKey(
  symbol: string,
  exchange: Exchange,
): Promise<string> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  // Index / F&O / non-equity segments keep the sync (name/token) form.
  if (INDEX_KEYS[clean] || (exchange === "NSE" && INDEX_KEYS[symbol])) {
    return toUpstoxInstrumentKey(symbol, exchange);
  }
  if (exchange === "NFO" || exchange === "BFO" || exchange === "MCX") {
    return toUpstoxInstrumentKey(symbol, exchange);
  }

  // Equity: resolve the ISIN-based key from the instrument master.
  if (exchange === "NSE" || exchange === "BSE") {
    try {
      const { resolveEquityInstrumentKey } = await import("./upstox-instruments");
      const resolved = await resolveEquityInstrumentKey(clean, exchange);
      if (resolved) return resolved;
    } catch {
      /* fall through to the sync fallback */
    }
  }
  return toUpstoxInstrumentKey(symbol, exchange);
}

/**
 * Resolve a canonical symbol to an Upstox instrument key for the option chain
 * endpoint.  The option chain requires the underlying's instrument key, which
 * for indices uses the special NSE_INDEX form.
 */
function toOptionChainInstrumentKey(underlying: string): string {
  const clean = underlying.toUpperCase();
  return INDEX_KEYS[clean] ?? `NSE_EQ|${clean}`;
}

// ── Upstox raw response types ─────────────────────────────────────────────────

/** Historical candle API — /v2/historical-candle/{key}/{interval}/{to}/{from} */
interface UpstoxCandleData {
  candles: Array<[string, number, number, number, number, number, number]>;
  // [timestamp, open, high, low, close, volume, oi]
}

/** Market quote API — /v2/market-quote/quotes */
interface UpstoxQuoteItem {
  instrument_token: string;
  last_price: number;
  net_change: number | null;
  net_change_percentage?: number | null;
  ohlc?: { open: number; high: number; low: number; close: number };
  volume?: number;
  average_price?: number;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  upper_circuit_limit?: number;
  lower_circuit_limit?: number;
  // 52-week fields are NOT returned by /v2/market-quote/quotes (verified live);
  // kept optional for forward-compat but will be null in practice.
  week_high_52?: number;
  week_low_52?: number;
  // Upstox returns these as *_quantity (verified against the live API). The
  // legacy *_qty aliases are kept only as a defensive fallback.
  total_buy_quantity?: number;
  total_sell_quantity?: number;
  total_buy_qty?: number;
  total_sell_qty?: number;
  last_trade_time?: string;
  depth?: {
    buy:  Array<{ quantity: number; price: number; orders: number }>;
    sell: Array<{ quantity: number; price: number; orders: number }>;
  };
}

/** Option chain API — /v2/option/chain */
interface UpstoxOptionStrike {
  expiry:        string;
  strike_price:  number;
  underlying_spot_price?: number;
  call_options?: UpstoxOptionLeg;
  put_options?:  UpstoxOptionLeg;
}

interface UpstoxOptionLeg {
  instrument_key: string;
  market_data?: {
    ltp?:       number;
    bid_price?: number;
    ask_price?: number;
    bid_qty?:   number;
    ask_qty?:   number;
    oi?:        number;
    oi_day_high?: number;
    oi_day_low?:  number;
    volume?:    number;
    vtt?:       number;
    prev_oi?:   number;
  };
  option_greeks?: {
    iv?:    number;
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?:  number;
    rho?:   number;
  };
}

/** WebSocket authorize endpoint response */
interface UpstoxWsAuthorizeResponse {
  /** v3 authorize returns camelCase `authorizedRedirectUri`. */
  authorizedRedirectUri?: string;
  /** v2 (discontinued) used snake_case; kept as a defensive fallback. */
  authorized_redirect_uri?: string;
}

/** Upstox WebSocket JSON feed frame */
interface UpstoxWsFeedFrame {
  feeds?: Record<string, UpstoxWsInstrumentFeed>;
  type?:  string;
}

interface UpstoxWsInstrumentFeed {
  ff?: {
    marketFF?: {
      // `ltt` is epoch-ms (number) on the v3 Protobuf feed, ISO string on legacy JSON.
      ltpc?: { ltp?: number; ltt?: number | string; ltq?: number; cp?: number };
      marketOHLC?: {
        ohlc?: Array<{ interval: string; open: number; high: number; low: number; close: number; volume: number; ts: string }>;
      };
      eFeedDetails?: {
        atp?: number;
        cp?: number;
        tbq?: number;
        tsq?: number;
        vtt?: number;
        oi?: number;
        iv?: number;
      };
    };
    indexFF?: {
      ltpc?: { ltp?: number; ltt?: number | string; ltq?: number; cp?: number };
    };
  };
}

/** Normalise a ws RawData payload into a single Buffer (or null if not bytes). */
function toBuffer(raw: WebSocket.RawData): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return null;
}

// ── WebSocket manager ─────────────────────────────────────────────────────────

/** How often to send a heartbeat ping to keep the connection alive. */
const WS_HEARTBEAT_INTERVAL_MS = 30_000;
/** Initial reconnect delay (doubles on each attempt, capped at WS_MAX_BACKOFF_MS). */
const WS_BACKOFF_BASE_MS = 1_000;
const WS_MAX_BACKOFF_MS  = 30_000;
/** Maximum consecutive reconnect attempts before giving up and marking provider unhealthy. */
const WS_MAX_RECONNECT_ATTEMPTS = 8;

type TickHandler = (tick: LiveTick) => void;

interface SubscriptionEntry {
  symbol:    string;
  exchange:  Exchange;
  handlers:  Set<TickHandler>;
}

/**
 * UpstoxWsManager manages a single persistent WebSocket connection to the
 * Upstox v2 market data feed.  It mirrors the architecture of AngelOneWsManager:
 *
 *   - One connection shared across all callers.
 *   - Per-token subscription registry with multi-handler fan-out.
 *   - Automatic reconnect with exponential backoff.
 *   - Periodic heartbeat (ping) to detect stale connections.
 *   - Stale tick detection via isTickStale.
 *   - Health scoring via recordSuccess / recordFailure / recordStaleData.
 */
export class UpstoxWsManager {
  // token → {symbol, exchange, handlers}
  private readonly registry = new Map<string, SubscriptionEntry>();

  private ws:                WebSocket | null = null;
  private heartbeatTimer:    ReturnType<typeof setInterval> | null = null;
  private reconnectTimer:    ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts  = 0;
  private _started           = false;
  private _destroyed         = false;

  /** Expose for tests */
  get isStarted(): boolean  { return this._started; }
  get registrySize(): number { return this.registry.size; }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this._started || this._destroyed) return;
    this._started = true;
    void this.connect();
  }

  stop(): void {
    this._destroyed = true;
    this._started   = false;
    this.clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, "UpstoxWsManager.stop()"); } catch { /* ignore */ }
      this.ws = null;
    }
    this.registry.clear();
  }

  // ── Subscription management ───────────────────────────────────────────────

  subscribe(
    token:    string,
    symbol:   string,
    exchange: Exchange,
    handler:  TickHandler,
  ): () => void {
    let entry = this.registry.get(token);
    if (!entry) {
      entry = { symbol, exchange, handlers: new Set() };
      this.registry.set(token, entry);
      // If already connected, send subscribe message for the new token.
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendSubscribeMessage([token]);
      }
    }
    entry.handlers.add(handler);

    return () => {
      entry?.handlers.delete(handler);
      if (entry?.handlers.size === 0) {
        this.registry.delete(token);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.sendUnsubscribeMessage([token]);
        }
      }
    };
  }

  unsubscribeTokens(tokens: string[]): void {
    for (const token of tokens) {
      const entry = this.registry.get(token);
      if (entry) {
        entry.handlers.clear();
        this.registry.delete(token);
      }
    }
    if (tokens.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.sendUnsubscribeMessage(tokens);
    }
  }

  // ── Internal: connect / reconnect ─────────────────────────────────────────

  private async connect(): Promise<void> {
    if (this._destroyed) return;

    try {
      const wsUrl = await this.fetchWsUrl();
      this.openSocket(wsUrl);
    } catch (err) {
      mdLog("provider_failure", {
        providerId: PROVIDER_ID,
        kind:       "ws_disconnect",
        message:    err instanceof Error ? err.message : String(err),
      });
      recordFailure(PROVIDER_ID, "ws_disconnect", "WebSocket auth failed");
      this.scheduleReconnect();
    }
  }

  private async fetchWsUrl(): Promise<string> {
    const token = await resolveReadToken();
    if (!token) throw new Error("Upstox WebSocket: no auth token — set UPSTOX_ANALYTICS_TOKEN or configure via Profile → API Keys");

    const res = await fetch(UPSTOX_WS_AUTH_URL, {
      method:  "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Upstox WS auth: HTTP ${res.status}`);

    const envelope = (await res.json()) as { status: string; data: UpstoxWsAuthorizeResponse };
    if (envelope.status !== "success") {
      throw new Error(`Upstox WS auth: status=${envelope.status}`);
    }
    // v3 → authorizedRedirectUri (camelCase); v2 fallback → authorized_redirect_uri.
    const wsUrl = envelope.data.authorizedRedirectUri ?? envelope.data.authorized_redirect_uri;
    if (!wsUrl) throw new Error("Upstox WS auth: no redirect URI in response");
    return wsUrl;
  }

  private openSocket(url: string): void {
    if (this._destroyed) return;

    const ws = new WebSocket(url);
    this.ws  = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      mdLog("provider_selected", { providerId: PROVIDER_ID, event: "ws_connected" });
      recordSuccess(PROVIDER_ID, 0);

      // Re-subscribe all tokens after (re)connection
      const tokens = Array.from(this.registry.keys());
      if (tokens.length > 0) this.sendSubscribeMessage(tokens);

      this.startHeartbeat();
    });

    ws.on("message", (raw) => {
      this.handleMessage(raw);
    });

    ws.on("error", (err) => {
      mdLog("provider_failure", {
        providerId: PROVIDER_ID,
        kind:       "ws_disconnect",
        message:    err.message,
      });
      recordFailure(PROVIDER_ID, "ws_disconnect", err.message);
    });

    ws.on("close", (code, reason) => {
      this.clearHeartbeat();
      if (!this._destroyed) {
        mdLog("provider_failure", {
          providerId: PROVIDER_ID,
          kind:       "ws_disconnect",
          message:    `WebSocket closed: ${code} ${reason.toString()}`,
        });
        recordFailure(PROVIDER_ID, "ws_disconnect", `closed: ${code}`);
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this._destroyed) return;
    if (this.reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      mdLog("provider_failure", {
        providerId: PROVIDER_ID,
        kind:       "ws_disconnect",
        message:    "Max reconnect attempts reached; giving up",
      });
      return;
    }
    const delay = Math.min(
      WS_MAX_BACKOFF_MS,
      WS_BACKOFF_BASE_MS * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (!this._destroyed) void this.connect();
    }, delay);
  }

  // ── Internal: subscription messages ───────────────────────────────────────

  private sendSubscribeMessage(tokens: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // The v3 feed expects the control message as a BINARY frame (UTF-8 bytes of
    // the JSON), not a text frame — a text frame is silently ignored and no
    // ticks are delivered.  `mode: "full"` maps to the v3 full_d5 request mode.
    const msg = JSON.stringify({
      guid:             crypto.randomUUID(),
      method:           "sub",
      data:             { mode: "full", instrumentKeys: tokens },
    });
    this.ws.send(Buffer.from(msg, "utf8"));
  }

  private sendUnsubscribeMessage(tokens: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({
      guid:   crypto.randomUUID(),
      method: "unsub",
      data:   { mode: "full", instrumentKeys: tokens },
    });
    this.ws.send(Buffer.from(msg, "utf8"));
  }

  // ── Internal: message handling ────────────────────────────────────────────

  private handleMessage(raw: WebSocket.RawData): void {
    const nowMs = Date.now();

    // The Upstox v3 feed sends market data as binary Protobuf frames and only
    // uses JSON for control/ack messages.  Try binary first, JSON as fallback.
    const buf = toBuffer(raw);
    if (buf && buf.length > 0) {
      // A JSON control frame begins with '{' (0x7b) or '[' (0x5b).  Everything
      // else is treated as a Protobuf FeedResponse.
      const first = buf[0];
      if (first !== 0x7b && first !== 0x5b) {
        try {
          const { feeds } = decodeFeedResponse(buf);
          for (const [instrumentKey, feed] of Object.entries(feeds)) {
            this.dispatchFeed(instrumentKey, feed as UpstoxWsInstrumentFeed, nowMs);
          }
        } catch {
          // Malformed binary frame — silently skip.
        }
        return;
      }
    }

    // JSON path (control acks, or a legacy/JSON deployment).
    try {
      const text = buf ? buf.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as UpstoxWsFeedFrame;
      if (!frame.feeds) return;
      for (const [instrumentKey, feed] of Object.entries(frame.feeds)) {
        this.dispatchFeed(instrumentKey, feed, nowMs);
      }
    } catch {
      // Malformed frame — silently skip
    }
  }

  /** Exposed for unit testing via bracket notation. */
  handleTick(instrumentKey: string, feed: UpstoxWsInstrumentFeed): void {
    this.dispatchFeed(instrumentKey, feed, Date.now());
  }

  private dispatchFeed(
    instrumentKey: string,
    feed: UpstoxWsInstrumentFeed,
    nowMs: number,
  ): void {
    // Resolve the token we registered with from the instrument key.
    // Upstox echoes back the same key we subscribed with.
    const entry = this.registry.get(instrumentKey);
    if (!entry || entry.handlers.size === 0) return;

    const ltpc = feed.ff?.marketFF?.ltpc ?? feed.ff?.indexFF?.ltpc;
    if (!ltpc?.ltp) return;

    const ltp  = ltpc.ltp;
    const cp   = ltpc.cp ?? null; // close price (prev close)
    const change    = cp != null ? ltp - cp : null;
    const changePct = cp != null && cp > 0 ? ((ltp - cp) / cp) * 100 : null;

    const eFeed  = feed.ff?.marketFF?.eFeedDetails;
    const volume = eFeed?.vtt ?? null;
    const oi     = eFeed?.oi ?? null;

    // Exchange timestamp from ltt (last trade time).
    //   - v3 Protobuf feed: epoch milliseconds (int64) as a number.
    //   - legacy JSON feed:  ISO-8601 string.
    let exchangeTimestampMs = nowMs;
    if (typeof ltpc.ltt === "number" && Number.isFinite(ltpc.ltt) && ltpc.ltt > 0) {
      exchangeTimestampMs = ltpc.ltt;
    } else if (typeof ltpc.ltt === "string" && ltpc.ltt) {
      const parsed = Date.parse(ltpc.ltt);
      if (Number.isFinite(parsed)) exchangeTimestampMs = parsed;
    }

    // Stale tick guard
    if (isTickStale(exchangeTimestampMs)) {
      recordStaleData(PROVIDER_ID, nowMs - exchangeTimestampMs, 5_000);
    }

    const tick: LiveTick = {
      token:               instrumentKey,
      symbol:              entry.symbol,
      exchange:            entry.exchange,
      ltp,
      change:              finiteOrNull(change),
      changePct:           finiteOrNull(changePct),
      volume:              volume != null ? finiteOrNull(volume) : null,
      oi:                  oi != null ? finiteOrNull(oi) : null,
      exchangeTimestampMs,
      receivedAtMs:        nowMs,
      provider:            PROVIDER_ID,
    };

    for (const handler of entry.handlers) {
      try { handler(tick); } catch { /* never let a handler crash the feed */ }
    }
  }

  // ── Internal: heartbeat ───────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ── Module-level singletons ───────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __upstoxWsManager: UpstoxWsManager | undefined;
}

/** Return (or create) the process-wide UpstoxWsManager singleton. */
export function getUpstoxWsManager(): UpstoxWsManager {
  if (!globalThis.__upstoxWsManager) {
    globalThis.__upstoxWsManager = new UpstoxWsManager();
  }
  return globalThis.__upstoxWsManager;
}

// ── Quote normalisation ───────────────────────────────────────────────────────

function translateQuoteItem(symbol: string, item: UpstoxQuoteItem): MDQuote {
  const prevClose = item.ohlc?.close ?? null;
  const change    = item.net_change ?? null;
  // Prefer the API-supplied percentage; fall back to computed value.
  const changePct =
    item.net_change_percentage != null
      ? item.net_change_percentage
      : change != null && prevClose != null && prevClose > 0
        ? (change / prevClose) * 100
        : null;

  return {
    symbol,
    token:          item.instrument_token ?? null,
    exchange:       "NSE",
    name:           null,
    ltp:            finiteOrNull(item.last_price),
    change:         finiteOrNull(change),
    changePct:      finiteOrNull(changePct),
    prevClose:      finiteOrNull(prevClose),
    open:           finiteOrNull(item.ohlc?.open ?? null),
    high:           finiteOrNull(item.ohlc?.high ?? null),
    low:            finiteOrNull(item.ohlc?.low ?? null),
    volume:         finiteOrNull(item.volume ?? null),
    oi:             finiteOrNull(item.oi ?? null),
    weekHigh52:     finiteOrNull(item.week_high_52 ?? null),
    weekLow52:      finiteOrNull(item.week_low_52 ?? null),
    upperCircuit:   finiteOrNull(item.upper_circuit_limit ?? null),
    lowerCircuit:   finiteOrNull(item.lower_circuit_limit ?? null),
    totalBuyQty:    finiteOrNull(item.total_buy_quantity ?? item.total_buy_qty ?? null),
    totalSellQty:   finiteOrNull(item.total_sell_quantity ?? item.total_sell_qty ?? null),
    lastTradeTime:  item.last_trade_time ?? null,
    provider:       PROVIDER_ID,
    fetchedAt:      new Date().toISOString(),
  };
}

// ── Option chain normalisation ────────────────────────────────────────────────

function normaliseOptionLeg(
  leg:        UpstoxOptionLeg | undefined,
  optionType: "CE" | "PE",
  underlying: string,
  expiry:     string,
  strike:     number,
): OptionContract | null {
  if (!leg) return null;

  const md     = leg.market_data ?? {};
  const greeks = leg.option_greeks ?? {};

  // RCA-D01: NEVER silently fabricate OI / OI-change / volume as a genuine 0.
  // A missing field is recorded as a PLACEHOLDER (0) with an explicit *Missing
  // flag so analytics and quality gates can exclude it instead of treating a
  // fabricated zero as a real reading (Absolute Rules 2, 5, 46).
  const oiRaw       = finiteOrNull(md.oi ?? null);
  const oiMissing   = oiRaw === null;
  const oi          = oiRaw ?? 0;

  const prevOi      = finiteOrNull(md.prev_oi ?? null);
  // OI-change is only real when BOTH current and previous OI are known.
  const oiChangeKnown = !oiMissing && prevOi != null;
  const oiChange      = oiChangeKnown ? oi - prevOi! : 0;
  const oiChangeMissing = !oiChangeKnown;

  const volumeRaw     = finiteOrNull(md.volume ?? null);
  const volumeMissing = volumeRaw === null;
  const volume        = volumeRaw ?? 0;

  return {
    token:         leg.instrument_key,
    tradingSymbol: leg.instrument_key,
    underlying,
    expiry,
    strike,
    optionType,
    ltp:    finiteOrNull(md.ltp       ?? null),
    bid:    finiteOrNull(md.bid_price ?? null),
    ask:    finiteOrNull(md.ask_price ?? null),
    oi,
    oiChange,
    volume,
    ...(oiMissing ? { oiMissing: true } : {}),
    ...(oiChangeMissing ? { oiChangeMissing: true } : {}),
    ...(volumeMissing ? { volumeMissing: true } : {}),
    greeks: {
      iv:    finiteOrNull(greeks.iv    ?? null),
      delta: finiteOrNull(greeks.delta ?? null),
      gamma: finiteOrNull(greeks.gamma ?? null),
      theta: finiteOrNull(greeks.theta ?? null),
      vega:  finiteOrNull(greeks.vega  ?? null),
      rho:   finiteOrNull(greeks.rho   ?? null),
    },
    fetchedAt: new Date().toISOString(),
  };
}

// ── Option chain analytics ────────────────────────────────────────────────────

function computeAnalytics(
  rows: OptionChainRow[],
  spot: number | null,
): OptionChain["analytics"] {
  let totalCeOi = 0, totalPeOi = 0;
  let totalCeOiChange = 0, totalPeOiChange = 0;
  let totalCeVol = 0, totalPeVol = 0;
  let maxCeOi = 0, maxPeOi = 0;
  let maxCeOiStrike: number | null = null;
  let maxPeOiStrike: number | null = null;

  // RCA-D01: placeholder (source-missing) OI/OI-change/volume must NOT be summed
  // as real zeros. Legs flagged *Missing carry a fabricated 0 for type
  // compatibility only — exclude them from every aggregate so PCR / max-pain /
  // OI-walls reflect actual data, not fabricated zeros.
  for (const row of rows) {
    if (row.ce) {
      if (!row.ce.oiMissing) {
        totalCeOi += row.ce.oi;
        if (row.ce.oi > maxCeOi) { maxCeOi = row.ce.oi; maxCeOiStrike = row.strike; }
      }
      if (!row.ce.oiChangeMissing) totalCeOiChange += row.ce.oiChange;
      if (!row.ce.volumeMissing)   totalCeVol      += row.ce.volume;
    }
    if (row.pe) {
      if (!row.pe.oiMissing) {
        totalPeOi += row.pe.oi;
        if (row.pe.oi > maxPeOi) { maxPeOi = row.pe.oi; maxPeOiStrike = row.strike; }
      }
      if (!row.pe.oiChangeMissing) totalPeOiChange += row.pe.oiChange;
      if (!row.pe.volumeMissing)   totalPeVol      += row.pe.volume;
    }
  }

  const pcrOi    = totalCeOi > 0 ? totalPeOi / totalCeOi    : null;
  const pcrVolume = totalCeVol > 0 ? totalPeVol / totalCeVol : null;

  // ATM IV: nearest-strike IV to spot
  let atmIv: number | null = null;
  if (spot != null) {
    let minDist = Infinity;
    for (const row of rows) {
      const dist = Math.abs(row.strike - spot);
      if (dist < minDist) {
        minDist = dist;
        atmIv   = row.ce?.greeks.iv ?? row.pe?.greeks.iv ?? null;
      }
    }
  }

  // Max pain: strike where total option buyer pain is maximised
  let maxPain: number | null = null;
  if (rows.length > 0) {
    let minPain = Infinity;
    for (const candidate of rows) {
      let pain = 0;
      for (const row of rows) {
        if (row.ce && !row.ce.oiMissing) pain += row.ce.oi * Math.max(0, row.strike - candidate.strike);
        if (row.pe && !row.pe.oiMissing) pain += row.pe.oi * Math.max(0, candidate.strike - row.strike);
      }
      if (pain < minPain) { minPain = pain; maxPain = candidate.strike; }
    }
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

// ── UpstoxProvider ────────────────────────────────────────────────────────────

export class UpstoxProvider implements MarketDataProvider {
  readonly id: ProviderId = PROVIDER_ID;

  // ── Historical candles ────────────────────────────────────────────────────

  async getHistoricalCandles(
    req: HistoricalCandleRequest,
    opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]> {
    if (!(await isUpstoxAvailable())) return [];

    const interval = intervalToUpstox(req.interval);
    if (!interval) return [];

    return memoCandles(
      req.symbol,
      req.exchange,
      req.interval,
      req.from,
      req.to,
      PROVIDER_ID,
      async () => {
        const instrumentKey = await resolveUpstoxInstrumentKey(req.symbol, req.exchange);
        const toDate   = req.to.slice(0, 10);   // YYYY-MM-DD
        const fromDate = req.from.slice(0, 10);

        const data = await upstoxGet<UpstoxCandleData>(
          `/v2/historical-candle/${encodeURIComponent(instrumentKey)}/${interval}/${toDate}/${fromDate}`,
          undefined,
          opts?.signal,
        );

        const rows = (data.candles ?? []).map((c) => ({
          timestamp: c[0],
          open:      c[1],
          high:      c[2],
          low:       c[3],
          close:     c[4],
          volume:    c[5],
          oi:        c[6],
        }));

        recordSuccess(PROVIDER_ID, 0);
        return filterValidCandles(normaliseCandlesFromUpstox(rows));
      },
    );
  }

  /**
   * V5 §8/§11: Upstox **V3** historical candles. Unlike V2 (limited to
   * 1minute/30minute/day), V3 supports per-minute intervals (1/3/5/15/30) +
   * hours/days AND serves INDEX instrument keys (NSE_INDEX|Nifty 50) that
   * Angel's getCandleData returns empty for. Endpoint shape:
   *   /v3/historical-candle/{instrument_key}/{unit}/{value}/{to_date}/{from_date}
   * Verified live: 200 for minutes/5 on RELIANCE and NIFTY.
   */
  async getHistoricalCandlesV3(
    req: HistoricalCandleRequest,
    opts?: ProviderCallOptions,
  ): Promise<OHLCVCandle[]> {
    if (!(await isUpstoxAvailable())) return [];
    const v3 = intervalToUpstoxV3(req.interval);
    if (!v3) return [];

    const instrumentKey = await resolveUpstoxInstrumentKey(req.symbol, req.exchange);
    const toDate = req.to.slice(0, 10);
    const fromDate = req.from.slice(0, 10);
    const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${v3.unit}/${v3.value}/${toDate}/${fromDate}`;

    const data = await upstoxGet<UpstoxCandleData>(path, undefined, opts?.signal);
    const rows = (data.candles ?? []).map((c) => ({
      timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5], oi: c[6],
    }));
    // Upstox returns candles NEWEST-FIRST (descending). The candle validator
    // rejects non-ascending timestamps, which would drop all but the first bar.
    // Normalise then sort ascending by time before validating.
    const normalised = normaliseCandlesFromUpstox(rows).sort((a, b) => a.time - b.time);
    recordSuccess(PROVIDER_ID, 0);
    return filterValidCandles(normalised);
  }

  // ── Live quote (single symbol) ────────────────────────────────────────────

  async getLatestQuote(
    symbol:  string,
    opts?:   ProviderCallOptions,
  ): Promise<MDQuote | null> {
    // §4: "not configured" must fail over (typed throw), not silently return a
    // null that withFailover would treat as a successful empty result.
    if (!(await isUpstoxAvailable())) {
      throw new MarketDataError(
        "Upstox: not configured — set UPSTOX_ANALYTICS_TOKEN or add an Analytics Token via Profile → API Keys",
        PROVIDER_ID,
        "NOT_CONFIGURED",
      );
    }

    return memoQuote(symbol, PROVIDER_ID, async () => {
      const instrumentKey = await resolveUpstoxInstrumentKey(symbol, "NSE");
      const data = await upstoxGet<Record<string, UpstoxQuoteItem>>(
        "/v2/market-quote/quotes",
        { instrument_key: instrumentKey },
        opts?.signal,
      );
      // Upstox echoes the key back with either delimiter (NSE_EQ|X or NSE_EQ:X),
      // so match on either form before falling back to the first row.
      const item =
        data[instrumentKey] ??
        data[instrumentKey.replace("|", ":")] ??
        Object.values(data)[0];
      if (!item) return null;
      recordSuccess(PROVIDER_ID, 0);
      return translateQuoteItem(symbol, item);
    });
  }

  // ── Bulk quotes ───────────────────────────────────────────────────────────

  async getQuotes(
    symbols: string[],
    opts?:   ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    // Empty input is not a failure — return an empty result.
    if (symbols.length === 0) return [];
    // §4: "not configured" is a real reason to fail over, NOT legitimate
    // empty data. Throw NOT_CONFIGURED so withFailover routes to the next
    // capable provider instead of interpreting all-null as unresolved symbols.
    if (!(await isUpstoxAvailable())) {
      throw new MarketDataError(
        "Upstox: not configured — set UPSTOX_ANALYTICS_TOKEN or add an Analytics Token via Profile → API Keys",
        PROVIDER_ID,
        "NOT_CONFIGURED",
      );
    }

    // Cache-first + request coalescing (single-flight): identical concurrent
    // batch polls share ONE provider request and a short-TTL cached payload, so
    // N consumers asking for the same symbol set produce 1 Upstox call, not N.
    return memoQuoteBatch(symbols, PROVIDER_ID, () => this._fetchQuotes(symbols, opts));
  }

  /** Raw bulk quote fetch against Upstox (uncached; used by the memo layer). */
  private async _fetchQuotes(
    symbols: string[],
    opts?:   ProviderCallOptions,
  ): Promise<Array<MDQuote | null>> {
    // Upstox allows up to 500 instrument keys per request.
    const CHUNK_SIZE = 500;
    const results: Array<MDQuote | null> = new Array(symbols.length).fill(null);

    // §4: track chunk outcomes so a TOTAL provider failure is re-thrown as a
    // typed error (drives failover + honest status) while a genuine PARTIAL
    // success is preserved. A quiet all-null return would be indistinguishable
    // from "symbols unresolved" and would suppress failover to Yahoo/Angel.
    let chunkCount = 0;
    let failedChunks = 0;
    let lastKind: "api_error" | "auth_failure" | "ws_disconnect" | "timeout" = "api_error";
    let lastMsg = "";

    for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
      chunkCount++;
      const chunk      = symbols.slice(i, i + CHUNK_SIZE);
      const keyToIndex = new Map<string, number>();

      // Resolve ISIN-based equity keys (index/F&O keep their static form).
      const keys = await Promise.all(
        chunk.map(async (s, idx) => {
          const k = await resolveUpstoxInstrumentKey(s, "NSE");
          // Index BOTH delimiter forms so we can match whatever Upstox echoes.
          keyToIndex.set(k, i + idx);
          keyToIndex.set(k.replace("|", ":"), i + idx);
          keyToIndex.set(k.replace(":", "|"), i + idx);
          return k;
        }),
      );

      try {
        const data = await upstoxGet<Record<string, UpstoxQuoteItem>>(
          "/v2/market-quote/quotes",
          { instrument_key: keys.join(",") },
          opts?.signal,
        );
        recordSuccess(PROVIDER_ID, 0);

        for (const [key, item] of Object.entries(data)) {
          // Match on the response key directly, or via the instrument_token the
          // item carries (which is the |-delimited canonical key).
          let globalIdx = keyToIndex.get(key);
          if (globalIdx == null && item?.instrument_token) {
            globalIdx = keyToIndex.get(item.instrument_token);
          }
          if (globalIdx != null) {
            const symbol = symbols[globalIdx]!;
            results[globalIdx] = translateQuoteItem(symbol, item);
          }
        }
      } catch (err) {
        // Record failure but continue processing remaining chunks so a genuine
        // PARTIAL (some chunks OK, some failed) is still returned.
        failedChunks++;
        lastKind = classifyError(err);
        lastMsg = err instanceof Error ? err.message : String(err);
        recordFailure(PROVIDER_ID, lastKind, lastMsg);
      }
    }

    // §4 ROOT-CAUSE FIX: if EVERY chunk failed (total provider failure) and we
    // resolved nothing, throw a typed MarketDataError instead of returning a
    // silent all-null array. That lets withFailover try the next capable
    // provider and lets getQuotesWithStatus stamp the true failure reason.
    if (chunkCount > 0 && failedChunks === chunkCount && results.every((r) => r == null)) {
      throw new MarketDataError(
        `Upstox getQuotes failed for all ${chunkCount} chunk(s): ${lastMsg}`,
        PROVIDER_ID,
        failureKindToErrorCode(lastKind) as MarketDataErrorCode,
      );
    }

    return results;
  }

  // ── Option chain ──────────────────────────────────────────────────────────

  async getOptionChain(
    underlying: string,
    expiry?:    string,
    opts?:      ProviderCallOptions,
  ): Promise<OptionChain> {
    if (!(await isUpstoxAvailable())) {
      throw new Error(
        "Upstox: not configured — set UPSTOX_ANALYTICS_TOKEN or add an Analytics Token via Profile → API Keys",
      );
    }

    const cacheExpiry = expiry ?? "nearest";

    return memoOptionChain(underlying, cacheExpiry, PROVIDER_ID, async () => {
      const instrumentKey = toOptionChainInstrumentKey(underlying);
      const params: Record<string, string> = { instrument_key: instrumentKey };
      if (expiry) params.expiry_date = expiry;

      const strikes = await upstoxGet<UpstoxOptionStrike[]>(
        "/v2/option/chain",
        params,
        opts?.signal,
      );

      if (!strikes || strikes.length === 0) {
        throw new Error(`Upstox: empty option chain for ${underlying}`);
      }

      // Collect unique expiries (normalised to ISO-8601)
      const expiriesSet = new Set<string>();
      let spot: number | null = null;

      for (const s of strikes) {
        if (s.expiry) expiriesSet.add(normaliseExpiry(s.expiry));
        // Upstox includes spot price on each strike row
        if (s.underlying_spot_price && spot == null) {
          spot = finiteOrNull(s.underlying_spot_price);
        }
      }

      const expiries     = Array.from(expiriesSet).sort();
      const chosenExpiry = expiry ? normaliseExpiry(expiry) : (expiries[0] ?? "");

      const filteredStrikes = expiry
        ? strikes.filter((s) => normaliseExpiry(s.expiry) === chosenExpiry)
        : strikes;

      const rows: OptionChainRow[] = filteredStrikes.map((s): OptionChainRow => ({
        strike: s.strike_price,
        ce:     normaliseOptionLeg(s.call_options, "CE", underlying, chosenExpiry, s.strike_price),
        pe:     normaliseOptionLeg(s.put_options,  "PE", underlying, chosenExpiry, s.strike_price),
      }));

      rows.sort((a, b) => a.strike - b.strike);

      recordSuccess(PROVIDER_ID, 0);

      return {
        underlying,
        spot,
        expiry:     chosenExpiry,
        expiries,
        rows,
        analytics:  computeAnalytics(rows, spot),
        provider:   PROVIDER_ID,
        fetchedAt:  new Date().toISOString(),
      };
    });
  }

  // ── Instrument master ─────────────────────────────────────────────────────

  async getInstrumentMaster(
    _filter?: InstrumentMasterFilter,
    _opts?:   ProviderCallOptions,
  ): Promise<Instrument[]> {
    // Upstox does not expose a full instrument master dump.
    // Angel One owns this capability via its ScripMaster CSV.
    return [];
  }

  // ── WebSocket subscribe ───────────────────────────────────────────────────

  subscribe(
    req:     SubscribeRequest,
    onTick:  (tick: LiveTick) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    const wsm = getUpstoxWsManager();

    // Start the WS manager only once a token source is confirmed available.
    // We can't await here (the interface requires a sync unsubscribe closure),
    // so we resolve availability asynchronously: the env fast-path resolves
    // instantly, and the per-user DB token resolves shortly after. Tokens are
    // registered into the manager below regardless — the socket authorizes via
    // resolveReadToken() (which reads the DB token) and (re)subscribes all
    // registered instrument keys on connect.
    if (!wsm.isStarted) {
      void isUpstoxAvailable().then((available) => {
        if (available && !wsm.isStarted) wsm.start();
        else if (!available) {
          onError?.(
            new Error(
              "Upstox WebSocket: no auth token — set UPSTOX_ANALYTICS_TOKEN or add an Analytics Token via Profile → API Keys",
            ),
          );
        }
      });
    }

    const unsubscribers: Array<() => void> = [];

    for (const { token, exchange } of req.tokens) {
      // Resolve the instrument key for this token.
      // Tokens from the SubscribeRequest are already Upstox instrument keys
      // (set by the caller from the instrument master) or fall back to the
      // canonical symbol → key conversion.
      const instrumentKey = token.includes("|")
        ? token                                       // already an Upstox key
        : toUpstoxInstrumentKey(token, exchange);

      // Derive a human-readable symbol from the key for the LiveTick
      const symbol = instrumentKey.includes("|")
        ? instrumentKey.split("|")[1] ?? token
        : token;

      const unsub = wsm.subscribe(instrumentKey, symbol, exchange, onTick);
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }

  // ── WebSocket unsubscribe ─────────────────────────────────────────────────

  unsubscribe(tokens: string[]): void {
    const wsm = getUpstoxWsManager();
    const keys = tokens.map((t) =>
      t.includes("|") ? t : t,   // pass through — they should already be keys
    );
    wsm.unsubscribeTokens(keys);
  }

  // ── Health ────────────────────────────────────────────────────────────────

  getProviderHealth(): ProviderHealth {
    return getProviderHealth(PROVIDER_ID);
  }
}

// ── Error classifier (mirrors failover.ts internal helper) ───────────────────

function classifyError(err: unknown): "api_error" | "auth_failure" | "ws_disconnect" | "timeout" {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("auth") || msg.includes("jwt") || msg.includes("unauthorized") || msg.includes("401")) {
    return "auth_failure";
  }
  if (msg.includes("timeout") || msg.includes("abort") || msg.includes("timed out")) {
    return "timeout";
  }
  if (msg.includes("websocket") || msg.includes("ws ") || msg.includes("socket")) {
    return "ws_disconnect";
  }
  return "api_error";
}
