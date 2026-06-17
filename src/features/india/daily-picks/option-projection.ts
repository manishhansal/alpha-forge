/**
 * Project an INDICES_SCALP signal into a tradeable option contract:
 *   - pick the ATM strike (snapped to the index's strike step),
 *   - side = CE for a bullish view, PE for a bearish view (long premium only —
 *     "hero-zero" sized scalps on the right side of the tape),
 *   - entry premium = current LTP from the chain (what you'd actually pay),
 *   - target / stop premium = delta-projected from current spot to the
 *     signal's target / stop underlying levels.
 *
 * This is what the user actually trades — `signal.entry` / `target` /
 * `stopLoss` reference the *index level*, but the desk takes the position in
 * the option. The Daily Picks board surfaces the option-level numbers so the
 * "+0.24%" P&L can't mislead (a 24-bp move on NIFTY is ~+50% on an ATM CE).
 */
import type { AiSignal } from "@/types/ai-signals";
import type {
  OptionChain,
  OptionChainRow,
  OptionLeg,
  OptionType,
} from "@/types/india";

/** Persisted snapshot of the option contract a pick is expressed in. */
export interface OptionContract {
  /** Chosen strike (snapped to the index's strike step). */
  strike: number;
  /** CE for bullish underlying view, PE for bearish. */
  side: OptionType;
  /** Expiry exactly as the chain reports it. */
  expiry: string;
  /** Display contract symbol — e.g. "NIFTY 24100 CE 26JUN26". */
  contractSymbol: string;
  /** Lot size for sizing display (75 for NIFTY, 30 for BANKNIFTY, ...). */
  lotSize: number;
  /** Underlying spot at projection time — used to re-price on each refresh. */
  spotAtFreeze: number;
  /** Magnitude of the delta used in the projection. */
  delta: number;
  /** IV reported by the chain at projection time (annualised %), if any. */
  ivPct: number | null;
}

export interface OptionProjection {
  contract: OptionContract;
  entryPremium: number;
  targetPremium: number;
  stopPremium: number;
  /** TP3-equivalent ("can move upto") premium. */
  stretchPremium: number;
  /** Resulting R:R on *premium* terms (not the underlying's R:R). */
  riskReward: number;
}

/** NSE F&O index lot sizes (as of the 2026 expiry cycles). */
export const INDEX_LOT_SIZE: Readonly<Record<string, number>> = Object.freeze({
  NIFTY: 75,
  BANKNIFTY: 30,
  FINNIFTY: 65,
  MIDCPNIFTY: 120,
});

/** Strike step for ATM rounding — matches NSE conventions. */
export const INDEX_STRIKE_STEP: Readonly<Record<string, number>> = Object.freeze({
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  MIDCPNIFTY: 25,
});

/** Floor for any projected premium — Indian options can't trade below ₹0.05. */
const MIN_PREMIUM = 0.05;

/**
 * ATM delta fallback. Black-Scholes ATM call delta ≈ 0.5, put ≈ -0.5 (we
 * always use the *magnitude*). Used only when the broker doesn't ship live
 * greeks for the chosen strike.
 */
const DEFAULT_DELTA = 0.5;

/** Clamp delta into a sane range so projection can't blow up. */
function clampDelta(d: number): number {
  if (!Number.isFinite(d) || d <= 0) return DEFAULT_DELTA;
  return Math.min(0.95, Math.max(0.2, d));
}

/** Round a spot price to the nearest ATM strike using the index's step. */
function roundToStrike(spot: number, step: number): number {
  return Math.round(spot / step) * step;
}

/** Pick the chain row whose strike is closest to the target strike. */
function rowAtStrike(
  rows: readonly OptionChainRow[],
  target: number,
): OptionChainRow | null {
  if (rows.length === 0) return null;
  let best: { row: OptionChainRow; d: number } | null = null;
  for (const r of rows) {
    const d = Math.abs(r.strike - target);
    if (!best || d < best.d) best = { row: r, d };
  }
  return best?.row ?? null;
}

function leg(row: OptionChainRow, side: OptionType): OptionLeg | null {
  return side === "CE" ? row.ce : row.pe;
}

/** Best-effort current premium — LTP, then mid of bid/ask, then either. */
function currentPremium(legPx: OptionLeg): number | null {
  if (legPx.ltp != null && Number.isFinite(legPx.ltp) && legPx.ltp > 0)
    return legPx.ltp;
  const { bid, ask } = legPx;
  if (
    bid != null &&
    ask != null &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0
  ) {
    return (bid + ask) / 2;
  }
  if (bid != null && Number.isFinite(bid) && bid > 0) return bid;
  if (ask != null && Number.isFinite(ask) && ask > 0) return ask;
  return null;
}

/**
 * Build a `{ entry, target, stop }` projection in option premiums for an
 * INDICES_SCALP signal. Returns null when the chain is too thin (no ATM row,
 * dead leg, no quotable premium) — the caller should then drop the pick
 * rather than ship a nonsense premium.
 */
/**
 * Maximum tolerated drift between the chain's reported spot and the signal's
 * underlying price. Real intraday drift is < 1%; anything larger means the
 * two feeds disagree on which instrument they're quoting (the MIDCPNIFTY
 * ticker-mapping bug from 2026-06-17 surfaced at ~17% drift). Drop the pick
 * rather than ship a projection built on disagreeing references.
 */
const MAX_SPOT_DRIFT = 0.05;

export function projectIndexScalpToOption(
  signal: AiSignal,
  chain: OptionChain,
  underlyingSymbol: string,
): OptionProjection | null {
  // Prefer the AI signal's live underlying price (Yahoo quote) for ATM strike
  // selection — it's always fresh. `chain.spot` is a snapshot from the option
  // chain feed and can lag or, in pathological cases (the MIDCPNIFTY
  // ticker-mapping bug from 2026-06-17), point at the wrong instrument entirely.
  const signalSpot =
    Number.isFinite(signal.underlyingPrice) && signal.underlyingPrice > 0
      ? signal.underlyingPrice
      : null;
  const chainSpot =
    chain.spot != null && Number.isFinite(chain.spot) && chain.spot > 0
      ? chain.spot
      : null;
  const spot = signalSpot ?? chainSpot;
  if (spot == null) return null;

  // Drift sanity gate: if both spots are present but disagree wildly, the
  // chain almost certainly belongs to a different instrument (delayed cache,
  // wrong ticker mapping). Drop the pick rather than ship a projection built
  // on disagreeing references.
  if (
    signalSpot != null &&
    chainSpot != null &&
    Math.abs(chainSpot - signalSpot) / signalSpot > MAX_SPOT_DRIFT
  ) {
    return null;
  }

  const side: OptionType = signal.direction === "BEARISH" ? "PE" : "CE";
  const step = INDEX_STRIKE_STEP[underlyingSymbol] ?? 50;
  const desiredStrike = roundToStrike(spot, step);
  const atmRow = rowAtStrike(chain.rows, desiredStrike);
  if (!atmRow) return null;
  const optLeg = leg(atmRow, side);
  if (!optLeg) return null;
  const entry = currentPremium(optLeg);
  if (entry == null) return null;

  const delta = clampDelta(
    optLeg.delta != null && Number.isFinite(optLeg.delta)
      ? Math.abs(optLeg.delta)
      : DEFAULT_DELTA,
  );
  // CE rises as underlying rises, PE rises as underlying falls — encoded as a
  // sign on the underlying move so the projection arithmetic stays linear.
  const sideSign = side === "CE" ? 1 : -1;
  const project = (newUnderlying: number): number => {
    const underlyingMove = (newUnderlying - spot) * sideSign;
    return Math.max(MIN_PREMIUM, entry + delta * underlyingMove);
  };

  const targetUnderlying = signal.takeProfits[0]?.price ?? signal.entry;
  const stretchUnderlying =
    signal.takeProfits.at(-1)?.price ?? targetUnderlying;
  const targetPremium = project(targetUnderlying);
  const stopPremium = project(signal.stopLoss);
  const stretchPremium = project(stretchUnderlying);

  const risk = entry - stopPremium;
  const reward = targetPremium - entry;
  // Fall back to the signal's underlying R:R when stop is at-or-below the
  // premium floor (extreme tail case) so the card still shows something
  // meaningful.
  const riskReward =
    risk > 0 && reward > 0 ? reward / risk : signal.riskReward;

  const lotSize = INDEX_LOT_SIZE[underlyingSymbol] ?? 1;
  const contractSymbol = `${underlyingSymbol} ${atmRow.strike} ${side}`;

  return {
    contract: {
      strike: atmRow.strike,
      side,
      expiry: chain.expiry,
      contractSymbol,
      lotSize,
      spotAtFreeze: spot,
      delta,
      ivPct: optLeg.iv ?? null,
    },
    entryPremium: entry,
    targetPremium,
    stopPremium,
    stretchPremium,
    riskReward,
  };
}

/**
 * Live premium for a stored option contract — re-priced from the latest
 * chain. Used by the live tracker to update `lastPrice` on each refresh.
 * Returns null when the chain doesn't currently quote that strike/side.
 */
export function livePremiumForContract(
  contract: OptionContract,
  chain: OptionChain | null,
): number | null {
  if (!chain) return null;
  const row = rowAtStrike(chain.rows, contract.strike);
  if (!row) return null;
  const legPx = leg(row, contract.side);
  if (!legPx) return null;
  return currentPremium(legPx);
}
