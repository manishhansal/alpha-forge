// Server-side feed gateway. Exposes a long-lived ReadableStream of
// FeedDiff JSON-lines, one per polling cycle. Only changed symbols are
// emitted (diff updates) — this is the same pattern a real broker WS would
// use, so client logic stays identical when we swap in Groww's binary feed.
//
// Chaos Engineering Hardening:
//   Scenario 4: isTickStale() filters quotes older than 30s before emission.
//   Scenario 5: TickDeduplicator drops ticks with the same (symbol, ts).
//   Scenario 6: TickSequenceBuffer reorders out-of-order ticks within a 2s
//               hold window before emitting to the client.
//   Scenario 12: The gateway tolerates rapid EventSource reconnects — the
//               `last` diff map is scoped to each stream instance so reconnects
//               receive a full snapshot rather than a stale diff slice.

import type { FeedDiff, FeedTick, Quote } from "@/types/india";
import { yahoo } from "@/services/india/yahoo";
import {
  isTickStale,
  TickDeduplicator,
  TickSequenceBuffer,
} from "@/lib/chaos/market-data-resilience";

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

  // ── Chaos Scenarios 5 & 6: Per-stream dedup + reorder ───────────────────
  // Each stream instance gets its own deduplicator and reorder buffer so
  // state does not leak across SSE reconnects (Scenario 12).
  const deduplicator = new TickDeduplicator(10_000);
  const sequenceBuffer = new TickSequenceBuffer({ flushDelayMs: 2_000, maxGapMs: 10_000 });

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

      // ── Chaos Scenario 12: Full snapshot on every (re)connect ──────────
      // The `last` map is cleared on each new stream instance (it's scoped to
      // this closure), so reconnecting clients always receive a fresh full
      // snapshot rather than an incremental diff from a previous connection.
      try {
        const quotes = await fetchQuotes(symbols);
        if (closed) return;
        const ticks = quotes
          .map(tickerToFeed)
          .filter((t) => {
            // ── Chaos Scenario 4: Drop stale initial snapshot ticks ──────
            if (isTickStale(t, { maxAgeMs: 60_000, label: "snapshot" })) return false;
            return true;
          });
        for (const t of ticks) last.set(t.symbol, t);
        send({ ticks, ts: Date.now() } satisfies FeedDiff);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "snapshot failed";
        send({ error: msg });
      }

      /** Process a single quote through dedup + reorder + stale filters,
       *  then emit any ticks that are ready to go. */
      const processQuote = (q: Quote) => {
        if (closed) return;
        const next = tickerToFeed(q);

        // ── Chaos Scenario 4: Stale tick filter ──────────────────────────
        if (isTickStale(next, { maxAgeMs: 30_000, label: "push" })) return;

        // ── Chaos Scenario 5: Duplicate tick filter ───────────────────────
        if (deduplicator.isDuplicate({ symbol: next.symbol, ts: next.ts })) return;

        // ── Chaos Scenario 6: Out-of-order reorder buffer ────────────────
        const toEmit = sequenceBuffer.push({
          symbol: next.symbol,
          ts: next.ts,
          price: next.ltp,
          volume: next.volume,
        });

        for (const tick of toEmit) {
          // Rebuild FeedTick from buffer output (price already ordered)
          const feedTick: FeedTick = {
            symbol: tick.symbol,
            ltp: tick.price,
            changePct: next.changePct, // preserve original diff
            volume: tick.volume ?? null,
            ts: tick.ts,
          };
          const prev = last.get(feedTick.symbol);
          if (!prev || prev.ltp !== feedTick.ltp || prev.changePct !== feedTick.changePct) {
            last.set(feedTick.symbol, feedTick);
            send({ ticks: [feedTick], ts: Date.now() } satisfies FeedDiff);
          }
        }
      };

      // Push path: a real-time subscription replaces the poll loop. The timer
      // becomes a keep-alive heartbeat so proxies don't drop an idle stream.
      if (opts.subscribe) {
        try {
          const handle = await opts.subscribe(processQuote);
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
          for (const q of quotes) {
            processQuote(q);
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
