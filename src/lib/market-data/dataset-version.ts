/**
 * dataset-version.ts — Data Foundation V3 §18.
 *
 * Deterministic dataset versioning for reproducibility. A dataset version is a
 * stable identity for "which provider + normalizer + correction/aggregation
 * logic produced this data", NOT a wall-clock timestamp. Two runs on the same
 * day with the same provider + normalizer must yield the SAME version so a
 * replay can reproduce the exact dataset.
 *
 * Format: `<YYYY-MM-DD>.<source>.<normalizer>` e.g.
 *   2026-09-10.angel_one.norm-v3          (provider-native capture)
 *   2026-09-10.agg-1m.norm-v3             (higher-timeframe aggregation)
 *   2026-09-10.correction.norm-v3         (a correction pass)
 *
 * The date component is the SESSION date the data belongs to (or capture date
 * for live), passed explicitly so it is deterministic — never `Date.now()`
 * baked into the identity implicitly.
 */

/** Bump when the normalization logic changes materially. */
export const NORMALIZER_VERSION = "norm-v3";

/** Bump when aggregation math changes. */
export const AGGREGATION_VERSION = "agg-v3";

export type DatasetSource =
  | { kind: "provider"; provider: string }
  | { kind: "aggregation"; sourceInterval: string }
  | { kind: "correction"; provider?: string };

/**
 * Build a deterministic dataset version. `dateKey` is the IST session/capture
 * date `YYYY-MM-DD` the data belongs to.
 */
export function datasetVersion(dateKey: string, source: DatasetSource): string {
  switch (source.kind) {
    case "provider":
      return `${dateKey}.${source.provider}.${NORMALIZER_VERSION}`;
    case "aggregation":
      return `${dateKey}.agg-${source.sourceInterval}.${AGGREGATION_VERSION}`;
    case "correction":
      return `${dateKey}.correction${source.provider ? `-${source.provider}` : ""}.${NORMALIZER_VERSION}`;
  }
}

/** Parse a dataset version back into its parts (best-effort). */
export function parseDatasetVersion(v: string): {
  dateKey: string | null;
  source: string | null;
  normalizer: string | null;
} {
  const parts = v.split(".");
  if (parts.length < 3) return { dateKey: null, source: null, normalizer: null };
  return { dateKey: parts[0]!, source: parts[1]!, normalizer: parts.slice(2).join(".") };
}
