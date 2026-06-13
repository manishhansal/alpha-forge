"use client";

import { TRACKED_SYMBOLS } from "@/lib/constants";
import { env } from "@/lib/env";
import type { SymbolId } from "@/types/market";

import {
  createBinanceLiquidationStream,
  createBinanceTickerStream,
} from "./binance/client";
import {
  createDeltaLiquidationStream,
  createDeltaTickerStream,
} from "./delta/ws";
import type {
  BrokerCapabilities,
  BrokerId,
  BrokerPairs,
  BrokerStreamClient,
  LiquidationStreamOptions,
  TickerStreamOptions,
} from "./types";

/**
 * Browser-side broker descriptor — narrower than `BrokerAdapter` because the
 * client only needs metadata + the WS factories. REST calls go through Next
 * route handlers, never directly from the browser.
 */
export interface ClientBroker {
  readonly id: BrokerId;
  readonly displayName: string;
  readonly pairs: BrokerPairs;
  readonly capabilities: BrokerCapabilities;
  createTickerStream(opts: TickerStreamOptions): BrokerStreamClient;
  createLiquidationStream(opts: LiquidationStreamOptions): BrokerStreamClient;
}

function buildPairs(brokerId: "binance" | "delta"): BrokerPairs {
  const spot: Record<SymbolId, string> = { BTC: "", ETH: "", SOL: "" };
  const futures: Record<SymbolId, string> = { BTC: "", ETH: "", SOL: "" };
  for (const s of TRACKED_SYMBOLS) {
    spot[s.id] = s.brokers[brokerId].spot;
    futures[s.id] = s.brokers[brokerId].futures;
  }
  return { spot, futures };
}

const binanceClient: ClientBroker = {
  id: "binance",
  displayName: "Binance",
  pairs: buildPairs("binance"),
  capabilities: { liquidations: true, longShortRatio: true, openInterestHistory: true },
  createTickerStream: createBinanceTickerStream,
  createLiquidationStream: createBinanceLiquidationStream,
};

const deltaClient: ClientBroker = {
  id: "delta",
  displayName: "Delta Exchange India",
  pairs: buildPairs("delta"),
  capabilities: { liquidations: false, longShortRatio: false, openInterestHistory: true },
  createTickerStream: createDeltaTickerStream,
  createLiquidationStream: createDeltaLiquidationStream,
};

const CLIENT_BROKERS: Record<BrokerId, ClientBroker> = {
  binance: binanceClient,
  delta: deltaClient,
};

/**
 * Resolve the active client broker. Reads `NEXT_PUBLIC_ACTIVE_BROKER`, which
 * is the public mirror of the server-side `ACTIVE_BROKER` value. Default:
 * delta.
 */
export function getActiveClientBrokerId(): BrokerId {
  return env.NEXT_PUBLIC_ACTIVE_BROKER;
}

export function getClientBroker(id?: BrokerId): ClientBroker {
  return CLIENT_BROKERS[id ?? getActiveClientBrokerId()];
}
