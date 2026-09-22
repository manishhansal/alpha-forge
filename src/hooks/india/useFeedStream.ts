"use client";

import { useEffect, useMemo, useRef } from "react";
import { useIndiaMarketStore } from "@/store/india/marketStore";
import type { FeedDiff } from "@/types/india";

// Back-off parameters for SSE reconnection after errors.
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MULTIPLIER = 2;

/**
 * Subscribes to /api/in/feed/stream (SSE) for the given symbols and pipes
 * incoming diffs into the Indian market store.
 *
 * Improvements over the original:
 *  - Handles `{type:"error"}` SSE frames from the gateway and triggers
 *    exponential back-off reconnection instead of freezing.
 *  - Reconnects automatically on EventSource `onerror` (network drop,
 *    server restart) using an exponential back-off schedule.
 *  - Resets back-off on a successful message so a healthy stream always
 *    reconnects quickly after a transient hiccup.
 *  - Also handles both `ticks` (FeedDiff diff format) and snapshot frames
 *    so the store is seeded on first connect without waiting for the first diff.
 *
 * Pass an empty array (or undefined) to disable.
 */
export function useFeedStream(symbols: string[] | undefined, intervalMs = 5000) {
  const applyTicks = useIndiaMarketStore((s) => s.applyTicks);

  const subKey = useMemo(() => {
    const list = Array.from(new Set((symbols ?? []).filter(Boolean))).sort();
    return list.length === 0 ? "" : list.join(",");
  }, [symbols]);

  // Keep a stable ref to applyTicks so the effect closure never goes stale.
  const applyTicksRef = useRef(applyTicks);
  useEffect(() => { applyTicksRef.current = applyTicks; }, [applyTicks]);

  useEffect(() => {
    if (!subKey) return;

    const url = `/api/in/feed/stream?symbols=${encodeURIComponent(subKey)}&interval=${intervalMs}`;

    let es: EventSource | null = null;
    let retryDelay = RECONNECT_BASE_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    function connect() {
      if (destroyed) return;

      try {
        es = new EventSource(url);
      } catch {
        // EventSource construction failed (e.g. invalid URL) — don't retry.
        return;
      }

      es.onmessage = (ev) => {
        if (destroyed) return;
        try {
          const data = JSON.parse(ev.data as string) as
            | FeedDiff
            | { type: "snapshot"; ticks: Record<string, { ltp: number; changePct: number | null; ts: number }> }
            | { type: "error"; error: string }
            | { type: "heartbeat" };

          if ("type" in data) {
            if (data.type === "snapshot" && data.ticks) {
              // Seed the store from the initial snapshot so prices appear
              // immediately on first connect, before the first diff arrives.
              const tickArr = Object.values(data.ticks).map((t) => ({
                symbol: Object.keys(data.ticks)[Object.values(data.ticks).indexOf(t)] ?? "",
                ...t,
              }));
              // Build proper array from the ticks record
              const entries = Object.entries(data.ticks).map(([sym, t]) => ({
                symbol: sym,
                ltp: t.ltp,
                changePct: t.changePct,
                ts: t.ts,
              }));
              if (entries.length > 0) applyTicksRef.current(entries);
              // Reset back-off on successful data
              retryDelay = RECONNECT_BASE_MS;
              void tickArr; // suppress unused warning
            } else if (data.type === "error") {
              // Gateway signals data-service unavailability — reconnect after back-off.
              scheduleReconnect();
            }
            // heartbeat: no action needed
          } else if ("ticks" in data && Array.isArray(data.ticks)) {
            // FeedDiff diff frame
            applyTicksRef.current(data.ticks);
            // Reset back-off on successful data
            retryDelay = RECONNECT_BASE_MS;
          }
        } catch {
          // Malformed frame — ignore, keep connection open.
        }
      };

      es.onerror = () => {
        if (destroyed) return;
        // Close the broken connection and reconnect with back-off.
        try { es?.close(); } catch { /* ignore */ }
        es = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (destroyed) return;
      if (retryTimer !== null) return; // already scheduled

      retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = Math.min(retryDelay * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
        connect();
      }, retryDelay);
    }

    connect();

    return () => {
      destroyed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try { es?.close(); } catch { /* ignore */ }
      es = null;
    };
  }, [subKey, intervalMs]);
}
