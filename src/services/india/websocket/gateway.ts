/**
 * Server-side feed gateway.
 *
 * After the data-service2.0 centralization, live market data is served
 * exclusively by data-service2.0. This gateway provides a ReadableStream
 * of FeedDiff JSON-lines, polling data-service2.0 via the canonical client.
 *
 * Direct broker WebSocket connections (Angel One SmartStream, Upstox WS)
 * have been removed. data-service2.0 handles provider connections.
 */
import type { FeedTick, Quote } from "@/types/india";
import { getQuotes } from "@/lib/data-service/client";
import { isTickStale } from "@/lib/chaos/market-data-resilience";
import type { MarketTick } from "@/lib/chaos/market-data-resilience";

export type GatewayOptions = {
  symbols: string[];
  intervalMs?: number;
  /** Optional override for quote fetching (e.g. in tests). Defaults to data-service2.0. */
  fetchQuotes?: (symbols: string[]) => Promise<Quote[]>;
};

/** Deduplication map — track last seen timestamp per symbol */
class SimpleDeduplicator {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  constructor(windowMs = 5_000) { this.windowMs = windowMs; }
  isDuplicate(symbol: string, ts: number): boolean {
    this._evict();
    const key = `${symbol}:${ts}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, ts);
    return false;
  }
  private _evict(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, ts] of this.seen) { if (ts < cutoff) this.seen.delete(key); }
  }
}

/**
 * Build a Server-Sent Events ReadableStream of FeedDiff payloads.
 * All quotes come from data-service2.0.
 */
export function buildFeedStream(opts: GatewayOptions): ReadableStream {
  const { symbols, intervalMs = 5000 } = opts;
  const fetchQuotes = opts.fetchQuotes ?? ((syms: string[]) =>
    getQuotes(syms, "NSE").then((qs) =>
      qs.map((q, i): Quote => ({
        symbol: symbols[i] ?? "",
        price: q?.ltp ?? 0,
        change: q?.change ?? null,
        changePct: q?.changePct ?? null,
        prevClose: q?.prevClose ?? null,
        open: q?.open ?? null,
        high: q?.high ?? null,
        low: q?.low ?? null,
        volume: q?.volume ?? null,
        oi: q?.oi ?? null,
        fetchedAt: q?.dataAsOf ?? new Date().toISOString(),
      }))
    )
  );

  const encoder = new TextEncoder();
  const dedup = new SimpleDeduplicator();
  const lastBySymbol = new Map<string, FeedTick>();
  let closed = false;

  function sse(payload: unknown): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  return new ReadableStream({
    async start(controller) {
      // Initial snapshot
      try {
        const quotes = await fetchQuotes(symbols);
        const ticks: Record<string, FeedTick> = {};
        quotes.forEach((q, i) => {
          const sym = symbols[i];
          if (!sym || !q) return;
          const price = (q as Quote & { ltp?: number }).ltp ?? q.price ?? 0;
          const tick: FeedTick = {
            symbol: sym,
            ltp: price,
            changePct: q.changePct ?? null,
            ts: q.fetchedAt ? Date.parse(q.fetchedAt) : Date.now(),
          };
          ticks[sym] = tick;
          lastBySymbol.set(sym, tick);
        });
        controller.enqueue(sse({ type: "snapshot", ticks, ts: Date.now() }));
      } catch {
        controller.enqueue(sse({ type: "error", error: "DATA_SERVICE_UNAVAILABLE", ts: Date.now() }));
      }

      const poll = async () => {
        if (closed) return;
        try {
          const quotes = await fetchQuotes(symbols);
          const diffTicks: FeedTick[] = [];
          quotes.forEach((q, i) => {
            const sym = symbols[i];
            if (!sym || !q) return;
            const staleTick: MarketTick = { symbol: sym, ts: q.fetchedAt ? Date.parse(q.fetchedAt) : Date.now(), price: 0 };
            if (isTickStale(staleTick)) return;
            const ts = q.fetchedAt ? Date.parse(q.fetchedAt) : Date.now();
            if (dedup.isDuplicate(sym, ts)) return;
            const price = (q as Quote & { ltp?: number }).ltp ?? q.price ?? 0;
            const tick: FeedTick = { symbol: sym, ltp: price, changePct: q.changePct ?? null, ts };
            const last = lastBySymbol.get(sym);
            if (!last || last.ltp !== tick.ltp || last.changePct !== tick.changePct) {
              diffTicks.push(tick);
              lastBySymbol.set(sym, tick);
            }
          });
          if (diffTicks.length > 0) {
            controller.enqueue(sse({ type: "diff", ticks: diffTicks, ts: Date.now() }));
          } else {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        } catch {
          controller.enqueue(sse({ type: "error", error: "DATA_SERVICE_UNAVAILABLE", ts: Date.now() }));
        }
        if (!closed) setTimeout(poll, intervalMs);
      };

      setTimeout(poll, intervalMs);
    },
    cancel() {
      closed = true;
    },
  });
}
