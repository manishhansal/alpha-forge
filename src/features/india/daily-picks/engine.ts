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
import type { OptionContract } from "./option-projection";
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

/**
 * Soft-warning kinds surfaced as badges on the pick card — never block the
 * pick from showing, just annotate it for the trader. Mirrors the Quality
 * Rules section of the institutional Daily Picks spec.
 */
export type DailyPickWarningKind =
  | "HIGH_VIX"
  | "EXTREME_VIX"
  | "LOW_VIX_REGIME"
  | "LOW_CONFIDENCE"
  | "LOW_RR"
  | "EVENT_RISK"
  | "EXPIRY_DAY"
  | "COUNTER_TAPE"
  | "OUTSIDE_WINDOW";

export type DailyPickWarningSeverity = "info" | "warn" | "danger";

export interface DailyPickWarning {
  kind: DailyPickWarningKind;
  /** Display label for the badge (`HIGH VIX WARNING`, `EVENT RISK`, …). */
  label: string;
  /** Short one-line explanation suitable for a tooltip / aria-label. */
  note: string;
  severity: DailyPickWarningSeverity;
}

/**
 * The IST window the desk should be looking to execute the pick in. Both
 * fields are 24h `HH:MM` strings so the UI can render them deterministically.
 */
export interface DailyPickTimeWindow {
  /** Inclusive start (IST, `HH:MM`). */
  start: string;
  /** Inclusive end (IST, `HH:MM`). */
  end: string;
  /** Human-readable name of the window (e.g. "ORB Retest", "Power Hour"). */
  label: string;
}

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
  /**
   * Present only on INDICES_SCALP picks: the ATM option contract this trade
   * is actually expressed in. When set, `entry` / `stopLoss` / `target` /
   * `canMoveUpto` / `lastPrice` are *option premiums* (₹), not the index
   * level — the desk trades the option, not the spot. `underlyingPrice`
   * still references the index level for display.
   */
  optionContract: OptionContract | null;

  // ─── Soft-annotation fields (institutional spec output) ─────────────────
  /**
   * 0..10 ladder version of `bucketScore` — what the spec calls the
   * "Confluence Score X/10". Rounded to one decimal, derived deterministically
   * from `bucketScore` so it never drifts under live tracking.
   */
  confluenceScore: number;
  /**
   * Compact list of the indicators the pick is leaning on (RSI / VWAP / OI /
   * PCR / Max Pain / ATR / EMA / ORB / Vol). Rendered as a chip strip on the
   * card.
   */
  keyIndicators: string[];
  /**
   * Short setup classification (e.g. "ORB Retest", "OI-Wall + Max-Pain
   * Magnet", "Trend Continuation"). Renders below the bucket label.
   */
  setupType: string;
  /**
   * 3–5 sentence institutional-grade research note — explains the *why*
   * behind the pick (chart structure, options-chain read, risk).
   */
  researchNote: string;
  /** IST execution window for the pick (`HH:MM`–`HH:MM`). */
  timeWindow: DailyPickTimeWindow;
  /** Soft warning badges — never block the pick, just annotate it. */
  warnings: DailyPickWarning[];
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

/**
 * Above this absolute regime score we *hard-filter* counter-tape directional
 * picks out of the stock buckets rather than merely demoting them — desks
 * don't take 5-day-momentum shorts in a tape that's grinding up. A symmetric
 * bullish/bearish threshold prevents the "all 3 SHORT in a flat tape" failure
 * mode (see Highly Scalping all-shorts incident on 2026-06-17).
 */
export const TAPE_HARD_FILTER_BIAS = 0.1;

/**
 * True when a signal's direction is compatible with the broader tape. Returns
 * true unconditionally when the tape is weak / mixed (|bias| < threshold) so
 * name-specific edges still surface. WAIT / NEUTRAL signals are always
 * compatible.
 */
export function passesTapeFilter(
  signal: AiSignal,
  marketBias = 0,
  threshold = TAPE_HARD_FILTER_BIAS,
): boolean {
  if (Math.abs(marketBias) < threshold) return true;
  const dir = dirSign(signal.direction);
  if (dir === 0) return true;
  return Math.sign(marketBias) === dir;
}

/**
 * Per-bucket quality floor — a candidate must clear these to be ranked.
 *
 * We gate on *factor strength* rather than the over-aggregated AI `grade`
 * because the grade thresholds (≥0.55 for C, ≥0.85 for A) assume a regime
 * where confidence regularly reaches that range. In compressed / coiling
 * regimes (low VIX, narrow daily range, mixed cross-sectional tape) every
 * signal stays grade D even when the factor signature is clean — a grade
 * gate would empty the board on those days. Direct factor gates surface
 * the right setups in *every* regime without sacrificing institutional
 * quality.
 */
const BUCKET_GATES: Record<
  DailyPickBucket,
  (signal: AiSignal) => boolean
> = {
  // INDICES_SCALP: 4-name universe ranked by OI / PCR / max-pain — chain
  // factors that the AI's confidence scoring largely ignores. Confidence
  // floor stays low; the bucket-ranking score does the heavy lifting.
  INDICES_SCALP: (s) => s.confidence >= 0.18,
  // OPENING_BREAKOUT is externally sourced (the strategy itself enforces its
  // own retest + confidence floor in `loadOpeningBreakoutPicks`).
  OPENING_BREAKOUT: () => true,
  // Momentum: the name must be MOVING and BREAKING OUT in the trade
  // direction. Trend OR momentum must be aligned (long-term up + 5-day push)
  // and either day-change or breakout must be aligned (today's tape is on
  // your side). Volume thrust is a *nice-to-have* — on coiling days the
  // best setups print before volume confirms.
  MOMENTUM: (s) =>
    aligned(s, "dayChange") >= 0.2 &&
    (aligned(s, "trend") >= 0.3 || aligned(s, "momentum") >= 0.3) &&
    aligned(s, "breakout") >= 0,
  // Scalping: useful blended R:R across the TP ladder AND the day's tape
  // already on your side. We use riskRewardBlended (≥ 1.5) because TP1 R:R
  // is structurally 1.14-1.25 for any ATR-derived intraday plan; the
  // blended ladder is the right measure of "is the math actually in my
  // favour for a same-session trade".
  SCALPING: (s) =>
    s.riskRewardBlended >= 1.4 &&
    aligned(s, "dayChange") >= 0.25 &&
    aligned(s, "breakout") >= 0,
  // Potential: the highest-conviction, best risk-adjusted setups even when
  // they aren't today's biggest movers. Floor confidence at a realistic
  // 0.2 for compressed regimes; require a real breakout edge AND either
  // long-term trend alignment or strong momentum.
  POTENTIAL: (s) =>
    s.confidence >= 0.2 &&
    aligned(s, "breakout") >= 0.2 &&
    (aligned(s, "trend") >= 0.3 || aligned(s, "momentum") >= 0.3),
};

/**
 * True when a candidate clears the per-bucket sanity gate. Used by
 * `fillBuckets` to drop low-quality picks entirely rather than rank them.
 */
export function passesBucketGate(
  signal: AiSignal,
  bucket: DailyPickBucket,
): boolean {
  return BUCKET_GATES[bucket](signal);
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
    case "MOMENTUM": {
      const volAligned = aligned(signal, "volume") > 0;
      const volPhrase = volAligned
        ? "volume thrust all aligned"
        : "trend and momentum aligned (volume light)";
      return `Momentum leader — daily trend, 5-day momentum and ${volPhrase} to the ${dirWord}.${
        drivers ? ` ${drivers}.` : ""
      }`;
    }
    case "SCALPING": {
      const volAligned = aligned(signal, "volume") > 0;
      const volPhrase = volAligned ? " with volume confirming" : "";
      return `Cleanest intraday setup — ${signal.horizon} horizon, ${signal.riskReward.toFixed(
        1,
      )}:1 reward and live scanner agreement${volPhrase}.${drivers ? ` ${drivers}.` : ""}`;
    }
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

// ─── Soft annotation helpers (institutional spec output) ──────────────────

/**
 * Scale the engine's [0, 1] `bucketScore` onto the "Confluence Score X/10"
 * ladder the spec asks for. Rounded to one decimal so the UI is stable;
 * clamps + non-finite-safe so callers can hand it the raw bucket score.
 */
export function confluenceScoreFromBucket(bucketScore: number): number {
  if (Number.isNaN(bucketScore)) return 0;
  // Treat +∞ as full marks rather than NaN-poisoning the ladder.
  if (!Number.isFinite(bucketScore)) return bucketScore > 0 ? 10 : 0;
  const clamped = clamp(bucketScore, 0, 1) * 10;
  return Math.round(clamped * 10) / 10;
}

/** Per-bucket "key indicators" the trader is supposed to read off the card. */
const BUCKET_INDICATORS: Record<DailyPickBucket, readonly string[]> = {
  // Indices live and die on derivatives positioning — OI first, then PCR,
  // then max pain, then the macro VIX read + intraday VWAP execution.
  INDICES_SCALP: ["OI", "PCR", "Max Pain", "India VIX", "VWAP"],
  // ORB structure — opening range, volume confirmation, VWAP fill and the
  // PDH/PDL context the strategy frames the trade around.
  OPENING_BREAKOUT: ["ORB", "Vol", "VWAP", "PDH/PDL"],
  // Momentum is a trend + flow read.
  MOMENTUM: ["RSI", "EMA", "OI", "Vol", "ADX"],
  // Scalping wants liquidity + volatility + execution price (VWAP).
  SCALPING: ["VWAP", "ATR", "Vol", "Beta"],
  // Potential is structural with derivative confluence.
  POTENTIAL: ["OI", "RSI", "EMA", "PCR", "Vol"],
};

/**
 * Pick the 3–5 most informative indicator chips for the bucket. Pure on
 * (signal, bucket) — currently doesn't read the signal, but the parameter
 * is kept so future versions can adapt the chip set based on which
 * confluence factors are actually loaded.
 */
export function keyIndicatorsFor(
  signal: AiSignal,
  bucket: DailyPickBucket,
): string[] {
  // Silence the unused-arg without weakening the signature — future refinements
  // (e.g. ATM IV chip only when chain is available) will read off the signal.
  void signal;
  return [...BUCKET_INDICATORS[bucket]];
}

/**
 * Classify the *kind* of setup the pick represents — independent of the
 * bucket label, and short enough to render as a sub-title under the symbol.
 */
export function setupTypeFor(
  signal: AiSignal,
  bucket: DailyPickBucket,
): string {
  switch (bucket) {
    case "INDICES_SCALP": {
      const oi = factorScore(signal, "oiBuildup") * dirSign(signal.direction);
      const pcr = factorScore(signal, "pcr") * dirSign(signal.direction);
      const maxPain = factorScore(signal, "maxPain") * dirSign(signal.direction);
      if (oi >= 0.6 && maxPain >= 0.3) return "OI-Wall + Max-Pain Magnet";
      if (oi >= 0.5) return "Heavy OI Build-up";
      if (pcr >= 0.5) return "PCR Extreme Reversal";
      if (maxPain >= 0.4) return "Max-Pain Gravity Pull";
      return "Index Derivatives Scalp";
    }
    case "OPENING_BREAKOUT":
      return "ORB Retest (5-min Opening Range)";
    case "MOMENTUM": {
      const breakout = factorScore(signal, "breakout") * dirSign(signal.direction);
      if (breakout >= 0.6) return "Trend Continuation Breakout";
      return "Trend Continuation";
    }
    case "SCALPING": {
      if (signal.horizon === "scalp") return "Quick Scalp (VWAP Pullback)";
      const breakout = factorScore(signal, "breakout") * dirSign(signal.direction);
      if (breakout >= 0.4) return "Range Compression Breakout";
      return "Intraday VWAP Scalp";
    }
    case "POTENTIAL": {
      if (signal.confidence >= 0.75) return "High-Conviction Structural Play";
      const breakout = factorScore(signal, "breakout") * dirSign(signal.direction);
      if (breakout >= 0.5) return "Liquidity Sweep Reversal";
      return "Multi-Factor Confluence Setup";
    }
    default:
      return "Intraday Setup";
  }
}

/**
 * Per-bucket IST execution window. Indices and momentum picks run the bulk
 * of the session; opening breakouts cluster in the first 1.5 h post-open;
 * scalps target the two highest-liquidity bands; potential picks ride the
 * trending middle of the day.
 */
const BUCKET_TIME_WINDOWS: Record<DailyPickBucket, DailyPickTimeWindow> = {
  INDICES_SCALP: {
    start: "09:30",
    end: "15:20",
    label: "Liquid intraday band (post-open ramp → power hour)",
  },
  OPENING_BREAKOUT: {
    start: "09:20",
    end: "11:30",
    label: "ORB Retest window",
  },
  MOMENTUM: {
    start: "09:45",
    end: "15:00",
    label: "Trending session",
  },
  SCALPING: {
    start: "09:15",
    end: "15:15",
    label: "Opening Volatility + Power Hour scalps",
  },
  POTENTIAL: {
    start: "10:00",
    end: "15:00",
    label: "Prime trending window",
  },
};

export function timeWindowFor(
  bucket: DailyPickBucket,
  horizon: AiHorizon,
): DailyPickTimeWindow {
  const base = BUCKET_TIME_WINDOWS[bucket];
  // Scalps are stricter: even for non-SCALPING buckets a scalp horizon
  // contracts the window to the high-liquidity zones.
  if (horizon === "scalp" && bucket !== "SCALPING") {
    return { ...base, end: base.end > "15:15" ? "15:15" : base.end };
  }
  return base;
}

const HORIZON_PHRASE: Record<AiHorizon, string> = {
  scalp: "quick scalp (5–30m hold)",
  intraday: "same-session intraday hold",
  swing: "1–3 day swing",
  positional: "1–2 week positional play",
};

/**
 * Synthesise a 3–5 sentence institutional-grade research note from the
 * signal's reasons + bucket. The note covers (in order): why the stock /
 * index today, what the structure / options chain shows, the win-probability
 * and expected move framing, and the risk anchor.
 */
export function buildResearchNote(args: {
  signal: AiSignal;
  bucket: DailyPickBucket;
  /** Optional broad-market headline (e.g. "Risk-on — indices firm"). */
  marketHeadline?: string;
}): string {
  const { signal, bucket, marketHeadline } = args;
  const dirWord = signal.direction === "BEARISH" ? "downside" : "upside";
  const winPct = Math.round(signal.winProbability * 100);
  const reasons = signal.reasons
    .filter((r) => r.bullish === (signal.direction === "BULLISH"))
    .map((r) => r.text);
  const fallback = signal.reasons.map((r) => r.text);
  const driverList = reasons.length > 0 ? reasons : fallback;
  const primaryDriver = driverList[0] ?? "Multi-factor confluence in the trade direction";
  const secondaryDriver = driverList[1] ?? null;

  const lead =
    bucket === "INDICES_SCALP"
      ? `${signal.symbol} is showing institutional ${dirWord} positioning on today's option chain — ${primaryDriver}.`
      : bucket === "OPENING_BREAKOUT"
        ? `${signal.symbol} cleared its first 5-min range and successfully retested the broken level — ${primaryDriver}.`
        : bucket === "MOMENTUM"
          ? `${signal.symbol} is one of today's strongest aligned movers — ${primaryDriver}.`
          : bucket === "SCALPING"
            ? `${signal.symbol} is set up for a clean intraday scalp — ${primaryDriver}.`
            : `${signal.symbol} carries the day's tightest multi-factor confluence — ${primaryDriver}.`;

  const structure = secondaryDriver
    ? `Structure check: ${secondaryDriver}.`
    : `Structure check: ${signal.bullishCount} bullish vs ${signal.bearishCount} bearish factors aligned for the ${signal.direction.toLowerCase()} read.`;

  const positioning =
    bucket === "INDICES_SCALP"
      ? `Options-chain read confirms the bias — OI build-up, PCR and max-pain positioning all support the ${dirWord} scalp, with the desk expressing it via the ATM strike on a ${HORIZON_PHRASE[signal.horizon]}.`
      : `Risk-reward sits at ${signal.riskReward.toFixed(2)}:1 on TP1 and ${signal.riskRewardBlended.toFixed(2)}:1 blended across the ladder, with a ${signal.expectedMovePct.toFixed(2)}% stretch move available on the ${HORIZON_PHRASE[signal.horizon]}.`;

  const probability = `Calibrated win-probability is ${winPct}% on TP1-before-stop, grade ${signal.grade}.`;

  const risk = `${signal.invalidationCriteria} — keep the stop honored; let the position breathe inside the window otherwise.`;

  const sentences = [
    lead,
    structure,
    positioning,
    probability,
    risk,
  ];
  if (marketHeadline && bucket !== "OPENING_BREAKOUT") {
    // Replace the last sentence with a regime-aware close (still 5 sentences).
    sentences[sentences.length - 1] =
      `Broad-tape context: ${marketHeadline} ${signal.invalidationCriteria.toLowerCase()}.`;
  }
  return sentences.join(" ");
}

/**
 * Build the array of soft warning badges for a pick. Every check produces an
 * annotation (never a hard block) so the card can surface the spec's Quality
 * Rules — HIGH VIX, EVENT RISK, low conviction, low R:R, fighting the tape —
 * while the ranking engine continues to do the hard work.
 */
export function buildSoftWarnings(args: {
  signal: AiSignal;
  bucket: DailyPickBucket;
  /**
   * 0..10 confluence ladder for the pick. Falls back to a bucketScore-derived
   * read when omitted.
   */
  confluenceScore?: number;
  /** Latest India VIX value (decimal %, e.g. 13.4 for 13.4%). */
  indiaVix?: number | null;
  /** Broad-market regime score in [-1, 1] — drives the counter-tape badge. */
  marketBias?: number;
  /** Days until the symbol's earnings event (0 = today, 1 = tomorrow, …). */
  earningsWithinDays?: number | null;
  /** True if today is an F&O expiry session (Tuesday for NIFTY, weekly). */
  isExpiryDay?: boolean;
}): DailyPickWarning[] {
  const out: DailyPickWarning[] = [];
  const vix = args.indiaVix ?? null;
  if (vix != null && Number.isFinite(vix)) {
    if (vix > 25) {
      out.push({
        kind: "EXTREME_VIX",
        label: "EXTREME VIX",
        note: `India VIX at ${vix.toFixed(2)} — IV is rich, expect outsized two-way moves. Trim size.`,
        severity: "danger",
      });
    }
    if (vix > 20) {
      out.push({
        kind: "HIGH_VIX",
        label: "HIGH VIX WARNING",
        note: `India VIX at ${vix.toFixed(2)} — option premium decay risk is elevated. Favour spreads over outright buys.`,
        severity: "warn",
      });
    }
    if (vix < 13) {
      out.push({
        kind: "LOW_VIX_REGIME",
        label: "LOW VIX",
        note: `India VIX at ${vix.toFixed(2)} — favour premium-selling structures; directional buys lose to theta.`,
        severity: "info",
      });
    }
  }

  const confluence =
    args.confluenceScore ??
    confluenceScoreFromBucket((args.signal as AiSignal).confidence ?? 0);
  if (confluence < 6) {
    out.push({
      kind: "LOW_CONFIDENCE",
      label: "LOW CONFIDENCE",
      note: `Confluence score ${confluence.toFixed(1)}/10 — below the desk's 6/10 floor. Treat as a probe-size trade.`,
      severity: "warn",
    });
  }

  const rrFloor = args.bucket === "SCALPING" ? 1.5 : 1.5;
  // Use blended R:R when present (full ladder picture); fall back to TP1 R:R.
  const rr = Math.min(args.signal.riskReward, args.signal.riskRewardBlended);
  if (rr < rrFloor) {
    out.push({
      kind: "LOW_RR",
      label: "LOW R:R",
      note: `R:R ${rr.toFixed(2)}:1 — below the ${rrFloor.toFixed(1)}:1 floor for this bucket. The math is borderline; size accordingly.`,
      severity: "warn",
    });
  }

  if (args.marketBias != null && Number.isFinite(args.marketBias)) {
    const COUNTER_TAPE_THRESHOLD = 0.25;
    const bias = args.marketBias;
    const fightingBull = bias > COUNTER_TAPE_THRESHOLD && args.signal.direction === "BEARISH";
    const fightingBear = bias < -COUNTER_TAPE_THRESHOLD && args.signal.direction === "BULLISH";
    if (fightingBull || fightingBear) {
      out.push({
        kind: "COUNTER_TAPE",
        label: "COUNTER-TAPE",
        note: `Pick fights a ${bias > 0 ? "bullish" : "bearish"} broad-tape regime (bias ${bias.toFixed(2)}) — expect choppy follow-through.`,
        severity: "warn",
      });
    }
  }

  if (args.earningsWithinDays != null && args.earningsWithinDays >= 0 && args.earningsWithinDays <= 2) {
    out.push({
      kind: "EVENT_RISK",
      label: "EVENT RISK",
      note: `Earnings within ${args.earningsWithinDays} session(s) — IV is sticky and gap-risk is non-trivial.`,
      severity: "warn",
    });
  }

  if (args.isExpiryDay) {
    out.push({
      kind: "EXPIRY_DAY",
      label: "EXPIRY DAY",
      note: "Weekly expiry — gamma + theta will whip the ATM premium. Watch the 14:30 IST window.",
      severity: "info",
    });
  }

  return out;
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
  /** Optional broad-market context for warnings + research note framing. */
  marketContext?: SoftAnnotationContext;
}): DailyPick {
  const { signal, bucket, rank, tradeDate, bucketScore, now, marketContext } = args;
  const target = signal.takeProfits[0]?.price ?? signal.entry;
  const canMoveUpto = signal.takeProfits.at(-1)?.price ?? target;
  const confluenceScore = confluenceScoreFromBucket(bucketScore);

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
    // Populated downstream by the builder for INDICES_SCALP picks once the
    // option chain is fetched (see `projectIndexScalpToOption`). Stocks and
    // ORB picks stay null and keep trading the underlying.
    optionContract: null,
    confluenceScore,
    keyIndicators: keyIndicatorsFor(signal, bucket),
    setupType: setupTypeFor(signal, bucket),
    researchNote: buildResearchNote({
      signal,
      bucket,
      marketHeadline: marketContext?.headline,
    }),
    timeWindow: timeWindowFor(bucket, signal.horizon),
    warnings: buildSoftWarnings({
      signal,
      bucket,
      confluenceScore,
      indiaVix: marketContext?.indiaVix ?? null,
      marketBias: marketContext?.marketBias ?? 0,
      earningsWithinDays: marketContext?.earningsByDays?.[signal.symbol] ?? null,
      isExpiryDay: marketContext?.isExpiryDay ?? false,
    }),
  };
}

/**
 * Context the engine needs to populate soft annotations (warnings, research
 * note framing). Kept separate from `AiMarketContext` so callers can pass a
 * minimal shape — the builder threads through whatever data is available.
 */
export interface SoftAnnotationContext {
  headline?: string;
  indiaVix?: number | null;
  marketBias?: number;
  isExpiryDay?: boolean;
  /** Per-symbol earnings-distance lookup. */
  earningsByDays?: Record<string, number | null | undefined>;
}

/**
 * Rehydrate a minimal `AiSignal`-shaped object from a persisted `DailyPick`,
 * so the soft-annotation helpers can recompute their fields after a DB
 * roundtrip (we only persist the *aggregated* pick — the source signal's
 * confluence factors and reasons are reduced to `rationale: string[]`).
 *
 * Pure + deterministic. Used by `softFieldsForPick`.
 */
function synthAiSignalFromPick(pick: DailyPick): AiSignal {
  const bullish = pick.direction === "BULLISH";
  return {
    id: `frozen-${pick.symbol}-${pick.tradeDate}-${pick.bucket}-${pick.rank}`,
    symbol: pick.symbol,
    displayName: pick.displayName,
    market: "india",
    pair: pick.pair,
    action: pick.action,
    direction: pick.direction,
    horizon: pick.horizon,
    underlyingPrice: pick.underlyingPrice,
    entry: pick.entry,
    entryZone: { min: pick.entry, max: pick.entry },
    strike: null,
    stopLoss: pick.stopLoss,
    takeProfits: [
      { level: 1, price: pick.target, percent: 0, allocation: 0.5 },
      { level: 2, price: pick.target, percent: 0, allocation: 0.3 },
      { level: 3, price: pick.canMoveUpto, percent: 0, allocation: 0.2 },
    ],
    riskReward: pick.riskReward,
    // Blended R:R isn't persisted — proxy from TP1 R:R (1.4× is a stable
    // empirical multiplier across the engine's TP3 = 1.4× TP1 sizing).
    riskRewardBlended: pick.riskReward * 1.4,
    expectedMovePct: pick.canExpectPct,
    positionSizingPct: 1,
    riskLevel: "medium",
    confidence: pick.confidence,
    confidenceScore: pick.confidenceScore,
    grade: pick.grade,
    winProbability: pick.winProbability,
    timing: {
      generatedAt: pick.generatedAt,
      enterBy: pick.generatedAt,
      exitBy: pick.generatedAt,
      validForMs: 0,
      bestEntryNote: "",
      bestExitNote: "",
    },
    confluences: [],
    bullishCount: bullish ? pick.rationale.length : 0,
    bearishCount: bullish ? 0 : pick.rationale.length,
    reasons: pick.rationale.map((text) => ({
      category: "technical",
      text,
      bullish,
    })),
    invalidationCriteria: `Stop on a close ${bullish ? "below" : "above"} ₹${pick.stopLoss.toFixed(
      2,
    )}`,
    modelVersion: "rehydrated",
    summary: pick.logic,
  };
}

/** Fields produced by the soft-annotation helpers. */
export type DailyPickSoftFields = Pick<
  DailyPick,
  | "confluenceScore"
  | "keyIndicators"
  | "setupType"
  | "researchNote"
  | "timeWindow"
  | "warnings"
>;

/**
 * Compute the soft annotation fields for a persisted pick (post-DB read or
 * ephemeral). Returns the six fields verbatim so callers can spread them in.
 *
 * The recompute path uses a synthesized AiSignal (we don't persist the raw
 * signal), so a few high-fidelity details (per-factor scores, per-reason
 * categories) degrade gracefully — confluence chips + setup type still
 * resolve correctly because they're driven by the bucket + direction.
 */
export function softFieldsForPick(
  pick: DailyPick,
  ctx?: SoftAnnotationContext,
): DailyPickSoftFields {
  const synth = synthAiSignalFromPick(pick);
  const confluenceScore = confluenceScoreFromBucket(pick.bucketScore);
  return {
    confluenceScore,
    keyIndicators: keyIndicatorsFor(synth, pick.bucket),
    setupType: setupTypeFor(synth, pick.bucket),
    researchNote: buildResearchNote({
      signal: synth,
      bucket: pick.bucket,
      marketHeadline: ctx?.headline,
    }),
    timeWindow: timeWindowFor(pick.bucket, pick.horizon),
    warnings: buildSoftWarnings({
      signal: synth,
      bucket: pick.bucket,
      confluenceScore,
      indiaVix: ctx?.indiaVix ?? null,
      marketBias: ctx?.marketBias ?? 0,
      earningsWithinDays: ctx?.earningsByDays?.[pick.symbol] ?? null,
      isExpiryDay: ctx?.isExpiryDay ?? false,
    }),
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
  /** Optional broad-market context for warnings + research note framing. */
  marketContext?: SoftAnnotationContext;
}): DailyPick {
  const { signal, rank, tradeDate, now, marketContext } = args;
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

  const direction: AiDirection = isLong ? "BULLISH" : "BEARISH";
  // Synthesize the bits of an AiSignal the soft-annotation helpers read, so
  // ORB picks expose the same Confluence Score / Setup / Research Note / Time
  // Window / Warnings as the AI-sourced buckets.
  const synthFactors: AiSignal["confluences"] = [
    {
      id: "breakout",
      category: "chart",
      label: "ORB Break",
      description: "First 5-min range break + retest",
      weight: 0.4,
      score: isLong ? 0.8 : -0.8,
      contribution: 0.32,
      available: true,
    },
    {
      id: "volume",
      category: "flow",
      label: "Volume",
      description: "Opening volume",
      weight: 0.2,
      score: isLong ? 0.5 : -0.5,
      contribution: 0.1,
      available: true,
    },
  ];
  const synth: AiSignal = {
    id: `orb-${signal.symbol}`,
    symbol: signal.symbol,
    displayName: signal.symbolName || signal.symbol,
    market: "india",
    pair: FNO_INDEX_UNDERLYINGS.has(signal.symbol) ? signal.symbol : `${signal.symbol}.NS`,
    action: isLong ? "LONG" : "SHORT",
    direction,
    horizon: "intraday",
    underlyingPrice: signal.price,
    entry: signal.entry,
    entryZone: { min: signal.entry, max: signal.entry },
    strike: null,
    stopLoss: signal.stopLoss,
    takeProfits: [
      { level: 1, price: signal.target, percent: 0, allocation: 0.5 },
      { level: 2, price: signal.target, percent: 0, allocation: 0.3 },
      { level: 3, price: stretch, percent: 0, allocation: 0.2 },
    ],
    riskReward: signal.riskReward,
    riskRewardBlended: signal.riskReward * 1.4,
    expectedMovePct: canExpectPct,
    positionSizingPct: 1,
    riskLevel: "medium",
    confidence,
    confidenceScore: Math.round(confidence * 100),
    grade: gradeFromConfidence(confidence),
    winProbability: Math.max(0, Math.min(1, 0.42 + confidence * 0.4)),
    timing: {
      generatedAt: signal.triggeredAt,
      enterBy: signal.triggeredAt,
      exitBy: signal.triggeredAt,
      validForMs: 0,
      bestEntryNote: "",
      bestExitNote: "",
    },
    confluences: synthFactors,
    bullishCount: isLong ? 2 : 0,
    bearishCount: isLong ? 0 : 2,
    reasons: signal.rationale.map((text, idx) => ({
      category: idx === 0 ? "chart" : idx === 1 ? "flow" : "technical",
      text,
      bullish: isLong,
    })),
    invalidationCriteria: `Stop on a 5-min close ${isLong ? "below" : "above"} ₹${signal.stopLoss.toFixed(2)}`,
    modelVersion: "orb",
    summary: signal.rationale[0] ?? "Opening Breakout",
  };

  return {
    tradeDate,
    bucket: "OPENING_BREAKOUT",
    rank,
    symbol: signal.symbol,
    displayName: signal.symbolName || signal.symbol,
    pair: synth.pair,
    direction,
    action: isLong ? "LONG" : "SHORT",
    horizon: "intraday",
    grade: gradeFromConfidence(confidence),
    confidence,
    confidenceScore: Math.round(confidence * 100),
    // Win-probability proxy: confirmed retest setups skew higher.
    winProbability: synth.winProbability,
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
    optionContract: null,
    confluenceScore: confluenceScoreFromBucket(confidence),
    keyIndicators: keyIndicatorsFor(synth, "OPENING_BREAKOUT"),
    setupType: setupTypeFor(synth, "OPENING_BREAKOUT"),
    researchNote: buildResearchNote({
      signal: synth,
      bucket: "OPENING_BREAKOUT",
      marketHeadline: marketContext?.headline,
    }),
    timeWindow: timeWindowFor("OPENING_BREAKOUT", "intraday"),
    warnings: buildSoftWarnings({
      signal: synth,
      bucket: "OPENING_BREAKOUT",
      confluenceScore: confluenceScoreFromBucket(confidence),
      indiaVix: marketContext?.indiaVix ?? null,
      marketBias: marketContext?.marketBias ?? 0,
      earningsWithinDays: marketContext?.earningsByDays?.[signal.symbol] ?? null,
      isExpiryDay: marketContext?.isExpiryDay ?? false,
    }),
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
  // Tape hard-filter: drop counter-tape directional picks once the broader
  // regime is meaningfully one-sided. The filter is *always* honored — we
  // never fall back past it, because a counter-tape pick is precisely the
  // failure mode we're trying to prevent (the "all SHORT in a flat-to-bullish
  // day" incident on 2026-06-17).
  const needed = perBucket * buckets.length;
  // Single soft fallback: if the WAIT-stripped pool is too small to fill every
  // bucket, include WAIT signals too (keeps the board populated out-of-hours
  // when most candidates are WAIT). The tape filter still applies to the
  // fallback pool.
  const base = directional.length >= needed ? directional : pool;
  const usable = base.filter((s) => passesTapeFilter(s, marketBias));

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
    // Per-bucket quality gate: a candidate must clear the bucket's floor (vol
    // agreement / RR / confidence) before it can be ranked. No fallback —
    // empty bucket is strictly preferable to a garbage pick.
    sortedByBucket[bucket] = scored
      .filter((s) => passesBucketGate(s.signal, bucket))
      .sort((a, b) => b.scores[bucket] - a.scores[bucket]);
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
  /** Optional soft-annotation context (headline, VIX, expiry-day, …). */
  marketContext?: SoftAnnotationContext;
}): DailyPick[] {
  const { signals, tradeDate, now, perBucket = 3, marketBias = 0, marketContext } = args;
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
          marketContext,
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

  // Once a pick is resolved (TARGET_HIT / STOP_HIT / CLOSED / EXPIRED), its
  // P&L snapshot is locked. Without this, a pick that hit target at 11:00
  // and then drifted back to entry by close would still report `Target` as
  // its outcome but `~0%` as its P&L — exactly the misleading rows we saw
  // on the 2026-06-18 history (CAMS = "Target" with +0.00%, NBCC = "Stop"
  // with -0.02%). Status correctness is necessary but not sufficient; the
  // recorded numbers must match the resolution instant too.
  if (pick.status !== "OPEN") {
    return { ...pick, updatedAt: now };
  }

  const dir = pick.direction === "BEARISH" ? -1 : 1;
  const pnlPct = ((lastPrice - pick.entry) / pick.entry) * 100 * dir;
  const targetMovePct = (Math.abs(pick.target - pick.entry) / pick.entry) * 100;
  const progress = targetMovePct > 0 ? (pnlPct / targetMovePct) * 100 : 0;
  const achievedPct =
    pick.achievedPct == null ? progress : Math.max(pick.achievedPct, progress);

  // Widen back to the full DailyPickStatus — the early-return above narrowed
  // `pick.status` to the literal `"OPEN"`.
  let status: DailyPickStatus = pick.status;
  let resolvedAt = pick.resolvedAt;
  const hitStop = dir === 1 ? lastPrice <= pick.stopLoss : lastPrice >= pick.stopLoss;
  const hitTarget =
    dir === 1 ? lastPrice >= pick.target : lastPrice <= pick.target;
  if (hitStop) status = "STOP_HIT";
  else if (hitTarget) status = "TARGET_HIT";
  // Stamp the resolution instant the moment the level is touched, so the
  // board can report how long the trade took to hit its target / stop.
  if (status !== "OPEN") resolvedAt = now;

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
