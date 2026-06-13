import { create } from "zustand";
import type { ScannerResult, ScannerType } from "@/types/india/scanner";

type State = {
  active: ScannerType;
  results: Partial<Record<ScannerType, ScannerResult>>;
  loading: Partial<Record<ScannerType, boolean>>;
  errors: Partial<Record<ScannerType, string>>;

  setActive: (t: ScannerType) => void;
  setResult: (t: ScannerType, r: ScannerResult) => void;
  setLoading: (t: ScannerType, b: boolean) => void;
  setError: (t: ScannerType, e: string | null) => void;
};

export const useIndiaScannerStore = create<State>((set) => ({
  active: "momentum",
  results: {},
  loading: {},
  errors: {},

  setActive: (active) => set({ active }),

  setResult: (t, r) => set((s) => ({ results: { ...s.results, [t]: r } })),

  setLoading: (t, b) => set((s) => ({ loading: { ...s.loading, [t]: b } })),

  setError: (t, e) =>
    set((s) => {
      const next = { ...s.errors };
      if (e) next[t] = e;
      else delete next[t];
      return { errors: next };
    }),
}));
