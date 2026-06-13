"use client";

import { create } from "zustand";

import type { ConnectionStatus } from "@/services/brokers/types";

const MAX_EVENTS = 80;

/**
 * Broker-agnostic liquidation event shape. Field names preserved from the
 * legacy Binance import (`symbol`) so existing UI selectors keep working
 * after the broker adapter rollout. New broker adapters normalize their
 * native payloads into this shape before pushing.
 */
export interface LiquidationEvent {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  notionalUsd: number;
  ts: number;
}

/** Re-export the connection-status alphabet for backwards compatibility. */
export type LiquidationConnectionStatus = ConnectionStatus;

interface LiquidationSlice {
  events: LiquidationEvent[];
  status: ConnectionStatus;
  totalNotional5m: number;
  buyNotional5m: number;
  sellNotional5m: number;
  push: (event: LiquidationEvent) => void;
  setStatus: (status: ConnectionStatus) => void;
  reset: () => void;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function recalcWindow(events: LiquidationEvent[]) {
  const cutoff = Date.now() - FIVE_MINUTES_MS;
  let buy = 0;
  let sell = 0;
  for (const e of events) {
    if (e.ts < cutoff) continue;
    if (e.side === "BUY") buy += e.notionalUsd;
    else sell += e.notionalUsd;
  }
  return { buy, sell, total: buy + sell };
}

export const useLiquidationStore = create<LiquidationSlice>((set) => ({
  events: [],
  status: "idle",
  totalNotional5m: 0,
  buyNotional5m: 0,
  sellNotional5m: 0,
  push: (event) =>
    set((state) => {
      const events = [event, ...state.events].slice(0, MAX_EVENTS);
      const { buy, sell, total } = recalcWindow(events);
      return { events, buyNotional5m: buy, sellNotional5m: sell, totalNotional5m: total };
    }),
  setStatus: (status) => set({ status }),
  reset: () =>
    set({
      events: [],
      status: "idle",
      totalNotional5m: 0,
      buyNotional5m: 0,
      sellNotional5m: 0,
    }),
}));
