/**
 * signal-data-snapshot.service.ts — Data Foundation V7 §26/§27/§33.
 *
 * ONE authoritative service that signal producers consume instead of each
 * deciding for itself whether the raw tables are "good enough". It assembles a
 * coherent, validated market snapshot from the REAL DB and exposes:
 *
 *   §26  SignalDataSnapshotService.build() — validated candles coverage,
 *        indices, option/OI/IV availability, snapshot timestamp, provider
 *        provenance, dataset versions, quality — all from the DB.
 *   §27  buildFnoSignalReadinessMatrix() — per (strategy, symbol, timeframe):
 *        READY / DEGRADED / BLOCKED with an EXACT reason (never a generic
 *        "data unavailable").
 *   §33  computeOverallDataStatus() — DATA_READY only when the required signal
 *        surface is genuinely complete; else DATA_DEGRADED / DATA_BLOCKED, with
 *        both overallDataStatus AND perStrategyReadiness returned.
 *
 * Everything is DB-derived. Nothing is fabricated. A missing field is reported
 * as missing with its exact deficit (required vs available bars, NULL IV, etc.).
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import type { Interval } from "../types";
import { requiredBarsForTimeframe } from "./feature-lookback.service";
import { isIndexSymbol } from "../provider-capability-matrix";

export type ReadinessState = "READY" | "DEGRADED" | "BLOCKED";

export interface IntervalCoverage {
  interval: Interval;
  bars: number;
  requiredBars: number;
  sufficient: boolean;
  firstTime: number | null;
  lastTime: number | null;
  providers: string[];
}

export interface SymbolSnapshot {
  symbol: string;
  isIndex: boolean;
  coverage: IntervalCoverage[];
  /** Option availability for this underlying. */
  options: {
    strikeRows: number;
    oiPopulated: number;
    ivPopulated: number;
    bidPopulated: number;
    expiries: string[];
  };
}

export interface SignalDataSnapshot {
  snapshotId: string;
  snapshotTimestamp: number;
  symbols: SymbolSnapshot[];
  /** Instrument-master snapshot version backing the universe (provenance). */
  instrumentMasterVersion: string | null;
}

async function coverageForSymbol(
  prisma: PrismaClient,
  symbol: string,
  intervals: Interval[],
): Promise<IntervalCoverage[]> {
  const out: IntervalCoverage[] = [];
  for (const interval of intervals) {
    const rows = await prisma.candleBar.findMany({
      where: { instrumentId: symbol, intervalStr: interval },
      select: { time: true, provider: true },
      orderBy: { time: "asc" },
    });
    const bars = rows.length;
    const requiredBars = requiredBarsForTimeframe(interval);
    const providers = Array.from(new Set(rows.map((r) => r.provider).filter(Boolean))) as string[];
    out.push({
      interval,
      bars,
      requiredBars,
      sufficient: bars >= requiredBars,
      firstTime: rows[0]?.time ?? null,
      lastTime: rows[rows.length - 1]?.time ?? null,
      providers,
    });
  }
  return out;
}

async function optionsForUnderlying(prisma: PrismaClient, underlying: string) {
  const rows = await prisma.optionChainStrike.findMany({
    where: { underlying },
    select: { oi: true, iv: true, bid: true, expiry: true },
  });
  return {
    strikeRows: rows.length,
    oiPopulated: rows.filter((r) => r.oi != null).length,
    ivPopulated: rows.filter((r) => r.iv != null).length,
    bidPopulated: rows.filter((r) => r.bid != null).length,
    expiries: Array.from(new Set(rows.map((r) => r.expiry))),
  };
}

/**
 * Build an authoritative, DB-derived signal-data snapshot for a set of symbols
 * and timeframes. The snapshotTimestamp is the build time; per-symbol coverage
 * carries the real first/last bar times so callers can enforce freshness/skew.
 */
export async function buildSignalDataSnapshot(opts: {
  symbols: string[];
  intervals?: Interval[];
  prisma?: PrismaClient;
}): Promise<SignalDataSnapshot> {
  const prisma = opts.prisma ?? getPrisma();
  const intervals = opts.intervals ?? (["1m", "5m", "10m", "15m", "30m", "1h", "1d"] as Interval[]);

  const master = await prisma.instrumentMasterSnapshot.findFirst({
    orderBy: { createdAt: "desc" },
    select: { snapshotVersion: true },
  });

  const symbols: SymbolSnapshot[] = [];
  for (const symbol of opts.symbols) {
    const coverage = await coverageForSymbol(prisma, symbol, intervals);
    const options = await optionsForUnderlying(prisma, symbol);
    symbols.push({ symbol, isIndex: isIndexSymbol(symbol), coverage, options });
  }

  return {
    snapshotId: `snap-${Date.now()}`,
    snapshotTimestamp: Date.now(),
    symbols,
    instrumentMasterVersion: master?.snapshotVersion ?? null,
  };
}

// ── §27 F&O signal readiness matrix ──────────────────────────────────────────

export interface StrategyReadinessSpec {
  strategy: string;
  /** Primary timeframe the strategy runs on. */
  timeframe: Interval;
  /** Whether the strategy needs option chain data (OI). */
  needsOptions?: boolean;
  /** Whether the strategy needs IV specifically. */
  needsIv?: boolean;
}

export interface ReadinessMatrixRow {
  strategy: string;
  symbol: string;
  timeframe: Interval;
  state: ReadinessState;
  /** Exact reason — never a generic "data unavailable". */
  reason: string;
  detail: {
    bars: number;
    requiredBars: number;
    optionOi: number;
    optionIv: number;
  };
}

/** The canonical F&O strategy surface evaluated by the matrix. */
export const FNO_STRATEGY_SPECS: readonly StrategyReadinessSpec[] = [
  { strategy: "ORB_5m", timeframe: "5m" },
  { strategy: "VWAP_scalp_5m", timeframe: "5m" },
  { strategy: "trend_1h", timeframe: "1h" },
  { strategy: "daily_swing", timeframe: "1d" },
  { strategy: "option_OI_strategy", timeframe: "5m", needsOptions: true },
  { strategy: "option_IV_strategy", timeframe: "5m", needsOptions: true, needsIv: true },
];

/**
 * Build the per-(strategy,symbol,timeframe) readiness matrix from a snapshot.
 * READY   — history sufficient + (options OI present if needed) + (IV if needed).
 * DEGRADED— history sufficient but an OPTIONAL dependency (IV) is missing.
 * BLOCKED — history insufficient OR a CRITICAL dependency (OI when needed) absent.
 * Every non-READY row states the EXACT deficit.
 */
export function buildFnoSignalReadinessMatrix(
  snapshot: SignalDataSnapshot,
  specs: readonly StrategyReadinessSpec[] = FNO_STRATEGY_SPECS,
): ReadinessMatrixRow[] {
  const rows: ReadinessMatrixRow[] = [];
  for (const sym of snapshot.symbols) {
    for (const spec of specs) {
      const cov = sym.coverage.find((c) => c.interval === spec.timeframe);
      const bars = cov?.bars ?? 0;
      const requiredBars = cov?.requiredBars ?? requiredBarsForTimeframe(spec.timeframe);
      const optionOi = sym.options.oiPopulated;
      const optionIv = sym.options.ivPopulated;

      let state: ReadinessState = "READY";
      const reasons: string[] = [];

      if (bars < requiredBars) {
        state = "BLOCKED";
        reasons.push(`INSUFFICIENT_HISTORY ${spec.timeframe}: have ${bars}, need ${requiredBars} (missing ${requiredBars - bars})`);
      }
      if (spec.needsOptions && optionOi === 0) {
        state = "BLOCKED";
        reasons.push(`MISSING_OPTION_OI: no OI rows for ${sym.symbol}`);
      }
      if (spec.needsIv && optionIv === 0 && state !== "BLOCKED") {
        state = "DEGRADED";
        reasons.push(`MISSING_IV: option IV unavailable for ${sym.symbol} (NULL — provider off-hours or unsupported)`);
      }

      rows.push({
        strategy: spec.strategy,
        symbol: sym.symbol,
        timeframe: spec.timeframe,
        state,
        reason: reasons.length > 0 ? reasons.join("; ") : "READY: all required dependencies satisfied",
        detail: { bars, requiredBars, optionOi, optionIv },
      });
    }
  }
  return rows;
}

// ── §33 overall + per-strategy readiness ─────────────────────────────────────

export interface OverallReadiness {
  overallDataStatus: "DATA_READY" | "DATA_DEGRADED" | "DATA_BLOCKED";
  perStrategyReadiness: Array<{ strategy: string; ready: number; degraded: number; blocked: number; state: ReadinessState }>;
  reason: string;
}

/**
 * Compute the overall data status from a readiness matrix. DATA_READY only when
 * EVERY evaluated (strategy,symbol) row is READY. If any is BLOCKED → the whole
 * surface is DATA_DEGRADED (not BLOCKED unless ALL are blocked) — and the
 * per-strategy breakdown is always returned so no single strategy's readiness
 * masks another's block (§33: never globally READY because one strategy is).
 */
export function computeOverallDataStatus(matrix: ReadinessMatrixRow[]): OverallReadiness {
  const byStrategy = new Map<string, { ready: number; degraded: number; blocked: number }>();
  for (const row of matrix) {
    const s = byStrategy.get(row.strategy) ?? { ready: 0, degraded: 0, blocked: 0 };
    if (row.state === "READY") s.ready++;
    else if (row.state === "DEGRADED") s.degraded++;
    else s.blocked++;
    byStrategy.set(row.strategy, s);
  }

  const perStrategyReadiness = Array.from(byStrategy.entries()).map(([strategy, c]) => ({
    strategy,
    ...c,
    state: (c.blocked > 0 ? "BLOCKED" : c.degraded > 0 ? "DEGRADED" : "READY") as ReadinessState,
  }));

  const anyReady = matrix.some((r) => r.state === "READY");
  const anyBlocked = matrix.some((r) => r.state === "BLOCKED");
  const allReady = matrix.length > 0 && matrix.every((r) => r.state === "READY");
  const allBlocked = matrix.length > 0 && matrix.every((r) => r.state === "BLOCKED");

  let overallDataStatus: OverallReadiness["overallDataStatus"];
  let reason: string;
  if (allReady) {
    overallDataStatus = "DATA_READY";
    reason = "every evaluated (strategy,symbol,timeframe) row is READY";
  } else if (allBlocked || !anyReady) {
    overallDataStatus = "DATA_BLOCKED";
    reason = "no (strategy,symbol,timeframe) row is READY";
  } else {
    overallDataStatus = "DATA_DEGRADED";
    reason = anyBlocked
      ? "some strategies READY, others BLOCKED/DEGRADED — surface is DEGRADED (never globally READY because one strategy is ready)"
      : "some strategies DEGRADED";
  }

  return { overallDataStatus, perStrategyReadiness, reason };
}
