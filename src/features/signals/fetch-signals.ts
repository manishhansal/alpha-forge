import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS, TRACKED_SYMBOLS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { computeIndicators } from "@/features/signals/indicators";
import { computeSignal } from "@/features/signals/engine";
import { getFuturesOverview } from "@/features/futures/aggregate";
import { getAllLiquidationBuckets } from "@/features/futures/liquidations";
import { fetchFearGreed } from "@/services/altme/fearGreed";
import { getServerBroker } from "@/services/brokers/registry";
import type { ServerBrokerAdapter } from "@/services/brokers/server-types";
import type {
  FuturesSymbolView,
  KlineCandle,
  SignalsResponse,
  SymbolId,
  TradingSignal,
} from "@/types/market";

interface PerSymbolInputs {
  symbol: SymbolId;
  pair: string;
  candles: KlineCandle[];
}

async function loadKlines(broker: ServerBrokerAdapter): Promise<PerSymbolInputs[]> {
  const results = await Promise.all(
    TRACKED_SYMBOLS.map(async (s) => {
      const pair = broker.pairs.spot[s.id];
      try {
        const candles = await broker.fetchKlines(pair, "1h", 100);
        return { symbol: s.id, pair, candles };
      } catch (err) {
        console.warn(`[signals] kline fetch failed for ${pair}:`, (err as Error).message);
        return { symbol: s.id, pair, candles: [] as KlineCandle[] };
      }
    }),
  );
  return results;
}

export async function getSignals(): Promise<SignalsResponse> {
  return cached(REDIS_KEYS.signals, CACHE_TTL_SECONDS.signals, async () => {
    const broker = getServerBroker();
    const [klineResults, futuresRes, fgRes, liqRes] = await Promise.allSettled([
      loadKlines(broker),
      getFuturesOverview(),
      fetchFearGreed(1),
      getAllLiquidationBuckets(),
    ]);

    const perSymbolKlines = klineResults.status === "fulfilled" ? klineResults.value : [];
    const futuresMap = new Map<SymbolId, FuturesSymbolView>();
    if (futuresRes.status === "fulfilled") {
      for (const f of futuresRes.value.symbols) futuresMap.set(f.symbol, f);
    }
    const fearGreedValue =
      fgRes.status === "fulfilled" && fgRes.value[0] ? fgRes.value[0].value : null;
    const liqMap = liqRes.status === "fulfilled" ? liqRes.value : null;

    const signals: TradingSignal[] = perSymbolKlines.map((entry) => {
      const indicators = computeIndicators(entry.candles);
      const lastClose = entry.candles.at(-1)?.close ?? futuresMap.get(entry.symbol)?.markPrice ?? 0;
      return computeSignal({
        symbol: entry.symbol,
        price: lastClose,
        indicators,
        futures: futuresMap.get(entry.symbol) ?? null,
        fearGreed: fearGreedValue,
        liquidationImbalance: liqMap?.[entry.symbol]?.imbalance ?? null,
      });
    });

    return {
      generatedAt: Date.now(),
      signals,
    };
  });
}
