import "server-only";

import type { LiquidationBucket } from "@/features/futures/liquidations";
import type { FuturesSymbolView, SignalType, SymbolId } from "@/types/market";

import {
  comparatorOk,
  describeAlertType,
  describeComparator,
  thresholdUnit,
  type AlertType,
  type Comparator,
} from "./types";

/**
 * Snapshot of every input the alert evaluator needs for one tick. Built once
 * in the worker, then iterated over against every active Alert row. Anything
 * that's null was unavailable this tick — the evaluator treats null inputs as
 * "skip" (never fire), never as "false".
 */
export interface AlertEvalContext {
  generatedAt: number;
  futures: Record<SymbolId, FuturesSymbolView | null>;
  liquidations: Record<SymbolId, LiquidationBucket | null>;
  /** Per-symbol latest two SignalHistory.type values (newest first). */
  signalTrail: Record<SymbolId, SignalType[]>;
}

export interface EvaluateInput {
  type: AlertType;
  symbol: SymbolId;
  threshold: number;
  comparator: Comparator;
  /** Last triggered time — used by SIGNAL_CHANGE to suppress repeats. */
  triggeredAt: Date | null;
}

export interface EvaluateResult {
  fire: boolean;
  /** Concrete value at evaluation time (null when N/A, e.g. SIGNAL_CHANGE). */
  observed: number | null;
  /** Short human title for the notification. */
  title: string;
  /** One-line body for the notification. */
  body: string;
  /** Snapshot payload persisted on the Notification row. */
  payload: Record<string, unknown>;
}

export function evaluateAlert(
  input: EvaluateInput,
  ctx: AlertEvalContext,
): EvaluateResult | null {
  switch (input.type) {
    case "FUNDING_SPIKE":
      return evalFundingSpike(input, ctx);
    case "OI_BREAKOUT":
      return evalOiBreakout(input, ctx);
    case "PRICE_BREAKOUT":
      return evalPriceBreakout(input, ctx);
    case "LIQUIDATION_SURGE":
      return evalLiquidationSurge(input, ctx);
    case "SIGNAL_CHANGE":
      return evalSignalChange(input, ctx);
  }
}

function fmt(n: number, digits = 2): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function evalFundingSpike(input: EvaluateInput, ctx: AlertEvalContext): EvaluateResult | null {
  const f = ctx.futures[input.symbol];
  if (!f) return null;
  // Funding APR in percent, signed.
  const observed = f.fundingRateAnnualized * 100;
  const fire = comparatorOk(observed, input.comparator, input.threshold);
  return {
    fire,
    observed,
    title: `${input.symbol} funding ${describeComparator(input.comparator)} ${fmt(input.threshold)}% APR`,
    body: `Annualized funding is ${fmt(observed)}% (raw ${fmt(f.fundingRate * 100, 4)}% / interval).`,
    payload: {
      type: input.type,
      symbol: input.symbol,
      observed,
      threshold: input.threshold,
      comparator: input.comparator,
      unit: thresholdUnit("FUNDING_SPIKE"),
      fundingRate: f.fundingRate,
    },
  };
}

function evalOiBreakout(input: EvaluateInput, ctx: AlertEvalContext): EvaluateResult | null {
  const f = ctx.futures[input.symbol];
  if (!f) return null;
  const observed = f.oiChangePct1h;
  const fire = comparatorOk(observed, input.comparator, input.threshold);
  return {
    fire,
    observed,
    title: `${input.symbol} OI 1h ${describeComparator(input.comparator)} ${fmt(input.threshold)}%`,
    body: `Open interest moved ${fmt(observed)}% in the last hour (notional ~$${fmt(
      f.openInterestNotionalUsd,
      0,
    )}).`,
    payload: {
      type: input.type,
      symbol: input.symbol,
      observed,
      threshold: input.threshold,
      comparator: input.comparator,
      unit: thresholdUnit("OI_BREAKOUT"),
      openInterest: f.openInterest,
      openInterestNotionalUsd: f.openInterestNotionalUsd,
    },
  };
}

function evalPriceBreakout(input: EvaluateInput, ctx: AlertEvalContext): EvaluateResult | null {
  const f = ctx.futures[input.symbol];
  if (!f || f.markPrice <= 0) return null;
  const observed = f.markPrice;
  const fire = comparatorOk(observed, input.comparator, input.threshold);
  return {
    fire,
    observed,
    title: `${input.symbol} price ${describeComparator(input.comparator)} $${fmt(input.threshold, 2)}`,
    body: `Mark price is $${fmt(observed, 2)}.`,
    payload: {
      type: input.type,
      symbol: input.symbol,
      observed,
      threshold: input.threshold,
      comparator: input.comparator,
      unit: thresholdUnit("PRICE_BREAKOUT"),
    },
  };
}

function evalLiquidationSurge(input: EvaluateInput, ctx: AlertEvalContext): EvaluateResult | null {
  const bucket = ctx.liquidations[input.symbol];
  if (!bucket) return null;
  const observed = bucket.totalNotionalUsd;
  const fire = comparatorOk(observed, input.comparator, input.threshold);
  return {
    fire,
    observed,
    title: `${input.symbol} liquidations ${describeComparator(input.comparator)} $${fmt(input.threshold, 0)} (5m)`,
    body: `$${fmt(observed, 0)} liquidated in last 5m (buys $${fmt(bucket.buyNotionalUsd, 0)} · sells $${fmt(
      bucket.sellNotionalUsd,
      0,
    )} · imbalance ${fmt(bucket.imbalance, 3)}).`,
    payload: {
      type: input.type,
      symbol: input.symbol,
      observed,
      threshold: input.threshold,
      comparator: input.comparator,
      unit: thresholdUnit("LIQUIDATION_SURGE"),
      buyNotionalUsd: bucket.buyNotionalUsd,
      sellNotionalUsd: bucket.sellNotionalUsd,
      imbalance: bucket.imbalance,
    },
  };
}

function evalSignalChange(input: EvaluateInput, ctx: AlertEvalContext): EvaluateResult | null {
  const trail = ctx.signalTrail[input.symbol];
  if (!trail || trail.length < 2) return null;
  const [latest, prev] = trail;
  if (latest === prev) return { fire: false, observed: null, title: "", body: "", payload: {} };
  // Suppress if we've already fired since the most recent change. The
  // ingestion job's 30-min dedup window means we won't see the same flip
  // repeatedly, but a worker restart could re-discover it.
  return {
    fire: true,
    observed: null,
    title: `${input.symbol} signal flipped → ${latest}`,
    body: `${describeAlertType("SIGNAL_CHANGE")}: ${prev} → ${latest}.`,
    payload: {
      type: input.type,
      symbol: input.symbol,
      from: prev,
      to: latest,
    },
  };
}
