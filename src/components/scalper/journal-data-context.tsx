"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  pairsToParam,
  useStrategyFilter,
} from "@/components/scalper/strategy-context";
import { JOURNAL_PAGE_SIZE } from "@/features/scalping/journal-constants";
import {
  parseTradeSource,
  type PaperTradeStatus,
  type ScalpStrategyId,
  type ScalpTimeframe,
} from "@/features/scalping/types";
import type { SymbolId } from "@/types/market";

/**
 * Single source of truth for the scalper journal + open positions data
 * the tabbed UI needs. Both the "Open positions" tab and the "Journal"
 * tab consume the same fetched payload from /api/scalper/journal —
 * routing it through one provider keeps the polling rate flat at one
 * request per `POLL_MS`, instead of N tabs × 1 request.
 *
 * Pagination is driven server-side: the provider sends `limit=PAGE_SIZE`
 * and `offset=(page-1)*PAGE_SIZE` to the journal endpoint, and the
 * frontend only ever renders the rows the server returned. The server
 * also returns `total` (the count of rows matching the current filter,
 * NOT just the current page), which drives the page-count calculation.
 *
 * Live mark prices for OPEN trades are fetched on a faster cadence
 * (`PRICE_POLL_MS`) so MTM P&L feels responsive without spamming the
 * journal endpoint.
 */

export interface ApiPaperTrade {
  id: string;
  symbol: SymbolId;
  direction: "LONG" | "SHORT";
  status: PaperTradeStatus;
  source: string;
  strategyId: ScalpStrategyId;
  strategyTimeframe: ScalpTimeframe;
  rationale: string[];
  notional: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  atr: number;
  exitPrice: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  note: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface JournalResponse {
  items: ApiPaperTrade[];
  open: ApiPaperTrade[];
  /** Total rows matching the filter (NOT just this page). */
  total: number;
  /** Page size echoed back by the server — confirms what we asked for. */
  limit: number;
  /** Row offset (0-indexed) of the first row in `items`. */
  offset: number;
}

interface MarketOverviewLite {
  entries: Array<{ symbol: SymbolId; price: number }>;
}

export type PriceMap = Partial<Record<SymbolId, number>>;

const POLL_MS = 15_000;
const PRICE_POLL_MS = 5_000;
/** Re-exported here so existing client consumers don't have to learn
 *  about the constants module. The source of truth is
 *  `journal-constants.ts` so server components can import it too. */
export { JOURNAL_PAGE_SIZE };

interface JournalDataContextValue {
  items: ApiPaperTrade[];
  open: ApiPaperTrade[];
  prices: PriceMap;
  loading: boolean;
  symbol: "ALL" | SymbolId;
  status: "ALL" | PaperTradeStatus;
  setSymbol: (s: "ALL" | SymbolId) => void;
  setStatus: (s: "ALL" | PaperTradeStatus) => void;
  /** Server-side pagination state for the `items` array. */
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  setPage: (p: number) => void;
  refresh: () => Promise<void>;
  cancelTrade: (id: string) => Promise<void>;
  saveNote: (id: string, note: string | null) => Promise<void>;
}

const JournalDataContext = createContext<JournalDataContextValue | null>(null);

export function useJournalData(): JournalDataContextValue {
  const ctx = useContext(JournalDataContext);
  if (!ctx) {
    throw new Error("useJournalData must be used inside <JournalDataProvider>");
  }
  return ctx;
}

export function JournalDataProvider({
  initial,
  children,
}: {
  initial?: JournalResponse;
  children: ReactNode;
}) {
  const { pairs } = useStrategyFilter();
  const [items, setItems] = useState<ApiPaperTrade[]>(() => normaliseList(initial?.items));
  const [open, setOpen] = useState<ApiPaperTrade[]>(() => normaliseList(initial?.open));
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbolState] = useState<"ALL" | SymbolId>("ALL");
  const [status, setStatusState] = useState<"ALL" | PaperTradeStatus>("ALL");
  const [prices, setPrices] = useState<PriceMap>({});
  const [page, setPageState] = useState<number>(() => {
    if (initial && initial.limit > 0) {
      return Math.floor(initial.offset / initial.limit) + 1;
    }
    return 1;
  });
  const [total, setTotal] = useState<number>(initial?.total ?? 0);
  const pageSize = JOURNAL_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Monotonic request id used to throw away stale responses when the
  // user rapidly changes pages or filters before earlier requests
  // resolve. Without this the table can briefly flash an older page.
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const url = new URL("/api/scalper/journal", window.location.origin);
      if (symbol !== "ALL") url.searchParams.set("symbol", symbol);
      if (status !== "ALL") url.searchParams.set("status", status);
      const sourcesParam = pairsToParam(pairs);
      if (sourcesParam) url.searchParams.set("sources", sourcesParam);
      url.searchParams.set("open", "1");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String((page - 1) * pageSize));
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as JournalResponse;
      // Drop the response if a newer request has already fired.
      if (requestId !== requestIdRef.current) return;
      setItems(normaliseList(json.items));
      setOpen(normaliseList(json.open));
      setTotal(typeof json.total === "number" ? json.total : 0);
    } catch {
      // best-effort; next poll will retry
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [symbol, status, pairs, page, pageSize]);

  useEffect(() => {
    const initialT = setTimeout(() => void fetchData(), 0);
    const id = setInterval(fetchData, POLL_MS);
    return () => {
      clearTimeout(initialT);
      clearInterval(id);
    };
  }, [fetchData]);

  // When filters change, the visible result set changes — snap back to
  // page 1 so the user always sees the freshest rows. Setters are
  // wrapped to enforce this invariant at the call site (rather than via
  // a separate useEffect that races with `fetchData`).
  const setSymbol = useCallback((s: "ALL" | SymbolId) => {
    setSymbolState(s);
    setPageState(1);
  }, []);
  const setStatus = useCallback((s: "ALL" | PaperTradeStatus) => {
    setStatusState(s);
    setPageState(1);
  }, []);

  // Strategy picker changes — also reset to page 1. The picker lives in
  // a different context, so we observe its key during render and snap
  // via React 19's "adjust state when a prop changes" pattern (an effect
  // here would race with `fetchData` and trigger a cascading render).
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const pairsKey = useMemo(
    () => pairs.map((p) => `${p.strategyId}:${p.timeframe}`).join(","),
    [pairs],
  );
  const [prevPairsKey, setPrevPairsKey] = useState(pairsKey);
  if (pairsKey !== prevPairsKey) {
    setPrevPairsKey(pairsKey);
    setPageState(1);
  }

  // Clamp the page when the row set shrinks under the current page
  // (e.g. trades resolve and the totals drop). We detect the shrink
  // during render so React batches the clamp into the same commit that
  // surfaces the new `totalPages`, instead of bouncing through an
  // effect (which the lint rule `react-hooks/set-state-in-effect` flags).
  // The `loading` guard preserves the previous behaviour of holding
  // position while a fetch is mid-flight.
  const [prevTotalPages, setPrevTotalPages] = useState(totalPages);
  if (totalPages !== prevTotalPages) {
    setPrevTotalPages(totalPages);
    if (!loading && page > totalPages) setPageState(totalPages);
  }

  const setPage = useCallback(
    (p: number) => {
      const clamped = Math.min(Math.max(1, Math.trunc(p)), Math.max(1, totalPages));
      setPageState(clamped);
    },
    [totalPages],
  );

  // Mark-to-market prices on a faster cadence so live P&L ticks while
  // OPEN positions are visible. Cancellation guard avoids a setState
  // after unmount when the request is in flight.
  useEffect(() => {
    let cancelled = false;
    const fetchPrices = async () => {
      try {
        const res = await fetch("/api/market/overview", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as MarketOverviewLite;
        if (cancelled || !json?.entries) return;
        const next: PriceMap = {};
        for (const e of json.entries) {
          if (typeof e.price === "number" && Number.isFinite(e.price)) next[e.symbol] = e.price;
        }
        setPrices(next);
      } catch {
        // best-effort — next tick will retry
      }
    };
    void fetchPrices();
    const id = setInterval(fetchPrices, PRICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const cancelTrade = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/scalper/journal/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cancel: true }),
        });
        await fetchData();
      } catch {
        // silently ignore — user can retry
      }
    },
    [fetchData],
  );

  const saveNote = useCallback(
    async (id: string, note: string | null) => {
      try {
        await fetch(`/api/scalper/journal/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }),
        });
        await fetchData();
      } catch {
        // silently ignore
      }
    },
    [fetchData],
  );

  const value = useMemo<JournalDataContextValue>(
    () => ({
      items,
      open,
      prices,
      loading,
      symbol,
      status,
      setSymbol,
      setStatus,
      page,
      pageSize,
      total,
      totalPages,
      setPage,
      refresh: fetchData,
      cancelTrade,
      saveNote,
    }),
    [
      items,
      open,
      prices,
      loading,
      symbol,
      status,
      setSymbol,
      setStatus,
      page,
      pageSize,
      total,
      totalPages,
      setPage,
      fetchData,
      cancelTrade,
      saveNote,
    ],
  );

  return <JournalDataContext.Provider value={value}>{children}</JournalDataContext.Provider>;
}

/**
 * Mark-to-market P&L for an open trade. Mirrors the formula the worker
 * uses (`pnlPercent`) so closed rows and live rows agree once the trade
 * resolves to an exit price.
 */
export function computeLivePnl(
  row: Pick<ApiPaperTrade, "direction" | "entry" | "notional">,
  mark: number | undefined,
): { pct: number; usd: number } | null {
  if (mark === undefined || !Number.isFinite(mark) || row.entry <= 0) return null;
  const isLong = row.direction === "LONG";
  const raw = (mark - row.entry) / row.entry;
  const pct = (isLong ? raw : -raw) * 100;
  const usd = (pct / 100) * row.notional;
  return { pct, usd };
}

/**
 * Backfill the parsed strategy fields for rows that arrived through a
 * legacy code path (where the API/server hadn't been redeployed yet).
 * The new server response always sets both fields directly.
 */
function normaliseList(items?: ApiPaperTrade[]): ApiPaperTrade[] {
  if (!items) return [];
  return items.map((t) => {
    if (t.strategyId && t.strategyTimeframe) return t;
    const parsed = parseTradeSource(t.source);
    return {
      ...t,
      strategyId: parsed?.strategyId ?? "UT_SMC",
      strategyTimeframe: parsed?.timeframe ?? "5m",
    };
  });
}
