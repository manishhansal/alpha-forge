import "server-only";

import { CACHE_TTL_SECONDS, REDIS_KEYS } from "@/lib/constants";
import { cached } from "@/lib/redis";
import { buildExpiryStats, groupByExpiry, type DeribitOptionInstrument } from "@/features/options/compute";
import { getDeribitOptionsOverview } from "@/lib/data-service/client";
import type { OptionsCurrency, OptionsOverview } from "@/types/market";

const MAX_EXPIRIES = 6;

export async function getOptionsOverview(currency: OptionsCurrency): Promise<OptionsOverview> {
  return cached(
    REDIS_KEYS.optionsOverview(currency),
    CACHE_TTL_SECONDS.optionsOverview,
    async () => {
      const rawData = await getDeribitOptionsOverview();
      // getDeribitOptionsOverview returns unknown[] — cast to instrument shape
      const all = rawData as DeribitOptionInstrument[];
      const underlyingPrice =
        all.find((i) => i.underlyingPrice > 0)?.underlyingPrice ?? 0;

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
