"use client";

import { useEffect } from "react";

import { TRACKED_SYMBOLS } from "@/lib/constants";
import { getClientBroker } from "@/services/brokers/client";
import { useLiquidationStore } from "@/store/liquidationStore";

interface Options {
  /** If true, only show liquidations for the tracked BTC/ETH/SOL symbols. */
  filterToTracked?: boolean;
}

/**
 * Subscribes to the active broker's public liquidation stream. Brokers that
 * don't expose one (e.g. Delta Exchange India) report `"unavailable"` via
 * the status callback and never fire data, so the UI shows a "stream
 * offline" badge instead of stalling on a never-opening socket.
 */
export function useLiquidationStream({ filterToTracked = true }: Options = {}) {
  const push = useLiquidationStore((s) => s.push);
  const setStatus = useLiquidationStore((s) => s.setStatus);

  useEffect(() => {
    const broker = getClientBroker();
    const pairs = filterToTracked
      ? TRACKED_SYMBOLS.map((s) => broker.pairs.futures[s.id])
      : undefined;
    const client = broker.createLiquidationStream({
      pairs,
      onLiquidation: (e) => {
        // Replay legacy field name (`symbol`) so the store doesn't need to
        // change shape — the store still expects the Binance event spelling.
        push({
          symbol: e.pair,
          side: e.side,
          qty: e.qty,
          price: e.price,
          notionalUsd: e.notionalUsd,
          ts: e.ts,
        });
      },
      onStatusChange: setStatus,
    });
    client.connect();
    return () => client.disconnect();
  }, [filterToTracked, push, setStatus]);
}
