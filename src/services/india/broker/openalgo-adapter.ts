/**
 * OpenAlgo broker adapter — implements the BrokerAdapter contract using the
 * normalised OpenAlgo REST API. This enables any OpenAlgo-compatible Indian
 * broker (Angel One, Zerodha, Upstox, Groww, Shoonya, etc.) to be used as
 * the market-data and order-execution backend.
 *
 * Security:
 *   - `apiKey` is expected to be the decrypted runtime value (caller must
 *     decrypt using src/lib/crypto.ts before constructing this adapter).
 *   - `placeOrder` / `modifyOrder` / `cancelOrder` are gated behind the
 *     `LIVE_TRADING_ENABLED=true` environment variable — they throw before
 *     making any network request when the flag is absent.
 *
 * Graceful degradation:
 *   - Non-OK HTTP responses throw with a descriptive message so the caller
 *     (route handler or worker) can catch and return `{ available: false }`.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.8
 */

import type { BrokerAdapter, BrokerFetchOptions } from "./types";
import type { Candle, HistoricalRequest, OptionChain, Quote } from "@/types/india";

// ---------------------------------------------------------------------------
// Additional order-related types (not part of the generic BrokerAdapter yet)
// ---------------------------------------------------------------------------

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type ProductType = "MIS" | "NRML" | "CNC";

export interface OrderParams {
  symbol: string;
  exchange?: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  product: ProductType;
  price?: number;
  triggerPrice?: number;
}

export interface OrderResult {
  orderId: string;
  status: string;
  symbol: string;
  quantity?: number;
  price?: number;
  side?: OrderSide;
  rawResponse?: unknown;
}

// ---------------------------------------------------------------------------
// Raw OpenAlgo API response shapes (internal, not exported)
// ---------------------------------------------------------------------------

interface OpenAlgoQuoteData {
  symbol: string;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  prev_close?: number;
  change?: number;
  change_pct?: number;
  volume?: number;
  oi?: number;
}

interface OpenAlgoQuoteResponse {
  status: string;
  data: OpenAlgoQuoteData;
}

interface OpenAlgoOHLCVBar {
  time: string; // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface OpenAlgoHistoricalResponse {
  status: string;
  data: OpenAlgoOHLCVBar[];
}

interface OpenAlgoOrderData {
  orderid: string;
  status: string;
  symbol: string;
  quantity?: number;
  price?: number;
  side?: string;
}

interface OpenAlgoOrderResponse {
  status: string;
  data: OpenAlgoOrderData;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a numeric value safely, returning null for non-finite values. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Assert live trading is enabled; throws before any network call otherwise. */
function assertLiveTradingEnabled(): void {
  if (process.env.LIVE_TRADING_ENABLED !== "true") {
    throw new Error(
      "Live trading is not enabled. Set LIVE_TRADING_ENABLED=true to allow order placement.",
    );
  }
}

const TIMEOUT_MS = 10_000;

/** Fetch with a timeout. Throws on timeout or non-OK status. */
async function openAlgoFetch(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`OpenAlgo ${init.method ?? "GET"} ${url}: HTTP ${res.status}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Normalisation — raw API shapes → canonical Alphaforge types
// ---------------------------------------------------------------------------

function normaliseQuote(symbol: string, data: OpenAlgoQuoteData): Quote {
  return {
    symbol,
    name: null,
    price: num(data.ltp),
    change: num(data.change),
    changePct: num(data.change_pct),
    prevClose: num(data.prev_close),
    open: num(data.open),
    high: num(data.high),
    low: num(data.low),
    volume: num(data.volume),
    oi: num(data.oi),
    source: "openalgo" as const,
    fetchedAt: new Date().toISOString(),
  };
}

function normaliseCandles(bars: OpenAlgoOHLCVBar[]): Candle[] {
  const out: Candle[] = [];
  for (const bar of bars) {
    if (!bar) continue;
    const ts = Date.parse(bar.time);
    const open = num(bar.open);
    const high = num(bar.high);
    const low = num(bar.low);
    const close = num(bar.close);
    if (!Number.isFinite(ts) || open == null || high == null || low == null || close == null) {
      continue;
    }
    out.push({
      time: Math.floor(ts / 1_000), // Unix timestamp in seconds
      open,
      high,
      low,
      close,
      volume: num(bar.volume) ?? undefined,
    });
  }
  return out;
}

function normaliseOrderResult(data: OpenAlgoOrderData, raw: unknown): OrderResult {
  return {
    orderId: data.orderid,
    status: data.status ?? "unknown",
    symbol: data.symbol,
    quantity: num(data.quantity) ?? undefined,
    price: num(data.price) ?? undefined,
    side: (data.side?.toUpperCase() as OrderSide) ?? undefined,
    rawResponse: raw,
  };
}

// ---------------------------------------------------------------------------
// OpenAlgoAdapter
// ---------------------------------------------------------------------------

/**
 * MarketBroker implementation backed by the OpenAlgo normalised REST API.
 *
 * Usage:
 * ```typescript
 * import { decrypt } from "@/lib/crypto";
 * const adapter = new OpenAlgoAdapter(
 *   process.env.OPENALGO_BASE_URL!,
 *   decrypt(JSON.parse(process.env.OPENALGO_API_KEY_ENCRYPTED!)),
 * );
 * ```
 */
export class OpenAlgoAdapter implements BrokerAdapter {
  readonly id = "openalgo" as const;

  constructor(
    private readonly baseUrl: string,
    /** AES-256-GCM encrypted at rest; caller must decrypt before passing here. */
    private readonly apiKey: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      "X-Api-Key": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // ── Quote ────────────────────────────────────────────────────────────────

  async getQuote(symbol: string): Promise<Quote> {
    const url = `${this.baseUrl}/api/v1/quotes?symbol=${encodeURIComponent(symbol)}`;
    const res = await openAlgoFetch(url, { headers: this.headers });
    const json = (await res.json()) as OpenAlgoQuoteResponse;
    return normaliseQuote(symbol, json.data);
  }

  async getQuotes(symbols: string[], _opts?: BrokerFetchOptions): Promise<Quote[]> {
    // OpenAlgo doesn't have a batch quote endpoint — fan out in parallel.
    return Promise.all(symbols.map((s) => this.getQuote(s)));
  }

  // ── Historical ───────────────────────────────────────────────────────────

  async getHistorical(req: HistoricalRequest, _opts?: BrokerFetchOptions): Promise<Candle[]> {
    const now = Date.now();
    const m = /^(\d+)(m|d|mo|y)$/.exec(req.range);
    let lookbackMs = 30 * 86_400_000;
    if (m) {
      const n = Number(m[1]);
      const unit = m[2];
      lookbackMs =
        unit === "m"
          ? n * 60_000
          : unit === "d"
            ? n * 86_400_000
            : unit === "mo"
              ? n * 30 * 86_400_000
              : n * 365 * 86_400_000;
    }
    const fromDate = new Date(now - lookbackMs);
    const toDate = new Date(now);

    const params = new URLSearchParams({
      symbol: req.symbol,
      interval: req.interval,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    });
    const url = `${this.baseUrl}/api/v1/historical?${params.toString()}`;
    const res = await openAlgoFetch(url, { headers: this.headers });
    const json = (await res.json()) as OpenAlgoHistoricalResponse;
    return normaliseCandles(json.data ?? []);
  }

  // ── Option chain (not natively supported — throw clearly) ────────────────

  async getOptionChain(_symbol: string, _expiry?: string): Promise<OptionChain> {
    throw new Error(
      "OpenAlgoAdapter: getOptionChain() is not supported by the OpenAlgo REST API. " +
        "Use the NSE or Angel One adapter for option chains.",
    );
  }

  // ── Order placement (gated behind LIVE_TRADING_ENABLED) ──────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    assertLiveTradingEnabled();

    const url = `${this.baseUrl}/api/v1/placeorder`;
    const body: Record<string, unknown> = {
      symbol: params.symbol,
      exchange: params.exchange ?? "NSE",
      action: params.side,
      quantity: params.quantity,
      ordertype: params.orderType,
      producttype: params.product,
    };
    if (params.price != null) body.price = params.price;
    if (params.triggerPrice != null) body.triggerprice = params.triggerPrice;

    const res = await openAlgoFetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as OpenAlgoOrderResponse;
    return normaliseOrderResult(json.data, json);
  }

  async modifyOrder(orderId: string, params: Partial<OrderParams>): Promise<OrderResult> {
    assertLiveTradingEnabled();

    const url = `${this.baseUrl}/api/v1/modifyorder`;
    const res = await openAlgoFetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ orderid: orderId, ...params }),
    });
    const json = (await res.json()) as OpenAlgoOrderResponse;
    return normaliseOrderResult(json.data, json);
  }

  async cancelOrder(orderId: string): Promise<void> {
    assertLiveTradingEnabled();

    const url = `${this.baseUrl}/api/v1/cancelorder`;
    await openAlgoFetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ orderid: orderId }),
    });
  }
}
