"use client";

import { useEffect, useRef } from "react";

import { TRACKED_SYMBOLS } from "@/lib/constants";
import { getClientBroker } from "@/services/brokers/client";
import type { BrokerStreamClient } from "@/services/brokers/types";
import { useMarketStore } from "@/store/marketStore";
import type { SymbolId } from "@/types/market";

/**
 * Subscribes to the active broker's public ticker stream and pumps updates
 * into the Zustand market store. The hook is still named `useBinanceTickers`
 * to avoid breaking call sites — it's broker-agnostic under the hood and
 * keeps the same contract (no args, fires on mount, disconnects on
 * unmount).
 */
export function useBinanceTickers(): void {
  const setTicker = useMarketStore((s) => s.setTicker);
  const setStatus = useMarketStore((s) => s.setStatus);
  const clientRef = useRef<BrokerStreamClient | null>(null);

  useEffect(() => {
    const broker = getClientBroker();
    const pairs = TRACKED_SYMBOLS.map((s) => broker.pairs.spot[s.id]);
    // Reverse map so we can dispatch each WS event back to the right SymbolId
    // without iterating TRACKED_SYMBOLS on every tick.
    const symbolByPair = new Map<string, SymbolId>();
    for (const s of TRACKED_SYMBOLS) symbolByPair.set(broker.pairs.spot[s.id], s.id);

    const client = broker.createTickerStream({
      pairs,
      onStatusChange: setStatus,
      onTicker: (t) => {
        const symbolId = symbolByPair.get(t.pair);
        if (!symbolId) return;
        const open = t.open || t.close;
        const change = t.close - open;
        const changePct = open > 0 ? (change / open) * 100 : 0;
        setTicker(symbolId, {
          symbol: symbolId,
          price: t.close,
          change24h: change,
          changePct24h: changePct,
          high24h: t.high,
          low24h: t.low,
          volume24h: t.volume,
          quoteVolume24h: t.quoteVolume,
          updatedAt: t.eventTime,
        });
      },
    });
    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [setStatus, setTicker]);
}
