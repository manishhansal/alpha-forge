"use client";

import { useEffect, useMemo } from "react";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import type { FeedDiff } from "@/types/india";

/**
 * Subscribes to /api/in/feed/stream (SSE) for the given symbols and pipes
 * incoming diffs into the Indian market store. The contract is identical to a
 * real broker WebSocket — when Groww credentials are wired, swap the
 * underlying transport in services/india/websocket and this hook stays the same.
 *
 * Pass an empty array (or undefined) to disable.
 */
export function useFeedStream(symbols: string[] | undefined, intervalMs = 5000) {
  const applyTicks = useIndiaMarketStore((s) => s.applyTicks);

  const subKey = useMemo(() => {
    const list = Array.from(new Set((symbols ?? []).filter(Boolean))).sort();
    return list.length === 0 ? "" : list.join(",");
  }, [symbols]);

  useEffect(() => {
    if (!subKey) return;

    const url = `/api/in/feed/stream?symbols=${encodeURIComponent(subKey)}&interval=${intervalMs}`;

    let es: EventSource | null = null;
    let closed = false;

    try {
      es = new EventSource(url);
    } catch {
      return;
    }

    es.onmessage = (ev) => {
      if (closed) return;
      try {
        const data = JSON.parse(ev.data) as FeedDiff | { error: string };
        if ("ticks" in data && Array.isArray(data.ticks)) {
          applyTicks(data.ticks);
        }
      } catch {
        // ignore malformed payloads
      }
    };

    es.onerror = () => {
      if (closed && es) {
        try {
          es.close();
        } catch {}
      }
    };

    return () => {
      closed = true;
      try {
        es?.close();
      } catch {}
      es = null;
    };
  }, [subKey, intervalMs, applyTicks]);
}
