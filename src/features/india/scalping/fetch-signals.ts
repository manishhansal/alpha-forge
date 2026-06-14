import "server-only";

import { runScanner } from "@/services/india/scanner/engine";
import type { ScannerHit, ScannerResult, ScannerType } from "@/types/india/scanner";

import {
  ALL_INDIA_STRATEGY_IDS,
  isIndiaScalpStrategyId,
  type IndiaScalpStrategyId,
} from "@/features/india/scalping/strategies/catalog";
import { getIndiaPositioningSignals } from "@/features/india/scalping/strategies/positioning";
import type {
  IndiaScalpDirection,
  IndiaScalpSignal,
  IndiaScalpSignalsResponse,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

/**
 * Server-side adapter that converts the existing NSE scanner output
 * (`src/services/india/scanner/engine.ts`) into the `IndiaScalpSignal`
 * shape consumed by the strategies page. This keeps the F&O strategies
 * page fully live today — the scanners run on daily / option-chain data
 * and we surface their hits as ready-to-paper-trade signals with
 * synthetic stop / target levels derived from a 2:1 RR around a 0.5%
 * ATR-proxy band (the proper paper-trader will replace this with real
 * ATR sizing once it ships).
 *
 * The crypto equivalent is `src/features/scalping/fetch-signals.ts` —
 * keeping them as separate files preserves the no-cross-imports rule
 * between markets and lets each engine evolve independently.
 */

/**
 * The subset of strategy ids that are backed by an NSE scanner. The two
 * ILE-Pine ports (`LIQUIDITY_EDGE`, `MAX_PAIN_GRAVITY`) are intentionally
 * absent — their signals come from the option-positioning engine
 * (`strategies/positioning.ts`) rather than `runScanner`.
 */
type ScannerBackedStrategyId =
  | "RANGE_EXPANSION"
  | "MOMENTUM"
  | "VOLUME_BREAKOUT"
  | "OI_BUILDUP"
  | "PCR_EXTREME"
  | "IV_SPIKE";

/** Mapping from a scanner-backed `IndiaScalpStrategyId` to the scanner key. */
const STRATEGY_TO_SCANNER: Record<ScannerBackedStrategyId, ScannerType> = {
  RANGE_EXPANSION: "range-expansion",
  MOMENTUM: "momentum",
  VOLUME_BREAKOUT: "volume-breakout",
  OI_BUILDUP: "oi-buildup",
  PCR_EXTREME: "pcr",
  IV_SPIKE: "iv-spike",
};

function isScannerBacked(
  id: IndiaScalpStrategyId,
): id is ScannerBackedStrategyId {
  return id in STRATEGY_TO_SCANNER;
}

/** Synthetic price band used for stop / target until the real ATR-driven
 *  paper-trader lands. 0.5% stop, 1.0% target → 2:1 reward / risk. */
const STOP_FRACTION = 0.005;
const TARGET_FRACTION = 0.01;

const DEFAULT_LIMIT = 10;
const ALLOWED_TIMEFRAMES: ReadonlyArray<IndiaScalpTimeframe> = [
  "1m",
  "5m",
  "15m",
];

export interface GetIndiaScalpSignalsOptions {
  /** Bar timeframe label rendered on the cards. Defaults to "5m". The
   *  scanners themselves run on daily / 15m option-chain snapshots so
   *  this is mostly cosmetic until the real paper-trader ships. */
  timeframe?: IndiaScalpTimeframe;
  /** Restrict the response to the listed strategy IDs. Empty / undefined
   *  fans out to every strategy in the catalog. */
  strategies?: ReadonlyArray<IndiaScalpStrategyId>;
  /** Max hits per strategy (post-filter). Mirrors the scanner endpoint. */
  limit?: number;
}

/**
 * Run the requested strategies and merge their hits into one
 * timeframe-stamped response. Each scanner is run in parallel; failures
 * are swallowed (logged) so a single broken upstream (e.g. NSE option
 * chain throttling) doesn't blank the whole feed.
 */
export async function getIndiaScalpSignals(
  options: GetIndiaScalpSignalsOptions = {},
): Promise<IndiaScalpSignalsResponse> {
  const timeframe = ALLOWED_TIMEFRAMES.includes(
    options.timeframe ?? ("5m" as IndiaScalpTimeframe),
  )
    ? (options.timeframe ?? "5m")
    : "5m";
  const limit = clampLimit(options.limit);
  const requested =
    options.strategies && options.strategies.length > 0
      ? options.strategies.filter(isIndiaScalpStrategyId)
      : [...ALL_INDIA_STRATEGY_IDS];

  // Split the request into the scanner-backed strategies (run via the NSE
  // scanner engine) and the option-positioning strategies (the two
  // ILE-Pine ports run via the dedicated positioning engine).
  const scannerIds = requested.filter(isScannerBacked);
  const positioningIds = requested.filter((id) => !isScannerBacked(id));

  const [scannerResults, positioningSignals] = await Promise.all([
    Promise.allSettled(
      scannerIds.map(async (strategyId) => {
        const scanner = await runScanner(STRATEGY_TO_SCANNER[strategyId], limit);
        return { strategyId, scanner };
      }),
    ),
    positioningIds.length > 0
      ? getIndiaPositioningSignals({
          strategies: positioningIds,
          timeframe,
          limit,
        }).catch((err) => {
          console.warn("[india/scalping/fetch-signals] positioning", err);
          return [] as IndiaScalpSignal[];
        })
      : Promise.resolve([] as IndiaScalpSignal[]),
  ]);

  const signals: IndiaScalpSignal[] = [];
  let latestFetchedAt = 0;

  for (const r of scannerResults) {
    if (r.status !== "fulfilled") {
      console.warn("[india/scalping/fetch-signals]", r.reason);
      continue;
    }
    const { strategyId, scanner } = r.value;
    const fetchedAtMs = Date.parse(scanner.fetchedAt) || Date.now();
    if (fetchedAtMs > latestFetchedAt) latestFetchedAt = fetchedAtMs;
    for (const hit of scanner.hits) {
      const sig = toSignal(strategyId, timeframe, hit, scanner, fetchedAtMs);
      if (sig) signals.push(sig);
    }
  }

  for (const sig of positioningSignals) {
    signals.push(sig);
    if (sig.triggeredAt > latestFetchedAt) latestFetchedAt = sig.triggeredAt;
  }

  signals.sort((a, b) => b.confidence - a.confidence);

  return {
    generatedAt: latestFetchedAt || Date.now(),
    timeframe,
    signals,
  };
}

/**
 * Lift a single `ScannerHit` into an `IndiaScalpSignal`. Returns null
 * when the hit lacks a price (we can't derive entry / stop / target
 * without one and the card would render `$NaN`).
 */
function toSignal(
  strategyId: ScannerBackedStrategyId,
  timeframe: IndiaScalpTimeframe,
  hit: ScannerHit,
  scanner: ScannerResult,
  triggeredAt: number,
): IndiaScalpSignal | null {
  const price = typeof hit.price === "number" ? hit.price : 0;
  if (!Number.isFinite(price) || price <= 0) return null;

  const direction = pickDirection(strategyId, hit);
  const reference = pickReference(strategyId, hit, scanner);
  const confidence = pickConfidence(strategyId, hit);
  const isLong = direction === "LONG";

  const stopLoss = isLong
    ? price * (1 - STOP_FRACTION)
    : price * (1 + STOP_FRACTION);
  const target = isLong
    ? price * (1 + TARGET_FRACTION)
    : price * (1 - TARGET_FRACTION);
  // Use the synthetic 0.5% band as an ATR proxy so the journal's
  // ATR-sizing math (when it lands) has a sane non-zero value to work
  // with today.
  const atr = price * STOP_FRACTION;

  const rationale = buildRationale(strategyId, scanner, hit);

  return {
    strategyId,
    symbol: hit.symbol,
    symbolName: hit.symbol,
    timeframe,
    direction,
    price,
    reference,
    atr,
    confirmed: true,
    entry: price,
    stopLoss,
    target,
    riskReward: TARGET_FRACTION / STOP_FRACTION,
    confidence,
    rationale,
    triggeredAt,
    extras: {
      metric: hit.metric,
      metricLabel: hit.metricLabel,
      kind: hit.kind ?? null,
      note: hit.note ?? null,
    },
  };
}

function pickDirection(
  strategyId: ScannerBackedStrategyId,
  hit: ScannerHit,
): IndiaScalpDirection {
  switch (strategyId) {
    case "RANGE_EXPANSION":
      // Scanner already filters to bullish-trend setups.
      return "LONG";
    case "MOMENTUM":
    case "VOLUME_BREAKOUT":
      return (hit.changePct ?? 0) >= 0 ? "LONG" : "SHORT";
    case "OI_BUILDUP":
      // Smart-money side: long build-up + short covering = bullish;
      // short build-up + long unwinding = bearish.
      if (hit.kind === "LONG_BUILDUP" || hit.kind === "SHORT_COVERING") {
        return "LONG";
      }
      return "SHORT";
    case "PCR_EXTREME":
      // Contrarian read: high PCR (>1.3) = excessive bearish positioning
      // → long; low PCR (<0.7) = excessive bullish positioning → short.
      return hit.metric >= 1.3 ? "LONG" : "SHORT";
    case "IV_SPIKE":
      // No directional signal from IV alone — bias long-vega (LONG)
      // when IV is elevated, short-vega (SHORT) when it's compressed.
      return hit.metric >= 14 ? "LONG" : "SHORT";
  }
}

function pickReference(
  strategyId: ScannerBackedStrategyId,
  hit: ScannerHit,
  scanner: ScannerResult,
): number {
  switch (strategyId) {
    case "VOLUME_BREAKOUT":
      // Reference is the volume ratio (e.g. 2.3× avg) — surfaced for
      // operator context, not used for entries.
      return hit.metric;
    case "PCR_EXTREME":
    case "IV_SPIKE":
      return hit.metric;
    case "OI_BUILDUP":
      return hit.metric;
    case "MOMENTUM":
      return hit.changePct ?? 0;
    case "RANGE_EXPANSION":
      return scanner.hits.length;
  }
}

function pickConfidence(
  strategyId: ScannerBackedStrategyId,
  hit: ScannerHit,
): number {
  // Clamp helper so every strategy returns a number in [0, 1].
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  switch (strategyId) {
    case "MOMENTUM":
      // Treat ≥5% intraday as a perfect-confidence move.
      return clamp(Math.abs(hit.changePct ?? 0) / 5);
    case "VOLUME_BREAKOUT":
      // 3× average volume = perfect confidence; 1.5× ≈ 0.5.
      return clamp((hit.metric - 1) / 2);
    case "RANGE_EXPANSION":
      // Range-expansion is filter-heavy upstream — every hit clears
      // multiple gates so we surface them as high-confidence.
      return 0.8;
    case "OI_BUILDUP":
      return hit.kind === "LONG_BUILDUP" || hit.kind === "SHORT_BUILDUP"
        ? 0.7
        : 0.5;
    case "PCR_EXTREME":
      // Distance from neutral PCR=1; clamp at PCR=1.5 / 0.5.
      return clamp(Math.abs((hit.metric ?? 1) - 1) / 0.5);
    case "IV_SPIKE":
      // IV >25% = very elevated; 20-25 = elevated; <14 = compressed.
      return clamp((hit.metric - 14) / 16);
  }
}

function buildRationale(
  strategyId: ScannerBackedStrategyId,
  scanner: ScannerResult,
  hit: ScannerHit,
): string[] {
  const out: string[] = [scanner.title];
  if (hit.metricLabel) out.push(hit.metricLabel);
  if (hit.kind) out.push(`Kind: ${hit.kind}`);
  if (hit.note) out.push(hit.note);
  if (strategyId === "RANGE_EXPANSION") {
    out.push("WR8 + bullish SMA stack + ≥1.5× volume");
  }
  return out;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(3, Math.min(50, Math.trunc(raw)));
}
