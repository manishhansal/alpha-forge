"use client";

import { BinanceLiquidationWsClient } from "@/services/binance/liquidation-ws";
import { BinanceWsClient } from "@/services/binance/ws";

import type {
  BrokerStreamClient,
  LiquidationStreamOptions,
  TickerStreamOptions,
} from "../types";

/**
 * Browser-side ticker stream for Binance — thin adapter that re-shapes the
 * Binance miniTicker payload into the generic `BrokerMiniTicker` shape.
 */
export function createBinanceTickerStream(opts: TickerStreamOptions): BrokerStreamClient {
  const client = new BinanceWsClient({
    symbols: opts.pairs,
    onStatusChange: opts.onStatusChange,
    onTicker: (t) => {
      opts.onTicker({
        pair: t.symbol,
        close: t.close,
        open: t.open,
        high: t.high,
        low: t.low,
        volume: t.volume,
        quoteVolume: t.quoteVolume,
        eventTime: t.eventTime,
      });
    },
  });
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
  };
}

export function createBinanceLiquidationStream(
  opts: LiquidationStreamOptions,
): BrokerStreamClient {
  const client = new BinanceLiquidationWsClient({
    symbols: opts.pairs,
    onStatusChange: opts.onStatusChange,
    onLiquidation: (e) => {
      opts.onLiquidation({
        pair: e.symbol,
        side: e.side,
        qty: e.qty,
        price: e.price,
        notionalUsd: e.notionalUsd,
        ts: e.ts,
      });
    },
  });
  return {
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
  };
}
