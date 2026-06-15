/**
 * Expiry-day index trades — pure engine.
 *
 * On NSE/BSE weekly expiry the nearest-strike options carry enormous gamma and
 * decay to (near) zero by 15:30. Two desk playbooks dominate that session and
 * this engine encodes both — deterministically, with no I/O:
 *
 *   - GAMMA BLAST — buy the ATM (or just-ITM) option in the direction of the
 *     intraday trend. With one expiry session of theta left, a clean directional
 *     push makes the ATM premium expand violently (high gamma). Defined risk
 *     (~half the premium), 2–3× target.
 *
 *   - HERO ZERO — buy a cheap, far-OTM option late in the session. It is a
 *     binary: a sharp move turns ₹5 into ₹40 (hero), otherwise it expires
 *     worthless (zero). Sized tiny; the whole premium is the risk.
 *
 * These only make sense on the actual expiry day, so the builder gates the
 * whole section on `isExpiryDay`. The engine just turns a resolved per-index
 * read (spot, bias, premiums) into concrete, labelled trade cards.
 *
 * Pure — no Date.now(), no fetch. Caller passes everything in.
 */

export type ExpiryIndex = "NIFTY" | "SENSEX";

export type ExpiryTradeKind = "GAMMA_BLAST" | "HERO_ZERO";

export type ExpiryOptionType = "CE" | "PE";

export interface ExpiryTrade {
  kind: ExpiryTradeKind;
  label: string;
  index: ExpiryIndex;
  optionType: ExpiryOptionType;
  /** Option strike (index points). */
  strike: number;
  /** Suggested entry premium per lot-unit (₹ per share/contract unit). */
  entryPremium: number;
  /** Target premium (take profit). */
  target: number;
  /** Stop-loss premium. Hero-Zero stops at 0 (worthless). */
  stopLoss: number;
  /** Target as a multiple of entry premium (e.g. 2.2 = +120%). */
  targetMultiple: number;
  /** Underlying spot at selection time. */
  spot: number;
  /** Why this trade — human readable. */
  rationale: string;
  /** Risk note — every expiry option trade is high risk. */
  riskNote: string;
}

export interface ExpiryIndexBlock {
  index: ExpiryIndex;
  spot: number;
  /** Expiry label (DD-MMM-YYYY for NSE chains; ISO date otherwise). */
  expiry: string;
  /** Directional read in [-1, 1] used to pick CE vs PE. */
  bias: number;
  /** "chain" when premiums came from a live option chain; "estimated" otherwise. */
  dataSource: "chain" | "estimated";
  trades: ExpiryTrade[];
  note: string;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_PER_YEAR = 24 * 365;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Round a number to a clean rupee value for premiums. */
function roundPremium(p: number): number {
  if (p >= 100) return Math.round(p);
  if (p >= 10) return Math.round(p * 2) / 2; // 0.5 steps
  return Math.round(p * 20) / 20; // 0.05 steps
}

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/**
 * Parse an NSE expiry string (DD-MMM-YYYY, e.g. "16-JUN-2026") into a
 * `YYYY-MM-DD` key. Returns null on anything it can't parse (so the caller
 * falls back to a weekday rule rather than mis-firing).
 */
export function parseExpiryToDateKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const parts = s.trim().toUpperCase().split("-");
  if (parts.length !== 3) return null;
  const [d, mon, y] = parts;
  const m = MONTHS.indexOf(mon);
  const day = Number(d);
  const year = Number(y);
  if (m < 0 || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return `${year}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** True when the option-chain expiry resolves to today's IST trade date. */
export function isExpiryDayFromChain(
  expiry: string | null | undefined,
  tradeDate: string,
): boolean {
  return parseExpiryToDateKey(expiry) === tradeDate;
}

/** IST weekday (0=Sun … 6=Sat) for a wall-clock instant. */
export function istWeekday(at: Date): number {
  const ist = new Date(at.getTime() + 5.5 * MS_PER_HOUR);
  return ist.getUTCDay();
}

/**
 * ATM single-leg premium estimate via the standard near-the-money Black-Scholes
 * approximation: `P ≈ 0.4 · S · σ · √T`. Used when no live chain LTP is
 * available (e.g. SENSEX, or NSE rate-limited). `ivPct` is annualised IV in
 * percent; `hoursToExpiry` is the time left in the session.
 */
export function estimateAtmPremium(
  spot: number,
  ivPct: number | null,
  hoursToExpiry: number,
): number {
  if (!Number.isFinite(spot) || spot <= 0) return 0;
  const sigma = clamp((ivPct ?? 14) / 100, 0.05, 1.5);
  const t = Math.max(hoursToExpiry, 0.25) / HOURS_PER_YEAR;
  return 0.4 * spot * sigma * Math.sqrt(t);
}

/** Nearest ATM strike for a step grid (50 NIFTY, 100 SENSEX). */
export function atmStrike(spot: number, step: number): number {
  return Math.round(spot / step) * step;
}

/** OTM strike `stepsOut` grid-steps away from ATM, in the option's direction. */
export function otmStrike(
  spot: number,
  step: number,
  type: ExpiryOptionType,
  stepsOut: number,
): number {
  const atm = atmStrike(spot, step);
  return type === "CE" ? atm + stepsOut * step : atm - stepsOut * step;
}

/** Pick CE (bullish) or PE (bearish) from the directional bias. */
export function optionTypeFromBias(bias: number): ExpiryOptionType {
  return bias >= 0 ? "CE" : "PE";
}

export interface BuildExpiryTradesArgs {
  index: ExpiryIndex;
  spot: number;
  /** Directional read in [-1, 1]. */
  bias: number;
  /** Strike grid step. */
  step: number;
  /** ATM IV in percent (for premium estimation / target sizing). */
  ivPct: number | null;
  /** Hours left to the 15:30 expiry settlement. */
  hoursToExpiry: number;
  expiry: string;
  dataSource: "chain" | "estimated";
  /**
   * Optional live-chain premium lookup (₹ LTP) for a given strike + type.
   * Returns null when the strike/leg is missing or untraded — the engine then
   * falls back to the BS estimate. Lets NIFTY use real LTPs while SENSEX uses
   * estimates, through one code path.
   */
  premiumAt?: (strike: number, type: ExpiryOptionType) => number | null;
}

const STRONG_RISK =
  "Expiry option-buying — premium can go to zero by 15:30. Size tiny, hard-stop, no averaging.";

/**
 * Build both expiry plays (Gamma Blast + Hero Zero) for one index, picking the
 * side from `bias` and pulling premiums from the live chain when available.
 */
export function buildIndexExpiryTrades(args: BuildExpiryTradesArgs): ExpiryTrade[] {
  const { index, spot, bias, step, ivPct, hoursToExpiry, premiumAt } = args;
  if (!Number.isFinite(spot) || spot <= 0) return [];

  const type = optionTypeFromBias(bias);
  const estAtm = estimateAtmPremium(spot, ivPct, hoursToExpiry);

  const resolve = (strike: number, fallback: number): number => {
    const live = premiumAt?.(strike, type) ?? null;
    const p = live != null && live > 0 ? live : fallback;
    return roundPremium(Math.max(p, 0.05));
  };

  // --- Gamma Blast: ATM, ride the trend, 2.2× target / 50% stop. -----------
  const gbStrike = atmStrike(spot, step);
  const gbPremium = resolve(gbStrike, estAtm);
  const gbMult = 2.2;
  const gammaBlast: ExpiryTrade = {
    kind: "GAMMA_BLAST",
    label: "Gamma Blast",
    index,
    optionType: type,
    strike: gbStrike,
    entryPremium: gbPremium,
    target: roundPremium(gbPremium * gbMult),
    stopLoss: roundPremium(gbPremium * 0.5),
    targetMultiple: gbMult,
    spot,
    rationale: `ATM ${gbStrike} ${type} — expiry gamma is maximal at-the-money, so a clean ${
      bias >= 0 ? "up" : "down"
    }-move makes the premium expand fast. Enter on momentum confirmation, trail hard.`,
    riskNote: STRONG_RISK,
  };

  // --- Hero Zero: far-OTM lottery, ~5× target / stop at zero. ---------------
  // 3 steps OTM for NIFTY (150 pts), scaled by step so SENSEX uses 300 pts.
  const hzStepsOut = 3;
  const hzStrike = otmStrike(spot, step, type, hzStepsOut);
  // OTM premium ≈ a small fraction of ATM (decays sharply with distance).
  const hzPremium = resolve(hzStrike, Math.max(0.5, estAtm * 0.18));
  const hzMult = 5;
  const heroZero: ExpiryTrade = {
    kind: "HERO_ZERO",
    label: "Hero / Zero",
    index,
    optionType: type,
    strike: hzStrike,
    entryPremium: hzPremium,
    target: roundPremium(hzPremium * hzMult),
    stopLoss: 0,
    targetMultiple: hzMult,
    spot,
    rationale: `Far-OTM ${hzStrike} ${type} — a cheap lottery on a sharp expiry-day ${
      bias >= 0 ? "rally" : "sell-off"
    }. Either it multiplies into a hero or expires at zero. Risk only what you can lose in full.`,
    riskNote: STRONG_RISK,
  };

  return [gammaBlast, heroZero];
}
