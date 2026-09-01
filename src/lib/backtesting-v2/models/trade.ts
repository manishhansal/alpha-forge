/**
 * Trade model — the immutable record of a completed round-trip (open + close).
 *
 * A Trade is constructed from a closed Position and is the primary input to
 * the analytics layer. It is the only model that the performance / attribution
 * engines consume — they never need to look at raw fills or orders.
 *
 * All monetary values in INR. Duration in bars and milliseconds.
 */

import type { InstrumentId } from "../events/market-event";
import type { SignalDirection } from "../events/signal-event";
import type { Position, CloseReason } from "./position";

export interface Trade {
  readonly id: string;         // same as Position.id
  readonly positionId: string;
  readonly instrument: InstrumentId;
  readonly direction: SignalDirection;

  // ── Entry / exit economics ──────────────────────────────────────────────
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly qty: number;
  /** INR gross P&L before commission. */
  readonly grossPnl: number;
  /** Total commission paid (both legs). */
  readonly commission: number;
  /** Net P&L = grossPnl − commission. */
  readonly netPnl: number;
  /** Net P&L as a fraction of entry notional. */
  readonly pnlPct: number;
  readonly closeReason: CloseReason;

  // ── Timing ──────────────────────────────────────────────────────────────
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly openBarIndex: number;
  readonly closeBarIndex: number;
  /** Duration in bars held. */
  readonly barsHeld: number;
  /** Duration in milliseconds. */
  readonly durationMs: number;

  // ── Attribution (always populated from PositionAttribution) ─────────────
  readonly strategyId: string;
  readonly signalId: string;
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly marketRegime: string;
  readonly dataQualityScore: number;

  // ── Risk context ────────────────────────────────────────────────────────
  readonly stopLoss: number;
  readonly target: number;
  /** Planned reward/risk at entry. */
  readonly plannedRR: number;
  /** Actual reward/risk achieved. */
  readonly actualRR: number;
  /** Initial ATR at entry (stored for regime analysis). */
  readonly entryAtr: number | null;

  // ── MAE / MFE — set by engine if tracking is enabled ────────────────────
  /** Maximum Adverse Excursion (INR) — worst intra-trade drawdown. */
  readonly mae: number | null;
  /** Maximum Favourable Excursion (INR) — best intra-trade peak. */
  readonly mfe: number | null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Build a Trade from a closed Position.
 * `entryAtr` / `mae` / `mfe` are optional — pass null when not tracked.
 */
export function buildTrade(
  pos: Position,
  opts: { entryAtr?: number | null; mae?: number | null; mfe?: number | null } = {},
): Trade {
  if (pos.status !== "CLOSED" || pos.closedAtMs === null || pos.closeBarIndex === null) {
    throw new Error(`Cannot build Trade from non-closed position ${pos.id}`);
  }
  const lotSize = pos.instrument.lotSize;
  const dir = pos.direction === "LONG" ? 1 : -1;
  const closeFill = pos.fills[pos.fills.length - 1];
  if (!closeFill) throw new Error(`Position ${pos.id} has no fills`);

  const exitPrice = closeFill.fillPrice;
  const grossPnl = dir * (exitPrice - pos.avgEntryPrice) * pos.qty * lotSize;
  const netPnl = grossPnl - pos.totalCommission;
  const entryNotional = pos.avgEntryPrice * pos.qty * lotSize;
  const pnlPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;

  const riskDist = Math.abs(pos.stopLoss - pos.avgEntryPrice);
  const rewardDist = Math.abs(pos.target - pos.avgEntryPrice);
  const plannedRR = riskDist > 0 ? rewardDist / riskDist : 0;
  const exitDist = Math.abs(exitPrice - pos.avgEntryPrice);
  const actualRR = riskDist > 0 ? (dir * (exitPrice - pos.avgEntryPrice)) / riskDist : 0;

  return {
    id: pos.id,
    positionId: pos.id,
    instrument: pos.instrument,
    direction: pos.direction,
    entryPrice: pos.avgEntryPrice,
    exitPrice,
    qty: pos.qty,
    grossPnl,
    commission: pos.totalCommission,
    netPnl,
    pnlPct,
    closeReason: pos.closeReason!,
    openedAtMs: pos.openedAtMs,
    closedAtMs: pos.closedAtMs,
    openBarIndex: pos.openBarIndex,
    closeBarIndex: pos.closeBarIndex,
    barsHeld: pos.closeBarIndex - pos.openBarIndex,
    durationMs: pos.closedAtMs - pos.openedAtMs,
    strategyId: pos.attribution.strategyId,
    signalId: pos.attribution.signalId,
    modelVersion: pos.attribution.modelVersion,
    featureVersion: pos.attribution.featureVersion,
    marketRegime: pos.attribution.marketRegime,
    dataQualityScore: pos.attribution.dataQualityScore,
    stopLoss: pos.stopLoss,
    target: pos.target,
    plannedRR,
    actualRR,
    entryAtr: opts.entryAtr ?? null,
    mae: opts.mae ?? null,
    mfe: opts.mfe ?? null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isWin(trade: Trade): boolean {
  return trade.netPnl > 0;
}

export function isLoss(trade: Trade): boolean {
  return trade.netPnl < 0;
}

export function isBreakEven(trade: Trade): boolean {
  return trade.netPnl === 0;
}
