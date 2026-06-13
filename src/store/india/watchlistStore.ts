import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WatchlistItem } from "@/types/india";

type WatchlistState = {
  items: WatchlistItem[];
  add: (symbol: string, display?: string) => void;
  remove: (symbol: string) => void;
  toggle: (symbol: string, display?: string) => void;
  clear: () => void;
  has: (symbol: string) => boolean;
};

const DEFAULT_ITEMS: WatchlistItem[] = [
  { symbol: "RELIANCE", addedAt: 0 },
  { symbol: "HDFCBANK", addedAt: 0 },
  { symbol: "ICICIBANK", addedAt: 0 },
  { symbol: "TCS", addedAt: 0 },
  { symbol: "INFY", addedAt: 0 },
  { symbol: "SBIN", addedAt: 0 },
];

export const useIndiaWatchlistStore = create<WatchlistState>()(
  persist(
    (set, get) => ({
      items: DEFAULT_ITEMS,

      add: (symbol, display) =>
        set((s) =>
          s.items.some((i) => i.symbol === symbol)
            ? s
            : {
                items: [
                  ...s.items,
                  { symbol, display, addedAt: Date.now() },
                ],
              },
        ),

      remove: (symbol) =>
        set((s) => ({ items: s.items.filter((i) => i.symbol !== symbol) })),

      toggle: (symbol, display) => {
        const exists = get().items.some((i) => i.symbol === symbol);
        if (exists) get().remove(symbol);
        else get().add(symbol, display);
      },

      clear: () => set({ items: [] }),

      has: (symbol) => get().items.some((i) => i.symbol === symbol),
    }),
    {
      name: "india-fno-watchlist",
      version: 1,
    },
  ),
);
