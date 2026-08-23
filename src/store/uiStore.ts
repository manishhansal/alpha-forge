"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type MarketRegime = "BULL" | "BEAR" | "SIDEWAYS" | "HIGH_VOL" | "UNKNOWN";

interface UIState {
  // Persisted slices
  sidebarCollapsed: boolean;
  tableDensity: "compact" | "default" | "comfortable";

  // Session-only slices
  commandPaletteOpen: boolean;
  activeRegime: MarketRegime;
  chartFullscreen: boolean;
  radarVisible: boolean;

  // Actions
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  setRegime: (regime: MarketRegime) => void;
  setDensity: (density: "compact" | "default" | "comfortable") => void;
  setChartFullscreen: (v: boolean) => void;
  toggleRadar: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // Persisted defaults
      sidebarCollapsed: false,
      tableDensity: "compact",

      // Session-only defaults
      commandPaletteOpen: false,
      activeRegime: "UNKNOWN",
      chartFullscreen: false,
      radarVisible: false,

      // Actions
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      openCommandPalette: () => set({ commandPaletteOpen: true }),
      closeCommandPalette: () => set({ commandPaletteOpen: false }),
      setRegime: (activeRegime) => set({ activeRegime }),
      setDensity: (tableDensity) => set({ tableDensity }),
      setChartFullscreen: (chartFullscreen) => set({ chartFullscreen }),
      toggleRadar: () => set((s) => ({ radarVisible: !s.radarVisible })),
    }),
    {
      name: "af-ui",
      // Only persist sidebar and density — regime/chart/radar/commandPalette are session state
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        tableDensity: s.tableDensity,
      }),
    },
  ),
);
