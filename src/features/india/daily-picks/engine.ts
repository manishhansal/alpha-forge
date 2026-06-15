/**
 * Daily Picks — pure engine.
 *
 * Takes the rich `AiSignal[]` produced by the India AI builder and distils it
 * into the day's **top three signals per bucket**:
 *
 *   - MOMENTUM  — "Highly momentum stocks": strongest directional trend +
 *     5-day momentum + volume thrust pushing in the trade direction.
 *   - SCALPING  — "Highly scalping stocks": best intraday tradability —
 *     enough expected range, clean risk:reward, live scanner agreement and a
 *     short (scalp / intraday) horizon.
 *   - POTENTIAL — "Highly potential stocks": highest conviction, biggest
 *     blended payoff — confidence, calibrated win-probability, blended R:R
 *     and stretch move.
 *
 * Every pick carries an `entry`, `stopLoss`, `target` (realistic TP1),
 * `canMoveUpto` (stretch TP3) and `canExpectPct` (the % move from entry to
 * the stretch target) plus a human-readable `logic` string explaining *why*
 * it landed in that bucket. The picks are designed to be frozen for the
 * trading day and then live-tracked (see `trackPick`) so the user can watch
 * the P&L / progress-to-target accrue in real time and review past days in
 * the history.
 *
 * Pure — no I/O, no Date.now() except where a caller passes `now` in. Safe to
 * unit test in isolation.
 */

import type {
  AiDirection,
  AiGrade,
  AiHorizon,
  AiAction,
  AiSignal,
} from "@/types/ai-signals";

export const DAILY_PICK_BUCKETS = [
  "MOMENTUM",
  "SCALPING",
  "POTENTIAL",
] as const;

export type DailyPickBucket = (typeof DAILY_PICK_BUCKETS)[number];

export type DailyPickStatus = "OPEN" | "TARGET_HIT" | "STOP_HIT" | "EXPIRED";

export interface DailyPickBucketMeta {
  bucket: DailyPickBucket;
  label: string;
  description: string;
}

export const DAILY_PICK_BUCKET_META: Record<
  DailyPickBucket,
  DailyPickBucketMeta
> = {
  MOMENTUM: {
    bucket: "MOMENTUM",
    label: "Highly Momentum Stocks",
    description:
      "Strongest directional trend — SMA stack, 5-day momentum and volume thrust all pushing the same way. Ride the move.",
  },
  SCALPING: {
    bucket: "SCALPING",
    label: "Highly Scalping Stocks",
    description:
      "Best intraday tradability — enough expected range, clean risk:reward and live scanner agreement on a scalp / intraday horizon.",
  },
  POTENTIAL: {
    bucket: "POTENTIAL",
    label: "Highly Potential Stocks",
    description:
      "Highest conviction with the biggest blended payoff — confidence, win-probability and stretch target lead the rank.",
  },
};

/**
 * One distilled daily pick. The `entry` / `stopLoss` / `target` /
 * `canMoveUpto` levels are frozen at selection time; the live-tracking
 * fields (`lastPrice` / `pnlPct` / `achievedPct` / `status`) are refreshed
 * against the latest mark.
 */
export interface DailyPick {
  tradeDate: string;
  bucket: DailyPickBucket;
  rank: number;
  symbol: string;
  displayName: string;
  pair: string;
  direction: AiDirection;
  action: AiAction;
  horizon: AiHorizon;
  grade: AiGrade;
  confidence: number;
  confidenceScore: number;
  winProbability: number;

  /** Mark price of the underlying when the pick was selected (the entry-time spot). */
  underlyingPrice: number;
  entry: number;
  stopLoss: number;
  /** Realistic, first-target (TP1) the trade is expected to reach. */
  target: number;
  /** Stretch target (TP3) — "can move upto" this level on a clean run. */
  canMoveUpto: number;
  /** Expected % move from entry to the stretch target ("can expect"). */
  canExpectPct: number;
  riskReward: number;
  /** Bucket-fit score in [0, 1] used to rank within the bucket. */
  bucketScore: number;

  rationale: string[];
  /** Why this signal sits in this bucket — human readable. */
  logic: string;

  /** Live-tracking fields. */
  status: DailyPickStatus;
  lastPrice: number | null;
  pnlPct: number | null;
  /** Best progress toward the target seen so far, in % (100 = target hit). */
  achievedPct: number | null;

  generatedAt: number;
  updatedAt: number;
}

export interface DailyPickGroup {
  bucket: DailyPickBucket;
  label: string;
  description: string;
  picks: DailyPick[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

const clamp01 = (x: number): number => clamp(x, 0, 1);

function dirSign(direction: AiDirection): number {
  return direction === "BULLISH" ? 1 : direction === "BEARISH" ? -1 : 0;
}

/** Read a confluence factor's signed score by id (0 when missing / unavailable). */
function factorScore(signal: AiSignal, id: string): number {
  const f = signal.confluences.find((c) => c.id === id);
  return f && f.available ? f.score : 0;
}

/**
 * Factor score projected onto the trade direction — positive when the factor
 * agrees with the trade (e.g. a bullish trend on a LONG), negative when it
 * fights it. Zero for WAIT / neutral signals so they never out-rank a real
 * directional setup.
 */
function aligned(signal: AiSignal, id: string): number {
  return factorScore(signal, id) * dirSign(signal.direction);
}

/**
 * Tape-alignment multiplier in (0, 1]. In a strongly trending market a desk
 * trades *with* the tape — so a pick whose direction fights a strong regime is
 * demoted (its bucket scores are scaled down), while an aligned pick keeps its
 * full score. A weak / mixed tape (|bias| < 0.25) applies no penalty so
 * name-specific edges still surface.
 */
export function marketAlignment(
  direction: AiDirection,
  marketBias = 0,
): number {
  const strength = Math.min(Math.abs(marketBias), 1);
  if (strength < 0.25) return 1;
  const dir = dirSign(direction);
  const agree = dir * Math.sign(marketBias);
  if (agree > 0) return 1; // aligned with the tape
  if (agree === 0) return 1 - 0.2 * strength; // neutral / WAIT
  return 1 - 0.6 * strength; // fighting the tape
}

function horizonScalpBonus(horizon: AiHorizon): number {
  switch (horizon) {
    case "scalp":
      return 1;
    case "intraday":
      return 0.7;
    case "swing":
      return 0.3;
    default:
      return 0.1;
  }
}

export interface BucketScores {
  MOMENTUM: number;
  SCALPING: number;
  POTENTIAL: number;
}

/**
 * Score a single signal for each of the three buckets. All sub-scores are
 * normalised into roughly [0, 1] so the weighted sums stay comparable.
 */
export function bucketScores(signal: AiSignal): BucketScores {
  const conf = clamp01(signal.confidence);
  const win = clamp01(signal.winProbability);
  const trend = clamp01(aligned(signal, "trend"));
  const mom = clamp01(aligned(signal, "momentum"));
  const vol = clamp01(aligned(signal, "volume"));
  const scan = clamp01(aligned(signal, "scanner"));
  const expectedMove = clamp01(signal.expectedMovePct / 6);
  const rr = clamp01(signal.riskReward / 3);
  const rrBlended = clamp01(signal.riskRewardBlended / 4);
  const scalpBonus = horizonScalpBonus(signal.horizon);

  const MOMENTUM =
    0.35 * trend + 0.28 * mom + 0.17 * vol + 0.1 * scan + 0.1 * conf;

  const SCALPING =
    0.34 * expectedMove +
    0.24 * rr +
    0.2 * vol +
    0.12 * scan +
    0.1 * scalpBonus;

  const POTENTIAL =
    0.42 * conf + 0.24 * win + 0.2 * rrBlended + 0.14 * expectedMove;

  return {
    MOMENTUM: clamp01(MOMENTUM),
    SCALPING: clamp01(SCALPING),
    POTENTIAL: clamp01(POTENTIAL),
  };
}

/** Build the "why it sits here" logic sentence for a pick. */
export function bucketLogic(signal: AiSignal, bucket: DailyPickBucket): string {
  const top = signal.reasons
    .filter((r) => r.bullish === (signal.direction === "BULLISH"))
    .slice(0, 2)
    .map((r) => r.text);
  const fallback = signal.reasons.slice(0, 2).map((r) => r.text);
  const drivers = (top.length > 0 ? top : fallback).join("; ");
  const dirWord = signal.direction === "BEARISH" ? "downside" : "upside";

  switch (bucket) {
    case "MOMENTUM":
      return `Momentum leader — daily trend, 5-day momentum and volume thrust all aligned to the ${dirWord}.${
        drivers ? ` ${drivers}.` : ""
      }`;
    case "SCALPING":
      return `Cleanest intraday setup — ${signal.horizon} horizon with a ${signal.riskReward.toFixed(
        1,
      )}:1 reward and live scanner agreement.${drivers ? ` ${drivers}.` : ""}`;
    case "POTENTIAL":
      return `Highest conviction — grade ${signal.grade}, ${Math.round(
        signal.winProbability * 100,
      )}% win-probability and a ${signal.expectedMovePct.toFixed(
        1,
      )}% potential ${dirWord} move.${drivers ? ` ${drivers}.` : ""}`;
    default:
      return drivers;
  }
}

/**
 * Project a signal into a frozen `DailyPick` for a given bucket / rank. The
 * live-tracking fields start unfilled (OPEN, no last price) — call
 * `trackPick` to refresh them against a live mark.
 */
export function pickFromSignal(args: {
  signal: AiSignal;
  bucket: DailyPickBucket;
  rank: number;
  tradeDate: string;
  bucketScore: number;
  now: number;
}): DailyPick {
  const { signal, bucket, rank, tradeDate, bucketScore, now } = args;
  const target = signal.takeProfits[0]?.price ?? signal.entry;
  const canMoveUpto = signal.takeProfits.at(-1)?.price ?? target;

  return {
    tradeDate,
    bucket,
    rank,
    symbol: signal.symbol,
    displayName: signal.displayName,
    pair: signal.pair,
    direction: signal.direction,
    action: signal.action,
    horizon: signal.horizon,
    grade: signal.grade,
    confidence: signal.confidence,
    confidenceScore: signal.confidenceScore,
    winProbability: signal.winProbability,
    underlyingPrice: signal.underlyingPrice,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target,
    canMoveUpto,
    canExpectPct: signal.expectedMovePct,
    riskReward: signal.riskReward,
    bucketScore,
    rationale: signal.reasons.map((r) => r.text),
    logic: bucketLogic(signal, bucket),
    status: "OPEN",
    lastPrice: null,
    pnlPct: null,
    achievedPct: null,
    generatedAt: now,
    updatedAt: now,
  };
}

interface Scored {
  signal: AiSignal;
  scores: BucketScores;
}

/**
 * Select the top `perBucket` signals for each bucket. A symbol can only land
 * in one bucket — we fill the buckets round-robin (best-available per bucket,
 * one slot at a time) so no single hot name monopolises every section and
 * each bucket gets its strongest *distinct* candidates.
 *
 * WAIT signals are excluded when there are enough real directional setups to
 * fill the board; only when the directional pool is too thin do we fall back
 * to including them (so the board still renders out of hours).
 */
export function selectDailyPicks(
  signals: AiSignal[],
  perBucket = 3,
  marketBias = 0,
): Record<DailyPickBucket, Scored[]> {
  const directional = signals.filter((s) => s.action !== "WAIT");
  const needed = perBucket * DAILY_PICK_BUCKETS.length;
  const pool = directional.length >= needed ? directional : signals;

  const scored: Scored[] = pool.map((signal) => {
    const base = bucketScores(signal);
    const m = marketAlignment(signal.direction, marketBias);
    return {
      signal,
      scores: {
        MOMENTUM: base.MOMENTUM * m,
        SCALPING: base.SCALPING * m,
        POTENTIAL: base.POTENTIAL * m,
      },
    };
  });

  const sortedByBucket: Record<DailyPickBucket, Scored[]> = {
    MOMENTUM: [...scored].sort((a, b) => b.scores.MOMENTUM - a.scores.MOMENTUM),
    SCALPING: [...scored].sort((a, b) => b.scores.SCALPING - a.scores.SCALPING),
    POTENTIAL: [...scored].sort(
      (a, b) => b.scores.POTENTIAL - a.scores.POTENTIAL,
    ),
  };

  const result: Record<DailyPickBucket, Scored[]> = {
    MOMENTUM: [],
    SCALPING: [],
    POTENTIAL: [],
  };
  const used = new Set<string>();

  for (let slot = 0; slot < perBucket; slot++) {
    for (const bucket of DAILY_PICK_BUCKETS) {
      const next = sortedByBucket[bucket].find(
        (x) => !used.has(x.signal.symbol),
      );
      if (next) {
        used.add(next.signal.symbol);
        result[bucket].push(next);
      }
    }
  }

  return result;
}

/**
 * Build the frozen daily-pick groups from a set of fresh signals. The result
 * is what gets persisted at the start of the trading day.
 */
export function buildDailyPicks(args: {
  signals: AiSignal[];
  tradeDate: string;
  now: number;
  perBucket?: number;
  /** Broad-market regime in [-1, 1] — demotes counter-tape picks. */
  marketBias?: number;
}): DailyPick[] {
  const { signals, tradeDate, now, perBucket = 3, marketBias = 0 } = args;
  const selected = selectDailyPicks(signals, perBucket, marketBias);
  const out: DailyPick[] = [];
  for (const bucket of DAILY_PICK_BUCKETS) {
    selected[bucket].forEach((scored, idx) => {
      out.push(
        pickFromSignal({
          signal: scored.signal,
          bucket,
          rank: idx + 1,
          tradeDate,
          bucketScore: scored.scores[bucket],
          now,
        }),
      );
    });
  }
  return out;
}

/**
 * Refresh a pick's live-tracking fields against the latest mark price.
 *
 * - `pnlPct` is the signed P&L from the frozen entry (positive when the trade
 *   is in profit, accounting for LONG vs SHORT).
 * - `achievedPct` is the *best* progress toward target seen so far (max of the
 *   prior value and the current progress) — "achieved till now".
 * - `status` transitions OPEN → TARGET_HIT / STOP_HIT once a level is touched
 *   and then sticks (a resolved pick is never re-opened). Stop wins ties.
 */
export function trackPick(
  pick: DailyPick,
  lastPrice: number | null | undefined,
  now: number,
): DailyPick {
  if (lastPrice == null || !Number.isFinite(lastPrice) || lastPrice <= 0) {
    return pick;
  }
  const dir = pick.direction === "BEARISH" ? -1 : 1;
  const pnlPct = ((lastPrice - pick.entry) / pick.entry) * 100 * dir;
  const targetMovePct = (Math.abs(pick.target - pick.entry) / pick.entry) * 100;
  const progress = targetMovePct > 0 ? (pnlPct / targetMovePct) * 100 : 0;
  const achievedPct =
    pick.achievedPct == null ? progress : Math.max(pick.achievedPct, progress);

  let status = pick.status;
  if (status === "OPEN") {
    const hitStop = dir === 1 ? lastPrice <= pick.stopLoss : lastPrice >= pick.stopLoss;
    const hitTarget =
      dir === 1 ? lastPrice >= pick.target : lastPrice <= pick.target;
    if (hitStop) status = "STOP_HIT";
    else if (hitTarget) status = "TARGET_HIT";
  }

  return {
    ...pick,
    lastPrice,
    pnlPct,
    achievedPct,
    status,
    updatedAt: now,
  };
}

/** Group a flat list of picks into the canonical bucket order. */
export function groupDailyPicks(picks: DailyPick[]): DailyPickGroup[] {
  return DAILY_PICK_BUCKETS.map((bucket) => {
    const meta = DAILY_PICK_BUCKET_META[bucket];
    return {
      bucket,
      label: meta.label,
      description: meta.description,
      picks: picks
        .filter((p) => p.bucket === bucket)
        .sort((a, b) => a.rank - b.rank),
    };
  });
}

/** IST (UTC+5:30) calendar date as `YYYY-MM-DD` — the trading-day key. */
export function istDateKey(at: Date): string {
  const ist = new Date(at.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
