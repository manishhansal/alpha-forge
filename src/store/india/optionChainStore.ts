import { create } from "zustand";
import type { OptionChain } from "@/types/india";

type State = {
  symbol: string;
  expiry: string | null;
  data: OptionChain | null;
  loading: boolean;
  error: string | null;
  /** Bumped by `refresh()` to force the poll hook to re-tick immediately
   *  (used by the "Retry" button when the upstream source rate-limits). */
  refreshTick: number;

  setSymbol: (symbol: string) => void;
  setExpiry: (expiry: string | null) => void;
  setData: (data: OptionChain) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  refresh: () => void;
};

export const useIndiaOptionChainStore = create<State>((set) => ({
  symbol: "NIFTY",
  expiry: null,
  data: null,
  loading: false,
  error: null,
  refreshTick: 0,

  setSymbol: (symbol) => set({ symbol, expiry: null, data: null }),
  setExpiry: (expiry) => set({ expiry }),
  setData: (data) => set({ data, expiry: data.expiry }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  refresh: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
}));
