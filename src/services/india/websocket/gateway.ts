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

export type GatewayOptions = {
  symbols: string[];
  intervalMs?: number;
  /** Optional override for quote fetching (e.g. in tests). Defaults to data-service2.0. */
  fetchQuotes?: (symbols: string[]) => Promise<Quote[]>;
};

/**
 * Deduplicates ticks by (symbol, ltp, changePct) — NOT by timestamp.
 *
 * Keying on timestamp caused two problems:
 *  1. Identical timestamps from slow providers suppressed real price changes.
 *  2. Simulated quotes (frozen dataAsOf) always looked duplicate.
 *
 * Now we track the last emitted (ltp, changePct) per symbol. A tick is only
 * a duplicate if the price AND change haven't moved since the last emission.
 */
class PriceDeduplicator {
  private readonly last = new Map<string, { ltp: number; changePct: number | null }>();

  isDuplicate(symbol: string, ltp: number, changePct: number | null): boolean {
    const prev = this.last.get(symbol);
    if (!prev) {
      this.last.set(symbol, { ltp, changePct });
      return false;
    }
    if (prev.ltp === ltp && prev.changePct === changePct) return true;
    this.last.set(symbol, { ltp, changePct });
    return false;
  }

  clear(): void {
    this.last.clear();
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
        // Always use the current server time when the upstream omits dataAsOf —
        // avoids the quote appearing stale purely due to a missing timestamp.
        fetchedAt: q?.dataAsOf ?? new Date().toISOString(),
      }))
    )
  );

  const encoder = new TextEncoder();
  const dedup = new PriceDeduplicator();
  let closed = false;

  function sse(payload: unknown): Uint8Array {
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  }

  /** Map a Quote from the fetch result to a FeedTick. */
  function toTick(q: Quote, sym: string): FeedTick {
    const price = (q as Quote & { ltp?: number }).ltp ?? q.price ?? 0;
    return {
      symbol: sym,
      ltp: price,
      changePct: q.changePct ?? null,
      // Always stamp ticks with the current server time so downstream
      // isTickStale checks (if any) never falsely discard fresh data.
      ts: Date.now(),
    };
  }

  return new ReadableStream({
    async start(controller) {
      // ── Initial snapshot ────────────────────────────────────────────────
      try {
        const quotes = await fetchQuotes(symbols);
        const ticks: Record<string, FeedTick> = {};
        quotes.forEach((q, i) => {
          const sym = symbols[i];
          if (!sym || !q) return;
          const tick = toTick(q, sym);
          ticks[sym] = tick;
          // Seed the deduplicator so the first poll only emits genuine changes.
          dedup.isDuplicate(sym, tick.ltp, tick.changePct);
        });
        controller.enqueue(sse({ type: "snapshot", ticks, ts: Date.now() }));
      } catch {
        controller.enqueue(sse({ type: "error", error: "DATA_SERVICE_UNAVAILABLE", ts: Date.now() }));
      }

      // ── Polling loop ────────────────────────────────────────────────────
      const poll = async () => {
        if (closed) return;
        try {
          const quotes = await fetchQuotes(symbols);
          const diffTicks: FeedTick[] = [];

          quotes.forEach((q, i) => {
            const sym = symbols[i];
            if (!sym || !q) return;

            const tick = toTick(q, sym);

            // Only emit when price or changePct actually changed — not when
            // the provider returned the same values again.
            if (!dedup.isDuplicate(sym, tick.ltp, tick.changePct)) {
              diffTicks.push(tick);
            }
          });

          if (diffTicks.length > 0) {
            controller.enqueue(sse({ type: "diff", ticks: diffTicks, ts: Date.now() }));
          } else {
            // No price change this cycle — send a heartbeat so the browser
            // EventSource doesn't time out.
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
