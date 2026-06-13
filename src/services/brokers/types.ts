import type { KlineInterval } from "@/services/binance/klines";
import type { KlineCandle, SymbolId } from "@/types/market";

/**
 * Identifier for the supported brokers. New brokers should add a string here
 * and an entry in the registry. Only public market-data brokers are listed;
 * account-side trading still lives behind the user's per-broker API keys.
 */
export type BrokerId = "binance" | "delta";

/**
 * Lookup tables exposed by every adapter so call sites can translate a
 * generic `SymbolId` ("BTC" / "ETH" / "SOL") into the broker's native pair
 * string (e.g. `BTCUSDT` on Binance, `BTCUSD` on Delta India).
 *
 * `spot` and `futures` are kept distinct because some brokers (notably
 * Binance) use the same string for both and others (Bybit, OKX) do not.
 */
export interface BrokerPairs {
  spot: Record<SymbolId, string>;
  futures: Record<SymbolId, string>;
}

/* ───────────────── REST shapes ───────────────── */

export interface NormalizedTicker {
  /** Broker-native pair string (e.g. `BTCUSDT`, `BTCUSD`). */
  pair: string;
  /** Last/close price in USD-quoted units. */
  price: number;
  /** Absolute 24h change in price. */
  change: number;
  /** 24h change in percent (`5.2` = +5.2%). */
  changePct: number;
  high: number;
  low: number;
  /** Base-asset 24h volume (BTC, ETH…). May be 0 if the broker only reports
   *  notional. */
  volume: number;
  /** Quote-asset (USD) 24h notional volume. Used for sort/filter. */
  quoteVolume: number;
  /** Event timestamp in ms. */
  ts: number;
}

export interface NormalizedFuturesTicker {
  /** Broker-native pair string (e.g. `BTCUSDT`, `BTCUSD`). */
  pair: string;
  price: number;
  changePct: number;
  quoteVolume: number;
  ts: number;
}

export interface NormalizedPremiumIndex {
  pair: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  fundingRateAnnualized: number;
  /** Unix ms of the next funding settlement; 0 if unknown. */
  nextFundingTime: number;
  ts: number;
}

export interface NormalizedOpenInterest {
  pair: string;
  /** OI in contracts (or base units depending on broker). */
  openInterest: number;
  ts: number;
}

export interface NormalizedOpenInterestPoint {
  ts: number;
  openInterest: number;
  notionalUsd: number;
}

export type OiPeriod = "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";

export interface NormalizedLongShortPoint {
  ts: number;
  longShortRatio: number;
  longAccount: number;
  shortAccount: number;
}

/* ───────────────── WS / streaming shapes ───────────────── */

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error" | "unavailable";

export interface BrokerMiniTicker {
  /** Broker-native pair (e.g. `BTCUSDT`, `BTCUSD`). */
  pair: string;
  close: number;
  open: number;
  high: number;
  low: number;
  /** Base-asset volume; may be 0 for brokers that only stream notional. */
  volume: number;
  /** Quote-asset (USD) notional; 0 if unknown. */
  quoteVolume: number;
  /** Event time in ms. */
  eventTime: number;
}

export interface BrokerLiquidationEvent {
  /** Broker-native pair. */
  pair: string;
  /** Side of the *order book* event (BUY = short being liquidated). */
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  notionalUsd: number;
  ts: number;
}

export interface TickerStreamOptions {
  pairs: string[];
  onTicker: (ticker: BrokerMiniTicker) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface LiquidationStreamOptions {
  /** If empty/undefined, the stream is firehose; adapters may downscope. */
  pairs?: string[];
  onLiquidation: (event: BrokerLiquidationEvent) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

export interface BrokerStreamClient {
  connect(): void;
  disconnect(): void;
}

/* ───────────────── Adapter interface ───────────────── */

/**
 * A broker adapter is the single seam between our feature code (which only
 * thinks in tracked SymbolIds + indicator math) and a specific exchange's
 * REST + WS surface. Concrete adapters live in `services/brokers/<id>/` and
 * implement the same contract so we can flip the active broker via env
 * without touching call sites.
 *
 * Capability flags surface what's actually available on the broker — Delta
 * India for example doesn't expose a public liquidation stream, so the
 * signal/heatmap pipelines short-circuit those features without crashing.
 */
export interface BrokerAdapter {
  /* identity */
  readonly id: BrokerId;
  readonly displayName: string;
  /** Marketing/home URL — only used for UI badges and error help text. */
  readonly homeUrl: string;
  /** Per-broker pair strings keyed by our generic `SymbolId`. */
  readonly pairs: BrokerPairs;
  /** What public market data this broker exposes. Callers should branch on
   *  these flags rather than special-casing broker IDs. */
  readonly capabilities: BrokerCapabilities;

  /* REST: spot market */
  fetch24hrTickers(pairs: string[]): Promise<NormalizedTicker[]>;
  fetchKlines(pair: string, interval: KlineInterval, limit?: number): Promise<KlineCandle[]>;
  fetchKlinesRange(
    pair: string,
    interval: KlineInterval,
    startTimeMs: number,
    endTimeMs: number,
  ): Promise<KlineCandle[]>;

  /* REST: futures */
  fetchPremiumIndex(pair: string): Promise<NormalizedPremiumIndex>;
  fetchOpenInterest(pair: string): Promise<NormalizedOpenInterest>;
  fetchOpenInterestHistory(
    pair: string,
    period?: OiPeriod,
    limit?: number,
  ): Promise<NormalizedOpenInterestPoint[]>;
  /** Some brokers (e.g. Delta India) don't publish a long/short ratio; in that
   *  case the adapter returns `[]` and feature code treats it as "missing". */
  fetchLongShortRatio(
    pair: string,
    period?: OiPeriod,
    limit?: number,
  ): Promise<NormalizedLongShortPoint[]>;
  /** Every perpetual on the broker, used for heatmap top-movers. */
  fetchAllFuturesTickers(): Promise<NormalizedFuturesTicker[]>;

  /* WS: streaming. Adapters that lack a given stream return a client whose
   *  `connect()` immediately reports "unavailable" status and never calls the
   *  data callback. This keeps caller logic uniform. */
  createTickerStream(opts: TickerStreamOptions): BrokerStreamClient;
  createLiquidationStream(opts: LiquidationStreamOptions): BrokerStreamClient;
}

export interface BrokerCapabilities {
  /** Whether `createLiquidationStream` is wired to a real upstream feed. */
  liquidations: boolean;
  /** Whether `fetchLongShortRatio` returns non-empty data. */
  longShortRatio: boolean;
  /** Whether `fetchOpenInterestHistory` returns historical points (not just
   *  the latest snapshot). */
  openInterestHistory: boolean;
}
