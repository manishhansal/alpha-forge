import { create } from "zustand";
import type { FeedTick, IndexQuote, Quote, Snapshot } from "@/types/india";

type MarketState = {
  /** Last full snapshot from /api/in/market-snapshot */
  snapshot: Snapshot | null;
  /** Per-symbol live LTP map updated by SSE feed (broker-agnostic). */
  ticks: Record<string, FeedTick>;
  /** Per-symbol latest quote (rich object, used by watchlist etc.) */
  quotes: Record<string, Quote>;

  setSnapshot: (s: Snapshot) => void;
  setIndices: (idx: IndexQuote[]) => void;
  applyTicks: (ticks: FeedTick[]) => void;
  upsertQuotes: (q: Quote[]) => void;
};

export const useIndiaMarketStore = create<MarketState>((set) => ({
  snapshot: null,
  ticks: {},
  quotes: {},

  setSnapshot: (snapshot) => set({ snapshot }),

  setIndices: (indices) =>
    set((s) =>
      s.snapshot
        ? { snapshot: { ...s.snapshot, indices } }
        : {
            snapshot: {
              indices,
              sectors: [],
              fetchedAt: new Date().toISOString(),
            },
          },
    ),

  applyTicks: (ticks) =>
    set((s) => {
      const next = { ...s.ticks };
      for (const t of ticks) next[t.symbol] = t;
      return { ticks: next };
    }),

  upsertQuotes: (qs) =>
    set((s) => {
      const next = { ...s.quotes };
      for (const q of qs) next[q.symbol] = q;
      return { quotes: next };
    }),
}));
