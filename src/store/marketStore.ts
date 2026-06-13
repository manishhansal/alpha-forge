"use client";

import { create } from "zustand";

import type { ConnectionStatus } from "@/services/brokers/types";
import type { SymbolId, Ticker } from "@/types/market";

// Re-export the connection-status alphabet so legacy import sites
// (`from "@/services/binance/ws"`) can be migrated incrementally.
export type { ConnectionStatus };

interface LiveTickerSlice {
  tickers: Partial<Record<SymbolId, Ticker>>;
  wsStatus: ConnectionStatus;
  lastUpdate: number | null;
  setTicker: (symbol: SymbolId, ticker: Ticker) => void;
  setStatus: (status: ConnectionStatus) => void;
  reset: () => void;
}

export const useMarketStore = create<LiveTickerSlice>((set) => ({
  tickers: {},
  wsStatus: "idle",
  lastUpdate: null,
  setTicker: (symbol, ticker) =>
    set((state) => ({
      tickers: { ...state.tickers, [symbol]: ticker },
      lastUpdate: ticker.updatedAt,
    })),
  setStatus: (wsStatus) => set({ wsStatus }),
  reset: () => set({ tickers: {}, wsStatus: "idle", lastUpdate: null }),
}));

export const selectTicker = (symbol: SymbolId) => (s: LiveTickerSlice) => s.tickers[symbol];
