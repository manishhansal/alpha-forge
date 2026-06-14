/**
 * Pure option-chain *replay* backtester. Turns a chronological series of
 * captured `OptionChainSnapshot` analytics (see `option-chain-capture.ts`)
 * into resolved trades for the five option-chain F&O strategies:
 *
 *   - `PCR_EXTREME`      — contrarian PCR-OI extreme
 *   - `IV_SPIKE`         — long/short vega on the ATM-IV regime
 *   - `OI_BUILDUP`       — price×OI quadrant (build-up / unwinding)
 *   - `LIQUIDITY_EDGE`   — option-chain confluence (reuses positioning-core)
 *   - `MAX_PAIN_GRAVITY` — max-pain fade (reuses positioning-core)
 *
 * It deliberately reuses the EXACT live signal logic — the positioning-core
 * builders for ILE/IMPG and the same scanner direction thresholds used by
 * `fetch-signals.ts` for PCR/IV/OI — so there is zero logic drift between
 * what we trade live and what we score.
 *
 * Resolution is intraday: a signal opened on snapshot[i] is walked forward
 * over the captured *spot path* (5-minute snapshots) and closed when spot
 * crosses the stop or target, or force-closed (EXPIRED) at the IST trading-
 * day boundary. No I/O — the async DB reader + scorer live in
 * `option-chain-replay.ts`.
 */

import {
  buildLiquidityEdgeSignal,
  buildMaxPainGravitySignal,
  type PositioningInput,
} from "@/features/india/scalping/strategies/positioning-core";
import type { IndiaBacktestTrade } from "@/features/india/scalping/backtest-core";
import type {
  IndiaScalpDirection,
  IndiaScalpStrategyId,
} from "@/features/india/scalping/types";
import type { OptionChainAnalytics } from "@/types/india/options";

/** The five strategies this engine can replay from option-chain history. */
export const OC_REPLAY_STRATEGY_IDS = [
  "PCR_EXTREME",
  "IV_SPIKE",
  "OI_BUILDUP",
  "LIQUIDITY_EDGE",
  "MAX_PAIN_GRAVITY",
] as const satisfies ReadonlyArray<IndiaScalpStrategyId>;

export type OcReplayStrategyId = (typeof OC_REPLAY_STRATEGY_IDS)[number];

export function isOcReplayStrategy(id: string): id is OcReplayStrategyId {
  return (OC_REPLAY_STRATEGY_IDS as ReadonlyArray<string>).includes(id);
}

/** A single captured snapshot the replay reconstructs a signal from. */
export interface ReplaySnapshot {
  underlying: string;
  spot: number | null;
  changePct: number | null;
  analytics: OptionChainAnalytics;
  capturedAtMs: number;
}

export interface OcReplaySignal {
  direction: IndiaScalpDirection;
  entry: number;
  stopLoss: number;
  target: number;
}

// Mirror the synthetic 0.5% / 1.0% band fetch-signals uses for the scanner
// strategies so replayed scanner trades size identically to the live lane.
const STOP_FRACTION = 0.005;
const TARGET_FRACTION = 0.01;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar-day key — used to force intraday trades flat overnight. */
function istDayKey(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / 86_400_000);
}

function scannerLevels(
  spot: number,
  direction: IndiaScalpDirection,
): OcReplaySignal {
  const isLong = direction === "LONG";
  return {
    direction,
    entry: spot,
    stopLoss: isLong ? spot * (1 - STOP_FRACTION) : spot * (1 + STOP_FRACTION),
    target: isLong ? spot * (1 + TARGET_FRACTION) : spot * (1 - TARGET_FRACTION),
  };
}

function toPositioningInput(snap: ReplaySnapshot): PositioningInput {
  return {
    underlying: snap.underlying,
    symbolName: snap.underlying,
    timeframe: "5m",
    spot: snap.spot ?? 0,
    changePct: snap.changePct,
    prevClose: null,
    analytics: snap.analytics,
    triggeredAt: snap.capturedAtMs,
  };
}

/**
 * Reconstruct an entry signal for `strategyId` from a single captured
 * snapshot, or null when the strategy does not fire on this snapshot.
 */
export function reconstructOcSignal(
  strategyId: OcReplayStrategyId,
  snap: ReplaySnapshot,
): OcReplaySignal | null {
  const spot = snap.spot;
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;
  const a = snap.analytics;

  switch (strategyId) {
    case "PCR_EXTREME": {
      const pcr = a.pcrOi;
      if (pcr == null || !Number.isFinite(pcr)) return null;
      // Contrarian: PCR > 1.3 (excess bearish) → LONG; < 0.7 → SHORT.
      if (pcr > 1.3) return scannerLevels(spot, "LONG");
      if (pcr < 0.7) return scannerLevels(spot, "SHORT");
      return null;
    }
    case "IV_SPIKE": {
      const iv = a.atmIv;
      if (iv == null || !Number.isFinite(iv)) return null;
      // Long-vega when IV is elevated (≥20), short-vega when compressed
      // (<14); the mid-band carries no edge so we stand aside.
      if (iv >= 20) return scannerLevels(spot, "LONG");
      if (iv < 14) return scannerLevels(spot, "SHORT");
      return null;
    }
    case "OI_BUILDUP": {
      const oiNet = (a.totalCeOiChange ?? 0) + (a.totalPeOiChange ?? 0);
      if (oiNet === 0) return null;
      const pct = snap.changePct ?? 0;
      // Smart-money quadrant collapses to the price side: price↑ = long
      // build-up / short covering (LONG); price↓ = short build-up / long
      // unwinding (SHORT). The OI move above just gates that a signal fires.
      return scannerLevels(spot, pct >= 0 ? "LONG" : "SHORT");
    }
    case "LIQUIDITY_EDGE": {
      const sig = buildLiquidityEdgeSignal(toPositioningInput(snap));
      if (!sig) return null;
      return {
        direction: sig.direction,
        entry: sig.entry,
        stopLoss: sig.stopLoss,
        target: sig.target,
      };
    }
    case "MAX_PAIN_GRAVITY": {
      const sig = buildMaxPainGravitySignal(toPositioningInput(snap));
      if (!sig) return null;
      return {
        direction: sig.direction,
        entry: sig.entry,
        stopLoss: sig.stopLoss,
        target: sig.target,
      };
    }
    default:
      return null;
  }
}

interface Position {
  side: IndiaScalpDirection;
  entry: number;
  stop: number;
  target: number;
  openedIdx: number;
  openedAtSec: number;
  dayKey: number;
}

function pnlPercent(entry: number, exit: number, isLong: boolean): number {
  if (entry <= 0) return 0;
  const raw = (exit - entry) / entry;
  return (isLong ? raw : -raw) * 100;
}

/**
 * Replay `strategyId` across one underlying's chronological snapshot series,
 * resolving each opened trade against the forward spot path. One position at
 * a time (mirrors the live single-lane journal). Returns booked trades.
 */
export function replayOptionChainStrategy(
  snaps: ReadonlyArray<ReplaySnapshot>,
  strategyId: OcReplayStrategyId,
): IndiaBacktestTrade[] {
  const trades: IndiaBacktestTrade[] = [];
  if (snaps.length < 2) return trades;

  let pos: Position | null = null;
  let prev: ReplaySnapshot | null = null;

  for (let i = 0; i < snaps.length; i += 1) {
    const snap = snaps[i];
    const spot = snap.spot;
    const valid = spot != null && Number.isFinite(spot) && spot > 0;

    if (pos && valid && spot != null) {
      const isLong = pos.side === "LONG";
      const sameDay = istDayKey(snap.capturedAtMs) === pos.dayKey;

      let exit: number | null = null;
      let reason: IndiaBacktestTrade["reason"] | null = null;

      if (!sameDay) {
        // Force flat overnight at the last same-day spot.
        const last = prev ?? snap;
        exit = last.spot ?? pos.entry;
        reason = "EXPIRED";
      } else if (isLong ? spot <= pos.stop : spot >= pos.stop) {
        exit = pos.stop;
        reason = "STOP";
      } else if (isLong ? spot >= pos.target : spot <= pos.target) {
        exit = pos.target;
        reason = "TARGET";
      } else if (i === snaps.length - 1) {
        exit = spot;
        reason = "EOD";
      }

      if (exit !== null && reason) {
        const closedAtSec = Math.floor(
          (reason === "EXPIRED" ? (prev?.capturedAtMs ?? snap.capturedAtMs) : snap.capturedAtMs) /
            1000,
        );
        trades.push({
          side: pos.side,
          entry: pos.entry,
          exit,
          reason,
          pnlPct: pnlPercent(pos.entry, exit, isLong),
          bars: i - pos.openedIdx,
          openedAtSec: pos.openedAtSec,
          closedAtSec,
        });
        pos = null;
      }
    }

    if (!pos && valid && spot != null) {
      const sig = reconstructOcSignal(strategyId, snap);
      if (sig) {
        const stopDist = Math.abs(sig.entry - sig.stopLoss);
        const targetDist = Math.abs(sig.target - sig.entry);
        if (stopDist > 0 && targetDist > 0) {
          pos = {
            side: sig.direction,
            entry: sig.entry,
            stop: sig.stopLoss,
            target: sig.target,
            openedIdx: i,
            openedAtSec: Math.floor(snap.capturedAtMs / 1000),
            dayKey: istDayKey(snap.capturedAtMs),
          };
        }
      }
    }

    if (valid) prev = snap;
  }

  return trades;
}
