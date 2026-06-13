import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { buildExpiryStats, groupByExpiry } from "@/features/options/compute";
import { fetchIndexPrice, fetchOptionsBookSummary } from "@/services/deribit/rest";
import type { OptionsCurrency, OptionsOverview } from "@/types/market";

const MAX_EXPIRIES = 6;

export async function getOptionsOverview(currency: OptionsCurrency): Promise<OptionsOverview> {
  return cached(
    REDIS_KEYS.optionsOverview(currency),
    CACHE_TTL_SECONDS.optionsOverview,
    async () => {
      const [instruments, indexPriceRes] = await Promise.allSettled([
        fetchOptionsBookSummary(currency),
        fetchIndexPrice(currency),
      ]);

      if (instruments.status !== "fulfilled") {
        throw new Error(`Deribit options fetch failed: ${instruments.reason}`);
      }
      const all = instruments.value;
      const underlyingPrice =
        indexPriceRes.status === "fulfilled"
          ? indexPriceRes.value
          : (all.find((i) => i.underlyingPrice > 0)?.underlyingPrice ?? 0);

      const expiriesAll = groupByExpiry(all);
      const now = Date.now();
      const expiriesFuture = expiriesAll.filter((e) => e.expiryTs > now);
      const expiryStatsAll = expiriesFuture
        .map((e) => buildExpiryStats(e, underlyingPrice))
        .sort((a, b) => b.callOi + b.putOi - (a.callOi + a.putOi));

      const top = expiryStatsAll.slice(0, MAX_EXPIRIES).sort((a, b) => a.expiryTs - b.expiryTs);

      let totalCallOi = 0;
      let totalPutOi = 0;
      let totalCallVolume = 0;
      let totalPutVolume = 0;
      for (const inst of all) {
        if (inst.optionType === "C") {
          totalCallOi += inst.openInterest;
          totalCallVolume += inst.volume;
        } else {
          totalPutOi += inst.openInterest;
          totalPutVolume += inst.volume;
        }
      }

      return {
        currency,
        generatedAt: Date.now(),
        underlyingPrice,
        totalCallOi,
        totalPutOi,
        totalCallVolume,
        totalPutVolume,
        pcrOi: totalCallOi > 0 ? totalPutOi / totalCallOi : 0,
        pcrVolume: totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 0,
        expiries: top,
      };
    },
  );
}
