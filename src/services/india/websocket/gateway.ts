/**
 * Server-side feed gateway.
 *
 * After the data-service2.0 centralization, live market data is served
 * exclusively by data-service2.0. This gateway provides a ReadableStream
 * of FeedDiff JSON-lines, polling data-service2.0 via the canonical client.
 *
 * Symbol translation: the browser and store key on Yahoo-style symbols
 * (^NSEI, ^NSEBANK) while data-service2.0 expects NSE underlying symbols
 * (NIFTY, BANKNIFTY). Translation is applied transparently here.
 */
import type { FeedTick, Quote } from "@/types/india";
import { getQuotes } from "@/lib/data-service/client";

// ---------------------------------------------------------------------------
// Yahoo → NSE symbol translation table
// ---------------------------------------------------------------------------
// Keys:   Yahoo Finance / UI symbols (used by the browser and Zustand store)
// Values: NSE trading symbols accepted by data-service2.0
// ---------------------------------------------------------------------------

const YAHOO_TO_NSE: Record<string, string> = {
  "^NSEI":      "NIFTY",
  "^NSEBANK":   "BANKNIFTY",
  "^CNXFIN":    "FINNIFTY",
  "^NSEMDCP50": "MIDCPNIFTY",
  "^BSESN":     "SENSEX",
  "^INDIAVIX":  "INDIAVIX",
};

/** Translate a symbol to the form data-service2.0 understands. */
function toNseSym(symbol: string): string {
  return YAHOO_TO_NSE[symbol] ?? symbol;
}

/** Reverse lookup: NSE symbol → Yahoo symbol (for re-keying responses). */
const NSE_TO_YAHOO: Record<string, string> = Object.fromEntries(
  Object.entries(YAHOO_TO_NSE).map(([y, n]) => [n, y]),
);

function toYahooSym(nseSym: string): string {
  return NSE_TO_YAHOO[nseSym] ?? nseSym;
}

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
 *
 * Input `symbols` may be Yahoo-style (^NSEI) or NSE-style (NIFTY).
 * Outbound FeedTick.symbol always uses the original input symbol so the
 * browser store keying is consistent.
 */
export function buildFeedStream(opts: GatewayOptions): ReadableStream {
  const { symbols, intervalMs = 5000 } = opts;

  // Translate input symbols → NSE symbols for data-service2.0, keeping
  // the original symbol as the key so the browser store stays consistent.
  const nseSymbols = symbols.map(toNseSym);

  const fetchQuotes = opts.fetchQuotes ?? ((syms: string[]) =>
    getQuotes(syms, "NSE").then((qs) =>
      qs.map((q, i): Quote => ({
        // Re-key with the ORIGINAL (Yahoo-style) symbol so the store
        // entries are keyed consistently with the snapshot.
        symbol:    toYahooSym(syms[i] ?? ""),
        price:     q?.ltp ?? 0,
        change:    q?.change ?? null,
        changePct: q?.changePct ?? null,
        prevClose: q?.prevClose ?? null,
        open:      q?.open ?? null,
        high:      q?.high ?? null,
        low:       q?.low ?? null,
        volume:    q?.volume ?? null,
        oi:        q?.oi ?? null,
        // Always use the current server time when the upstream omits dataAsOf.
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
        const quotes = await fetchQuotes(nseSymbols);
        const ticks: Record<string, FeedTick> = {};
        quotes.forEach((q, i) => {
          const sym = q?.symbol ?? symbols[i];  // use re-keyed Yahoo symbol
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
          const quotes = await fetchQuotes(nseSymbols);
          const diffTicks: FeedTick[] = [];

          quotes.forEach((q, i) => {
            const sym = q?.symbol ?? symbols[i];
            if (!sym || !q) return;

            const tick = toTick(q, sym);

            // Only emit when price or changePct actually changed.
            if (!dedup.isDuplicate(sym, tick.ltp, tick.changePct)) {
              diffTicks.push(tick);
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
