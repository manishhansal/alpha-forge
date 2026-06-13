// Shared "trend health" score used by /api/in/sector-stocks and the signal
// snapshotter. See the original `services/signals/score.ts` for rationale.

export type ScoreInputs = {
  price: number | null;
  sma50: number | null;
  sma200: number | null;
  changePct: number | null;
  /** Analyst mean target price (Yahoo `targetMeanPrice`). May be null/stale. */
  targetMean: number | null;
};

export type SignalLabel =
  | "STRONG BUY"
  | "BUY"
  | "HOLD"
  | "SELL"
  | "STRONG SELL"
  | "N/A";

const SMA50_BAND = 0.05;
const SMA200_BAND = 0.1;
const TARGET_BAND = 0.1;

function tanhWeight(dist: number, band: number): number {
  if (!Number.isFinite(dist) || !Number.isFinite(band) || band <= 0) return 0;
  return Math.tanh(dist / band);
}

export function computeScore(inputs: ScoreInputs): number {
  let score = 0;

  if (inputs.price != null && inputs.sma50 != null && inputs.sma50 > 0) {
    const dist = (inputs.price - inputs.sma50) / inputs.sma50;
    score += 20 * tanhWeight(dist, SMA50_BAND);
  }

  if (inputs.price != null && inputs.sma200 != null && inputs.sma200 > 0) {
    const dist = (inputs.price - inputs.sma200) / inputs.sma200;
    score += 20 * tanhWeight(dist, SMA200_BAND);
  }

  if (inputs.changePct != null) {
    const dir = Math.sign(inputs.changePct);
    const mag = Math.min(Math.abs(inputs.changePct) / 3, 1);
    score += dir * 30 * mag;
  }

  if (
    inputs.price != null &&
    inputs.targetMean != null &&
    inputs.targetMean > 0
  ) {
    const tgtDist = inputs.targetMean / inputs.price - 1;
    score += 30 * tanhWeight(tgtDist, TARGET_BAND);
  }

  return Math.round(Math.max(-100, Math.min(100, score)));
}

export function classifySignal(score: number): SignalLabel {
  if (score >= 60) return "STRONG BUY";
  if (score >= 20) return "BUY";
  if (score <= -60) return "STRONG SELL";
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
