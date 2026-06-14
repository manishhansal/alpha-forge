/**
 * Pure signal builders for the two option-positioning F&O strategies
 * ported from the *India Liquidity Edge — Quant Framework* Pine
 * indicator:
 *
 *   - `LIQUIDITY_EDGE`   (India Liquidity Edge)  — broad confluence score
 *   - `MAX_PAIN_GRAVITY` (India Max-Pain Gravity) — max-pain fade
 *
 * This module is deliberately I/O-free (no `server-only`, no service
 * imports) so the scoring logic is unit-testable with fixed inputs. The
 * async orchestrator that fetches live NSE option chains + index quotes
 * and calls these builders lives in `positioning.ts`.
 *
 * Both engines operate on F&O *indices* (NIFTY / BANKNIFTY / FINNIFTY /
 * MIDCPNIFTY) because the option-chain analytics they rely on (CE/PE
 * walls, max pain, PCR, OI build-up) are index-based — matching the
 * Nifty / BankNifty focus of the original Pine indicator.
 */

import type {
  IndiaScalpSignal,
  IndiaScalpTimeframe,
} from "@/features/india/scalping/types";
import type { OptionChainAnalytics } from "@/types/india/options";

export interface PositioningInput {
  /** NSE underlying without the `.NS` suffix (e.g. "NIFTY"). */
  underlying: string;
  /** Pretty display name (e.g. "NIFTY 50"). Falls back to `underlying`. */
  symbolName?: string;
  timeframe: IndiaScalpTimeframe;
  /** Underlying spot (₹). */
  spot: number;
  /** Intraday % change — used as a proxy for "price vs previous close". */
  changePct: number | null;
  prevClose: number | null;
  analytics: OptionChainAnalytics;
  /** Wall-clock ms the signal fired on. */
  triggeredAt: number;
}

/** ATR-proxy risk band (0.5% of spot) shared by both engines until the
 *  real ATR-sized F&O paper-trader lands. */
const STOP_FRACTION = 0.005;
/** Liquidity Edge mirrors the Pine 0.25× ATR stop / 2.5× RR target. */
const ILE_RR = 2.5;
/** Net confluence (bull − bear) required before ILE fires. */
const ILE_MIN_NET = 2;
const ILE_MAX_FACTORS = 5;
/** Max-pain drift (as % of spot) below which price is "pinned" — no edge. */
const GRAVITY_BUFFER_PCT = 0.4;
/** How close (fraction of spot) a strike must be to count as "at" a wall. */
const WALL_PROXIMITY_FRACTION = 0.005;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function nearStrike(spot: number, strike: number | null): boolean {
  if (strike == null || !Number.isFinite(strike) || strike <= 0) return false;
  return Math.abs(spot - strike) / spot <= WALL_PROXIMITY_FRACTION;
}

/**
 * India Max-Pain Gravity (IMPG) — fade price back toward the max-pain
 * strike when spot has drifted beyond the pull buffer. Returns null when
 * max pain is unknown or price is pinned inside the buffer (no edge).
 */
export function buildMaxPainGravitySignal(
  input: PositioningInput,
): IndiaScalpSignal | null {
  const { spot, analytics } = input;
  const maxPain = analytics.maxPain;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  if (maxPain == null || !Number.isFinite(maxPain) || maxPain <= 0) return null;

  const driftPct = ((spot - maxPain) / spot) * 100;
  if (Math.abs(driftPct) < GRAVITY_BUFFER_PCT) return null;

  const isShort = spot > maxPain; // above pain → gravity pulls down
  const direction = isShort ? "SHORT" : "LONG";

  const entry = spot;
  const risk = entry * STOP_FRACTION;
  const stopLoss = isShort ? entry + risk : entry - risk;
  const target = maxPain;
  const reward = Math.abs(entry - target);
  const riskReward = risk > 0 ? reward / risk : 0;

  // Confluence boosts: a confirming OI wall in the fade direction and an
  // aligned PCR skew raise confidence above the drift-only base.
  const confirmingWall = isShort
    ? nearStrike(spot, analytics.maxCeOiStrike)
    : nearStrike(spot, analytics.maxPeOiStrike);
  const pcr = analytics.pcrOi;
  const pcrAligned =
    pcr != null &&
    ((isShort && pcr < 0.85) || (!isShort && pcr > 1.2));

  const base = clamp01(Math.abs(driftPct) / 2.0);
  const confidence = clamp01(
    base + (confirmingWall ? 0.15 : 0) + (pcrAligned ? 0.1 : 0),
  );

  const rationale: string[] = [
    "Max-Pain Gravity — dealers pin spot to max pain into the close",
    `Spot ${spot.toFixed(0)} is ${Math.abs(driftPct).toFixed(2)}% ${
      isShort ? "above" : "below"
    } max pain ${maxPain.toFixed(0)} → fade ${isShort ? "down" : "up"}`,
  ];
  if (confirmingWall) {
    rationale.push(
      isShort
        ? `Confirmed by CE wall @ ${analytics.maxCeOiStrike} (resistance ceiling)`
        : `Confirmed by PE floor @ ${analytics.maxPeOiStrike} (support floor)`,
    );
  }
  if (pcrAligned && pcr != null) {
    rationale.push(`PCR ${pcr.toFixed(2)} agrees with the fade`);
  }

  return {
    strategyId: "MAX_PAIN_GRAVITY",
    symbol: input.underlying,
    symbolName: input.symbolName ?? input.underlying,
    timeframe: input.timeframe,
    direction,
    price: spot,
    reference: maxPain,
    atr: entry * STOP_FRACTION,
    confirmed: true,
    entry,
    stopLoss,
    target,
    riskReward,
    confidence,
    rationale,
    triggeredAt: input.triggeredAt,
    extras: {
      maxPain,
      driftPct: Number(driftPct.toFixed(3)),
      pcrOi: analytics.pcrOi ?? null,
      ceWall: analytics.maxCeOiStrike ?? null,
      peFloor: analytics.maxPeOiStrike ?? null,
      kind: isShort ? "PIN_FADE_DOWN" : "PIN_FADE_UP",
    },
  };
}

/**
 * India Liquidity Edge (ILE) — broad option-chain confluence score. Sums
 * up to five bull / bear factors (PCR side, max-pain side, OI-wall
 * proximity, ΔPE−ΔCE OI build-up, intraday trend) and fires when the net
 * edge clears the confluence threshold. Returns null otherwise.
 */
export function buildLiquidityEdgeSignal(
  input: PositioningInput,
): IndiaScalpSignal | null {
  const { spot, analytics: a, changePct } = input;
  if (!Number.isFinite(spot) || spot <= 0) return null;

  let bull = 0;
  let bear = 0;
  const reasons: string[] = [];

  // 1 — PCR side (Pine thresholds: >1.2 bullish PE writing, <0.85 bearish).
  if (a.pcrOi != null) {
    if (a.pcrOi > 1.2) {
      bull += 1;
      reasons.push(`PCR ${a.pcrOi.toFixed(2)} > 1.2 (heavy PE writing)`);
    } else if (a.pcrOi < 0.85) {
      bear += 1;
      reasons.push(`PCR ${a.pcrOi.toFixed(2)} < 0.85 (heavy CE writing)`);
    }
  }

  // 2 — Max-pain side (pain above spot pulls price up, and vice-versa).
  if (a.maxPain != null && a.maxPain > 0) {
    if (a.maxPain > spot) {
      bull += 1;
      reasons.push(`Max pain ${a.maxPain.toFixed(0)} above spot`);
    } else if (a.maxPain < spot) {
      bear += 1;
      reasons.push(`Max pain ${a.maxPain.toFixed(0)} below spot`);
    }
  }

  // 3 — OI-wall proximity (at the PE floor = support, at the CE wall = resistance).
  if (nearStrike(spot, a.maxPeOiStrike)) {
    bull += 1;
    reasons.push(`At PE floor @ ${a.maxPeOiStrike} (support)`);
  }
  if (nearStrike(spot, a.maxCeOiStrike)) {
    bear += 1;
    reasons.push(`At CE wall @ ${a.maxCeOiStrike} (resistance)`);
  }

  // 4 — OI build-up skew (ΔPE − ΔCE).
  const oiSkew = (a.totalPeOiChange ?? 0) - (a.totalCeOiChange ?? 0);
  if (oiSkew > 0) {
    bull += 1;
    reasons.push("ΔPE OI > ΔCE OI (bullish positioning)");
  } else if (oiSkew < 0) {
    bear += 1;
    reasons.push("ΔCE OI > ΔPE OI (bearish positioning)");
  }

  // 5 — Intraday trend vs the previous close.
  if (changePct != null) {
    if (changePct > 0) {
      bull += 1;
      reasons.push(`Up ${changePct.toFixed(2)}% vs prev close`);
    } else if (changePct < 0) {
      bear += 1;
      reasons.push(`Down ${Math.abs(changePct).toFixed(2)}% vs prev close`);
    }
  }

  const net = bull - bear;
  if (Math.abs(net) < ILE_MIN_NET) return null;

  const isLong = net > 0;
  const direction = isLong ? "LONG" : "SHORT";
  const score = Math.max(bull, bear);

  const entry = spot;
  const risk = entry * STOP_FRACTION;
  const stopLoss = isLong ? entry - risk : entry + risk;
  const target = isLong ? entry + ILE_RR * risk : entry - ILE_RR * risk;

  return {
    strategyId: "LIQUIDITY_EDGE",
    symbol: input.underlying,
    symbolName: input.symbolName ?? input.underlying,
    timeframe: input.timeframe,
    direction,
    price: spot,
    reference: a.maxPain ?? spot,
    atr: entry * STOP_FRACTION,
    confirmed: true,
    entry,
    stopLoss,
    target,
    riskReward: ILE_RR,
    confidence: clamp01(score / ILE_MAX_FACTORS),
    rationale: [
      "India Liquidity Edge confluence",
      `Score ${score}/${ILE_MAX_FACTORS} (bull ${bull} / bear ${bear})`,
      ...reasons,
    ],
    triggeredAt: input.triggeredAt,
    extras: {
      bullScore: bull,
      bearScore: bear,
      net,
      pcrOi: a.pcrOi ?? null,
      maxPain: a.maxPain ?? null,
      kind: isLong ? "ILE_BULL" : "ILE_BEAR",
    },
  };
}
