export type SymbolId = "BTC" | "ETH" | "SOL";

/**
 * Per-broker pair identifiers for a tracked coin. Every supported broker has
 * one entry so the broker adapter can resolve the right native pair string.
 */
export interface BrokerPairConfig {
  spot: string;
  futures: string;
}

export interface TrackedSymbol {
  id: SymbolId;
  name: string;
  /**
   * @deprecated Use `brokers.binance.spot` instead — kept as an alias so
   * external code that still reaches in via this field keeps compiling.
   */
  binanceSpot: string;
  /**
   * @deprecated Use `brokers.binance.futures` instead.
   */
  binanceFutures: string;
  coingeckoId: string;
  color: string;
  /** Per-broker native pair strings. New brokers add a key here. */
  brokers: {
    binance: BrokerPairConfig;
    delta: BrokerPairConfig;
  };
}

export interface Ticker {
  symbol: SymbolId;
  price: number;
  change24h: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  quoteVolume24h: number;
  updatedAt: number;
}

export interface MarketCapData {
  symbol: SymbolId;
  marketCap: number;
  dominance: number;
  fullyDilutedValuation?: number;
  circulatingSupply?: number;
}

export interface MarketOverviewEntry extends Ticker {
  marketCap: number;
  dominance: number;
  name: string;
}

export interface MarketOverviewResponse {
  generatedAt: number;
  totalMarketCap: number;
  totalVolume24h: number;
  btcDominance: number;
  ethDominance: number;
  entries: MarketOverviewEntry[];
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface FundingRate {
  symbol: SymbolId;
  rate: number;
  nextFundingTime: number;
  markPrice: number;
}

export interface OpenInterest {
  symbol: SymbolId;
  openInterest: number;
  notionalUsd: number;
  ts: number;
}

export interface LongShortRatio {
  symbol: SymbolId;
  longAccount: number;
  shortAccount: number;
  ratio: number;
  ts: number;
}

export interface Liquidation {
  symbol: SymbolId;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  ts: number;
  notionalUsd: number;
}

export type SignalType = "LONG" | "SHORT" | "BUY" | "SELL" | "HOLD";
export type RiskLevel = "low" | "medium" | "high";

export interface TradingSignal {
  id: string;
  symbol: SymbolId;
  type: SignalType;
  confidence: number;
  risk: RiskLevel;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  rationale: string[];
  generatedAt: number;
  features: Partial<{
    rsi: number;
    macdHistogram: number;
    emaCross: "bull" | "bear" | "none";
    fundingRate: number;
    oiChangePct: number;
    longShortRatio: number;
    volumeBreakout: boolean;
    liquidationImbalance: number;
    fearGreed: number;
  }>;
}

export interface FearGreed {
  value: number;
  classification: "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed";
  ts: number;
}

export type SentimentLabel = "Bullish" | "Bearish" | "Neutral";

export interface SentimentBreakdownEntry {
  label: string;
  weight: number;
  score: number;
  rawValue: number | null;
  description: string;
}

export interface SentimentResult {
  label: SentimentLabel;
  score: number;
  confidence: number;
  generatedAt: number;
  breakdown: SentimentBreakdownEntry[];
}

export interface FuturesSymbolView {
  symbol: SymbolId;
  markPrice: number;
  fundingRate: number;
  fundingRateAnnualized: number;
  nextFundingTime: number;
  openInterest: number;
  openInterestNotionalUsd: number;
  oiChangePct1h: number;
  longShortRatio: number;
  longAccount: number;
  shortAccount: number;
}

export interface TopMover {
  symbol: string;
  price: number;
  changePct: number;
  quoteVolume: number;
}

export interface FuturesTickerSummary {
  symbol: SymbolId;
  pair: string;
  price: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  quoteVolume24h: number;
}

export interface FuturesOverviewResponse {
  generatedAt: number;
  symbols: FuturesSymbolView[];
  tickers24h: FuturesTickerSummary[];
  topGainers: TopMover[];
  topLosers: TopMover[];
}

export type OptionsCurrency = "BTC" | "ETH" | "SOL";

export interface StrikeOiBucket {
  strike: number;
  callOi: number;
  putOi: number;
  totalOi: number;
}

export interface ExpiryStats {
  expiryTs: number;
  expiryLabel: string;
  daysToExpiry: number;
  callOi: number;
  putOi: number;
  callVolume: number;
  putVolume: number;
  pcrOi: number;
  pcrVolume: number;
  maxPainStrike: number;
  atmIv: number;
  topStrikes: StrikeOiBucket[];
}

export interface OptionsOverview {
  currency: OptionsCurrency;
  generatedAt: number;
  underlyingPrice: number;
  totalCallOi: number;
  totalPutOi: number;
  totalCallVolume: number;
  totalPutVolume: number;
  pcrOi: number;
  pcrVolume: number;
  expiries: ExpiryStats[];
}

export interface KlineCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface IndicatorSnapshot {
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  emaCross: "bull" | "bear" | "none";
  macdLine: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  atr14: number | null;
  volumeBreakout: number | null;
}

export interface SignalScoreContribution {
  key: string;
  label: string;
  weight: number;
  score: number;
  description: string;
  available: boolean;
}

export interface SignalsResponse {
  generatedAt: number;
  signals: TradingSignal[];
}

export interface ApiError {
  error: true;
  code: string;
  message: string;
}
