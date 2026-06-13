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
  indiaPairsToParam,
  useIndiaStrategyFilter,
} from "@/components/india/strategies/strategy-context";
import { INDIA_JOURNAL_PAGE_SIZE } from "@/features/india/scalping/journal-constants";
import {
  isIndiaScalpStrategyId,
  type IndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import {
  parseIndiaTradeSource,
  type IndiaPaperTradeStatus,
  type IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

/**
 * Single source of truth for the India F&O paper-trading journal + open
 * positions data the page tabs need. Mirrors the crypto
 * `JournalDataProvider` 1:1 — server-paginated journal, fast-cadence
 * live mark prices for OPEN positions, picker-aware filtering.
 *
 * The mark-price fetch hits `/api/in/quote?symbols=…` (instead of the
 * crypto `/api/market/overview`) because India quotes are open-ended:
 * we only pay for the symbols currently OPEN in paper trades rather
 * than the full F&O universe.
 */

export interface ApiIndiaPaperTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  status: IndiaPaperTradeStatus;
  source: string;
  strategyId: IndiaScalpStrategyId;
  strategyTimeframe: IndiaScalpTimeframe;
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

export interface IndiaJournalResponse {
  items: ApiIndiaPaperTrade[];
  open: ApiIndiaPaperTrade[];
  total: number;
  limit: number;
  offset: number;
}

interface QuotesLite {
  quotes: Array<{ symbol: string; price: number | null }>;
}

export type IndiaPriceMap = Record<string, number>;

const POLL_MS = 15_000;
const PRICE_POLL_MS = 5_000;

export { INDIA_JOURNAL_PAGE_SIZE };

interface IndiaJournalDataContextValue {
  items: ApiIndiaPaperTrade[];
  open: ApiIndiaPaperTrade[];
  prices: IndiaPriceMap;
  loading: boolean;
  symbol: "ALL" | string;
  status: "ALL" | IndiaPaperTradeStatus;
  setSymbol: (s: "ALL" | string) => void;
  setStatus: (s: "ALL" | IndiaPaperTradeStatus) => void;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  setPage: (p: number) => void;
  refresh: () => Promise<void>;
  cancelTrade: (id: string) => Promise<void>;
  saveNote: (id: string, note: string | null) => Promise<void>;
}

const IndiaJournalDataContext =
  createContext<IndiaJournalDataContextValue | null>(null);

export function useIndiaJournalData(): IndiaJournalDataContextValue {
  const ctx = useContext(IndiaJournalDataContext);
  if (!ctx) {
    throw new Error(
      "useIndiaJournalData must be used inside <IndiaJournalDataProvider>",
    );
  }
  return ctx;
}

export function IndiaJournalDataProvider({
  initial,
  children,
}: {
  initial?: IndiaJournalResponse;
  children: ReactNode;
}) {
  const { pairs } = useIndiaStrategyFilter();
  const [items, setItems] = useState<ApiIndiaPaperTrade[]>(() =>
    normaliseList(initial?.items),
  );
  const [open, setOpen] = useState<ApiIndiaPaperTrade[]>(() =>
    normaliseList(initial?.open),
  );
  const [loading, setLoading] = useState(false);
  const [symbol, setSymbolState] = useState<"ALL" | string>("ALL");
  const [status, setStatusState] = useState<"ALL" | IndiaPaperTradeStatus>(
    "ALL",
  );
  const [prices, setPrices] = useState<IndiaPriceMap>({});
  const [page, setPageState] = useState<number>(() => {
    if (initial && initial.limit > 0) {
      return Math.floor(initial.offset / initial.limit) + 1;
    }
    return 1;
  });
  const [total, setTotal] = useState<number>(initial?.total ?? 0);
  const pageSize = INDIA_JOURNAL_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const url = new URL("/api/in/scalper/journal", window.location.origin);
      if (symbol !== "ALL") url.searchParams.set("symbol", symbol);
      if (status !== "ALL") url.searchParams.set("status", status);
      const sourcesParam = indiaPairsToParam(pairs);
      if (sourcesParam) url.searchParams.set("sources", sourcesParam);
      url.searchParams.set("open", "1");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String((page - 1) * pageSize));
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as IndiaJournalResponse;
      if (requestId !== requestIdRef.current) return;
      setItems(normaliseList(json.items));
      setOpen(normaliseList(json.open));
      setTotal(typeof json.total === "number" ? json.total : 0);
    } catch {
      // best-effort — next poll will retry
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

  const setSymbol = useCallback((s: "ALL" | string) => {
    setSymbolState(s);
    setPageState(1);
  }, []);
  const setStatus = useCallback((s: "ALL" | IndiaPaperTradeStatus) => {
    setStatusState(s);
    setPageState(1);
  }, []);

  const pairsKey = useMemo(
    () => pairs.map((p) => `${p.strategyId}:${p.timeframe}`).join(","),
    [pairs],
  );
  const [prevPairsKey, setPrevPairsKey] = useState(pairsKey);
  if (pairsKey !== prevPairsKey) {
    setPrevPairsKey(pairsKey);
    setPageState(1);
  }

  const [prevTotalPages, setPrevTotalPages] = useState(totalPages);
  if (totalPages !== prevTotalPages) {
    setPrevTotalPages(totalPages);
    if (!loading && page > totalPages) setPageState(totalPages);
  }

  const setPage = useCallback(
    (p: number) => {
      const clamped = Math.min(
        Math.max(1, Math.trunc(p)),
        Math.max(1, totalPages),
      );
      setPageState(clamped);
    },
    [totalPages],
  );

  // Mark-to-market prices on a faster cadence — only fetch the symbols
  // we actually have OPEN positions on so the network stays small.
  useEffect(() => {
    let cancelled = false;
    const fetchPrices = async () => {
      try {
        const symbols = Array.from(new Set(open.map((t) => t.symbol))).filter(
          Boolean,
        );
        if (symbols.length === 0) {
          setPrices({});
          return;
        }
        const url = new URL("/api/in/quote", window.location.origin);
        url.searchParams.set("symbols", symbols.join(","));
        const res = await fetch(url.toString(), { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as QuotesLite;
        if (cancelled || !json?.quotes) return;
        const next: IndiaPriceMap = {};
        for (const q of json.quotes) {
          if (
            typeof q.price === "number" &&
            Number.isFinite(q.price) &&
            q.price > 0
          ) {
            next[q.symbol] = q.price;
          }
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
  }, [open]);

  const cancelTrade = useCallback(
    async (id: string) => {
      try {
        await fetch(`/api/in/scalper/journal/${id}`, {
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
        await fetch(`/api/in/scalper/journal/${id}`, {
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

  const value = useMemo<IndiaJournalDataContextValue>(
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

  return (
    <IndiaJournalDataContext.Provider value={value}>
      {children}
    </IndiaJournalDataContext.Provider>
  );
}

/**
 * MTM P&L for an open India F&O trade. Same formula as the crypto
 * helper — the dollar/rupee label is purely a UI concern that the
 * journal card surfaces in ₹.
 */
export function computeIndiaLivePnl(
  row: Pick<ApiIndiaPaperTrade, "direction" | "entry" | "notional">,
  mark: number | undefined,
): { pct: number; usd: number } | null {
  if (mark === undefined || !Number.isFinite(mark) || row.entry <= 0) {
    return null;
  }
  const isLong = row.direction === "LONG";
  const raw = (mark - row.entry) / row.entry;
  const pct = (isLong ? raw : -raw) * 100;
  const usd = (pct / 100) * row.notional;
  return { pct, usd };
}

function normaliseList(items?: ApiIndiaPaperTrade[]): ApiIndiaPaperTrade[] {
  if (!items) return [];
  return items.map((t) => {
    if (t.strategyId && t.strategyTimeframe) return t;
    const parsed = parseIndiaTradeSource(t.source);
    return {
      ...t,
      strategyId:
        parsed && isIndiaScalpStrategyId(parsed.strategyId)
          ? parsed.strategyId
          : "MOMENTUM",
      strategyTimeframe: parsed?.timeframe ?? "5m",
    };
  });
}
