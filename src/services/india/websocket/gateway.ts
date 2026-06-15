// Server-side feed gateway. Exposes a long-lived ReadableStream of
// FeedDiff JSON-lines, one per polling cycle. Only changed symbols are
// emitted (diff updates) — this is the same pattern a real broker WS would
// use, so client logic stays identical when we swap in Groww's binary feed.

import type { FeedDiff, FeedTick, Quote } from "@/types/india";
import { yahoo } from "@/services/india/yahoo";

export type GatewayOptions = {
  symbols: string[];
  intervalMs?: number;
  /**
   * Quote fetcher backing the stream. Defaults to the Yahoo poller so the SSE
   * feed works with zero credentials, but the route injects the user's active
   * broker (e.g. Angel One SmartAPI) so the live feed reflects their choice.
   * Always used for the initial snapshot, and for the polling loop when no
   * push `subscribe` source is provided.
   */
  fetchQuotes?: (symbols: string[]) => Promise<Quote[]>;
  /**
   * Optional push tick source (e.g. Angel One SmartStream WebSocket 2.0). When
   * provided, the per-cycle poll is replaced by this real-time subscription —
   * `fetchQuotes` still serves the one-shot initial snapshot. Returns (or
   * resolves to) an unsubscribe handle invoked on stream cancel.
   */
  subscribe?: (
    onQuote: (q: Quote) => void,
  ) => (() => void) | Promise<() => void>;
};

/**
 * Build a ReadableStream emitting `data: {FeedDiff}\n\n` SSE events.
 * Closes when the consumer cancels OR when the underlying controller
 * becomes invalid (e.g. the client disconnected unexpectedly).
 */
export function buildFeedStream(opts: GatewayOptions): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const symbols = Array.from(new Set(opts.symbols)).slice(0, 100);
  const intervalMs = Math.max(1500, opts.intervalMs ?? 5000);
  const fetchQuotes = opts.fetchQuotes ?? ((s: string[]) => yahoo.getQuotes(s));
  const last = new Map<string, FeedTick>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
    }
  };

  const tickerToFeed = (q: Quote): FeedTick => ({
    symbol: q.symbol,
    ltp: q.price ?? 0,
    changePct: q.changePct,
    volume: q.volume ?? null,
    ts: Date.now(),
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          stop();
          return false;
        }
      };

      const send = (payload: unknown) =>
        safeEnqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));

      try {
        const quotes = await fetchQuotes(symbols);
        if (closed) return;
        const ticks = quotes.map(tickerToFeed);
        for (const t of ticks) last.set(t.symbol, t);
        send({ ticks, ts: Date.now() } satisfies FeedDiff);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "snapshot failed";
        send({ error: msg });
      }

      // Diff a single quote against the last sent tick; emit only on change.
      const pushQuote = (q: Quote) => {
        if (closed) return;
        const next = tickerToFeed(q);
        const prev = last.get(next.symbol);
        if (
          !prev ||
          prev.ltp !== next.ltp ||
          prev.changePct !== next.changePct
        ) {
          last.set(next.symbol, next);
          send({ ticks: [next], ts: Date.now() } satisfies FeedDiff);
        }
      };

      // Push path: a real-time subscription replaces the poll loop. The timer
      // becomes a keep-alive heartbeat so proxies don't drop an idle stream.
      if (opts.subscribe) {
        try {
          const handle = await opts.subscribe(pushQuote);
          if (closed) {
            try {
              handle();
            } catch {
              /* already closing */
            }
            return;
          }
          unsubscribe = handle;
          timer = setInterval(() => {
            safeEnqueue(enc.encode(`: ping\n\n`));
          }, 15_000);
          return;
        } catch (e: unknown) {
          // Subscription setup failed — fall through to polling so the feed
          // still flows.
          const msg = e instanceof Error ? e.message : "subscribe failed";
          send({ error: msg });
        }
      }

      const poll = async () => {
        if (closed) return;
        try {
          const quotes = await fetchQuotes(symbols);
          if (closed) return;
          const diffs: FeedTick[] = [];
          for (const q of quotes) {
            const next = tickerToFeed(q);
            const prev = last.get(next.symbol);
            if (
              !prev ||
              prev.ltp !== next.ltp ||
              prev.changePct !== next.changePct
            ) {
              diffs.push(next);
              last.set(next.symbol, next);
            }
          }
          if (diffs.length > 0) {
            send({ ticks: diffs, ts: Date.now() } satisfies FeedDiff);
          } else {
            safeEnqueue(enc.encode(`: ping\n\n`));
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "poll failed";
          send({ error: msg });
        }
      };

      timer = setInterval(poll, intervalMs);
    },
    cancel() {
      stop();
    },
  });
}
