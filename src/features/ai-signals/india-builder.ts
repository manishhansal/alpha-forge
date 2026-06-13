/**
 * India F&O AI Signals builder.
 *
 * Mirrors the crypto builder's shape but pulls from the India data stack:
 *   - Yahoo for live quotes + historical OHLCV on each underlying
 *   - NSE option chain (PCR, ATM IV, max-pain, OI build-up)
 *   - The India scanner cache (range-expansion / volume / momentum hits)
 *   - The India best-time engine for session-aware timing
 *
 * The result is the same `AiSignal` type the crypto surface produces — so
 * the rich `<AiSignalCard>` component can render either market 1:1.
 */

import "server-only";

import { FNO_INDICES } from "@/lib/india/fno-symbols";
import { yahoo } from "@/services/india/yahoo";
import { nse } from "@/services/india/nse";
import { cache as indiaCache } from "@/services/india/cache";
import {
  getBestTimeStatus,
  getNextTradingSessionOpen,
  type NextTradingSession,
} from "@/features/india/best-time/engine";
import { runScanner } from "@/services/india/scanner/engine";
import type {
  AiConfluenceFactor,
  AiMarketContext,
  AiMarketRegime,
  AiSignal,
  AiSignalsResponse,
} from "@/types/ai-signals";
import type { Candle, OptionChain, Quote } from "@/types/india";
import {
  AI_MODEL_VERSION,
  buildReasons,
  buildTimingWindow,
  buildTradeLevels,
  calibrateWinProbability,
  classifyAction,
  clamp,
  composeSummary,
  compositeScore,
  derivativeShare,
  directionFromAction,
  gradeFromConfidence,
  invalidationLine,
  makeFactor,
  pickHorizon,
  riskLevelFromConfidence,
  roundToTick,
  suggestPositionSizePct,
} from "./engine";

const CACHE_TTL_MS = 30_000;

const DERIVATIVE_FACTOR_IDS = new Set([
  "pcr",
  "ivAtm",
  "oiBuildup",
  "maxPain",
]);

/**
 * NSE F&O tick size depends on the underlying price band. Stocks use
 * 0.05 ticks; indices >5,000 use 1.0 / 5.0 ticks but the option-chain
 * shows strikes at 50 / 100. For our AI levels we round entries / stops
 * to a sensible price band so the UI doesn't show 22_847.13 as a stop on
 * a NIFTY trade.
 */
function tickFor(symbol: string, price: number): number {
  if (FNO_INDICES.some((i) => i.underlying === symbol)) {
    return price >= 30_000 ? 5 : 1;
  }
  return 0.05;
}

/**
 * Compute a Wilder ATR(14) over daily candles. Returns null if we don't
 * have enough history.
 */
function dailyAtr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
  }
  return prev;
}

/** Wilder RSI(14) over daily closes. */
function dailyRsi(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const closes = candles.map((c) => c.close);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let g = gain / period;
  let l = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (l === 0) return 100;
  const rs = g / l;
  return 100 - 100 / (1 + rs);
}

/** SMA over closes. */
function sma(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;
  const last = candles.slice(-period);
  return last.reduce((s, c) => s + c.close, 0) / period;
}

/** Nearest ATM option strike from an NSE chain. */
function nearestAtmStrike(chain: OptionChain | null, spot: number): number | null {
  if (!chain || chain.rows.length === 0) return null;
  let best = chain.rows[0].strike;
  let bestDist = Math.abs(best - spot);
  for (const row of chain.rows) {
    const d = Math.abs(row.strike - spot);
    if (d < bestDist) {
      bestDist = d;
      best = row.strike;
    }
  }
  return best;
}

interface IndiaSignalInputs {
  symbol: string;
  displayName: string;
  isIndex: boolean;
  quote: Quote | null;
  dailies: Candle[];
  chain: OptionChain | null;
  scannerScore: { score: number; tags: string[] } | null;
  now: number;
  inActiveWindow: boolean;
  windowLabel: string;
  /**
   * Next NSE session open — passed through to the timing-window builder
   * so the signal is framed as "queued for tomorrow" when NSE is closed.
   * Null when the market is currently open.
   */
  nextSession: NextTradingSession | null;
}

/**
 * Build the 9-factor confluence stack used by the India AI engine.
 */
function indiaFactors(args: IndiaSignalInputs): AiConfluenceFactor[] {
  const { quote, dailies, chain } = args;
  const closes = dailies.map((c) => c.close);
  const rsi = dailyRsi(dailies);
  const sma20 = sma(dailies, 20);
  const sma50 = sma(dailies, 50);
  const sma200 = sma(dailies, 200);
  const lastClose = closes.at(-1) ?? quote?.price ?? null;

  // Trend stack score: +1 if 20 > 50 > 200 and price above 20; -1 if mirror.
  let trendStack = 0;
  if (sma20 != null && sma50 != null && sma200 != null && lastClose != null) {
    if (sma20 > sma50 && sma50 > sma200 && lastClose > sma20) trendStack = 1;
    else if (sma20 < sma50 && sma50 < sma200 && lastClose < sma20)
      trendStack = -1;
    else trendStack = clamp(((sma20 - sma50) / Math.max(sma50, 1)) * 10, -0.6, 0.6);
  }

  // 5-day momentum
  const mom5 =
    closes.length >= 6 && closes.at(-6)
      ? ((closes.at(-1)! - closes.at(-6)!) / closes.at(-6)!) * 100
      : null;

  // Volume thrust: today vs 20-day avg
  const vol20 =
    dailies.length >= 21
      ? dailies
          .slice(-21, -1)
          .map((c) => c.volume ?? 0)
          .reduce((a, b) => a + b, 0) / 20
      : null;
  const volRatio =
    vol20 && vol20 > 0 ? ((dailies.at(-1)?.volume ?? 0) / vol20) : null;

  // PCR (open-interest based, indices only)
  const pcr = chain?.analytics.pcrOi ?? null;
  // ATM IV — high IV often precedes mean reversion in F&O indices
  const atmIv = chain?.analytics.atmIv ?? null;
  // OI build-up direction: ΔPE OI − ΔCE OI (positive → bullish, indices only)
  const oiSkew =
    chain != null
      ? (chain.analytics.totalPeOiChange ?? 0) - (chain.analytics.totalCeOiChange ?? 0)
      : null;
  // Max-pain pull — distance from spot
  const maxPainPull =
    chain != null && chain.analytics.maxPain != null && lastClose != null && lastClose > 0
      ? ((chain.analytics.maxPain - lastClose) / lastClose) * 100
      : null;

  return [
    makeFactor({
      id: "trend",
      category: "technical",
      label: "Daily SMA trend",
      weight: 0.14,
      raw: trendStack,
      denominator: 1,
      describe: (raw) =>
        raw >= 0.9
          ? `Bull stack · SMA 20 > 50 > 200, price above 20`
          : raw <= -0.9
            ? `Bear stack · SMA 20 < 50 < 200, price below 20`
            : raw >= 0
              ? `Mild bullish — SMA spread positive`
              : `Mild bearish — SMA spread negative`,
    }),
    makeFactor({
      id: "rsi",
      category: "technical",
      label: "Daily RSI(14)",
      weight: 0.1,
      raw: rsi != null ? 50 - rsi : null,
      denominator: 25,
      describe: () =>
        rsi == null
          ? "Unavailable"
          : rsi > 70
            ? `Overbought ${rsi.toFixed(1)} — fade risk`
            : rsi < 30
              ? `Oversold ${rsi.toFixed(1)} — mean-revert bias`
              : `Neutral ${rsi.toFixed(1)}`,
    }),
    makeFactor({
      id: "momentum",
      category: "technical",
      label: "5-day momentum",
      weight: 0.1,
      raw: mom5,
      denominator: 4,
      describe: (raw) =>
        raw > 0
          ? `+${raw.toFixed(2)}% over 5 sessions`
          : `${raw.toFixed(2)}% over 5 sessions`,
    }),
    makeFactor({
      id: "volume",
      category: "flow",
      label: "Volume thrust",
      weight: 0.08,
      raw: volRatio != null ? volRatio - 1 : null,
      denominator: 1,
      describe: () =>
        volRatio == null
          ? "Unavailable"
          : volRatio >= 1.5
            ? `Breakout volume ${volRatio.toFixed(2)}× 20-day avg`
            : volRatio >= 1
              ? `Above-avg volume ${volRatio.toFixed(2)}×`
              : `Below-avg volume ${volRatio.toFixed(2)}×`,
    }),
    makeFactor({
      id: "pcr",
      category: "derivatives",
      label: "PCR (OI)",
      weight: 0.12,
      raw: pcr != null ? pcr - 1 : null,
      denominator: 0.5,
      describe: () =>
        pcr == null
          ? "Unavailable"
          : pcr > 1.3
            ? `PCR ${pcr.toFixed(2)} — heavy PE write, bullish bias`
            : pcr < 0.7
              ? `PCR ${pcr.toFixed(2)} — heavy CE write, bearish bias`
              : `PCR ${pcr.toFixed(2)} — balanced`,
    }),
    makeFactor({
      id: "ivAtm",
      category: "derivatives",
      label: "ATM IV",
      weight: 0.06,
      raw: atmIv != null ? atmIv - 15 : null,
      denominator: 12,
      // High IV → wider expected range; we treat it as a *bearish* tilt for
      // directional positions because IV crush after the move kills options.
      invert: true,
      describe: () =>
        atmIv == null
          ? "Unavailable"
          : atmIv > 22
            ? `Elevated IV ${atmIv.toFixed(1)}% — option premium rich`
            : atmIv > 14
              ? `Normal IV ${atmIv.toFixed(1)}%`
              : `Compressed IV ${atmIv.toFixed(1)}% — premium cheap`,
    }),
    makeFactor({
      id: "oiBuildup",
      category: "derivatives",
      label: "OI build-up Δ",
      weight: 0.12,
      raw: oiSkew,
      denominator: 5e5,
      describe: () => {
        if (oiSkew == null) return "Unavailable";
        if (oiSkew > 0)
          return `PE writers > CE writers (${(oiSkew / 1e5).toFixed(1)}L) — bullish OI`;
        return `CE writers > PE writers (${(-oiSkew / 1e5).toFixed(1)}L) — bearish OI`;
      },
    }),
    makeFactor({
      id: "maxPain",
      category: "derivatives",
      label: "Max-pain pull",
      weight: 0.08,
      raw: maxPainPull,
      denominator: 1.5,
      describe: () =>
        maxPainPull == null
          ? "Unavailable"
          : maxPainPull > 0.3
            ? `Max-pain ${maxPainPull.toFixed(2)}% above spot — magnet up`
            : maxPainPull < -0.3
              ? `Max-pain ${maxPainPull.toFixed(2)}% below spot — magnet down`
              : `Max-pain near spot — neutral pin`,
    }),
    makeFactor({
      id: "scanner",
      category: "flow",
      label: "Scanner agreement",
      weight: 0.1,
      raw: args.scannerScore?.score ?? null,
      denominator: 1,
      describe: () => {
        if (!args.scannerScore) return "Unavailable";
        const tags = args.scannerScore.tags.join(" · ");
        return tags
          ? `Scanner: ${tags}`
          : `Scanner score ${args.scannerScore.score.toFixed(2)}`;
      },
    }),
    makeFactor({
      id: "session",
      category: "macro",
      label: "NSE session",
      weight: 0.1,
      raw: args.inActiveWindow ? 1 : -0.5,
      denominator: 1,
      describe: () =>
        args.inActiveWindow
          ? `Inside ${args.windowLabel} — F&O liquidity active`
          : `Outside ${args.windowLabel} — wait for market open`,
    }),
  ];
}

/**
 * Cross-reference live scanner cache to compute a per-symbol bullishness
 * score in [-1, 1] plus a short list of tags ("Volume +", "Momentum +").
 */
async function loadScannerScores(): Promise<
  Map<string, { score: number; tags: string[] }>
> {
  const out = new Map<string, { score: number; tags: string[] }>();
  const safeRun = async (type: Parameters<typeof runScanner>[0]) => {
    try {
      return await runScanner(type, 50);
    } catch {
      return null;
    }
  };
  const [momentum, volume, rangeExp, oi] = await Promise.all([
    safeRun("momentum"),
    safeRun("volume-breakout"),
    safeRun("range-expansion"),
    safeRun("oi-buildup"),
  ]);
  const bump = (sym: string, delta: number, tag: string) => {
    const cur = out.get(sym) ?? { score: 0, tags: [] };
    cur.score = clamp(cur.score + delta, -1, 1);
    if (!cur.tags.includes(tag)) cur.tags.push(tag);
    out.set(sym, cur);
  };
  for (const hit of momentum?.hits ?? []) {
    const dir = (hit.changePct ?? 0) >= 0 ? 1 : -1;
    bump(hit.symbol, dir * 0.3, dir > 0 ? "Momentum +" : "Momentum −");
  }
  for (const hit of volume?.hits ?? []) {
    const dir = (hit.changePct ?? 0) >= 0 ? 1 : -1;
    bump(hit.symbol, dir * 0.25, dir > 0 ? "Volume +" : "Volume −");
  }
  for (const hit of rangeExp?.hits ?? []) {
    bump(hit.symbol, 0.35, "Range expansion");
  }
  for (const hit of oi?.hits ?? []) {
    const kind = String(hit.kind ?? "");
    if (kind === "LONG_BUILDUP") bump(hit.symbol, 0.3, "Long build-up");
    else if (kind === "SHORT_BUILDUP") bump(hit.symbol, -0.3, "Short build-up");
    else if (kind === "SHORT_COVERING") bump(hit.symbol, 0.2, "Short covering");
    else if (kind === "LONG_UNWINDING") bump(hit.symbol, -0.2, "Long unwinding");
  }
  return out;
}

function buildIndiaSignal(args: IndiaSignalInputs): AiSignal {
  const factors = indiaFactors(args);
  const composite = compositeScore(factors);
  const derivShare = derivativeShare(factors, DERIVATIVE_FACTOR_IDS);
  // F&O — always LONG/SHORT (perp-style), even for spot stocks, because the
  // tradeable instrument is the future / option.
  const action = classifyAction(composite.score, derivShare, {
    allowPerps: true,
  });
  const direction = directionFromAction(action);
  const isWait = action === "WAIT";
  const bullish = direction === "BULLISH";

  const horizon = pickHorizon({
    inActiveWindow: args.inActiveWindow,
    derivativeShare: derivShare,
    scoreMagnitude: Math.abs(composite.score),
  });

  const price = args.quote?.price ?? args.dailies.at(-1)?.close ?? 0;
  const atrRaw = dailyAtr(args.dailies) ?? price * 0.012;
  // Index ATRs can come out small relative to spot in compressed regimes;
  // bound to a sensible band so the TPs/stops aren't trivially close.
  const atr = clamp(atrRaw, price * 0.005, price * 0.06);

  const levels = buildTradeLevels({
    underlyingPrice: price,
    atr,
    horizon,
    bullish,
  });

  const tick = tickFor(args.symbol, price);
  const entry = roundToTick(levels.entry, tick);
  const stopLoss = roundToTick(levels.stopLoss, tick);
  const takeProfits = levels.takeProfits.map((tp) => ({
    ...tp,
    price: roundToTick(tp.price, tick),
  }));
  const entryZone = {
    min: roundToTick(levels.entryZone.min, tick),
    max: roundToTick(levels.entryZone.max, tick),
  };

  const strike = nearestAtmStrike(args.chain, price);

  const confidenceScore = Math.round(composite.confidence * 100);
  const grade = gradeFromConfidence(composite.confidence);
  const winProbability = calibrateWinProbability(
    Math.abs(composite.score),
    composite.confidence,
  );

  const positionSizingPct = isWait
    ? 0
    : suggestPositionSizePct(entry, stopLoss, horizon, {
        confidence: composite.confidence,
      });

  const alignedRatio =
    composite.bullishCount + composite.bearishCount > 0
      ? Math.max(composite.bullishCount, composite.bearishCount) /
        (composite.bullishCount + composite.bearishCount)
      : 0;
  const riskLevel = riskLevelFromConfidence(composite.confidence, alignedRatio);

  const reasons = buildReasons(factors);

  const timing = buildTimingWindow({
    now: args.now,
    horizon,
    inActiveWindow: args.inActiveWindow,
    windowLabel: args.windowLabel,
    nextSession:
      !args.inActiveWindow && args.nextSession
        ? {
            opensAt: args.nextSession.opensAt,
            dayLabel: args.nextSession.dayLabel,
            timeLabel: args.nextSession.timeLabel,
          }
        : undefined,
  });

  const summary = composeSummary({
    action,
    symbol: args.symbol,
    grade,
    confidenceScore,
    reasons,
    horizon,
  });

  const invalidationCriteria = invalidationLine({
    bullish,
    stopLoss,
    horizon,
  });

  return {
    id: `india-${args.symbol}-${args.now}`,
    symbol: args.symbol,
    displayName: args.displayName,
    market: "india",
    pair: args.isIndex ? args.symbol : `${args.symbol}.NS`,
    action,
    direction,
    horizon,
    underlyingPrice: price,
    entry: isWait ? price : entry,
    entryZone: isWait
      ? { min: price - price * 0.0015, max: price + price * 0.0015 }
      : entryZone,
    strike: isWait ? null : strike ?? entry,
    stopLoss: isWait ? roundToTick(price - 1.5 * atr, tick) : stopLoss,
    takeProfits: isWait
      ? [
          { level: 1, price: roundToTick(price * 1.005, tick), percent: 0.5, allocation: 0.5 },
          { level: 2, price: roundToTick(price * 1.015, tick), percent: 1.5, allocation: 0.3 },
          { level: 3, price: roundToTick(price * 1.03, tick), percent: 3.0, allocation: 0.2 },
        ]
      : takeProfits,
    riskReward: isWait ? 0 : levels.riskReward,
    riskRewardBlended: isWait ? 0 : levels.riskRewardBlended,
    expectedMovePct: isWait ? 0 : levels.expectedMovePct,
    positionSizingPct,
    riskLevel: isWait ? "high" : riskLevel,
    confidence: composite.confidence,
    confidenceScore,
    grade,
    winProbability,
    timing,
    confluences: factors,
    bullishCount: composite.bullishCount,
    bearishCount: composite.bearishCount,
    reasons,
    invalidationCriteria,
    modelVersion: AI_MODEL_VERSION,
    summary,
  };
}

function buildIndiaContext(args: {
  vixQuote: Quote | null;
  indexQuotes: Quote[];
  inActiveWindow: boolean;
  windowLabel: string;
  nextSession: NextTradingSession | null;
}): AiMarketContext {
  const avgChange =
    args.indexQuotes.length > 0
      ? args.indexQuotes.reduce((s, q) => s + (q.changePct ?? 0), 0) /
        args.indexQuotes.length
      : 0;
  const vix = args.vixQuote?.price ?? null;

  let regimeScore = clamp(avgChange / 2, -1, 1) * 0.7;
  if (vix != null) {
    if (vix > 20) regimeScore -= 0.3;
    else if (vix < 12) regimeScore += 0.2;
  }
  regimeScore = clamp(regimeScore, -1, 1);

  let regime: AiMarketRegime;
  if (regimeScore > 0.4) regime = "risk-on";
  else if (regimeScore < -0.4) regime = "risk-off";
  else if (Math.abs(regimeScore) < 0.15) regime = "compressed";
  else regime = "mixed";

  const bullets: string[] = [];
  bullets.push(
    `NIFTY/BANKNIFTY/FINNIFTY avg ${avgChange >= 0 ? "+" : ""}${avgChange.toFixed(2)}%`,
  );
  if (vix != null) bullets.push(`India VIX ${vix.toFixed(2)}`);
  if (args.inActiveWindow) {
    bullets.push(`Inside ${args.windowLabel} — F&O execution OK`);
  } else if (args.nextSession) {
    bullets.push(
      `NSE closed — signals queued for ${args.nextSession.dayLabel}'s ${args.nextSession.timeLabel} open`,
    );
  } else {
    bullets.push(`Outside ${args.windowLabel} — plan only, no live execution`);
  }

  const headline =
    regime === "risk-on"
      ? "Risk-on — indices firm, VIX contained. Press the longs."
      : regime === "risk-off"
        ? "Risk-off — indices red, VIX elevated. Fade rips, hedge longs."
        : regime === "compressed"
          ? "Compressed — IV cheap, indices coiled. Pre-position lightly."
          : "Mixed — sectors rotating, pick spots only.";

  return {
    market: "india",
    regime,
    regimeScore,
    headline,
    bullets,
    inActiveWindow: args.inActiveWindow,
    windowLabel: args.windowLabel,
    dataFreshness: "live",
    // Only surface the next-session anchor when NSE is actually closed.
    // When it's open, leaving these nullish keeps the UI from rendering
    // a stale "queued for…" banner mid-session.
    nextSessionOpensAt:
      !args.inActiveWindow && args.nextSession
        ? args.nextSession.opensAt
        : null,
    nextSessionLabel:
      !args.inActiveWindow && args.nextSession
        ? `${args.nextSession.dayLabel} at ${args.nextSession.timeLabel}`
        : null,
  };
}

/**
 * Build the F&O ticker universe the AI engine covers. We focus on the four
 * index underlyings (best option-chain coverage) and three high-liquidity
 * F&O leaders for stock-level signals.
 */
const FNO_STOCK_LEADERS = ["RELIANCE", "HDFCBANK", "TCS"] as const;

interface UniverseEntry {
  symbol: string;
  displayName: string;
  isIndex: boolean;
  yahooSymbol: string;
}

function buildUniverse(): UniverseEntry[] {
  const indexEntries: UniverseEntry[] = FNO_INDICES.map((i) => ({
    symbol: i.underlying,
    displayName: i.name,
    isIndex: true,
    yahooSymbol: i.symbol,
  }));
  const stockEntries: UniverseEntry[] = FNO_STOCK_LEADERS.map((s) => ({
    symbol: s,
    displayName: s,
    isIndex: false,
    yahooSymbol: s,
  }));
  return [...indexEntries, ...stockEntries];
}

export async function getIndiaAiSignals(): Promise<AiSignalsResponse> {
  return indiaCache.memo("ai-signals:india:v1", CACHE_TTL_MS, async () => {
    const universe = buildUniverse();
    const yahooSymbols = universe.map((u) => u.yahooSymbol);

    const [quotes, vixQuoteRes, scannerScoresRes] = await Promise.allSettled([
      yahoo.getQuotes(yahooSymbols),
      yahoo.getQuote("^INDIAVIX"),
      loadScannerScores(),
    ]);

    const quoteList = quotes.status === "fulfilled" ? quotes.value : [];
    const vixQuote = vixQuoteRes.status === "fulfilled" ? vixQuoteRes.value : null;
    const scannerMap =
      scannerScoresRes.status === "fulfilled"
        ? scannerScoresRes.value
        : new Map<string, { score: number; tags: string[] }>();

    const dailiesByYf = new Map<string, Candle[]>();
    const chainBySymbol = new Map<string, OptionChain | null>();

    await Promise.all(
      universe.map(async (u, idx) => {
        const yfSym = yahooSymbols[idx];
        try {
          const candles = await yahoo.getHistorical({
            symbol: u.yahooSymbol,
            interval: "1d",
            range: "1y",
          });
          dailiesByYf.set(yfSym, candles);
        } catch (err) {
          console.warn(
            `[ai-signals/india] hist failed for ${u.symbol}:`,
            (err as Error).message,
          );
          dailiesByYf.set(yfSym, []);
        }

        // Option chain only available for the four F&O index underlyings + the
        // F&O stocks NSE serves. Fail-soft on shadow-bans / 401s.
        try {
          const chain = await nse.getOptionChain(u.symbol);
          chainBySymbol.set(u.symbol, chain);
        } catch (err) {
          console.warn(
            `[ai-signals/india] option-chain failed for ${u.symbol}:`,
            (err as Error).message,
          );
          chainBySymbol.set(u.symbol, null);
        }
      }),
    );

    const status = getBestTimeStatus();
    const inActiveWindow =
      status.active.slug !== "off" && status.active.slug !== "worst";
    const windowLabel = status.active.label;

    // When NSE is currently closed (off-hours, weekend, auction), resolve
    // the next 09:15 IST open so per-signal timing windows + the context
    // banner can frame every signal as "queued for the next session"
    // rather than "fired at a dead-zone timestamp".
    const nextSession = inActiveWindow ? null : getNextTradingSessionOpen();

    const now = Date.now();

    const signals: AiSignal[] = universe.map((u, idx) => {
      const yfSym = yahooSymbols[idx];
      const quote = quoteList[idx] ?? null;
      const dailies = dailiesByYf.get(yfSym) ?? [];
      const chain = chainBySymbol.get(u.symbol) ?? null;
      const scannerScore = scannerMap.get(u.symbol) ?? null;
      return buildIndiaSignal({
        symbol: u.symbol,
        displayName: u.displayName,
        isIndex: u.isIndex,
        quote,
        dailies,
        chain,
        scannerScore,
        now,
        inActiveWindow,
        windowLabel,
        nextSession,
      });
    });

    const context = buildIndiaContext({
      vixQuote,
      indexQuotes: quoteList.slice(0, FNO_INDICES.length),
      inActiveWindow,
      windowLabel,
      nextSession,
    });

    let bullish = 0;
    let bearish = 0;
    let wait = 0;
    let confSum = 0;
    let topGrade: AiSignal["grade"] | null = null;
    const gradeRank = { S: 5, A: 4, B: 3, C: 2, D: 1 } as const;
    for (const s of signals) {
      if (s.direction === "BULLISH") bullish++;
      else if (s.direction === "BEARISH") bearish++;
      else wait++;
      confSum += s.confidence;
      if (!topGrade || gradeRank[s.grade] > gradeRank[topGrade]) topGrade = s.grade;
    }
    const avgConfidence = signals.length > 0 ? confSum / signals.length : 0;

    return {
      market: "india",
      generatedAt: now,
      modelVersion: AI_MODEL_VERSION,
      context,
      signals,
      stats: { bullish, bearish, wait, avgConfidence, topGrade },
    };
  });
}

export const __internals = {
  buildIndiaSignal,
  indiaFactors,
  dailyAtr,
  dailyRsi,
  sma,
  DERIVATIVE_FACTOR_IDS,
};
