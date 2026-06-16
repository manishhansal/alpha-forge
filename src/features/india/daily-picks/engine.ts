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

import { FNO_INDEX_UNDERLYINGS } from "@/lib/india/fno-symbols";
import type { IndiaScalpSignal } from "@/features/india/scalping/types";
import type {
  AiDirection,
  AiGrade,
  AiHorizon,
  AiAction,
  AiSignal,
} from "@/types/ai-signals";

export const DAILY_PICK_BUCKETS = [
  "INDICES_SCALP",
  "OPENING_BREAKOUT",
  "MOMENTUM",
  "SCALPING",
  "POTENTIAL",
] as const;

export type DailyPickBucket = (typeof DAILY_PICK_BUCKETS)[number];

/** Buckets filled from index underlyings (NIFTY/BANKNIFTY/…). */
const INDEX_BUCKETS = ["INDICES_SCALP"] as const satisfies readonly DailyPickBucket[];
/** Buckets filled from F&O stocks. */
const STOCK_BUCKETS = [
  "MOMENTUM",
  "SCALPING",
  "POTENTIAL",
] as const satisfies readonly DailyPickBucket[];
/**
 * Buckets sourced *externally* (not ranked from the AI candidate universe by
 * `selectDailyPicks`). `OPENING_BREAKOUT` is fed straight from the Opening
 * Breakout strategy's top signals via `dailyPickFromScalpSignal`.
 */
export const EXTERNAL_BUCKETS = [
  "OPENING_BREAKOUT",
] as const satisfies readonly DailyPickBucket[];

/** True when an AI signal is one of the F&O index underlyings. */
export function isIndexSignal(signal: AiSignal): boolean {
  return FNO_INDEX_UNDERLYINGS.has(signal.symbol);
}

export type DailyPickStatus =
  | "OPEN"
  | "TARGET_HIT"
  | "STOP_HIT"
  | "CLOSED"
  | "EXPIRED";

export interface DailyPickBucketMeta {
  bucket: DailyPickBucket;
  label: string;
  description: string;
}

export const DAILY_PICK_BUCKET_META: Record<
  DailyPickBucket,
  DailyPickBucketMeta
> = {
  INDICES_SCALP: {
    bucket: "INDICES_SCALP",
    label: "Indices Scalping",
    description:
      "Institutional index scalps — strong option-chain OI build-up, PCR and max-pain positioning aligned with intraday demand and the broad tape. Tight, same-session trades on NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY.",
  },
  OPENING_BREAKOUT: {
    bucket: "OPENING_BREAKOUT",
    label: "Opening Breakout",
    description:
      "First 5-min candle (9:15–9:19:59 IST) breakout, entered on the retest of the broken level (resistance→support flip). Stop below the breakout candle, target 2R, confirmed with PCR / OI / max-pain. The day's highest-probability, lowest-risk intraday setup.",
  },
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

  /** Epoch ms the signal appeared on the board (frozen at selection time). */
  generatedAt: number;
  /**
   * Epoch ms the pick first resolved (target / stop / square-off), or null
   * while still live. Time-to-outcome = `resolvedAt - generatedAt`.
   */
  resolvedAt: number | null;
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
  INDICES_SCALP: number;
  OPENING_BREAKOUT: number;
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
  // Institutional futures-segment screen, projected onto the trade direction
  // (range expansion + bullish candle/up-day + bullish week & month +
  // liquidity + SMA 20>50>200, with a bearish mirror). 0 when absent.
  const screen = clamp01(aligned(signal, "futuresScreen"));
  const expectedMove = clamp01(signal.expectedMovePct / 6);
  const rr = clamp01(signal.riskReward / 3);
  const rrBlended = clamp01(signal.riskRewardBlended / 4);
  const scalpBonus = horizonScalpBonus(signal.horizon);

  // Derivatives positioning, projected onto the trade direction — the
  // institutional backbone of an index scalp. OI build-up is the headline; PCR
  // and max-pain confirm where the option writers are leaning.
  const oi = clamp01(aligned(signal, "oiBuildup"));
  const pcr = clamp01(aligned(signal, "pcr"));
  const maxPain = clamp01(aligned(signal, "maxPain"));

  const MOMENTUM =
    0.28 * trend + 0.22 * mom + 0.14 * vol + 0.08 * scan + 0.08 * conf + 0.2 * screen;

  const SCALPING =
    0.3 * expectedMove +
    0.22 * rr +
    0.16 * vol +
    0.1 * scan +
    0.1 * scalpBonus +
    0.12 * screen;

  const POTENTIAL =
    0.38 * conf + 0.22 * win + 0.18 * rrBlended + 0.12 * expectedMove + 0.1 * screen;

  // Index scalps live and die on option-chain positioning: heavy OI weight,
  // PCR / max-pain confirmation, then intraday demand, expected range and a
  // short horizon. The futures screen keeps it on the right side of the tape.
  const INDICES_SCALP =
    0.3 * oi +
    0.16 * pcr +
    0.12 * maxPain +
    0.14 * mom +
    0.1 * expectedMove +
    0.1 * scalpBonus +
    0.08 * screen;

  return {
    INDICES_SCALP: clamp01(INDICES_SCALP),
    // Externally sourced (Opening Breakout strategy) — never ranked from the
    // AI universe, so its bucket score here is unused.
    OPENING_BREAKOUT: 0,
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
    case "INDICES_SCALP": {
      const oi = factorScore(signal, "oiBuildup") * dirSign(signal.direction);
      const oiWord =
        oi > 0.15 ? "OI build-up confirming" : oi < -0.15 ? "OI unwinding into" : "balanced OI on";
      return `Institutional index scalp — ${oiWord} the ${dirWord} with PCR / max-pain positioning and intraday demand aligned to the tape, on a ${signal.horizon} horizon.${
        drivers ? ` ${drivers}.` : ""
      }`;
    }
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
    resolvedAt: null,
    updatedAt: now,
  };
}

/** Map a [0, 1] confidence onto the AI letter grade ladder. */
function gradeFromConfidence(confidence: number): AiGrade {
  if (confidence >= 0.85) return "S";
  if (confidence >= 0.7) return "A";
  if (confidence >= 0.55) return "B";
  if (confidence >= 0.4) return "C";
  return "D";
}

/**
 * Project an Opening Breakout strategy signal into a frozen `DailyPick` for the
 * externally-sourced `OPENING_BREAKOUT` bucket. The strategy already carries
 * entry / stop / target (2R) and a confidence; we derive the stretch target
 * ("can move upto", 3R), grade and a win-probability proxy so the pick renders
 * identically to the AI-sourced buckets and tracks live the same way. The
 * appeared-on-board time is the strategy's `triggeredAt` (the retest instant).
 */
export function dailyPickFromScalpSignal(args: {
  signal: IndiaScalpSignal;
  rank: number;
  tradeDate: string;
  now: number;
}): DailyPick {
  const { signal, rank, tradeDate, now } = args;
  const isLong = signal.direction === "LONG";
  const confidence = Math.max(0, Math.min(1, signal.confidence));
  const risk = Math.abs(signal.entry - signal.stopLoss);
  const stretch =
    typeof signal.extras?.stretchTarget === "number"
      ? signal.extras.stretchTarget
      : isLong
        ? signal.entry + 3 * risk
        : signal.entry - 3 * risk;
  const canExpectPct =
    signal.entry > 0
      ? (Math.abs(stretch - signal.entry) / signal.entry) * 100
      : 0;

  return {
    tradeDate,
    bucket: "OPENING_BREAKOUT",
    rank,
    symbol: signal.symbol,
    displayName: signal.symbolName || signal.symbol,
    pair: FNO_INDEX_UNDERLYINGS.has(signal.symbol)
      ? signal.symbol
      : `${signal.symbol}.NS`,
    direction: isLong ? "BULLISH" : "BEARISH",
    action: isLong ? "LONG" : "SHORT",
    horizon: "intraday",
    grade: gradeFromConfidence(confidence),
    confidence,
    confidenceScore: Math.round(confidence * 100),
    // Win-probability proxy: confirmed retest setups skew higher.
    winProbability: Math.max(0, Math.min(1, 0.42 + confidence * 0.4)),
    underlyingPrice: signal.price,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target,
    canMoveUpto: stretch,
    canExpectPct,
    riskReward: signal.riskReward,
    bucketScore: confidence,
    rationale: signal.rationale,
    logic: `Opening Breakout — ${signal.rationale[2] ?? "first 5-min range break, entered on the retest"}.`,
    status: "OPEN",
    lastPrice: null,
    pnlPct: null,
    achievedPct: null,
    generatedAt: signal.triggeredAt,
    resolvedAt: null,
    updatedAt: now,
  };
}

interface Scored {
  signal: AiSignal;
  scores: BucketScores;
}

/**
 * Fill a set of buckets round-robin from a candidate pool, best-available per
 * bucket one slot at a time, so no single hot name monopolises every section
 * and each bucket gets its strongest *distinct* candidates. `used` is shared
 * across calls so a symbol can only ever land in one bucket overall.
 *
 * WAIT signals are excluded when there are enough real directional setups to
 * fill the buckets; only when the directional pool is too thin do we fall back
 * to including them (so the board still renders out of hours).
 */
function fillBuckets(
  pool: AiSignal[],
  buckets: readonly DailyPickBucket[],
  perBucket: number,
  marketBias: number,
  result: Record<DailyPickBucket, Scored[]>,
  used: Set<string>,
): void {
  const directional = pool.filter((s) => s.action !== "WAIT");
  const needed = perBucket * buckets.length;
  const usable = directional.length >= needed ? directional : pool;

  const scored: Scored[] = usable.map((signal) => {
    const base = bucketScores(signal);
    const m = marketAlignment(signal.direction, marketBias);
    return {
      signal,
      scores: {
        INDICES_SCALP: base.INDICES_SCALP * m,
        OPENING_BREAKOUT: base.OPENING_BREAKOUT * m,
        MOMENTUM: base.MOMENTUM * m,
        SCALPING: base.SCALPING * m,
        POTENTIAL: base.POTENTIAL * m,
      },
    };
  });

  const sortedByBucket = {} as Record<DailyPickBucket, Scored[]>;
  for (const bucket of buckets) {
    sortedByBucket[bucket] = [...scored].sort(
      (a, b) => b.scores[bucket] - a.scores[bucket],
    );
  }

  for (let slot = 0; slot < perBucket; slot++) {
    for (const bucket of buckets) {
      const next = sortedByBucket[bucket].find(
        (x) => !used.has(x.signal.symbol),
      );
      if (next) {
        used.add(next.signal.symbol);
        result[bucket].push(next);
      }
    }
  }
}

/**
 * Select the top `perBucket` signals for each bucket. Index underlyings feed
 * only the Indices-Scalping bucket and F&O stocks feed the Momentum / Scalping
 * / Potential buckets, so the index section is always pure index plays and the
 * stock sections never get crowded out by a hot index. A symbol can only ever
 * land in one bucket.
 */
export function selectDailyPicks(
  signals: AiSignal[],
  perBucket = 3,
  marketBias = 0,
): Record<DailyPickBucket, Scored[]> {
  const indexPool = signals.filter((s) => isIndexSignal(s));
  const stockPool = signals.filter((s) => !isIndexSignal(s));

  const result: Record<DailyPickBucket, Scored[]> = {
    INDICES_SCALP: [],
    // Externally sourced — populated by the builder from the Opening Breakout
    // strategy, not by ranking the AI universe here.
    OPENING_BREAKOUT: [],
    MOMENTUM: [],
    SCALPING: [],
    POTENTIAL: [],
  };
  const used = new Set<string>();

  fillBuckets(indexPool, INDEX_BUCKETS, perBucket, marketBias, result, used);
  fillBuckets(stockPool, STOCK_BUCKETS, perBucket, marketBias, result, used);

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
  let resolvedAt = pick.resolvedAt;
  if (status === "OPEN") {
    const hitStop = dir === 1 ? lastPrice <= pick.stopLoss : lastPrice >= pick.stopLoss;
    const hitTarget =
      dir === 1 ? lastPrice >= pick.target : lastPrice <= pick.target;
    if (hitStop) status = "STOP_HIT";
    else if (hitTarget) status = "TARGET_HIT";
    // Stamp the resolution instant the moment the level is touched, so the
    // board can report how long the trade took to hit its target / stop.
    if (status !== "OPEN") resolvedAt = now;
  }

  return {
    ...pick,
    lastPrice,
    pnlPct,
    achievedPct,
    status,
    resolvedAt,
    updatedAt: now,
  };
}

/**
 * Square off an intraday pick at the market close. Daily Picks are strictly
 * intraday, so any pick still OPEN once its trading session has ended is
 * force-closed at its last mark — regardless of profit/loss — and never carried
 * overnight. The frozen P&L / progress (`pnlPct`, `achievedPct`, `lastPrice`)
 * are kept as-is; only the status flips OPEN → CLOSED. Already-resolved picks
 * (TARGET_HIT / STOP_HIT / CLOSED / EXPIRED) are returned untouched, so it's
 * idempotent.
 */
export function squareOffPick(pick: DailyPick, now: number): DailyPick {
  if (pick.status !== "OPEN") return pick;
  return {
    ...pick,
    status: "CLOSED",
    resolvedAt: pick.resolvedAt ?? now,
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
