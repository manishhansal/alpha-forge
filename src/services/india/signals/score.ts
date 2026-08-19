/**
 * Quant-grade "trend health" score for NSE F&O stocks.
 *
 * Upgraded from a 4-factor linear model to an 8-factor weighted model that
 * mirrors how a desk actually reads a chart:
 *
 *   1. SMA-50 proximity   (15 pts) — medium-term trend anchor
 *   2. SMA-200 proximity  (15 pts) — primary trend direction
 *   3. Intraday change    (20 pts) — today's tape read
 *   4. Analyst target     (15 pts) — fundamental upside
 *   5. RSI(14)            (10 pts) — momentum / overbought-oversold
 *   6. ADX(14)            ( 8 pts) — trend conviction gate
 *   7. Volume thrust       ( 9 pts) — institutional participation
 *   8. Delivery %          ( 8 pts) — delivery-vs-trading quality filter
 *
 * Total available: 100 pts (clamped to [-100, 100]).
 *
 * Stocks that pass the quant gate (ADX ≥ 20, volume ≥ 1.2×, delivery ≥ 40%)
 * get a small score multiplier to reward predictable setups.
 */

export type ScoreInputs = {
  price: number | null;
  sma50: number | null;
  sma200: number | null;
  changePct: number | null;
  /** Analyst mean target price (Yahoo `targetMeanPrice`). May be null/stale. */
  targetMean: number | null;
  /** RSI(14) — 0..100. Null when history is too short. */
  rsi14?: number | null;
  /** ADX(14) — ≥ 25 = strong trend, < 20 = ranging. Null when unavailable. */
  adx14?: number | null;
  /**
   * Today's volume relative to the 20-day average (1.0 = average, 2.0 = 2×).
   * Null when the average is unavailable.
   */
  relativeVolume?: number | null;
  /**
   * NSE delivery % (delivery shares / total traded volume × 100).
   * High delivery (≥ 50%) signals conviction; low delivery (< 30%) flags
   * speculative/leveraged activity. Null when unavailable.
   */
  deliveryPct?: number | null;
};

export type SignalLabel =
  | "STRONG BUY"
  | "BUY"
  | "HOLD"
  | "SELL"
  | "STRONG SELL"
  | "N/A";

// ─── Quant gate thresholds ────────────────────────────────────────────────────
/** Minimum ADX for a directional trade to be considered "trending". */
export const QUANT_ADX_MIN = 20;
/** Volume must be at or above this multiple of the 20-day average. */
export const QUANT_VOLUME_MIN = 1.2;
/** NSE delivery % floor for institutional-quality activity. */
export const QUANT_DELIVERY_MIN = 40;

// ─── Score band widths (for tanh normalisation) ───────────────────────────────
const SMA50_BAND = 0.05;
const SMA200_BAND = 0.1;
const TARGET_BAND = 0.1;

function tanhWeight(dist: number, band: number): number {
  if (!Number.isFinite(dist) || !Number.isFinite(band) || band <= 0) return 0;
  return Math.tanh(dist / band);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * True when a stock passes the quantitative liquidity + trend-conviction gate.
 * Stocks that pass get a mild confidence multiplier downstream; those that
 * fail are still scored but flagged as lower-predictability.
 */
export function passesQuantGate(inputs: ScoreInputs): boolean {
  const adxOk = inputs.adx14 == null || inputs.adx14 >= QUANT_ADX_MIN;
  const volOk =
    inputs.relativeVolume == null || inputs.relativeVolume >= QUANT_VOLUME_MIN;
  const delOk =
    inputs.deliveryPct == null || inputs.deliveryPct >= QUANT_DELIVERY_MIN;
  return adxOk && volOk && delOk;
}

export function computeScore(inputs: ScoreInputs): number {
  let score = 0;

  // ── 1. SMA-50 proximity (15 pts) ─────────────────────────────────────────
  if (inputs.price != null && inputs.sma50 != null && inputs.sma50 > 0) {
    const dist = (inputs.price - inputs.sma50) / inputs.sma50;
    score += 15 * tanhWeight(dist, SMA50_BAND);
  }

  // ── 2. SMA-200 proximity (15 pts) ────────────────────────────────────────
  if (inputs.price != null && inputs.sma200 != null && inputs.sma200 > 0) {
    const dist = (inputs.price - inputs.sma200) / inputs.sma200;
    score += 15 * tanhWeight(dist, SMA200_BAND);
  }

  // ── 3. Intraday change (20 pts) ───────────────────────────────────────────
  if (inputs.changePct != null) {
    const dir = Math.sign(inputs.changePct);
    const mag = Math.min(Math.abs(inputs.changePct) / 3, 1);
    score += dir * 20 * mag;
  }

  // ── 4. Analyst target upside (15 pts) ─────────────────────────────────────
  if (
    inputs.price != null &&
    inputs.targetMean != null &&
    inputs.targetMean > 0
  ) {
    const tgtDist = inputs.targetMean / inputs.price - 1;
    score += 15 * tanhWeight(tgtDist, TARGET_BAND);
  }

  // ── 5. RSI(14) momentum factor (10 pts) ───────────────────────────────────
  // RSI between 55–70 on a LONG is ideal (trending up, not overbought).
  // RSI above 70 gives partial credit (strong momentum, fade-risk caveat).
  // RSI below 30 gives negative credit (oversold in a trending setup = weak).
  if (inputs.rsi14 != null && Number.isFinite(inputs.rsi14)) {
    const rsi = inputs.rsi14;
    let rsiScore = 0;
    if (rsi >= 55 && rsi <= 70) {
      rsiScore = 1.0;
    } else if (rsi > 70) {
      // Overbought — mild negative (overbought can persist but fade risk is real)
      rsiScore = clamp((100 - rsi) / 30 - 0.5, -0.8, 0.3);
    } else if (rsi >= 45 && rsi < 55) {
      rsiScore = 0.3; // Neutral zone
    } else if (rsi >= 30 && rsi < 45) {
      rsiScore = clamp((rsi - 30) / 15 - 1, -0.5, 0);
    } else {
      // Oversold (< 30): bearish signal for trend-following (bullish for mean-rev
      // but our scorer is trend-following-oriented)
      rsiScore = -0.8;
    }
    score += 10 * rsiScore;
  }

  // ── 6. ADX(14) trend conviction gate (8 pts) ──────────────────────────────
  // ADX doesn't give direction — it measures how *strong* the current trend is.
  // We reward high ADX (strong trending stock) regardless of direction.
  if (inputs.adx14 != null && Number.isFinite(inputs.adx14)) {
    const adx = inputs.adx14;
    // ADX ≥ 25 = solid trend, ≥ 40 = very strong, < 20 = ranging (negative)
    const adxNorm = clamp((adx - 20) / 20, -0.5, 1.0);
    // Directional sign from changePct (positive change → reward strong ADX)
    const dir = inputs.changePct != null ? Math.sign(inputs.changePct) : 0;
    score += 8 * adxNorm * (dir === 0 ? 0 : dir);
  }

  // ── 7. Volume thrust (9 pts) ──────────────────────────────────────────────
  // Relative volume > 1.5× = institutional activity; < 0.8× = no conviction.
  if (
    inputs.relativeVolume != null &&
    Number.isFinite(inputs.relativeVolume) &&
    inputs.changePct != null
  ) {
    const vol = inputs.relativeVolume;
    const dir = Math.sign(inputs.changePct);
    // Scale: 1.0× vol = 0, 2.0× vol = full weight
    const volNorm = clamp((vol - 1.0) / 1.0, -0.5, 1.0);
    score += 9 * volNorm * dir;
  }

  // ── 8. NSE delivery % quality filter (8 pts) ─────────────────────────────
  // High delivery = real buying/selling conviction, not just intraday punting.
  if (inputs.deliveryPct != null && Number.isFinite(inputs.deliveryPct)) {
    const del = inputs.deliveryPct;
    // 50%+ delivery is excellent; below 30% is speculative. Scale linearly.
    const delNorm = clamp((del - 30) / 30, -0.5, 1.0);
    const dir = inputs.changePct != null ? Math.sign(inputs.changePct) : 0;
    score += 8 * delNorm * (dir === 0 ? 0 : dir);
  }

  // ── Quant gate multiplier ─────────────────────────────────────────────────
  // Stocks that fully pass the liquidity + conviction gate get a +5% boost on
  // the final score — nudging strongly-confirmed setups above the classification
  // boundaries without distorting low-quality signals.
  if (passesQuantGate(inputs)) {
    score *= 1.05;
  }

  return Math.round(Math.max(-100, Math.min(100, score)));
}

export function classifySignal(score: number): SignalLabel {
  // Tightened thresholds: require a higher quant score to earn STRONG BUY/SELL.
  if (score >= 55) return "STRONG BUY";
  if (score >= 20) return "BUY";
  if (score <= -55) return "STRONG SELL";
  if (score <= -20) return "SELL";
  return "HOLD";
}

export function scoreAndClassify(inputs: ScoreInputs): {
  score: number;
  signal: SignalLabel;
} {
  if (inputs.price == null) return { score: 0, signal: "N/A" };
  const score = computeScore(inputs);
  return { score, signal: classifySignal(score) };
}
