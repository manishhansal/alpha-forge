/**
 * 9-Step Candle Validation Pipeline for the Indian Market Data layer.
 *
 * Implements the complete ordered pipeline from design section 10.1:
 *
 *   Step 1  — Schema validation (Zod)
 *   Step 2  — UTC timestamp normalisation (all times already UTC epoch seconds
 *             after normaliser; this step re-asserts correctness)
 *   Step 3  — OHLC validation (drop invalid candles, never coerce, increment invalidCount)
 *   Step 4  — Future timestamp guard (> now + 5 s → DROP)
 *   Step 5  — Duplicate detection by (instrumentId, exchange, intervalStr, time)
 *   Step 6  — Gap detection (if gap% > 20 % → quality grade = DEGRADED)
 *   Step 7  — Cross-provider reconciliation (deviation > 0.5 % → RECONCILIATION_CONFLICT)
 *   Step 8  — Spike detection (> 20 % move → suspicious: true, keep candle, skip first)
 *   Step 9  — Quality scoring + provenance stamping
 *
 * Quality score formula (design §10.1 step 9):
 *   score = 0.25 × completeness + 0.25 × freshness + 0.25 × accuracy
 *           + 0.15 × consistency + 0.10 × providerReliability
 *   All sub-scores are 0–1; output is 0–100.
 *
 * Grade thresholds:
 *   A+  95–100  |  A  85–94  |  B  70–84
 *   C   50–69   |  D  30–49  |  BLOCKED < 30
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7
 */

import { z } from "zod";

import {
  computeFreshness,
  resolveProviderType,
  isProviderAuthenticated,
  scoreToGrade,
  stampLiveProvenance,
} from "../provenance";
import type { DataProvenance, Interval, OHLCVCandle, ProviderId, ReconciliationStatus, QualityGrade } from "../types";

// ── Interval width in seconds (3m intentionally absent — V8 removal) ──────────

/** Interval in seconds — used for gap detection and freshness sub-scores. */
export const PIPELINE_INTERVAL_SECONDS: Partial<Record<Interval, number>> = {
  "1m":  60,
  "5m":  300,
  "10m": 600,
  "15m": 900,
  "30m": 1_800,
  "1h":  3_600,
  "1d":  86_400,
  "1w":  7 * 86_400,
  "1M":  30 * 86_400,  // approximate; used only for freshness sub-score
};

// ── Tolerance constants ───────────────────────────────────────────────────────

/** Future-timestamp tolerance (5 seconds of clock-skew tolerance). */
const FUTURE_TOLERANCE_MS = 5_000;

/** Gap threshold: if gap% exceeds this, quality grade is forced to DEGRADED. */
const GAP_DEGRADED_THRESHOLD = 0.20; // 20 %

/** Reconciliation conflict threshold: abs mid-price deviation > 0.5 %. */
const RECONCILIATION_CONFLICT_PCT = 0.005; // 0.5 %

/** Spike detection: move > 20 % relative to previous close → suspicious: true. */
const SPIKE_THRESHOLD_PCT = 0.20; // 20 %

// ── Step 1 — Zod schema ───────────────────────────────────────────────────────

/**
 * Zod schema for a raw candle row as received from a provider normaliser.
 * All fields are numbers; `oi` and `volumeUnavailable` are optional.
 * The pipeline validates this shape first before any numeric checks.
 */
export const OHLCVCandleSchema = z.object({
  time:   z.number().int().positive(),
  open:   z.number(),
  high:   z.number(),
  low:    z.number(),
  close:  z.number(),
  volume: z.number(),
  oi:     z.number().optional(),
  volumeUnavailable: z.boolean().optional(),
  sourceTimestamp:   z.union([z.string(), z.number()]).optional(),
});

/** Input type accepted by the pipeline (slightly looser than OHLCVCandle). */
export type RawCandle = z.input<typeof OHLCVCandleSchema>;

// ── Pipeline result types ─────────────────────────────────────────────────────

/** A candle that was dropped during the pipeline, with the step and reason. */
export type PipelineDroppedCandle = {
  /** Original array index in the input. */
  index: number;
  /** UTC epoch seconds timestamp from the raw row (if parseable). */
  time: number | null;
  /** Which pipeline step dropped this candle. */
  step:
    | "SCHEMA_VALIDATION"
    | "OHLC_VALIDATION"
    | "FUTURE_TIMESTAMP"
    | "DUPLICATE";
  reason: string;
};

/** A candle output that survived the pipeline. May be flagged `suspicious`. */
export type ValidatedCandle = OHLCVCandle & {
  /** Set to true when a >20 % move vs the previous close was detected (Step 8). */
  suspicious?: true;
};

/** Per-field comparison when reconciling two provider versions of the same candle. */
export type ReconciliationConflict = {
  /** UTC epoch seconds of the conflicting candle. */
  time: number;
  /** Which OHLCV field conflicts. */
  field: "open" | "high" | "low" | "close" | "volume";
  valueA: number;
  valueB: number;
  /** abs((a − b) / mid) × 100, expressed as a fraction 0–1. */
  deviationFraction: number;
};

/** Full result returned by `runCandlePipeline`. */
export type CandlePipelineResult = {
  /** Candles that passed all 9 steps (Steps 8 adds `suspicious` flag, never drops). */
  candles: ValidatedCandle[];

  // ── Per-step statistics ───────────────────────────────────────────────────

  /** Total candles fed into the pipeline. */
  inputCount: number;
  /** Candles dropped by schema + OHLC + future-timestamp + duplicate steps. */
  droppedCount: number;
  /** Alias for droppedCount — populated in DataProvenance.quality.invalidCount. */
  invalidCount: number;
  /** Detected gaps in the expected bar sequence. 0 when interval unknown. */
  gapCount: number;
  /** Candles with a >20 % move flagged suspicious (kept in output). */
  suspiciousCount: number;
  /** Candles excluded from output due to cross-provider RECONCILIATION_CONFLICT. */
  conflictCount: number;

  /** Detailed list of every dropped candle with the step and reason. */
  dropped: PipelineDroppedCandle[];
  /** Candles excluded due to reconciliation conflicts (not in `candles`). */
  conflicted: ValidatedCandle[];
  /** Individual field conflicts detected by Step 7. */
  reconciliationConflicts: ReconciliationConflict[];

  // ── Quality outcome ───────────────────────────────────────────────────────

  quality: {
    score: number;
    grade: QualityGrade;
    completeness: number;    // 0–100 percentage
    freshness: number;       // 0–1 sub-score
    accuracy: number;        // 0–1 sub-score
    validationStatus: "PASSED" | "FAILED" | "PARTIAL" | "PENDING";
    reconciliationStatus: ReconciliationStatus;
    gapCount: number;
    invalidCount: number;
    suspiciousCount: number;
  };

  /** Full DataProvenance object (populated when stampProvenance=true). */
  provenance?: DataProvenance;
};

// ── Pipeline options ──────────────────────────────────────────────────────────

export type CandlePipelineOptions = {
  /**
   * The provider that supplied these candles.
   * Required when `stampProvenance: true`.
   */
  providerId?: ProviderId;

  /**
   * Canonical interval for this candle batch.
   * Used for gap detection (Step 6) and freshness sub-score (Step 9).
   */
  interval?: Interval;

  /**
   * Expected number of candles for the requested range.
   * When supplied, gap detection uses this directly instead of computing
   * from the interval + range. If omitted, gap count falls back to comparing
   * the dense-sequence ideal computed from the received timestamps.
   */
  expectedBars?: number;

  /**
   * A second provider's version of the same candle batch for cross-provider
   * reconciliation (Step 7). When absent, Step 7 marks reconciliation as
   * UNRECONCILED and skips conflict detection.
   */
  secondaryCandles?: OHLCVCandle[];

  /**
   * Whether to stamp a DataProvenance object onto the result.
   * Requires `providerId` to be set.
   * @default false
   */
  stampProvenance?: boolean;

  /**
   * UTC epoch milliseconds for "now" — injectable for deterministic testing.
   * @default Date.now()
   */
  nowMs?: number;
};

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the full 9-step candle validation pipeline.
 *
 * This is the canonical entry point for every provider response. Consumers
 * MUST call this before persisting to `CandleBar` or passing data to the
 * signal / ML engine.
 *
 * @param rawCandles  Raw candle rows as received from the provider normaliser.
 * @param opts        Pipeline configuration.
 * @returns           `CandlePipelineResult` with statistics and DataProvenance.
 */
export function runCandlePipeline(
  rawCandles: RawCandle[],
  opts: CandlePipelineOptions = {},
): CandlePipelineResult {
  const nowMs = opts.nowMs ?? Date.now();
  const inputCount = rawCandles.length;

  const dropped: PipelineDroppedCandle[] = [];
  // Survivors after steps 1–5.
  const survivors: ValidatedCandle[] = [];

  // ── Step 1 + 2 + 3 + 4 + 5 (per-candle loop) ─────────────────────────────

  const seenTimes = new Set<number>();

  for (let i = 0; i < rawCandles.length; i++) {
    const raw = rawCandles[i]!;

    // Step 1 — Schema validation (Zod) ─────────────────────────────────────
    const parsed = OHLCVCandleSchema.safeParse(raw);
    if (!parsed.success) {
      dropped.push({
        index: i,
        time: typeof raw.time === "number" ? raw.time : null,
        step: "SCHEMA_VALIDATION",
        reason: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
      });
      continue;
    }

    const c = parsed.data as ValidatedCandle;

    // Step 2 — UTC timestamp normalisation ────────────────────────────────
    // Timestamps arrive as UTC epoch seconds from the normaliser. We assert
    // they are finite positive integers — already enforced by the schema, but
    // this makes the intent explicit and guards future schema relaxation.
    // (No transformation needed; normaliseCandlesFromAngel/Upstox already
    // converts IST → UTC before this pipeline runs.)

    // Step 3 — OHLC validation (drop, never coerce) ────────────────────────
    const ohlcError = validateOhlcFields(c);
    if (ohlcError) {
      dropped.push({ index: i, time: c.time, step: "OHLC_VALIDATION", reason: ohlcError });
      continue;
    }

    // Step 4 — Future timestamp guard (> now + 5 s) ────────────────────────
    const candleTimeMs = c.time * 1_000;
    if (candleTimeMs > nowMs + FUTURE_TOLERANCE_MS) {
      dropped.push({
        index: i,
        time: c.time,
        step: "FUTURE_TIMESTAMP",
        reason: `candle time ${c.time}s is more than ${FUTURE_TOLERANCE_MS}ms in the future (now=${Math.floor(nowMs / 1000)}s)`,
      });
      continue;
    }

    // Step 5 — Duplicate detection by time ────────────────────────────────
    // Full key is (instrumentId, exchange, intervalStr, time); at this layer
    // we only have the time — callers ensure they pass a single-instrument
    // batch. Cross-instrument dedup lives at the DB upsert layer.
    if (seenTimes.has(c.time)) {
      dropped.push({
        index: i,
        time: c.time,
        step: "DUPLICATE",
        reason: `duplicate candle at time=${c.time}s (UTC epoch seconds)`,
      });
      continue;
    }
    seenTimes.add(c.time);
    survivors.push(c);
  }

  // Sort survivors by time ascending so gap detection and spike detection work
  // correctly regardless of provider ordering.
  survivors.sort((a, b) => a.time - b.time);

  // ── Step 6 — Gap detection ────────────────────────────────────────────────

  const gapCount = computeGapCount(survivors, opts.interval, opts.expectedBars);
  const expectedCount = opts.expectedBars ?? estimateExpectedBars(survivors, opts.interval);
  const gapFraction = expectedCount > 0 ? gapCount / expectedCount : 0;

  // ── Step 7 — Cross-provider reconciliation ────────────────────────────────

  const {
    reconciliationStatus,
    conflicts: reconciliationConflicts,
    excluded: conflicted,
    passedReconciliation,
  } = reconcileCandles(survivors, opts.secondaryCandles);

  // ── Step 8 — Spike detection ──────────────────────────────────────────────

  let suspiciousCount = 0;
  const postSpikeCandles: ValidatedCandle[] = [];

  for (let i = 0; i < passedReconciliation.length; i++) {
    const candle = passedReconciliation[i]!;
    const prev = i > 0 ? passedReconciliation[i - 1] : null;

    // Skip spike check on the first candle — no previous bar to compare against.
    if (prev !== null) {
      const move = Math.abs(candle.close - prev.close) / prev.close;
      if (move > SPIKE_THRESHOLD_PCT) {
        // Flag as suspicious but KEEP the candle — circuit-limit moves are real.
        (candle as ValidatedCandle).suspicious = true;
        suspiciousCount++;
      }
    }
    postSpikeCandles.push(candle);
  }

  // ── Step 9 — Quality scoring + provenance stamping ───────────────────────

  const invalidCount = dropped.length;
  const conflictCount = conflicted.length;
  const droppedCount = invalidCount; // conflicted candles tracked separately

  const quality = computeQualityScore({
    inputCount,
    survivorCount: postSpikeCandles.length,
    invalidCount,
    gapFraction,
    gapDegraded: gapFraction > GAP_DEGRADED_THRESHOLD,
    reconciliationStatus,
    interval: opts.interval,
    nowMs,
    latestCandleTimeSec: postSpikeCandles.length > 0
      ? postSpikeCandles[postSpikeCandles.length - 1]!.time
      : null,
    providerId: opts.providerId,
  });

  // Optionally stamp a DataProvenance object.
  let provenance: DataProvenance | undefined;
  if (opts.stampProvenance && opts.providerId) {
    const latestTimeSec = postSpikeCandles.length > 0
      ? postSpikeCandles[postSpikeCandles.length - 1]!.time
      : null;

    provenance = stampLiveProvenance({
      providerId: opts.providerId,
      dataAsOf: latestTimeSec ? latestTimeSec * 1_000 : nowMs,
      isLive: false,
      isHistorical: true,
      requestedAtMs: nowMs,
    });

    // Enrich the provenance quality with pipeline-level statistics.
    provenance = {
      ...provenance,
      quality: {
        ...provenance.quality,
        score: quality.score,
        grade: quality.grade,
        completeness: quality.completeness,
        freshness: quality.freshness,
        accuracy: quality.accuracy,
        validationStatus: quality.validationStatus,
        reconciliationStatus,
        gapCount,
        invalidCount,
        suspiciousCount,
      },
    };
  }

  return {
    candles: postSpikeCandles,
    inputCount,
    droppedCount,
    invalidCount,
    gapCount,
    suspiciousCount,
    conflictCount,
    dropped,
    conflicted,
    reconciliationConflicts,
    quality: {
      score: quality.score,
      grade: quality.grade,
      completeness: quality.completeness,
      freshness: quality.freshness,
      accuracy: quality.accuracy,
      validationStatus: quality.validationStatus,
      reconciliationStatus,
      gapCount,
      invalidCount,
      suspiciousCount,
    },
    ...(provenance ? { provenance } : {}),
  };
}

// ── Step 3 helper — OHLC field checks ─────────────────────────────────────────

/**
 * Validate OHLC numeric constraints.
 * Returns a human-readable error string when invalid, null when valid.
 * Never coerces values — a bad candle is always dropped.
 */
function validateOhlcFields(c: OHLCVCandle): string | null {
  const { open, high, low, close } = c;

  // All OHLC must be finite numbers (schema already enforces number type).
  if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return `non-finite OHLC: o=${open} h=${high} l=${low} c=${close}`;
  }

  // All prices must be positive.
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    return `non-positive price: o=${open} h=${high} l=${low} c=${close}`;
  }

  // high >= low
  if (high < low) {
    return `high(${high}) < low(${low})`;
  }

  // high >= max(open, close)
  if (high < open || high < close) {
    return `high(${high}) < max(open=${open}, close=${close})`;
  }

  // low <= min(open, close)
  if (low > open || low > close) {
    return `low(${low}) > min(open=${open}, close=${close})`;
  }

  return null; // valid
}

// ── Step 6 helper — gap count ─────────────────────────────────────────────────

/**
 * Count the number of missing bars in the survived sequence.
 *
 * Uses `expectedBars` when provided. Falls back to counting gaps in the
 * time series: for each consecutive pair of candles, if the interval between
 * them is greater than 1.5× the expected interval width, a gap of
 * `floor(gap / intervalSec) - 1` bars is inferred.
 */
function computeGapCount(
  candles: ValidatedCandle[],
  interval?: Interval,
  expectedBars?: number,
): number {
  if (candles.length === 0) return 0;

  if (typeof expectedBars === "number" && expectedBars > 0) {
    return Math.max(0, expectedBars - candles.length);
  }

  const intervalSec = interval ? (PIPELINE_INTERVAL_SECONDS[interval] ?? null) : null;
  if (!intervalSec) return 0;

  let gaps = 0;
  for (let i = 1; i < candles.length; i++) {
    const span = candles[i]!.time - candles[i - 1]!.time;
    if (span > intervalSec * 1.5) {
      // Infer gap count from the span.
      gaps += Math.floor(span / intervalSec) - 1;
    }
  }
  return gaps;
}

/**
 * Estimate the number of expected bars from the received candle time range,
 * used as a fallback when `opts.expectedBars` is not provided.
 */
function estimateExpectedBars(candles: ValidatedCandle[], interval?: Interval): number {
  if (candles.length < 2 || !interval) return candles.length;
  const intervalSec = PIPELINE_INTERVAL_SECONDS[interval];
  if (!intervalSec) return candles.length;
  const span = candles[candles.length - 1]!.time - candles[0]!.time;
  return Math.max(candles.length, Math.floor(span / intervalSec) + 1);
}

// ── Step 7 helper — cross-provider reconciliation ─────────────────────────────

type ReconciliationOutput = {
  reconciliationStatus: ReconciliationStatus;
  conflicts: ReconciliationConflict[];
  /** Candles excluded from the final output due to RECONCILIATION_CONFLICT. */
  excluded: ValidatedCandle[];
  /** Candles that passed reconciliation (may be the original set when no secondary). */
  passedReconciliation: ValidatedCandle[];
};

/**
 * Cross-provider reconciliation (Step 7).
 *
 * When `secondaryCandles` is absent: mark UNRECONCILED, return all primaries.
 * When present: build a map by time, then for each primary candle that has a
 * matching secondary, compare OHLCV fields. A deviation > 0.5 % on any field
 * flags RECONCILIATION_CONFLICT; the conflicting candle is excluded from output.
 *
 * Design rule: fewer than 2 providers → UNRECONCILED (skip reconciliation).
 */
function reconcileCandles(
  primary: ValidatedCandle[],
  secondary?: OHLCVCandle[],
): ReconciliationOutput {
  if (!secondary || secondary.length === 0) {
    return {
      reconciliationStatus: "UNRECONCILED",
      conflicts: [],
      excluded: [],
      passedReconciliation: primary,
    };
  }

  // Build a lookup by time for the secondary provider.
  const secondaryMap = new Map<number, OHLCVCandle>();
  for (const sc of secondary) {
    secondaryMap.set(sc.time, sc);
  }

  const conflicts: ReconciliationConflict[] = [];
  const conflictTimes = new Set<number>();
  const OHLCV_FIELDS = ["open", "high", "low", "close", "volume"] as const;

  for (const candle of primary) {
    const sc = secondaryMap.get(candle.time);
    if (!sc) continue; // no matching secondary bar — skip reconciliation for this candle

    for (const field of OHLCV_FIELDS) {
      const va = candle[field];
      const vb = sc[field];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
      if (va === 0 && vb === 0) continue;

      const mid = (Math.abs(va) + Math.abs(vb)) / 2;
      if (mid === 0) continue;

      const deviationFraction = Math.abs(va - vb) / mid;
      if (deviationFraction > RECONCILIATION_CONFLICT_PCT) {
        conflicts.push({
          time: candle.time,
          field,
          valueA: va,
          valueB: vb,
          deviationFraction,
        });
        conflictTimes.add(candle.time);
      }
    }
  }

  const excluded: ValidatedCandle[] = [];
  const passedReconciliation: ValidatedCandle[] = [];

  for (const candle of primary) {
    if (conflictTimes.has(candle.time)) {
      excluded.push(candle);
    } else {
      passedReconciliation.push(candle);
    }
  }

  // Determine overall reconciliation status.
  let reconciliationStatus: ReconciliationStatus = "CONFIRMED";
  if (conflicts.length > 0) {
    // Check max deviation across all conflicts.
    const maxDeviation = Math.max(...conflicts.map((c) => c.deviationFraction));
    reconciliationStatus = maxDeviation > 0.02 ? "MAJOR_DISCREPANCY" : "MINOR_DISCREPANCY";
  }

  return { reconciliationStatus, conflicts, excluded, passedReconciliation };
}

// ── Step 9 helper — quality scoring ──────────────────────────────────────────

interface QualityScoreInput {
  inputCount: number;
  survivorCount: number;
  invalidCount: number;
  gapFraction: number;
  gapDegraded: boolean;
  reconciliationStatus: ReconciliationStatus;
  interval?: Interval;
  nowMs: number;
  /** UTC epoch seconds of the newest surviving candle. */
  latestCandleTimeSec: number | null;
  providerId?: ProviderId;
}

interface ComputedQuality {
  score: number;
  grade: QualityGrade;
  completeness: number;  // 0–100
  freshness: number;     // 0–1
  accuracy: number;      // 0–1
  validationStatus: "PASSED" | "FAILED" | "PARTIAL" | "PENDING";
}

/**
 * Compute the composite quality score using the design formula:
 *   score = 0.25 × completeness + 0.25 × freshness + 0.25 × accuracy
 *           + 0.15 × consistency + 0.10 × providerReliability
 *
 * All sub-scores (except completeness) are 0–1. Output is 0–100.
 *
 * Grade thresholds: A+ 95–100, A 85–94, B 70–84, C 50–69, D 30–49, BLOCKED <30.
 */
function computeQualityScore(input: QualityScoreInput): ComputedQuality {
  // ── Completeness (0–100) ──────────────────────────────────────────────────
  // Percentage of input candles that survived all validation steps.
  // Clamped to [0, 100].
  const completeness = input.inputCount > 0
    ? Math.max(0, Math.min(100, (input.survivorCount / input.inputCount) * 100))
    : 0;

  // ── Freshness sub-score (0–1) ─────────────────────────────────────────────
  // A candle is fresh if its timestamp is within 2 × interval duration of now.
  // (Req 17.7: "a candle is fresh if timestamp is within 2 × candle interval
  // duration relative to Date.now()")
  let freshnessSubScore: number;
  if (input.latestCandleTimeSec === null) {
    freshnessSubScore = 0;
  } else {
    const intervalSec = input.interval ? (PIPELINE_INTERVAL_SECONDS[input.interval] ?? 0) : 0;
    const ageMs = input.nowMs - input.latestCandleTimeSec * 1_000;
    const freshnessLabel = computeFreshness(ageMs);
    if (intervalSec > 0) {
      // Fresh if age <= 2 × interval (hard criterion from Req 17.7)
      const freshWindowMs = 2 * intervalSec * 1_000;
      if (ageMs <= freshWindowMs) {
        freshnessSubScore = 1.0;
      } else {
        // Gracefully degrade: 0.8 for RECENT, 0.4 for STALE, 0 for HISTORICAL
        freshnessSubScore =
          freshnessLabel === "LIVE"   ? 1.0 :
          freshnessLabel === "RECENT" ? 0.8 :
          freshnessLabel === "STALE"  ? 0.4 :
          0.0;
      }
    } else {
      // No interval info — use freshness label alone
      freshnessSubScore =
        freshnessLabel === "LIVE"   ? 1.0 :
        freshnessLabel === "RECENT" ? 0.8 :
        freshnessLabel === "STALE"  ? 0.4 :
        0.0;
    }
  }

  // ── Accuracy sub-score (0–1) ──────────────────────────────────────────────
  // Proportion of input candles that passed OHLC + schema validation.
  const accuracy = input.inputCount > 0
    ? Math.max(0, 1 - input.invalidCount / input.inputCount)
    : 0;

  // ── Consistency sub-score (0–1) ───────────────────────────────────────────
  // Combines gap penalty (gapFraction) and reconciliation status.
  const gapPenalty = Math.min(1, input.gapFraction); // 0 = no gaps, 1 = all gaps
  const reconciliationPenalty =
    input.reconciliationStatus === "CONFIRMED"          ? 0.0 :
    input.reconciliationStatus === "MINOR_DISCREPANCY"  ? 0.15 :
    input.reconciliationStatus === "MAJOR_DISCREPANCY"  ? 0.35 :
    0.0; // UNRECONCILED — no penalty, insufficient data to judge
  const consistency = Math.max(0, 1 - gapPenalty * 0.7 - reconciliationPenalty);

  // ── Provider reliability sub-score (0–1) ──────────────────────────────────
  const providerReliability = input.providerId
    ? (isProviderAuthenticated(input.providerId) ? 1.0 : 0.7)
    : 0.7; // unknown provider → conservative score

  // ── Composite score ───────────────────────────────────────────────────────
  const rawScore =
    0.25 * (completeness / 100) +
    0.25 * freshnessSubScore +
    0.25 * accuracy +
    0.15 * consistency +
    0.10 * providerReliability;

  let score = Math.round(rawScore * 100);

  // Force DEGRADED cap when gap% > 20 % (design §10.1 step 6).
  if (input.gapDegraded && score > 50) {
    score = 50; // cap at grade C
  }

  // Clamp to [0, 100].
  score = Math.max(0, Math.min(100, score));

  const grade = scoreToGrade(score);

  // Determine validation status.
  const validationStatus: ComputedQuality["validationStatus"] =
    input.inputCount === 0           ? "PENDING" :
    input.survivorCount === 0        ? "FAILED"  :
    input.invalidCount > 0           ? "PARTIAL" :
    "PASSED";

  return { score, grade, completeness, freshness: freshnessSubScore, accuracy, validationStatus };
}

// ── Convenience re-exports ────────────────────────────────────────────────────

export {
  computeFreshness,
  resolveProviderType,
  isProviderAuthenticated,
  scoreToGrade,
  stampLiveProvenance,
} from "../provenance";
