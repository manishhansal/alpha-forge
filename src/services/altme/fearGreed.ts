import "server-only";

import { z } from "zod";

const ALTME_REST = "https://api.alternative.me/fng/";

const fearGreedEntrySchema = z.object({
  value: z.string(),
  value_classification: z.string(),
  timestamp: z.string(),
  time_until_update: z.string().optional(),
});

const fearGreedResponseSchema = z.object({
  name: z.string(),
  data: z.array(fearGreedEntrySchema),
});

export type FearGreedClassification =
  | "Extreme Fear"
  | "Fear"
  | "Neutral"
  | "Greed"
  | "Extreme Greed";

export interface FearGreedEntry {
  value: number;
  classification: FearGreedClassification;
  ts: number;
  nextUpdateInSeconds?: number;
}

function classify(value: number): FearGreedClassification {
  if (value < 25) return "Extreme Fear";
  if (value < 45) return "Fear";
  if (value < 55) return "Neutral";
  if (value < 75) return "Greed";
  return "Extreme Greed";
}

export async function fetchFearGreed(limit = 1): Promise<FearGreedEntry[]> {
  const res = await fetch(`${ALTME_REST}?limit=${limit}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Alternative.me F&G request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const parsed = fearGreedResponseSchema.parse(json);
  return parsed.data.map((d) => {
    const value = Number(d.value);
    const valid = (d.value_classification ?? "") as FearGreedClassification;
    const allowed: FearGreedClassification[] = [
      "Extreme Fear",
      "Fear",
      "Neutral",
      "Greed",
      "Extreme Greed",
    ];
    return {
      value,
      classification: allowed.includes(valid) ? valid : classify(value),
      ts: Number(d.timestamp) * 1000,
      nextUpdateInSeconds: d.time_until_update ? Number(d.time_until_update) : undefined,
    };
  });
}
