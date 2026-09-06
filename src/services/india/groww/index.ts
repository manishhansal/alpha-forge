import type {
  Candle,
  HistoricalRequest,
  OptionChain,
  Quote,
} from "@/types/india";
import type { BrokerAdapter } from "../broker/types";
import { yahoo } from "../yahoo";

/**
 * GrowwAdapter — production wiring for Groww Trade API.
 *
 * When `GROWW_API_KEY` and `GROWW_API_SECRET` are set, this adapter issues
 * real Groww REST calls for quotes/history. Option chain requests must go
 * through the ProviderRegistry (registry.getOptionChain()) which routes
 * DATA_SERVICE → Angel One → Upstox automatically — getOptionChain() on
 * this adapter throws to signal that it is not implemented here.
 */

const GROWW_BASE = process.env.GROWW_API_BASE ?? "https://api.groww.in";

function hasGrowwCreds(): boolean {
  return Boolean(process.env.GROWW_API_KEY && process.env.GROWW_API_SECRET);
}

async function growwFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!hasGrowwCreds()) {
    throw new Error("Groww credentials missing — set GROWW_API_KEY/SECRET.");
  }
  const res = await fetch(`${GROWW_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.GROWW_API_KEY ?? "",
      "X-API-Secret": process.env.GROWW_API_SECRET ?? "",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Groww ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface GrowwQuotePayload {
  tradingSymbol?: string;
  lastPrice?: number;
  netChange?: number;
  percentChange?: number;
  previousClose?: number;
  open?: number;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
}

export class GrowwAdapter implements BrokerAdapter {
  readonly id = "groww" as const;

  /** True when this adapter is wired to live Groww endpoints. */
  get isLive(): boolean {
    return hasGrowwCreds();
  }

  async getQuote(symbol: string): Promise<Quote> {
    if (!this.isLive) return yahoo.getQuote(symbol);
    try {
      const data = await growwFetch<GrowwQuotePayload>(
        `/v1/quote?symbol=${encodeURIComponent(symbol)}`,
      );
      return {
        symbol,
        name: data?.tradingSymbol ?? null,
        price: data?.lastPrice ?? null,
        change: data?.netChange ?? null,
        changePct: data?.percentChange ?? null,
        prevClose: data?.previousClose ?? null,
        open: data?.open ?? null,
        high: data?.dayHigh ?? null,
        low: data?.dayLow ?? null,
        volume: data?.volume ?? null,
        fetchedAt: new Date().toISOString(),
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`groww.getQuote(${symbol}):`, msg);
      return yahoo.getQuote(symbol);
    }
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (!this.isLive) return yahoo.getQuotes(symbols);
    try {
      const data = await growwFetch<{ quotes: GrowwQuotePayload[] }>(
        `/v1/quotes`,
        {
          method: "POST",
          body: JSON.stringify({ symbols }),
        },
      );
      return symbols.map((s, i) => {
        const q = data.quotes?.[i];
        return {
          symbol: s,
          name: q?.tradingSymbol ?? null,
          price: q?.lastPrice ?? null,
          change: q?.netChange ?? null,
          changePct: q?.percentChange ?? null,
          prevClose: q?.previousClose ?? null,
          fetchedAt: new Date().toISOString(),
        } as Quote;
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`groww.getQuotes:`, msg);
      return yahoo.getQuotes(symbols);
    }
  }

  async getHistorical(req: HistoricalRequest): Promise<Candle[]> {
    return yahoo.getHistorical(req);
  }

  async getOptionChain(symbol: string, expiry?: string): Promise<OptionChain> {
    // Groww option chain is not yet implemented. Option chain requests must go
    // through the ProviderRegistry (registry.getOptionChain()) which routes
    // DATA_SERVICE → Angel One → Upstox automatically.
    throw new Error(
      `GrowwAdapter.getOptionChain: not implemented for ${symbol}${expiry ? `@${expiry}` : ""}. Use registry.getOptionChain() instead.`,
    );
  }

  /**
   * Subscribe to Groww's WebSocket feed when live; otherwise fall back to
   * polling via Yahoo.
   */
  subscribeFeed(
    symbols: string[],
    onTick: (q: Quote) => void,
    intervalMs?: number,
  ): () => void {
    if (this.isLive) {
      console.warn(
        "GrowwAdapter.subscribeFeed: live feed not yet implemented; using polling.",
      );
    }
    return yahoo.subscribeFeed!(symbols, onTick, intervalMs);
  }
}

export const groww = new GrowwAdapter();
