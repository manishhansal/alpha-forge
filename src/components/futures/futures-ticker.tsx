"use client";

import { useEffect, useRef, useState } from "react";

import { TRACKED_SYMBOLS } from "@/lib/constants";
import { cn, formatCompact, formatPercent, formatPrice } from "@/lib/utils";
import { useMarketStore } from "@/store/marketStore";
import type { FuturesTickerSummary, SymbolId } from "@/types/market";

interface Props {
  initial: FuturesTickerSummary[];
  initialGeneratedAt?: number;
}

interface PollResponse {
  generatedAt: number;
  tickers: FuturesTickerSummary[];
}

/* ──────────────────── live data hook ──────────────────── */

/**
 * Poll `/api/futures/tickers` at 1 Hz from the browser. We deliberately use a
 * raw `setInterval` + `fetch` instead of React Query here because:
 *   - the user wants per-second updates and RQ's `refetchInterval` was
 *     visibly underperforming in our setup (auth-proxy overhead, dedupe
 *     windows, focus-tracking) → simpler primitive = more predictable.
 *   - the payload is tiny (~1 KB) so there's no benefit to RQ's cache.
 *   - we don't need retry / mutation / cache invalidation semantics.
 *
 * Also subscribes to the in-memory `marketStore` (WS pipeline) so when a
 * trade prints between polls the price flashes immediately without waiting
 * for the next tick.
 */
function usePollingTickers(
  initial: FuturesTickerSummary[],
  initialGeneratedAt: number | undefined,
): { tickers: FuturesTickerSummary[]; generatedAt: number; isLive: boolean } {
  const [state, setState] = useState<PollResponse>(() => ({
    generatedAt: initialGeneratedAt ?? Date.now(),
    tickers: initial,
  }));
  const [isLive, setIsLive] = useState(false);
  // Track in-flight aborts so a stalled request can't clobber a fresh one.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch("/api/futures/tickers", {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PollResponse;
        if (cancelled) return;
        setState(data);
        setIsLive(true);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        if (!cancelled) setIsLive(false);
      }
    };

    // Fire immediately so the UI starts ticking before the first interval
    // tick — otherwise users see a 1 s "frozen" period on every mount.
    void tick();
    const id = setInterval(tick, 1_000);

    return () => {
      cancelled = true;
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, []);

  return { tickers: state.tickers, generatedAt: state.generatedAt, isLive };
}

/* ──────────────────── tile ──────────────────── */

interface TileViewModel {
  pair: string;
  price: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  quoteVolume24h: number;
}

/**
 * Merge poll + WS into a single view model. The poll fires every 1s and is
 * the authoritative source for 24h derivatives (high / low / change %)
 * because Delta's WS only re-emits `ohlc` on actual trades. WS price is
 * only used as a fallback when poll didn't return a price yet (cold start
 * with broker REST failing, etc.).
 */
function buildVM(
  poll: FuturesTickerSummary,
  live: ReturnType<typeof useMarketStore.getState>["tickers"][SymbolId],
): TileViewModel {
  const price = poll.price > 0 ? poll.price : live?.price ?? 0;
  return {
    pair: poll.pair,
    price,
    changePct24h: poll.changePct24h,
    high24h: poll.high24h,
    low24h: poll.low24h,
    quoteVolume24h: poll.quoteVolume24h,
  };
}

function FuturesTickerTile({
  symbol,
  poll,
}: {
  symbol: SymbolId;
  poll: FuturesTickerSummary;
}) {
  const live = useMarketStore((s) => s.tickers[symbol]);
  const meta = TRACKED_SYMBOLS.find((m) => m.id === symbol)!;
  const vm = buildVM(poll, live);
  const positive = vm.changePct24h >= 0;

  // Flash on price change. Using a ref means the timeout closure always
  // sees the latest "last price" without retriggering the effect.
  const lastPriceRef = useRef(vm.price);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (lastPriceRef.current === vm.price || vm.price <= 0) return;
    const direction = vm.price > lastPriceRef.current ? "up" : "down";
    lastPriceRef.current = vm.price;
    setFlash(direction);
    const id = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(id);
  }, [vm.price]);

  return (
    <div
      className={cn(
        "relative flex min-w-[220px] flex-1 flex-col gap-1.5 px-5 py-4 transition-colors duration-500",
        flash === "up" && "bg-[color-mix(in_oklch,var(--color-bull)_8%,transparent)]",
        flash === "down" && "bg-[color-mix(in_oklch,var(--color-bear)_8%,transparent)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="grid h-7 w-7 place-items-center rounded-md text-[10px] font-semibold"
            style={{
              background: `color-mix(in oklch, ${meta.color} 18%, transparent)`,
              color: meta.color,
            }}
          >
            {symbol}
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">
              {meta.name}
            </span>
            <span className="text-[9px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
              {vm.pair} · Perp
            </span>
          </div>
        </div>
        <span
          className={cn(
            "num rounded-md px-1.5 py-0.5 text-[11px] font-medium",
            positive
              ? "bg-[color-mix(in_oklch,var(--color-bull)_14%,transparent)] text-bull"
              : "bg-[color-mix(in_oklch,var(--color-bear)_14%,transparent)] text-bear",
          )}
        >
          {formatPercent(vm.changePct24h)}
        </span>
      </div>

      <div className="num text-xl font-semibold tracking-tight text-[var(--color-fg)]">
        ${formatPrice(vm.price)}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
        <div className="flex flex-col gap-0.5">
          <dt>24h High</dt>
          <dd className="num text-[11px] font-medium normal-case tracking-normal text-[var(--color-fg-muted)]">
            ${formatPrice(vm.high24h)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt>24h Low</dt>
          <dd className="num text-[11px] font-medium normal-case tracking-normal text-[var(--color-fg-muted)]">
            ${formatPrice(vm.low24h)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt>24h Vol</dt>
          <dd className="num text-[11px] font-medium normal-case tracking-normal text-[var(--color-fg-muted)]">
            ${formatCompact(vm.quoteVolume24h)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* ──────────────────── header indicator ──────────────────── */

function LiveIndicator({
  generatedAt,
  isLive,
}: {
  generatedAt: number;
  isLive: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const ageSec = Math.max(0, Math.floor((now - generatedAt) / 1000));
  const fresh = isLive && ageSec < 3;
  return (
    <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
      <span
        className={cn(
          "inline-flex h-1.5 w-1.5 rounded-full transition-colors",
          fresh
            ? "bg-[var(--color-bull)] shadow-[0_0_8px_var(--color-bull)] animate-pulse"
            : "bg-[var(--color-fg-subtle)]",
        )}
      />
      {isLive ? `${ageSec}s ago` : "stalled"}
    </span>
  );
}

/* ──────────────────── public component ──────────────────── */

export function FuturesTickerBar({ initial, initialGeneratedAt }: Props) {
  const { tickers, generatedAt, isLive } = usePollingTickers(initial, initialGeneratedAt);
  const byId = new Map(tickers.map((t) => [t.symbol, t]));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
          Perpetuals · Live (1s)
        </span>
        <LiveIndicator generatedAt={generatedAt} isLive={isLive} />
      </div>
      <div className="flex flex-col divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] sm:flex-row sm:divide-x sm:divide-y-0">
        {TRACKED_SYMBOLS.map((meta) => {
          const poll = byId.get(meta.id) ?? {
            symbol: meta.id,
            pair: meta.brokers.delta.futures || meta.brokers.binance.futures,
            price: 0,
            changePct24h: 0,
            high24h: 0,
            low24h: 0,
            quoteVolume24h: 0,
          };
          return <FuturesTickerTile key={meta.id} symbol={meta.id} poll={poll} />;
        })}
      </div>
    </div>
  );
}
