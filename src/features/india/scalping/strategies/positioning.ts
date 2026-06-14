import "server-only";

import { FNO_INDICES } from "@/lib/india/fno-symbols";
import { cache } from "@/services/india/cache";
import { nse } from "@/services/india/nse";
import { yahoo } from "@/services/india/yahoo";

import {
  buildLiquidityEdgeSignal,
  buildMaxPainGravitySignal,
  type PositioningInput,
} from "@/features/india/scalping/strategies/positioning-core";
import type { IndiaScalpStrategyId } from "@/features/india/scalping/strategies/catalog";
import type {
  IndiaScalpSignal,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";

/**
 * IO orchestrator for the option-positioning F&O strategies — the two
 * ILE-Pine ports that are NOT scanner-backed (`LIQUIDITY_EDGE` and
 * `MAX_PAIN_GRAVITY`). It fetches the live NSE index option chains +
 * index quotes, folds them into `PositioningInput`s, and runs the pure
 * builders in `positioning-core.ts`.
 *
 * Kept separate from `fetch-signals.ts` (which wraps `runScanner`) so the
 * scanner-backed and positioning-backed strategies can evolve / be mocked
 * independently. The scoring logic itself is in the pure core module so
 * it stays unit-testable without touching the network.
 */

/** The strategy ids served by this engine (everything not scanner-backed). */
export const POSITIONING_STRATEGY_IDS = [
  "LIQUIDITY_EDGE",
  "MAX_PAIN_GRAVITY",
] as const satisfies ReadonlyArray<IndiaScalpStrategyId>;

export interface GetIndiaPositioningSignalsOptions {
  /** Which positioning strategies to run. */
  strategies: ReadonlyArray<IndiaScalpStrategyId>;
  /** Bar timeframe stamped on the produced signals. */
  timeframe: IndiaScalpTimeframe;
  /** Max signals per strategy after sorting by confidence. */
  limit?: number;
}

const DEFAULT_LIMIT = 10;

export async function getIndiaPositioningSignals(
  options: GetIndiaPositioningSignalsOptions,
): Promise<IndiaScalpSignal[]> {
  const wanted = new Set(options.strategies);
  const runIle = wanted.has("LIQUIDITY_EDGE");
  const runImpg = wanted.has("MAX_PAIN_GRAVITY");
  if (!runIle && !runImpg) return [];

  const inputs = await loadPositioningInputs(options.timeframe);

  const ile: IndiaScalpSignal[] = [];
  const impg: IndiaScalpSignal[] = [];
  for (const inp of inputs) {
    if (runIle) {
      const s = buildLiquidityEdgeSignal(inp);
      if (s) ile.push(s);
    }
    if (runImpg) {
      const s = buildMaxPainGravitySignal(inp);
      if (s) impg.push(s);
    }
  }

  const limit = clampLimit(options.limit);
  const byConfidence = (a: IndiaScalpSignal, b: IndiaScalpSignal) =>
    b.confidence - a.confidence;

  return [
    ...ile.sort(byConfidence).slice(0, limit),
    ...impg.sort(byConfidence).slice(0, limit),
  ];
}

/**
 * Fetch index option chains + index quotes and fold them into one
 * `PositioningInput` per F&O index. Resilient: a single failing chain is
 * skipped (the rest of the feed survives), and a total quote failure
 * degrades to chain-only inputs (no intraday trend factor).
 */
async function loadPositioningInputs(
  timeframe: IndiaScalpTimeframe,
): Promise<PositioningInput[]> {
  return cache.memo(`scalp:positioning-inputs:${timeframe}`, 15_000, async () => {
    const quoteBySymbol = await loadIndexQuotes();

    const settled = await Promise.allSettled(
      FNO_INDICES.map((i) => nse.getOptionChain(i.underlying)),
    );

    const inputs: PositioningInput[] = [];
    settled.forEach((res, idx) => {
      if (res.status !== "fulfilled") {
        console.warn(
          "[india/scalping/positioning]",
          FNO_INDICES[idx].underlying,
          res.reason,
        );
        return;
      }
      const meta = FNO_INDICES[idx];
      const chain = res.value;
      const quote = quoteBySymbol.get(meta.symbol);
      const spot = chain.spot ?? quote?.price ?? null;
      if (spot == null || !Number.isFinite(spot) || spot <= 0) return;

      inputs.push({
        underlying: meta.underlying,
        symbolName: meta.name,
        timeframe,
        spot,
        changePct: quote?.changePct ?? null,
        prevClose: quote?.prevClose ?? null,
        analytics: chain.analytics,
        triggeredAt: Date.parse(chain.fetchedAt) || Date.now(),
      });
    });
    return inputs;
  });
}

async function loadIndexQuotes() {
  const map = new Map<
    string,
    Awaited<ReturnType<typeof yahoo.getQuotes>>[number]
  >();
  try {
    const quotes = await yahoo.getQuotes(FNO_INDICES.map((i) => i.symbol));
    for (const q of quotes) map.set(q.symbol, q);
  } catch (err) {
    console.warn("[india/scalping/positioning] index quotes failed", err);
  }
  return map;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(50, Math.trunc(raw)));
}
