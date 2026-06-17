/**
 * Daily Picks — builder (I/O layer).
 *
 * Glues the pure engine to the data + persistence stack:
 *
 *   1. Pull a fresh candidate pool from the India AI universe.
 *   2. The first time the board is requested on a given IST trading day, the
 *      top three picks per bucket are *frozen* into Postgres (entry / stop /
 *      target locked in) so the day's picks become an honest, immutable
 *      track record.
 *   3. On every subsequent request the frozen picks are live-tracked against
 *      the latest mark — P&L, progress-to-target, and TARGET_HIT / STOP_HIT
 *      resolution are refreshed and persisted in place.
 *   4. History exposes every past trading day's picks + their final outcome.
 *
 * Every DB touch is wrapped so the board still renders (ephemerally) when
 * Postgres is unavailable — the feature degrades, it never hard-fails.
 */

import "server-only";

import type { PrismaClient } from "@prisma/client";

import { getPrisma } from "@/lib/prisma";
import { AI_MODEL_VERSION } from "@/features/ai-signals/engine";
import { getIndiaDailyPickCandidates } from "@/features/ai-signals/india-builder";
import { getIndiaOpeningBreakoutSignals } from "@/features/india/scalping/strategies/opening-breakout";
import {
  isNseSessionEndedForDateIST,
  nseCloseMsForDateIST,
  nseOpenMsForDateIST,
} from "@/lib/india/market-hours";
import { angel, isAngelConfigured } from "@/services/india/angelone";
import { pickBrokerChain } from "@/services/india/broker/factory";
import { nse } from "@/services/india/nse";
import { resolveQuotes } from "@/services/india/resolve";
import { getActiveSelections } from "@/features/settings/active-sources";
import type { AiMarketContext } from "@/types/ai-signals";
import type { AiSignal } from "@/types/ai-signals";
import type { OptionChain } from "@/types/india";

import {
  buildDailyPicks,
  dailyPickFromScalpSignal,
  EXTERNAL_BUCKETS,
  groupDailyPicks,
  istDateKey,
  softFieldsForPick,
  squareOffPick,
  trackPick,
  type DailyPick,
  type DailyPickBucket,
  type DailyPickGroup,
  type DailyPickStatus,
  type SoftAnnotationContext,
} from "./engine";
import {
  buildMarketContextHeader,
  type MarketContextHeader,
} from "./market-context";
import {
  livePremiumForContract,
  projectIndexScalpToOption,
  type OptionContract,
} from "./option-projection";
import {
  buildFnoFlowTilt,
  buildSectorWatch,
  type OiBuildupCounts,
} from "./sector-flow";

/** How many Opening Breakout signals seed the externally-sourced bucket. */
const OPENING_BREAKOUT_PICKS = 3;

const isExternalBucket = (bucket: string): boolean =>
  (EXTERNAL_BUCKETS as readonly string[]).includes(bucket);

/**
 * NSE sectoral indices the Daily Picks header ranks for the "SECTOR WATCH"
 * line. Yahoo-style symbols are used so the existing broker chain resolver
 * can serve them — Angel One picks up what it has tokens for and Yahoo
 * Finance backfills the rest with no extra wiring.
 *
 * Curated to the F&O-relevant sectors (matches the heatmap surface).
 */
const SECTOR_WATCH_INDICES: { name: string; symbol: string }[] = [
  { name: "Bank", symbol: "^NSEBANK" },
  { name: "IT", symbol: "^CNXIT" },
  { name: "Auto", symbol: "^CNXAUTO" },
  { name: "Pharma", symbol: "^CNXPHARMA" },
  { name: "FMCG", symbol: "^CNXFMCG" },
  { name: "Metal", symbol: "^CNXMETAL" },
  { name: "Energy", symbol: "^CNXENERGY" },
  { name: "Realty", symbol: "^CNXREALTY" },
  { name: "Fin Services", symbol: "^CNXFIN" },
  { name: "PSU Bank", symbol: "^CNXPSUBANK" },
  { name: "Infra", symbol: "^CNXINFRA" },
];

/**
 * Resolve intraday % changes for the NSE sectoral indices via the active
 * broker chain (Angel for the indices it can serve, Yahoo for the rest).
 *
 * Fail-soft: returns an empty array on any resolver error so the header
 * just renders `—` for the sector line rather than blanking the board.
 */
async function fetchSectorWatchRows(): Promise<
  { name: string; changePct: number | null }[]
> {
  try {
    const selections = await getActiveSelections();
    const chain = pickBrokerChain(selections.india.selected);
    const { quotes } = await resolveQuotes(
      chain,
      SECTOR_WATCH_INDICES.map((s) => s.symbol),
    );
    return SECTOR_WATCH_INDICES.map((s, i) => ({
      name: s.name,
      changePct: quotes[i]?.changePct ?? null,
    }));
  } catch (err) {
    console.warn(
      "[daily-picks] sector watch unavailable:",
      (err as Error).message,
    );
    return [];
  }
}

/**
 * Pull the four OI-Buildup categories from SmartAPI and reduce them to
 * counts. SmartAPI does NOT expose the cash-market FII ₹Cr figure the spec
 * names — this is the closest first-party institutional-flow signal Angel
 * exposes (Long Built Up + Short Covering = bullish; Short Built Up + Long
 * Unwinding = bearish, across the whole F&O segment).
 *
 * Returns null when Angel One isn't configured or every category fails, so
 * the header line falls back to a blank tile instead of a fabricated value.
 */
async function fetchFnoOiBuildupCounts(): Promise<OiBuildupCounts | null> {
  if (!isAngelConfigured()) return null;
  try {
    const [lbu, sbu, sc, lu] = await Promise.all([
      angel.getOiBuildup("Long Built Up", "NEAR").catch(() => []),
      angel.getOiBuildup("Short Built Up", "NEAR").catch(() => []),
      angel.getOiBuildup("Short Covering", "NEAR").catch(() => []),
      angel.getOiBuildup("Long Unwinding", "NEAR").catch(() => []),
    ]);
    const total = lbu.length + sbu.length + sc.length + lu.length;
    if (total === 0) return null;
    return {
      longBuiltUp: lbu.length,
      shortBuiltUp: sbu.length,
      shortCovering: sc.length,
      longUnwinding: lu.length,
    };
  } catch (err) {
    console.warn(
      "[daily-picks] OI buildup unavailable:",
      (err as Error).message,
    );
    return null;
  }
}

export interface DailyPicksResponse {
  market: "india";
  tradeDate: string;
  generatedAt: number;
  modelVersion: string;
  context: AiMarketContext;
  inActiveWindow: boolean;
  groups: DailyPickGroup[];
  /** True when the picks are DB-frozen; false when served ephemerally. */
  persisted: boolean;
  /**
   * The institutional Market Context Header rendered once above the board
   * (NIFTY / BANKNIFTY level + trend + S/R, India VIX + regime, PCR + Max
   * Pain, bias). Built from the same candidate data + option chains the
   * picks are scored against, so the header is always coherent with the
   * picks beneath it.
   */
  marketContextHeader: MarketContextHeader;
}

export interface DailyPicksDaySummary {
  total: number;
  targetHit: number;
  stopHit: number;
  /** Squared off at the market close without hitting target/stop. */
  closed: number;
  open: number;
  /** Resolved win rate = targetHit / (targetHit + stopHit). */
  winRate: number;
}

export interface DailyPicksHistoryDay {
  tradeDate: string;
  groups: DailyPickGroup[];
  summary: DailyPicksDaySummary;
}

export interface DailyPicksHistoryResponse {
  market: "india";
  generatedAt: number;
  days: DailyPicksHistoryDay[];
}

/** `getPrisma()` throws when DATABASE_URL is missing — soften that to null. */
function safeGetPrisma(): PrismaClient | null {
  try {
    return getPrisma();
  } catch {
    return null;
  }
}

function priceMap(signals: AiSignal[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of signals) m.set(s.symbol, s.underlyingPrice);
  return m;
}

/**
 * Fetch option chains for a set of index underlyings in parallel, fail-soft
 * (a 401 / shadow-ban on one chain just returns null for that symbol so the
 * board still ships the others). Used by the INDICES_SCALP projection step
 * and the live tracker.
 */
async function fetchIndexChains(
  symbols: Iterable<string>,
): Promise<Map<string, OptionChain | null>> {
  const out = new Map<string, OptionChain | null>();
  const unique = Array.from(new Set(symbols));
  await Promise.all(
    unique.map(async (sym) => {
      try {
        const chain = await nse.getOptionChain(sym);
        out.set(sym, chain);
      } catch (err) {
        console.warn(
          `[daily-picks] option chain for ${sym} unavailable:`,
          (err as Error).message,
        );
        out.set(sym, null);
      }
    }),
  );
  return out;
}

/**
 * Project every INDICES_SCALP pick in `picks` into its tradeable ATM option
 * contract: entry / stop / target / canMoveUpto become *option premiums*,
 * displayName becomes the contract name, and `optionContract` stores the
 * metadata needed to live-price the option. Picks whose chain is unavailable
 * are dropped (better to ship fewer picks than to ship index-level numbers
 * with an option's risk-reward).
 */
function projectIndicesScalpPicks(
  picks: DailyPick[],
  chains: Map<string, OptionChain | null>,
): DailyPick[] {
  return picks.flatMap((pick) => {
    if (pick.bucket !== "INDICES_SCALP") return [pick];
    const chain = chains.get(pick.symbol);
    if (!chain) {
      console.warn(
        `[daily-picks] dropping INDICES_SCALP ${pick.symbol} — chain unavailable for option projection`,
      );
      return [];
    }
    // Reconstruct a minimal AiSignal-shaped object the projection needs.
    const proj = projectIndexScalpToOption(
      {
        direction: pick.direction,
        entry: pick.entry,
        stopLoss: pick.stopLoss,
        underlyingPrice: pick.underlyingPrice,
        riskReward: pick.riskReward,
        takeProfits: [
          { level: 1, price: pick.target, percent: 0, allocation: 0.5 },
          {
            level: 3,
            price: pick.canMoveUpto,
            percent: 0,
            allocation: 0.25,
          },
        ],
      } as Parameters<typeof projectIndexScalpToOption>[0],
      chain,
      pick.symbol,
    );
    if (!proj) {
      console.warn(
        `[daily-picks] dropping INDICES_SCALP ${pick.symbol} — projection failed (thin chain)`,
      );
      return [];
    }
    const expectedPct =
      proj.entryPremium > 0
        ? (Math.abs(proj.stretchPremium - proj.entryPremium) /
            proj.entryPremium) *
          100
        : pick.canExpectPct;
    return [
      {
        ...pick,
        displayName: proj.contract.contractSymbol,
        entry: proj.entryPremium,
        stopLoss: proj.stopPremium,
        target: proj.targetPremium,
        canMoveUpto: proj.stretchPremium,
        canExpectPct: expectedPct,
        riskReward: proj.riskReward,
        optionContract: proj.contract,
      },
    ];
  });
}

/**
 * Resolve the live mark for a pick. INDICES_SCALP picks live and die on
 * *option premium* — we re-read the chosen strike's LTP from the latest
 * chain. Everything else tracks the underlying spot.
 */
function livePriceFor(
  pick: DailyPick,
  prices: Map<string, number>,
  chains: Map<string, OptionChain | null>,
): number | null {
  if (pick.optionContract) {
    const chain = chains.get(pick.symbol) ?? null;
    const live = livePremiumForContract(pick.optionContract, chain);
    if (live != null) return live;
    // Fallback: keep the last-known premium rather than corrupt P&L with spot.
    return pick.lastPrice;
  }
  return prices.get(pick.symbol) ?? pick.lastPrice ?? pick.underlyingPrice;
}

/**
 * Fetch the Opening Breakout strategy's top signals and project them into
 * `OPENING_BREAKOUT` Daily Picks. Resilient — a failing scan yields no picks
 * rather than blanking the board. ORB signals only appear once the opening
 * candle has broken + retested (typically 9:30+), so this can legitimately
 * return [] early in the session.
 *
 * NOTE: Returns the full *qualifying* set (not sliced to the bucket size) so
 * the orchestrator can apply the tape filter before picking the top N — that
 * way a clean index breakout that worked all day isn't crowded out of the
 * board by a stock SHORT setup fighting a bullish tape (the regression we
 * hit on 2026-06-17 when NIFTY's ORB long never reached the board despite
 * hitting its stretch target).
 */
/** Minimum confidence an Opening Breakout signal needs to reach Daily Picks. */
const ORB_DAILY_PICK_MIN_CONFIDENCE = 0.55;

interface OrbScalpSignalLike {
  direction: string;
  confidence: number;
  confirmed: boolean;
  price: number | null | undefined;
  symbol: string;
}

async function loadOpeningBreakoutPicks(
  tradeDate: string,
  now: number,
  marketContext?: SoftAnnotationContext,
): Promise<{
  qualifying: OrbScalpSignalLike[];
  pickFromSignal: (signal: OrbScalpSignalLike, rank: number) => DailyPick;
  prices: Map<string, number>;
}> {
  const prices = new Map<string, number>();
  const pickFromSignal = (signal: OrbScalpSignalLike, rank: number): DailyPick =>
    dailyPickFromScalpSignal({
      signal: signal as unknown as Parameters<
        typeof dailyPickFromScalpSignal
      >[0]["signal"],
      rank,
      tradeDate,
      now,
      marketContext,
    });
  try {
    // Pull a deeper slice for live-price coverage, freeze only the top few.
    const signals = await getIndiaOpeningBreakoutSignals({
      timeframe: "5m",
      limit: 12,
    });
    for (const s of signals) {
      if (Number.isFinite(s.price) && s.price > 0) prices.set(s.symbol, s.price);
    }
    // Hard-filter to *confirmed retests* with a real confidence floor — an
    // unconfirmed breakout (still awaiting its retest) or a weak setup is not
    // Daily-Picks-grade. The Strategies page still surfaces them.
    const qualifying = signals.filter(
      (s) => s.confirmed && s.confidence >= ORB_DAILY_PICK_MIN_CONFIDENCE,
    );
    return { qualifying, pickFromSignal, prices };
  } catch (err) {
    console.warn(
      "[daily-picks] opening-breakout unavailable:",
      (err as Error).message,
    );
    return { qualifying: [], pickFromSignal, prices };
  }
}

/**
 * Project ORB scalp signals into the final OPENING_BREAKOUT bucket, applying
 * the same tape filter the AI signals use. On a bullish regime
 * (regimeScore > +0.10) counter-tape SHORT breakouts are dropped — they
 * crowded out clean LONG index breakouts on 2026-06-17 even when those longs
 * hit their stretch targets. On a sufficiently one-sided tape we want the
 * bucket to reflect the regime.
 */
function selectOrbBucket(
  qualifying: OrbScalpSignalLike[],
  pickFromSignal: (signal: OrbScalpSignalLike, rank: number) => DailyPick,
  marketBias: number | null | undefined,
): DailyPick[] {
  const TAPE_BIAS = 0.1;
  const bias = Number.isFinite(marketBias) ? (marketBias as number) : 0;
  const tapeFiltered = qualifying.filter((s) => {
    if (Math.abs(bias) < TAPE_BIAS) return true;
    const wantsLong = bias >= TAPE_BIAS;
    const wantsShort = bias <= -TAPE_BIAS;
    if (wantsLong && s.direction === "SHORT") return false;
    if (wantsShort && s.direction === "LONG") return false;
    return true;
  });
  // If the tape filter wiped the bucket clean (e.g. only counter-tape breakouts
  // fired today), fall back to the unfiltered set rather than going empty.
  const final = tapeFiltered.length > 0 ? tapeFiltered : qualifying;
  return final
    .slice(0, OPENING_BREAKOUT_PICKS)
    .map((signal, i) => pickFromSignal(signal, i + 1));
}

function ephemeralPicks(
  signals: AiSignal[],
  tradeDate: string,
  now: number,
  prices: Map<string, number>,
  marketBias: number,
  orbPicks: DailyPick[],
  chains: Map<string, OptionChain | null>,
  marketContext?: SoftAnnotationContext,
): DailyPick[] {
  const openMs = nseOpenMsForDateIST(tradeDate);
  // Same pre-market guard as the DB path — without real opening-session prices
  // any "frozen" picks would just lock in last evening's closes.
  if (openMs != null && now < openMs) return [];
  const fresh = [
    ...projectIndicesScalpPicks(
      buildDailyPicks({ signals, tradeDate, now, marketBias, marketContext }),
      chains,
    ),
    ...orbPicks,
  ];
  const sessionEnded = isNseSessionEndedForDateIST(tradeDate, new Date(now));
  return fresh.map((p) => {
    const tracked = trackPick(p, livePriceFor(p, prices, chains), now);
    return sessionEnded ? squareOffPick(tracked, now) : tracked;
  });
}

type DailyPickCreate = Parameters<
  PrismaClient["indiaDailyPick"]["createMany"]
>[0] extends { data: infer D }
  ? D extends ReadonlyArray<infer E>
    ? E
    : D
  : never;

function toCreateData(p: DailyPick): DailyPickCreate {
  return {
    tradeDate: p.tradeDate,
    bucket: p.bucket,
    rank: p.rank,
    symbol: p.symbol,
    displayName: p.displayName,
    direction: p.direction,
    action: p.action,
    horizon: p.horizon,
    grade: p.grade,
    confidence: p.confidence,
    confidenceScore: p.confidenceScore,
    winProbability: p.winProbability,
    underlyingPrice: p.underlyingPrice,
    entry: p.entry,
    stopLoss: p.stopLoss,
    target: p.target,
    canMoveUpto: p.canMoveUpto,
    canExpectPct: p.canExpectPct,
    riskReward: p.riskReward,
    bucketScore: p.bucketScore,
    rationale: p.rationale,
    logic: p.logic,
    status: p.status,
    lastPrice: p.lastPrice,
    pnlPct: p.pnlPct,
    achievedPct: p.achievedPct,
    resolvedAt: p.resolvedAt != null ? new Date(p.resolvedAt) : null,
    generatedAt: new Date(p.generatedAt),
    optionContract: p.optionContract
      ? (p.optionContract as unknown as Record<string, unknown>)
      : null,
  } as DailyPickCreate;
}

interface DailyPickRow {
  tradeDate: string;
  bucket: string;
  rank: number;
  symbol: string;
  displayName: string;
  direction: string;
  action: string;
  horizon: string;
  grade: string;
  confidence: number;
  confidenceScore: number;
  winProbability: number;
  underlyingPrice: number;
  entry: number;
  stopLoss: number;
  target: number;
  canMoveUpto: number;
  canExpectPct: number;
  riskReward: number;
  bucketScore: number;
  rationale: string[];
  logic: string;
  status: string;
  lastPrice: number | null;
  pnlPct: number | null;
  achievedPct: number | null;
  resolvedAt: Date | null;
  generatedAt: Date;
  updatedAt: Date;
  optionContract: unknown;
}

function rowToPick(row: DailyPickRow): DailyPick {
  // Soft fields aren't persisted (they're derived); we rehydrate them from
  // the row itself. The final response runs another `softFieldsForPick`
  // pass with the resolved market context so warnings reflect the *current*
  // VIX / bias / expiry-day state rather than the freeze-time snapshot.
  const base: Omit<
    DailyPick,
    | "confluenceScore"
    | "keyIndicators"
    | "setupType"
    | "researchNote"
    | "timeWindow"
    | "warnings"
  > = {
    tradeDate: row.tradeDate,
    bucket: row.bucket as DailyPickBucket,
    rank: row.rank,
    symbol: row.symbol,
    displayName: row.displayName,
    pair: row.symbol,
    direction: row.direction as DailyPick["direction"],
    action: row.action as DailyPick["action"],
    horizon: row.horizon as DailyPick["horizon"],
    grade: row.grade as DailyPick["grade"],
    confidence: row.confidence,
    confidenceScore: row.confidenceScore,
    winProbability: row.winProbability,
    underlyingPrice: row.underlyingPrice,
    entry: row.entry,
    stopLoss: row.stopLoss,
    target: row.target,
    canMoveUpto: row.canMoveUpto,
    canExpectPct: row.canExpectPct,
    riskReward: row.riskReward,
    bucketScore: row.bucketScore,
    rationale: row.rationale,
    logic: row.logic,
    status: row.status as DailyPickStatus,
    lastPrice: row.lastPrice,
    pnlPct: row.pnlPct,
    achievedPct: row.achievedPct,
    resolvedAt: row.resolvedAt ? row.resolvedAt.getTime() : null,
    generatedAt: row.generatedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    optionContract:
      row.optionContract && typeof row.optionContract === "object"
        ? (row.optionContract as OptionContract)
        : null,
  };
  // Temporarily widen with default soft fields, then compute them off the
  // full shape — `softFieldsForPick` reads `bucket` / `bucketScore` /
  // `horizon` / `direction` / `rationale` so this is self-consistent.
  const withDefaults: DailyPick = {
    ...base,
    confluenceScore: 0,
    keyIndicators: [],
    setupType: "",
    researchNote: "",
    timeWindow: { start: "09:15", end: "15:30", label: "Intraday Window" },
    warnings: [],
  };
  return { ...withDefaults, ...softFieldsForPick(withDefaults) };
}

/** Track + persist a fresh batch of frozen picks (first freeze of a bucket). */
async function freezeAndTrack(
  db: PrismaClient,
  fresh: DailyPick[],
  tradeDate: string,
  prices: Map<string, number>,
  chains: Map<string, OptionChain | null>,
  now: number,
  sessionEnded: boolean,
): Promise<DailyPick[]> {
  if (fresh.length === 0) return [];
  const tracked = fresh.map((p) => {
    const t = trackPick(p, livePriceFor(p, prices, chains), now);
    return sessionEnded ? squareOffPick(t, now) : t;
  });
  await db.indiaDailyPick.createMany({
    data: tracked.map(toCreateData),
    skipDuplicates: true,
  });
  return tracked;
}

/** Live-track already-frozen rows against the latest mark, persisting deltas. */
async function trackExistingRows(
  db: PrismaClient,
  rows: DailyPickRow[],
  tradeDate: string,
  prices: Map<string, number>,
  chains: Map<string, OptionChain | null>,
  now: number,
  sessionEnded: boolean,
): Promise<DailyPick[]> {
  const updated: DailyPick[] = [];
  for (const row of rows) {
    const pick = rowToPick(row);
    const price = livePriceFor(pick, prices, chains);
    const tracked = trackPick(pick, price, now);
    const next = sessionEnded ? squareOffPick(tracked, now) : tracked;
    updated.push(next);

    const changed =
      next.status !== pick.status ||
      next.lastPrice !== pick.lastPrice ||
      next.pnlPct !== pick.pnlPct ||
      next.achievedPct !== pick.achievedPct ||
      next.resolvedAt !== pick.resolvedAt;
    if (changed) {
      await db.indiaDailyPick.update({
        where: {
          tradeDate_bucket_rank: {
            tradeDate,
            bucket: pick.bucket,
            rank: pick.rank,
          },
        },
        data: {
          status: next.status,
          lastPrice: next.lastPrice,
          pnlPct: next.pnlPct,
          achievedPct: next.achievedPct,
          resolvedAt: next.resolvedAt != null ? new Date(next.resolvedAt) : null,
        },
      });
    }
  }
  return updated;
}

async function loadOrCreateAndTrack(
  db: PrismaClient,
  signals: AiSignal[],
  tradeDate: string,
  prices: Map<string, number>,
  chains: Map<string, OptionChain | null>,
  now: number,
  marketBias: number,
  orbPicks: DailyPick[],
  marketContext?: SoftAnnotationContext,
): Promise<DailyPick[]> {
  const openMs = nseOpenMsForDateIST(tradeDate);

  // Pre-market guard: never freeze before 09:15 IST. The picks need real
  // opening-session prices; anything frozen earlier (e.g. by a midnight cron
  // when the IST trade date rolled over) would lock in stale yesterday-close
  // levels and then live-track them all day. Pre-market requests return an
  // empty board and the page renders a "waiting for open" state.
  if (openMs != null && now < openMs) return [];

  const existingRaw = (await db.indiaDailyPick.findMany({
    where: { tradeDate },
  })) as unknown as DailyPickRow[];

  // Evict any rows for today that were captured *before* the NSE open — they
  // were frozen against last evening's closes and are useless once the bell
  // rings. We delete them here and let the freeze path below regenerate fresh
  // picks against current opening-session candidates.
  if (openMs != null) {
    const stale = existingRaw.filter((r) => r.generatedAt.getTime() < openMs);
    if (stale.length > 0) {
      await db.indiaDailyPick.deleteMany({
        where: { tradeDate, generatedAt: { lt: new Date(openMs) } },
      });
    }
  }
  const existing =
    openMs != null
      ? existingRaw.filter((r) => r.generatedAt.getTime() >= openMs)
      : existingRaw;

  // Intraday-only: once this trade date's 15:30 IST session has ended, any
  // still-open pick is force-squared-off at its last mark (no overnight carry).
  const sessionEnded = isNseSessionEndedForDateIST(tradeDate, new Date(now));

  // The AI-sourced buckets (indices / momentum / scalping / potential) and the
  // externally-sourced Opening Breakout bucket are frozen independently: the AI
  // buckets freeze on the first request of the day, while ORB freezes *lazily*
  // the first time its signals exist (the opening candle must break + retest
  // first, usually 9:30+). Each then live-tracks in place.
  const aiExisting = existing.filter((r) => !isExternalBucket(r.bucket));
  const orbExisting = existing.filter((r) => isExternalBucket(r.bucket));

  const ai =
    aiExisting.length === 0
      ? await freezeAndTrack(
          db,
          // INDICES_SCALP picks are re-projected into ATM option contracts
          // before they're frozen — entry / stop / target persist as option
          // premiums so live tracking reflects what the desk actually trades.
          projectIndicesScalpPicks(
            buildDailyPicks({ signals, tradeDate, now, marketBias, marketContext }),
            chains,
          ),
          tradeDate,
          prices,
          chains,
          now,
          sessionEnded,
        )
      : await trackExistingRows(
          db,
          aiExisting,
          tradeDate,
          prices,
          chains,
          now,
          sessionEnded,
        );

  const orb =
    orbExisting.length === 0
      ? await freezeAndTrack(
          db,
          orbPicks,
          tradeDate,
          prices,
          chains,
          now,
          sessionEnded,
        )
      : await trackExistingRows(
          db,
          orbExisting,
          tradeDate,
          prices,
          chains,
          now,
          sessionEnded,
        );

  return [...ai, ...orb];
}

/**
 * Build today's Daily Picks board — frozen + live-tracked when Postgres is
 * reachable, ephemeral otherwise.
 */
export async function getIndiaDailyPicks(
  prisma?: PrismaClient,
): Promise<DailyPicksResponse> {
  const now = Date.now();
  const tradeDate = istDateKey(new Date(now));
  // INDICES_SCALP picks need live option chains both at freeze time (to pick
  // the ATM strike + entry premium) and on every refresh (to re-price the
  // option). Fetched here in parallel with the candidate signals + the
  // header-only inputs (sectoral indices, OI-buildup tilt) so the whole
  // request happens in a single network fan-out instead of serialising.
  const [candidates, chains, sectorRows, oiCounts] = await Promise.all([
    getIndiaDailyPickCandidates(),
    fetchIndexChains(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"]),
    fetchSectorWatchRows(),
    fetchFnoOiBuildupCounts(),
  ]);
  const marketBias = candidates.context.regimeScore;

  // Resolved soft-annotation context, threaded into every soft-field call
  // so the Confluence / Setup / Time Window / Warnings on each pick reflect
  // the *current* regime instead of just whatever was frozen at 09:15.
  const softCtx: SoftAnnotationContext = {
    headline: candidates.context.headline,
    // `indiaVix` was added to the candidates payload in v5; older shapes
    // (incl. some test mocks) may omit it — coalesce to null so the soft
    // helpers gracefully skip the VIX-derived warnings.
    indiaVix: candidates.indiaVix ?? null,
    marketBias,
    // Earnings-distance lookup is not wired yet — left undefined so the
    // "EVENT RISK" badge stays off until we plumb the events feed in.
    earningsByDays: undefined,
    // TODO: thread NSE expiry-day detection — for now leave it false.
    isExpiryDay: false,
  };

  const orb = await loadOpeningBreakoutPicks(tradeDate, now, softCtx);
  const prices = priceMap(candidates.signals);
  // Merge Opening Breakout live prices so its (possibly non-AI-universe) symbols
  // also track live.
  for (const [sym, px] of orb.prices) prices.set(sym, px);

  // Apply the tape filter to the ORB bucket using the *resolved* marketBias —
  // counter-tape SHORT breakouts get dropped on a bullish day (and longs on a
  // bearish day) so a clean index breakout that worked all day isn't crowded
  // out by stock setups fighting the regime.
  const orbPicks = selectOrbBucket(orb.qualifying, orb.pickFromSignal, marketBias);

  let picks: DailyPick[];
  let persisted = false;

  const db = prisma ?? safeGetPrisma();
  if (db) {
    try {
      picks = await loadOrCreateAndTrack(
        db,
        candidates.signals,
        tradeDate,
        prices,
        chains,
        now,
        marketBias,
        orbPicks,
        softCtx,
      );
      persisted = true;
    } catch (err) {
      console.warn(
        "[daily-picks] DB unavailable, serving ephemeral picks:",
        (err as Error).message,
      );
      picks = ephemeralPicks(
        candidates.signals,
        tradeDate,
        now,
        prices,
        marketBias,
        orbPicks,
        chains,
        softCtx,
      );
    }
  } else {
    picks = ephemeralPicks(
      candidates.signals,
      tradeDate,
      now,
      prices,
      marketBias,
      orbPicks,
      chains,
      softCtx,
    );
  }

  // Final pass: re-enrich every pick (DB-loaded or fresh) with the *current*
  // market context. This is what guarantees the warnings (HIGH VIX, LOW
  // CONFIDENCE, …) and research-note framing on a re-frozen pick reflect the
  // live tape rather than the freeze-time snapshot.
  picks = picks.map((p) => ({ ...p, ...softFieldsForPick(p, softCtx) }));

  // Build the once-per-board Market Context Header. NIFTY / BANKNIFTY data
  // comes from `candidates.indexLevels`, the chains are re-used to extract
  // Max Pain + PCR + S/R bounds.
  const marketContextHeader = buildMarketContextHeader({
    now,
    indiaVix: candidates.indiaVix ?? null,
    indices: candidates.indexLevels ?? {},
    chains: {
      NIFTY: chains.get("NIFTY") ?? null,
      BANKNIFTY: chains.get("BANKNIFTY") ?? null,
    },
    context: candidates.context,
    // SmartAPI cannot give us the cash-market FII ₹Cr figure — we surface
    // its OI-Buildup tilt as the closest institutional-flow proxy and label
    // it honestly in the panel. Null when Angel isn't configured.
    fiiFlow: oiCounts ? buildFnoFlowTilt(oiCounts) : null,
    // Sector watch is resolved over the broker chain (Angel for the
    // indices it has tokens for, Yahoo backfilling the rest).
    sectorWatch: buildSectorWatch(sectorRows),
  });

  return {
    market: "india",
    tradeDate,
    generatedAt: now,
    modelVersion: AI_MODEL_VERSION,
    context: candidates.context,
    inActiveWindow: candidates.inActiveWindow,
    groups: groupDailyPicks(picks),
    persisted,
    marketContextHeader,
  };
}

export function summariseDay(picks: DailyPick[]): DailyPicksDaySummary {
  let targetHit = 0;
  let stopHit = 0;
  let closed = 0;
  let open = 0;
  for (const p of picks) {
    if (p.status === "TARGET_HIT") targetHit += 1;
    else if (p.status === "STOP_HIT") stopHit += 1;
    else if (p.status === "CLOSED" || p.status === "EXPIRED") closed += 1;
    else open += 1;
  }
  const resolved = targetHit + stopHit;
  return {
    total: picks.length,
    targetHit,
    stopHit,
    closed,
    open,
    winRate: resolved > 0 ? targetHit / resolved : 0,
  };
}

/**
 * Past trading days' picks + their final outcome, most recent first. Today
 * is excluded by default (it lives on the live board). Returns an empty list
 * when Postgres is unavailable.
 */
export async function getIndiaDailyPicksHistory(
  opts?: { days?: number; excludeDate?: string },
  prisma?: PrismaClient,
): Promise<DailyPicksHistoryResponse> {
  const now = Date.now();
  const db = prisma ?? safeGetPrisma();
  if (!db) return { market: "india", generatedAt: now, days: [] };

  try {
    const days = Math.min(Math.max(opts?.days ?? 14, 1), 60);
    const exclude = opts?.excludeDate ?? istDateKey(new Date(now));

    const dateRows = (await db.indiaDailyPick.findMany({
      where: { tradeDate: { not: exclude } },
      distinct: ["tradeDate"],
      orderBy: { tradeDate: "desc" },
      take: days,
      select: { tradeDate: true },
    })) as Array<{ tradeDate: string }>;

    const dates = dateRows.map((r) => r.tradeDate);
    if (dates.length === 0) return { market: "india", generatedAt: now, days: [] };

    const rows = (await db.indiaDailyPick.findMany({
      where: { tradeDate: { in: dates } },
      orderBy: [{ tradeDate: "desc" }, { rank: "asc" }],
    })) as unknown as DailyPickRow[];

    // Every history day is a *past* trading day, so its session has ended —
    // force-square-off any pick still left OPEN (intraday, no overnight carry)
    // and persist the flip so the track record is honest on future reads too.
    const squaredOff: Array<{
      tradeDate: string;
      bucket: string;
      rank: number;
      resolvedAt: number | null;
    }> = [];
    const byDate = new Map<string, DailyPick[]>();
    for (const row of rows) {
      let pick = rowToPick(row);
      if (pick.status === "OPEN") {
        // Resolve at that day's 15:30 IST close (not "now"), so the recorded
        // time-to-outcome reflects a real intraday hold, not the gap until the
        // history was viewed.
        const closeMs = nseCloseMsForDateIST(pick.tradeDate) ?? now;
        pick = squareOffPick(pick, closeMs);
        squaredOff.push({
          tradeDate: pick.tradeDate,
          bucket: pick.bucket,
          rank: pick.rank,
          resolvedAt: pick.resolvedAt,
        });
      }
      const bucket = byDate.get(pick.tradeDate) ?? [];
      bucket.push(pick);
      byDate.set(pick.tradeDate, bucket);
    }

    // Persist the flips so the track record stays honest on future reads. Each
    // day closes at its own instant, so these are per-pick updates.
    for (const s of squaredOff) {
      try {
        await db.indiaDailyPick.update({
          where: {
            tradeDate_bucket_rank: {
              tradeDate: s.tradeDate,
              bucket: s.bucket,
              rank: s.rank,
            },
          },
          data: {
            status: "CLOSED",
            resolvedAt: s.resolvedAt != null ? new Date(s.resolvedAt) : null,
          },
        });
      } catch {
        // Display still reflects the square-off even if the write fails.
      }
    }

    const out: DailyPicksHistoryDay[] = dates
      .filter((d) => byDate.has(d))
      .map((tradeDate) => {
        const picks = byDate.get(tradeDate) ?? [];
        return {
          tradeDate,
          groups: groupDailyPicks(picks),
          summary: summariseDay(picks),
        };
      });

    return { market: "india", generatedAt: now, days: out };
  } catch (err) {
    console.warn(
      "[daily-picks] history unavailable:",
      (err as Error).message,
    );
    return { market: "india", generatedAt: now, days: [] };
  }
}
