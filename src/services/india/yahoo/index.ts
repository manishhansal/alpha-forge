import YahooFinance from "yahoo-finance2";
import type {
  Candle,
  HistoricalRequest,
  Interval,
  OptionChain,
  Quote,
} from "@/types/india";
import type { BrokerAdapter } from "../broker/types";
import { cache } from "../cache";

const yf = new YahooFinance();

const YF_INTERVAL: Record<
  Interval,
  "1m" | "5m" | "15m" | "30m" | "1h" | "1d" | "1wk"
> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "1d": "1d",
  "1w": "1wk",
};

function rangeToFrom(range: string): Date {
  const now = Date.now();
  const m = /^(\d+)(m|d|mo|y)$/.exec(range);
  if (!m) return new Date(now - 1000 * 60 * 60 * 24 * 30);
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
  return new Date(now - ms);
}

/** Map an "NSE-style" symbol (RELIANCE, ^NSEI) to a Yahoo ticker. */
export function toYahooSymbol(symbol: string): string {
  if (symbol.startsWith("^")) return symbol;
  if (symbol.includes(".")) return symbol;
  return `${symbol}.NS`;
}

interface YfRawQuote {
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
}

function quoteFromYf(input: string, q: YfRawQuote | undefined): Quote {
  return {
    symbol: input,
    name: q?.shortName ?? q?.longName ?? null,
    price: q?.regularMarketPrice ?? null,
    change: q?.regularMarketChange ?? null,
    changePct: q?.regularMarketChangePercent ?? null,
    prevClose: q?.regularMarketPreviousClose ?? null,
    open: q?.regularMarketOpen ?? null,
    high: q?.regularMarketDayHigh ?? null,
    low: q?.regularMarketDayLow ?? null,
    volume: q?.regularMarketVolume ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

const emptyQuote = (symbol: string): Quote => ({
  symbol,
  name: null,
  price: null,
  change: null,
  changePct: null,
  prevClose: null,
  fetchedAt: new Date().toISOString(),
});

interface YfRawCandle {
  date: string | Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume?: number | null;
}

export class YahooAdapter implements BrokerAdapter {
  readonly id = "yahoo" as const;

  async getQuote(symbol: string): Promise<Quote> {
    const yfSym = toYahooSymbol(symbol);
    return cache.memo(`yf:quote:${yfSym}`, 5_000, async () => {
      try {
        const q = (await yf.quote(yfSym)) as YfRawQuote;
        return quoteFromYf(symbol, q);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`yahoo.getQuote(${symbol}):`, msg);
        return emptyQuote(symbol);
      }
    });
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    const yfSyms = symbols.map(toYahooSymbol);
    return cache.memo(`yf:quotes:${yfSyms.join(",")}`, 5_000, async () => {
      try {
        const res = (await yf.quote(yfSyms)) as YfRawQuote | YfRawQuote[];
        const arr = Array.isArray(res) ? res : [res];
        const byYf = new Map<string, YfRawQuote>();
        for (const q of arr) if (q?.symbol) byYf.set(q.symbol, q);
        return symbols.map((s, i) => {
          const q = byYf.get(yfSyms[i]);
          return q ? quoteFromYf(s, q) : emptyQuote(s);
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`yahoo.getQuotes:`, msg);
        return symbols.map(emptyQuote);
      }
    });
  }

  async getHistorical(req: HistoricalRequest): Promise<Candle[]> {
    const yfSym = toYahooSymbol(req.symbol);
    const interval = YF_INTERVAL[req.interval];
    const period1 = rangeToFrom(req.range);
    const cacheKey = `yf:hist:${yfSym}:${interval}:${req.range}`;
    return cache.memo(cacheKey, 30_000, async () => {
      try {
        const res = await yf.chart(yfSym, { period1, interval });
        const quotes = (res?.quotes ?? []) as YfRawCandle[];
        return quotes
          .filter((c) => c.open != null && c.close != null)
          .map((c) => ({
            time: Math.floor(new Date(c.date).getTime() / 1000),
            open: c.open as number,
            high: c.high as number,
            low: c.low as number,
            close: c.close as number,
            volume: c.volume ?? undefined,
          })) as Candle[];
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`yahoo.getHistorical(${req.symbol}):`, msg);
        return [];
      }
    });
  }

  /**
   * Yahoo doesn't expose Indian option chains — adapters that delegate here
   * for option chains should fall back to the NSE adapter instead.
   */
  async getOptionChain(): Promise<OptionChain> {
    throw new Error("YahooAdapter does not support option chains; use NseAdapter.");
  }

  /** Polling-based "feed" for adapters that don't have a real WebSocket. */
  subscribeFeed(
    symbols: string[],
    onTick: (q: Quote) => void,
    intervalMs = 5000,
  ): () => void {
    if (symbols.length === 0) return () => {};
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const quotes = await this.getQuotes(symbols);
      if (cancelled) return;
      for (const q of quotes) onTick(q);
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }
}

export const yahoo = new YahooAdapter();
