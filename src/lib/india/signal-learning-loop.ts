/**
 * India Signal Closed-Loop Learning System
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Closes the empirical loop that every prior report pointed to
 * (`INDIA_SIGNAL_FORENSIC_AUDIT.md` … `INDIA_PROFITABILITY_ENGINE.md`):
 *
 *   signal → auditable prediction record → chronological outcome → rolling
 *   statistics → DELAYED, OOS-only retraining → champion/challenger promotion.
 *
 * Design pillars:
 *   1. Every generated signal becomes an immutable, auditable PredictionRecord
 *      (all creation-time fields) and gains a ResolutionRecord at close.
 *   2. Outcomes are decided by the ACTUAL execution policy walked
 *      CHRONOLOGICALLY — never by final price direction. If stop and target are
 *      both touched in the same candle and intrabar ordering is unknown, the
 *      result is AMBIGUOUS (never assumed favorable). This is the anti–backtest-
 *      inflation rule.
 *   3. Rolling statistics (20/50/100/250) across many dimensions, gated by
 *      sample size.
 *   4. Retraining is DELAYED: same-day outcomes are embargoed; live models are
 *      never updated from outcomes they could have influenced. Evaluation is
 *      strictly out-of-sample.
 *   5. Champion/Challenger: a candidate replaces the champion ONLY on
 *      statistically-meaningful OOS improvement across a full metric battery.
 *
 * All computation is deterministic and I/O-free (persistence is an injected
 * interface), so records and decisions are reproducible and auditable.
 */

export const SIGNAL_LEARNING_LOOP_VERSION = "sll-1.0.0";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Outcome states & records
// ═══════════════════════════════════════════════════════════════════════════

/** Terminal outcome states. AMBIGUOUS is a resolution *quality* flag (see below). */
export type OutcomeState =
  | "TARGET_HIT"
  | "STOP_HIT"
  | "TIME_EXIT"
  | "MANUAL_CLOSE"
  | "INVALIDATED"
  | "NO_FILL"
  | "CANCELLED";

export type SignalDirection = "LONG" | "SHORT";
export type LearnRegime = "BULL_TREND" | "BEAR_TREND" | "RANGE" | "HIGH_VOL" | "LOW_VOL" | "UNKNOWN";
export type LearnTimeframe = "SCALP" | "INTRADAY" | "SWING";
export type LearnInstrument = "INDEX_OPTION" | "STOCK_OPTION" | "INDEX_FUT" | "STOCK_FUT" | "EQUITY";
export type LearnGrade = "A_PLUS" | "A" | "B" | "C" | "REJECT";

/**
 * The auditable prediction record persisted AT SIGNAL CREATION. Immutable once
 * written — the resolution record is a separate append.
 */
export interface PredictionRecord {
  signalId: string;
  symbol: string;
  strategy: string;
  direction: SignalDirection;
  /** Signal generation time (UTC ms). */
  timestamp: number;
  entry: number;
  stop: number;
  targets: number[];
  timeframe: LearnTimeframe;
  regime: LearnRegime;
  instrumentType: LearnInstrument;
  sector: string | null;

  // ── scoring provenance (from the six engines) ──
  signalQuality: number;          // 0–100 predictive quality
  grade: LearnGrade;
  rawConfidence: number;          // heuristic conviction (NOT probability)
  calibratedProbability: number;  // empirically OOS-calibrated P(profit)
  expectedValue: number;          // net EV in R
  modelContributions: Record<string, number>; // per-model weight/contribution
  qualityComponents: Record<string, number>;  // per-component quality attribution
  abstentionDecision: boolean;    // did the meta layer abstain?

  // ── snapshots (immutable evidence at signal time) ──
  featureSnapshot: Record<string, number>;
  derivativesSnapshot: Record<string, number | null>;
  marketContext: Record<string, number | null>;

  // ── data / execution quality at signal time ──
  dataQuality: number;            // [0,1]
  liquidity: number;              // [0,1]
  costEstimate: number;           // % of entry (round-trip)
  slippageEstimate: number;       // % of entry (round-trip)

  // ── model provenance (for champion/challenger attribution) ──
  modelVersion: string;
  /** IST calendar day key (YYYY-MM-DD) — used for the same-day embargo. */
  tradeDate: string;
}

/**
 * The resolution record appended AT CLOSE. `ambiguous` marks a resolution whose
 * ordering could not be determined intrabar (both stop & target touched in one
 * candle) — such trades are EXCLUDED from win-rate/expectancy aggregation to
 * avoid inflation.
 */
export interface ResolutionRecord {
  signalId: string;
  outcome: OutcomeState;
  exit: number | null;
  exitTime: number | null;        // UTC ms
  returnPct: number | null;
  returnR: number | null;
  mfe: number;                    // max favorable excursion (% of entry)
  mae: number;                    // max adverse excursion (% of entry)
  holdingTimeMs: number | null;
  targetReached: boolean;
  stopReached: boolean;
  costActual: number;             // % of entry
  slippageActual: number;         // % of entry
  netReturn: number | null;       // returnPct − costActual − slippageActual
  regimeDuringTrade: LearnRegime;
  /** True when intrabar ordering could not be determined — excluded from stats. */
  ambiguous: boolean;
  resolvedAt: number;             // UTC ms
}

/** A completed observation = prediction + resolution, used by the stats + trainer. */
export interface CompletedObservation {
  prediction: PredictionRecord;
  resolution: ResolutionRecord;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Persistence interface (injected; unit-testable)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The learning loop is persistence-agnostic. A production adapter maps these to
 * Prisma; the in-memory implementation below backs the tests.
 */
export interface SignalRecordStore {
  savePrediction(record: PredictionRecord): Promise<void>;
  saveResolution(record: ResolutionRecord): Promise<void>;
  getPrediction(signalId: string): Promise<PredictionRecord | null>;
  listCompleted(): Promise<CompletedObservation[]>;
  listOpenPredictions(): Promise<PredictionRecord[]>;
}

/** Deterministic in-memory store (tests + local). */
export class InMemorySignalRecordStore implements SignalRecordStore {
  private predictions = new Map<string, PredictionRecord>();
  private resolutions = new Map<string, ResolutionRecord>();

  async savePrediction(record: PredictionRecord): Promise<void> {
    if (this.predictions.has(record.signalId)) {
      throw new Error(`prediction already exists (immutable): ${record.signalId}`);
    }
    this.predictions.set(record.signalId, { ...record });
  }
  async saveResolution(record: ResolutionRecord): Promise<void> {
    if (!this.predictions.has(record.signalId)) {
      throw new Error(`cannot resolve unknown signal: ${record.signalId}`);
    }
    this.resolutions.set(record.signalId, { ...record });
  }
  async getPrediction(signalId: string): Promise<PredictionRecord | null> {
    return this.predictions.get(signalId) ?? null;
  }
  async listCompleted(): Promise<CompletedObservation[]> {
    const out: CompletedObservation[] = [];
    for (const [id, resolution] of this.resolutions) {
      const prediction = this.predictions.get(id);
      if (prediction) out.push({ prediction, resolution });
    }
    // deterministic order: by resolution time then signalId
    out.sort((a, b) => a.resolution.resolvedAt - b.resolution.resolvedAt || (a.prediction.signalId < b.prediction.signalId ? -1 : 1));
    return out;
  }
  async listOpenPredictions(): Promise<PredictionRecord[]> {
    return [...this.predictions.values()].filter((p) => !this.resolutions.has(p.signalId));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Chronological outcome evaluation (anti-inflation)
// ═══════════════════════════════════════════════════════════════════════════

/** OHLC candle for path evaluation. `time` in UTC seconds. */
export interface EvalCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface EvalPolicy {
  direction: SignalDirection;
  entry: number;
  stop: number;
  /** Primary target used for the outcome (first target hit resolves). */
  target: number;
  entryTimeMs: number;
  /** Max holding time (ms) → TIME_EXIT if neither hit. */
  maxHoldingMs: number;
  /** Round-trip cost & slippage (% of entry) for net return. */
  costPct: number;
  slippagePct: number;
  regimeDuringTrade: LearnRegime;
  /**
   * Whether intrabar tick ordering is available. When false and a single candle
   * touches BOTH stop and target, the result is AMBIGUOUS (never favorable).
   */
  intrabarOrderingAvailable?: boolean;
}

/**
 * Walk candles chronologically and resolve the trade by the ACTUAL execution
 * policy. Returns a `ResolutionRecord` (minus signalId, filled by the caller).
 *
 * The critical anti-inflation rule: if a single candle touches BOTH stop and
 * target and intrabar ordering is unavailable, `ambiguous = true` and the
 * outcome is recorded as `STOP_HIT` for P&L conservatism BUT flagged so
 * aggregation EXCLUDES it — a backtest must never assume the favorable fill.
 */
export function evaluateOutcome(
  candles: ReadonlyArray<EvalCandle>,
  policy: EvalPolicy,
): Omit<ResolutionRecord, "signalId"> {
  const isLong = policy.direction === "LONG";
  const entry = policy.entry;
  const pnlPct = (exit: number): number => {
    if (entry <= 0) return 0;
    const raw = (exit - entry) / entry;
    return (isLong ? raw : -raw) * 100;
  };
  const riskPct = entry > 0 ? Math.abs(entry - policy.stop) / entry * 100 : 0;

  let mfe = 0; // max favorable excursion (%)
  let mae = 0; // max adverse excursion (%)
  let ambiguous = false;

  const finalize = (
    outcome: OutcomeState,
    exit: number | null,
    exitTime: number | null,
    targetReached: boolean,
    stopReached: boolean,
    amb: boolean,
  ): Omit<ResolutionRecord, "signalId"> => {
    const returnPct = exit != null ? pnlPct(exit) : null;
    const returnR = returnPct != null && riskPct > 0 ? returnPct / riskPct : null;
    const netReturn = returnPct != null ? returnPct - policy.costPct - policy.slippagePct : null;
    return {
      outcome, exit, exitTime, returnPct, returnR, mfe, mae,
      holdingTimeMs: exitTime != null ? exitTime - policy.entryTimeMs : null,
      targetReached, stopReached,
      costActual: policy.costPct, slippageActual: policy.slippagePct,
      netReturn, regimeDuringTrade: policy.regimeDuringTrade,
      ambiguous: amb, resolvedAt: exitTime ?? policy.entryTimeMs,
    };
  };

  for (const c of candles) {
    const cTimeMs = c.time * 1000;
    if (cTimeMs < policy.entryTimeMs) continue; // pre-entry candles ignored

    // update excursions (favorable / adverse extremes within the candle)
    const favExtreme = isLong ? c.high : c.low;
    const advExtreme = isLong ? c.low : c.high;
    mfe = Math.max(mfe, pnlPct(favExtreme));
    mae = Math.min(mae, pnlPct(advExtreme));

    const hitStop = isLong ? c.low <= policy.stop : c.high >= policy.stop;
    const hitTarget = isLong ? c.high >= policy.target : c.low <= policy.target;

    if (hitStop && hitTarget) {
      // Both touched in one candle. Only trust ordering if intrabar data says so.
      if (policy.intrabarOrderingAvailable) {
        // With ordering, the caller is expected to have pre-split; without a
        // tick feed here we still cannot know → treat as ambiguous unless the
        // open already sat beyond one level (a gap that resolves ordering).
        const openBeyondTarget = isLong ? c.open >= policy.target : c.open <= policy.target;
        const openBeyondStop = isLong ? c.open <= policy.stop : c.open >= policy.stop;
        if (openBeyondTarget && !openBeyondStop) {
          return finalize("TARGET_HIT", policy.target, cTimeMs, true, false, false);
        }
        if (openBeyondStop && !openBeyondTarget) {
          return finalize("STOP_HIT", policy.stop, cTimeMs, false, true, false);
        }
      }
      // ambiguous: record conservatively as a stop for P&L, flag for exclusion.
      ambiguous = true;
      return finalize("STOP_HIT", policy.stop, cTimeMs, true, true, true);
    }
    if (hitStop) return finalize("STOP_HIT", policy.stop, cTimeMs, false, true, false);
    if (hitTarget) return finalize("TARGET_HIT", policy.target, cTimeMs, true, false, false);

    if (cTimeMs - policy.entryTimeMs >= policy.maxHoldingMs) {
      return finalize("TIME_EXIT", c.close, cTimeMs, false, false, false);
    }
  }

  // No candle resolved and holding time not exceeded within the data → TIME_EXIT
  // at the last available close, or unresolved if there is no post-entry data.
  const post = candles.filter((c) => c.time * 1000 >= policy.entryTimeMs);
  if (post.length === 0) {
    return finalize("NO_FILL", null, null, false, false, false);
  }
  const last = post[post.length - 1]!;
  void ambiguous;
  return finalize("TIME_EXIT", last.close, last.time * 1000, false, false, false);
}

/** Is this observation eligible for statistics (resolved, non-ambiguous, filled)? */
export function isStatEligible(r: ResolutionRecord): boolean {
  if (r.ambiguous) return false;
  if (r.outcome === "NO_FILL" || r.outcome === "CANCELLED" || r.outcome === "INVALIDATED") return false;
  return r.returnPct != null;
}

/** Binary win label by the execution policy (net of costs) — NOT price direction. */
export function isWin(r: ResolutionRecord): boolean {
  return r.outcome === "TARGET_HIT" || (r.netReturn != null && r.netReturn > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Rolling statistics across dimensions
// ═══════════════════════════════════════════════════════════════════════════

const meanOf = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((s, x) => s + x, 0) / a.length);
const stdOf = (a: number[]): number => {
  if (a.length < 2) return 0;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
function profitFactorR(rs: number[]): number {
  const w = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const l = Math.abs(rs.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  return l === 0 ? (w > 0 ? Infinity : 0) : w / l;
}
function maxDrawdownR(rs: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/** The dimensions the brief requires rolling stats over. */
export const STAT_DIMENSIONS = [
  "strategy", "symbol", "sector", "regime", "timeframe", "grade",
  "qualityBucket", "probabilityBucket", "timeOfDay", "side", "instrument",
] as const;
export type StatDimension = (typeof STAT_DIMENSIONS)[number];

/** Rolling-window sizes. */
export const ROLLING_WINDOWS = [20, 50, 100, 250] as const;

export interface RollingWindowStat {
  window: number;
  n: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  avgReturnPct: number;
  sharpe: number;              // per-trade Sharpe (mean/std of R)
  maxDrawdownR: number;
  brier: number;               // calibration: mean((p − outcome)²)
  /** Whether n meets the window's own size (enough data). */
  full: boolean;
  /** Statistically reliable (n ≥ minReliable). */
  reliable: boolean;
}

export interface DimensionBucketStats {
  dimension: StatDimension;
  bucket: string;
  windows: RollingWindowStat[];
}

function bucketValue(dim: StatDimension, obs: CompletedObservation): string {
  const p = obs.prediction;
  switch (dim) {
    case "strategy": return p.strategy;
    case "symbol": return p.symbol;
    case "sector": return p.sector ?? "UNKNOWN";
    case "regime": return obs.resolution.regimeDuringTrade;
    case "timeframe": return p.timeframe;
    case "grade": return p.grade;
    case "qualityBucket": return qualityBucket(p.signalQuality);
    case "probabilityBucket": return probabilityBucket(p.calibratedProbability);
    case "timeOfDay": return todBucket(p.timestamp);
    case "side": return p.direction;
    case "instrument": return p.instrumentType;
  }
}

export function qualityBucket(q: number): string {
  if (q >= 90) return "90-100";
  if (q >= 80) return "80-90";
  if (q >= 70) return "70-80";
  if (q >= 60) return "60-70";
  if (q >= 50) return "50-60";
  if (q >= 40) return "40-50";
  return "0-40";
}
export function probabilityBucket(p: number): string {
  if (p >= 0.8) return "0.80-1.00";
  if (p >= 0.7) return "0.70-0.80";
  if (p >= 0.6) return "0.60-0.70";
  if (p >= 0.55) return "0.55-0.60";
  if (p >= 0.5) return "0.50-0.55";
  return "0.00-0.50";
}
export function todBucket(timestampMs: number): string {
  const IST = timestampMs + 5.5 * 3600 * 1000;
  const d = new Date(IST);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const fromOpen = mins - (9 * 60 + 15);
  if (fromOpen < 15) return "09:15-09:30";
  if (fromOpen < 45) return "09:30-10:00";
  if (fromOpen < 105) return "10:00-11:00";
  if (fromOpen < 225) return "11:00-13:00";
  if (fromOpen < 345) return "13:00-15:00";
  return "15:00-15:30";
}

/**
 * Compute rolling window stats for one ordered set of observations (most recent
 * last). Each window uses the LAST `window` stat-eligible observations.
 */
function rollingStatsFor(obs: CompletedObservation[], minReliable = 30): RollingWindowStat[] {
  const eligible = obs.filter((o) => isStatEligible(o.resolution));
  return ROLLING_WINDOWS.map((window) => {
    const slice = eligible.slice(-window);
    const n = slice.length;
    const rs = slice.map((o) => o.resolution.returnR ?? 0);
    const rets = slice.map((o) => o.resolution.returnPct ?? 0);
    const wins = slice.filter((o) => isWin(o.resolution)).length;
    const preds = slice.map((o) => o.prediction.calibratedProbability);
    const labels = slice.map((o) => (isWin(o.resolution) ? 1 : 0));
    const brier = n > 0 ? meanOf(preds.map((p, i) => (p - labels[i]!) ** 2)) : 1;
    const sd = stdOf(rs);
    return {
      window,
      n,
      winRate: n > 0 ? wins / n : 0,
      expectancyR: meanOf(rs),
      profitFactor: (() => { const pf = profitFactorR(rs); return Number.isFinite(pf) ? pf : 0; })(),
      avgReturnPct: meanOf(rets),
      sharpe: sd === 0 ? 0 : meanOf(rs) / sd,
      maxDrawdownR: maxDrawdownR(rs),
      brier,
      full: n >= window,
      reliable: n >= minReliable,
    };
  });
}

/**
 * Build rolling statistics across ALL required dimensions and buckets. Only
 * buckets with data are returned. Deterministic ordering.
 */
export function buildRollingStatistics(
  observations: CompletedObservation[],
  minReliable = 30,
): DimensionBucketStats[] {
  // chronological order so "rolling" windows are time-correct
  const ordered = [...observations].sort((a, b) => a.resolution.resolvedAt - b.resolution.resolvedAt);
  const out: DimensionBucketStats[] = [];
  for (const dim of STAT_DIMENSIONS) {
    const byBucket = new Map<string, CompletedObservation[]>();
    for (const o of ordered) {
      const b = bucketValue(dim, o);
      const arr = byBucket.get(b);
      if (arr) arr.push(o);
      else byBucket.set(b, [o]);
    }
    for (const [bucket, rows] of [...byBucket.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      out.push({ dimension: dim, bucket, windows: rollingStatsFor(rows, minReliable) });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Delayed retraining bus (same-day embargo + OOS split)
// ═══════════════════════════════════════════════════════════════════════════

/** The learnable targets updated by the loop (never live, never same-day). */
export type RetrainTarget =
  | "calibration"
  | "qualityScore"
  | "strategyHealth"
  | "gradeThresholds"
  | "modelWeights"
  | "featureImportance"
  | "abstentionThresholds";

export const RETRAIN_TARGETS: RetrainTarget[] = [
  "calibration", "qualityScore", "strategyHealth", "gradeThresholds",
  "modelWeights", "featureImportance", "abstentionThresholds",
];

export interface RetrainConfig {
  /** Outcomes resolved on/after (asOfDay − embargoDays) are EXCLUDED from training. */
  embargoDays: number;
  /** Fraction of the (embargoed) history used to FIT; the rest is untouched OOS eval. */
  trainFraction: number;
  /** Minimum eligible observations before a retrain is allowed to produce a candidate. */
  minObservations: number;
}

export const DEFAULT_RETRAIN_CONFIG: RetrainConfig = {
  embargoDays: 1,       // never learn from today's (or the boundary day's) outcomes
  trainFraction: 0.6,
  minObservations: 100,
};

export interface RetrainSplit {
  /** Observations eligible to FIT a challenger (embargoed + train portion). */
  train: CompletedObservation[];
  /** Untouched OOS observations used to EVALUATE the challenger. */
  oos: CompletedObservation[];
  /** Observations excluded by the same-day/boundary embargo. */
  embargoed: CompletedObservation[];
  note: string;
}

/** Parse an IST YYYY-MM-DD day key to a comparable ordinal. */
function dayOrdinal(dayKey: string): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return (y ?? 0) * 372 + (m ?? 0) * 31 + (d ?? 0);
}

/**
 * Build the delayed-retraining split.
 *
 * The EMBARGO is the crux of "never update live models from the same day's
 * outcomes": any observation whose `tradeDate` is within `embargoDays` of
 * `asOfDay` is excluded entirely. The remaining history is split chronologically
 * into a fit set (early) and an UNTOUCHED OOS set (late) — the champion/
 * challenger comparison only ever runs on the OOS set.
 */
export function buildRetrainSplit(
  observations: CompletedObservation[],
  asOfDay: string,
  cfg: RetrainConfig = DEFAULT_RETRAIN_CONFIG,
): RetrainSplit {
  const asOfOrd = dayOrdinal(asOfDay);
  const embargoed: CompletedObservation[] = [];
  const usable: CompletedObservation[] = [];
  for (const o of observations) {
    const ord = dayOrdinal(o.prediction.tradeDate);
    // embargo the last `embargoDays` days up to and including asOfDay
    if (asOfOrd - ord < cfg.embargoDays || ord >= asOfOrd) embargoed.push(o);
    else usable.push(o);
  }
  usable.sort((a, b) => a.resolution.resolvedAt - b.resolution.resolvedAt);
  const cut = Math.floor(usable.length * cfg.trainFraction);
  const train = usable.slice(0, cut);
  const oos = usable.slice(cut);
  return {
    train,
    oos,
    embargoed,
    note: `usable=${usable.length} train=${train.length} oos=${oos.length} embargoed=${embargoed.length} (embargoDays=${cfg.embargoDays})`,
  };
}

/**
 * A guard the LIVE path calls before applying any retrained artifact. It asserts
 * the artifact was NOT fit on any observation from `asOfDay` (or within the
 * embargo). Returns false (and a reason) if any training observation violates
 * the embargo — a hard stop against same-day leakage into the live model.
 */
export function assertNoSameDayLeakage(
  trainObservations: CompletedObservation[],
  asOfDay: string,
  cfg: RetrainConfig = DEFAULT_RETRAIN_CONFIG,
): { ok: boolean; reason: string } {
  const asOfOrd = dayOrdinal(asOfDay);
  for (const o of trainObservations) {
    const ord = dayOrdinal(o.prediction.tradeDate);
    if (asOfOrd - ord < cfg.embargoDays || ord >= asOfOrd) {
      return { ok: false, reason: `same_day_or_embargoed_observation_in_train:${o.prediction.signalId}@${o.prediction.tradeDate}` };
    }
  }
  return { ok: true, reason: "no_embargo_violation" };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Champion / Challenger
// ═══════════════════════════════════════════════════════════════════════════

/** The full metric battery computed on an OOS observation set. */
export interface MetricBattery {
  n: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdownR: number;
  /** Calibration slope proxy: 1 = perfect; via reliability gap. */
  calibrationGap: number;   // mean|predicted − realized| (lower better)
  brier: number;            // lower better
  ece: number;              // lower better
  turnover: number;         // trades per eligible day (proxy)
  costAdjustedReturnPct: number; // Σ netReturn
  /** Regime robustness: min per-regime expectancy (higher/less-negative better). */
  regimeRobustness: number;
}

/** Compute the metric battery for a model over its OOS observations. */
export function computeMetricBattery(oos: CompletedObservation[]): MetricBattery {
  const eligible = oos.filter((o) => isStatEligible(o.resolution));
  const n = eligible.length;
  const rs = eligible.map((o) => o.resolution.returnR ?? 0);
  const wins = eligible.filter((o) => isWin(o.resolution)).length;
  const preds = eligible.map((o) => o.prediction.calibratedProbability);
  const labels = eligible.map((o) => (isWin(o.resolution) ? 1 : 0));
  const sd = stdOf(rs);
  const brier = n > 0 ? meanOf(preds.map((p, i) => (p - labels[i]!) ** 2)) : 1;

  // ECE over 10 bins
  let ece = 0;
  if (n > 0) {
    for (let b = 0; b < 10; b++) {
      const lo = b / 10;
      const hi = (b + 1) / 10;
      const idx = preds.map((p, i) => ({ p, y: labels[i]! })).filter((x) => x.p >= lo && (x.p < hi || (b === 9 && x.p <= hi)));
      if (idx.length === 0) continue;
      const mp = meanOf(idx.map((x) => x.p));
      const mr = meanOf(idx.map((x) => x.y));
      ece += (idx.length / n) * Math.abs(mp - mr);
    }
  }
  const calibrationGap = n > 0 ? Math.abs(meanOf(preds) - meanOf(labels)) : 1;

  // regime robustness: worst per-regime expectancy
  const byRegime = new Map<string, number[]>();
  for (const o of eligible) {
    const r = o.resolution.regimeDuringTrade;
    const arr = byRegime.get(r);
    if (arr) arr.push(o.resolution.returnR ?? 0);
    else byRegime.set(r, [o.resolution.returnR ?? 0]);
  }
  const regimeExps = [...byRegime.values()].filter((a) => a.length >= 10).map((a) => meanOf(a));
  const regimeRobustness = regimeExps.length > 0 ? Math.min(...regimeExps) : (n > 0 ? meanOf(rs) : 0);

  // turnover proxy: trades per distinct trade-day
  const days = new Set(eligible.map((o) => o.prediction.tradeDate));
  const turnover = days.size > 0 ? n / days.size : 0;

  const pf = profitFactorR(rs);
  return {
    n,
    winRate: n > 0 ? wins / n : 0,
    expectancyR: meanOf(rs),
    profitFactor: Number.isFinite(pf) ? pf : 0,
    sharpe: sd === 0 ? 0 : meanOf(rs) / sd,
    maxDrawdownR: maxDrawdownR(rs),
    calibrationGap,
    brier,
    ece,
    turnover,
    costAdjustedReturnPct: eligible.reduce((s, o) => s + (o.resolution.netReturn ?? 0), 0),
    regimeRobustness,
  };
}

export type PromotionDecision = "PROMOTE" | "HOLD" | "REJECT";

export interface ChampionChallengerConfig {
  /** Minimum OOS observations before any promotion is even considered. */
  minOosSample: number;
  /** Minimum expectancy improvement (R) to count as meaningful. */
  minExpectancyGain: number;
  /** Challenger must not worsen Brier/ECE beyond this tolerance. */
  maxCalibrationRegression: number;
  /** Challenger must not worsen max drawdown beyond this factor. */
  maxDrawdownRegressionFactor: number;
  /** Bootstrap-style z threshold on expectancy improvement (statistical gate). */
  minZ: number;
}

export const DEFAULT_CHAMPION_CHALLENGER_CONFIG: ChampionChallengerConfig = {
  minOosSample: 100,
  minExpectancyGain: 0.05,
  maxCalibrationRegression: 0.02,
  maxDrawdownRegressionFactor: 1.25,
  minZ: 1.96,
};

export interface ChampionChallengerResult {
  decision: PromotionDecision;
  champion: MetricBattery;
  challenger: MetricBattery;
  /** Per-metric pass/fail on the required comparison battery. */
  checks: Array<{ metric: string; champion: number; challenger: number; better: boolean; required: boolean }>;
  z: number;
  reasons: string[];
}

/**
 * Compare a challenger to the champion on UNTOUCHED OOS data across the full
 * required battery (win rate, expectancy, profit factor, Sharpe, max drawdown,
 * calibration, Brier, ECE, turnover, cost-adjusted return, regime robustness).
 *
 * PROMOTE only when the challenger shows a STATISTICALLY MEANINGFUL improvement
 * (expectancy gain ≥ threshold AND z ≥ minZ) WITHOUT regressing calibration or
 * drawdown, and with adequate OOS sample. Otherwise HOLD (keep champion) or
 * REJECT (challenger clearly worse). Nothing is ever auto-promoted to LIVE
 * without passing this gate.
 */
export function evaluateChampionChallenger(
  championOos: CompletedObservation[],
  challengerOos: CompletedObservation[],
  cfg: ChampionChallengerConfig = DEFAULT_CHAMPION_CHALLENGER_CONFIG,
): ChampionChallengerResult {
  const champion = computeMetricBattery(championOos);
  const challenger = computeMetricBattery(challengerOos);
  const reasons: string[] = [];

  const higherBetter = (m: keyof MetricBattery) => (challenger[m] as number) >= (champion[m] as number);
  const lowerBetter = (m: keyof MetricBattery) => (challenger[m] as number) <= (champion[m] as number);

  const checks: ChampionChallengerResult["checks"] = [
    { metric: "winRate", champion: champion.winRate, challenger: challenger.winRate, better: higherBetter("winRate"), required: false },
    { metric: "expectancyR", champion: champion.expectancyR, challenger: challenger.expectancyR, better: higherBetter("expectancyR"), required: true },
    { metric: "profitFactor", champion: champion.profitFactor, challenger: challenger.profitFactor, better: higherBetter("profitFactor"), required: false },
    { metric: "sharpe", champion: champion.sharpe, challenger: challenger.sharpe, better: higherBetter("sharpe"), required: false },
    { metric: "maxDrawdownR", champion: champion.maxDrawdownR, challenger: challenger.maxDrawdownR, better: lowerBetter("maxDrawdownR"), required: false },
    { metric: "calibrationGap", champion: champion.calibrationGap, challenger: challenger.calibrationGap, better: lowerBetter("calibrationGap"), required: false },
    { metric: "brier", champion: champion.brier, challenger: challenger.brier, better: lowerBetter("brier"), required: true },
    { metric: "ece", champion: champion.ece, challenger: challenger.ece, better: lowerBetter("ece"), required: false },
    { metric: "turnover", champion: champion.turnover, challenger: challenger.turnover, better: true, required: false },
    { metric: "costAdjustedReturnPct", champion: champion.costAdjustedReturnPct, challenger: challenger.costAdjustedReturnPct, better: higherBetter("costAdjustedReturnPct"), required: true },
    { metric: "regimeRobustness", champion: champion.regimeRobustness, challenger: challenger.regimeRobustness, better: higherBetter("regimeRobustness"), required: false },
  ];

  // Statistical gate on expectancy improvement (two-sample z on R means).
  const chRs = challengerOos.filter((o) => isStatEligible(o.resolution)).map((o) => o.resolution.returnR ?? 0);
  const cpRs = championOos.filter((o) => isStatEligible(o.resolution)).map((o) => o.resolution.returnR ?? 0);
  const se = Math.sqrt(variance(chRs) / Math.max(1, chRs.length) + variance(cpRs) / Math.max(1, cpRs.length));
  const gain = challenger.expectancyR - champion.expectancyR;
  const z = se > 0 ? gain / se : 0;

  // Decision gates.
  if (challenger.n < cfg.minOosSample || champion.n < cfg.minOosSample) {
    reasons.push(`insufficient_oos_sample:challenger=${challenger.n},champion=${champion.n}<${cfg.minOosSample}`);
    return { decision: "HOLD", champion, challenger, checks, z, reasons };
  }

  const requiredMetricsPass = checks.filter((c) => c.required).every((c) => c.better);
  // Calibration guard. Brier is a strict proper scoring rule (captures both
  // calibration and sharpness) and is the PRIMARY gate: the challenger must not
  // regress Brier beyond tolerance. ECE is secondary — a small ECE wobble is
  // acceptable when Brier clearly improves (a coincidentally-perfect champion
  // ECE must not veto a genuinely better-scoring challenger). ECE only blocks
  // when it regresses AND Brier did not improve.
  const brierOk = challenger.brier <= champion.brier + cfg.maxCalibrationRegression;
  const brierImproved = challenger.brier < champion.brier - 1e-9;
  const eceOk = challenger.ece <= champion.ece + cfg.maxCalibrationRegression || brierImproved;
  const calibrationOk = brierOk && eceOk;
  const drawdownOk = challenger.maxDrawdownR <= champion.maxDrawdownR * cfg.maxDrawdownRegressionFactor + 1e-9;
  const meaningfulGain = gain >= cfg.minExpectancyGain && z >= cfg.minZ;

  if (!calibrationOk) reasons.push("challenger_calibration_regressed");
  if (!drawdownOk) reasons.push("challenger_drawdown_regressed");
  if (!requiredMetricsPass) reasons.push("challenger_failed_required_metrics");
  if (!meaningfulGain) reasons.push(`expectancy_gain_not_meaningful:gain=${gain.toFixed(3)},z=${z.toFixed(2)}`);

  if (requiredMetricsPass && calibrationOk && drawdownOk && meaningfulGain) {
    reasons.push("statistically_meaningful_oos_improvement");
    return { decision: "PROMOTE", champion, challenger, checks, z, reasons };
  }
  // Clearly worse → REJECT; otherwise HOLD (keep champion).
  if (challenger.expectancyR < champion.expectancyR - cfg.minExpectancyGain || !calibrationOk) {
    return { decision: "REJECT", champion, challenger, checks, z, reasons };
  }
  return { decision: "HOLD", champion, challenger, checks, z, reasons };
}

function variance(a: number[]): number {
  if (a.length < 2) return 0;
  const m = meanOf(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — Feedback bus (what the loop updates, delayed + OOS-only)
// ═══════════════════════════════════════════════════════════════════════════

export interface RetrainReport {
  asOfDay: string;
  split: RetrainSplit;
  /** Whether enough embargoed+usable data existed to produce a candidate. */
  producedCandidate: boolean;
  /** The targets a candidate WOULD update (the loop itself is delegated to each engine's trainer). */
  targets: RetrainTarget[];
  /** Hard leakage guard result on the train split. */
  leakageGuard: { ok: boolean; reason: string };
  reasons: string[];
}

/**
 * Orchestrate one DELAYED retraining pass. It builds the embargoed OOS split,
 * asserts no same-day leakage, and reports which learnable targets a candidate
 * would refresh. The ACTUAL fitting is delegated to each engine's existing
 * trainer (calibration store, quality model, strategy health, grade thresholds,
 * ensemble weights, feature importance, abstention) — this function is the
 * governance wrapper that guarantees the delay + OOS discipline.
 */
export function runDelayedRetrain(
  observations: CompletedObservation[],
  asOfDay: string,
  cfg: RetrainConfig = DEFAULT_RETRAIN_CONFIG,
): RetrainReport {
  const split = buildRetrainSplit(observations, asOfDay, cfg);
  const leakageGuard = assertNoSameDayLeakage(split.train, asOfDay, cfg);
  const reasons: string[] = [];
  const producedCandidate = split.train.length + split.oos.length >= cfg.minObservations && leakageGuard.ok;
  if (!leakageGuard.ok) reasons.push(leakageGuard.reason);
  if (split.train.length + split.oos.length < cfg.minObservations) {
    reasons.push(`insufficient_usable_observations:${split.train.length + split.oos.length}<${cfg.minObservations}`);
  }
  if (producedCandidate) reasons.push("candidate_produced_for_champion_challenger_eval");
  return { asOfDay, split, producedCandidate, targets: RETRAIN_TARGETS, leakageGuard, reasons };
}
