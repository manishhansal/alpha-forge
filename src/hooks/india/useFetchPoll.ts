// Polling primitive used by every "live" view in the Indian-market surface.
//
// Solves three concrete problems we were hitting in the browser:
//
//   1. ERR_INSUFFICIENT_RESOURCES — HTTP/1.1 caps each origin at ~6 sockets.
//      The skip-if-in-flight guard prevents request pile-up.
//   2. Stale-render races — per-tick AbortController + cancelled flag.
//   3. Drift / thundering herd — tiny random jitter on the interval.

"use client";

import * as React from "react";

export type PollOptions = {
  /** Ms between successful polls (a small jitter is added). */
  intervalMs: number;
  /** Skip the next tick while a previous one is still in flight. Default: true. */
  skipIfInFlight?: boolean;
  /** Called on every error. Defaults to a console.warn. */
  onError?: (e: unknown) => void;
};

export type PollLoader<T> = (signal: AbortSignal) => Promise<T>;
export type PollHandler<T> = (data: T) => void;

export function useFetchPoll<T>(
  loader: PollLoader<T>,
  onData: PollHandler<T>,
  opts: PollOptions,
  deps: React.DependencyList,
): void {
  const { intervalMs, skipIfInFlight = true, onError } = opts;

  const loaderRef = React.useRef(loader);
  const onDataRef = React.useRef(onData);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    loaderRef.current = loader;
    onDataRef.current = onData;
    onErrorRef.current = onError;
  });

  React.useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (skipIfInFlight && inFlight) return;
      inFlight = true;
      controller = new AbortController();
      try {
        const data = await loaderRef.current(controller.signal);
        if (!cancelled) onDataRef.current(data);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        if (!cancelled) {
          if (onErrorRef.current) onErrorRef.current(e);
          else
            console.warn(
              "[india-poll] error:",
              (e as Error)?.message ?? String(e),
            );
        }
      } finally {
        inFlight = false;
      }
    };

    void tick();

    const jitter = Math.floor(Math.random() * intervalMs * 0.15);
    const id = setInterval(tick, intervalMs + jitter);

    return () => {
      cancelled = true;
      clearInterval(id);
      controller?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, skipIfInFlight, ...deps]);
}

export async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { cache: "no-store", signal });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(
      `HTTP ${r.status} ${url}${txt ? `: ${txt.slice(0, 120)}` : ""}`,
    );
  }
  return (await r.json()) as T;
}
