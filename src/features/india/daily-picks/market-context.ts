/**
 * Daily Picks — Market Context Header builder.
 *
 * The Market Context Block from the institutional Daily Picks spec, rendered
 * once above all picks: NIFTY 50 / BANKNIFTY level + trend + S/R, India VIX
 * value + regime, NIFTY PCR + interpretation, max-pain levels, FII flow,
 * sector watch, and a single overall bias line.
 *
 * Pure — same inputs always produce the same output. Resolution is fail-soft:
 * any input that's null / unavailable is reflected as null in the header
 * rather than poisoning the whole block.
 */

import type { AiMarketContext, AiMarketRegime } from "@/types/ai-signals";
import type { OptionChain } from "@/types/india";

/** Coarse intraday trend classification used in the header. */
export type IndexTrend = "bullish" | "bearish" | "sideways";

/** India VIX regime ladder — low/moderate/high/extreme. */
export type IndiaVixRegime = "low" | "moderate" | "high" | "extreme";

/** PCR interpretation — bearish (CE-heavy) / neutral / bullish (PE-heavy). */
export type PcrInterpretation = "bearish" | "neutral" | "bullish";

export interface IndexContextLine {
  /** Latest spot / level for the underlying. */
  level: number;
  trend: IndexTrend;
  /** Intraday change in % (positive = up). */
  changePct: number;
  /** Nearest desk-level support — derived from the largest PE OI strike. */
  support: number | null;
  /** Nearest desk-level resistance — derived from the largest CE OI strike. */
  resistance: number | null;
}

export interface VixHeader {
  value: number;
  regime: IndiaVixRegime;
}

export interface PcrHeader {
  value: number;
  interpretation: PcrInterpretation;
}

export interface FiiFlowHeader {
  /** Net buy/sell in ₹ Cr; null when the data source is absent. */
  netCr: number | null;
  /** Free-form context line. */
  note: string;
}

export interface SectorWatchHeader {
  /** Top sectors by intraday momentum. */
  strong: string[];
  /** Weakest sectors by intraday momentum. */
  weak: string[];
}

export interface MarketContextHeader {
  /** Human-readable IST date label ("Wed, 17 Jun 2026 IST"). */
  date: string;
  nifty: IndexContextLine | null;
  banknifty: IndexContextLine | null;
  indiaVix: VixHeader | null;
  pcrNifty: PcrHeader | null;
  maxPain: { nifty: number | null; banknifty: number | null };
  fiiFlow: FiiFlowHeader | null;
  sectorWatch: SectorWatchHeader | null;
  bias: { regime: AiMarketRegime; headline: string };
}

const TREND_THRESHOLD_PCT = 0.4;

export function classifyTrend(changePct: number | null | undefined): IndexTrend {
  if (changePct == null || !Number.isFinite(changePct)) return "sideways";
  if (changePct > TREND_THRESHOLD_PCT) return "bullish";
  if (changePct < -TREND_THRESHOLD_PCT) return "bearish";
  return "sideways";
}

export function classifyIndiaVixRegime(
  vix: number | null | undefined,
): IndiaVixRegime {
  if (vix == null || !Number.isFinite(vix)) return "moderate";
  if (vix < 13) return "low";
  if (vix < 18) return "moderate";
  if (vix < 25) return "high";
  return "extreme";
}

export function classifyPcr(
  pcr: number | null | undefined,
): PcrInterpretation {
  if (pcr == null || !Number.isFinite(pcr)) return "neutral";
  if (pcr > 1.3) return "bullish";
  if (pcr < 0.7) return "bearish";
  return "neutral";
}

/** IST (UTC+5:30) wall-clock formatted as "Wed, 17 Jun 2026 IST". */
function istDateLabel(now: number): string {
  const ist = new Date(now + 5.5 * 60 * 60 * 1000);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const dow = weekdays[ist.getUTCDay()];
  const day = String(ist.getUTCDate()).padStart(2, "0");
  const month = months[ist.getUTCMonth()];
  const year = ist.getUTCFullYear();
  return `${dow}, ${day} ${month} ${year} IST`;
}

function indexLineFromChain(
  level: number | null | undefined,
  changePct: number | null | undefined,
  chain: OptionChain | null | undefined,
): IndexContextLine | null {
  if (level == null || !Number.isFinite(level)) return null;
  return {
    level,
    changePct: changePct ?? 0,
    trend: classifyTrend(changePct),
    support: chain?.analytics.maxPeOiStrike ?? null,
    resistance: chain?.analytics.maxCeOiStrike ?? null,
  };
}

function biasHeadline(args: {
  regime: AiMarketRegime;
  context: AiMarketContext;
  indiaVix: number | null | undefined;
}): string {
  const vixRegime = classifyIndiaVixRegime(args.indiaVix);
  // When VIX is hot we surface that risk explicitly in the headline, so the
  // user reads the volatility regime before the directional bias.
  if (vixRegime === "high" || vixRegime === "extreme") {
    const suffix = args.context.headline.replace(/^[A-Za-z-]+ — /, "");
    return `High-VIX regime · ${suffix}`;
  }
  return args.context.headline;
}

export interface MarketContextHeaderInputs {
  now: number;
  /** Per-index level + intraday % change. Missing entries → null line. */
  indices: Partial<Record<"NIFTY" | "BANKNIFTY", { level: number; changePct: number | null }>>;
  /** Per-index option chain (used for S/R + PCR + max-pain). Missing → null. */
  chains: Partial<Record<"NIFTY" | "BANKNIFTY", OptionChain | null>>;
  indiaVix: number | null;
  /** Existing AI market context — drives regime + headline. */
  context: AiMarketContext;
  /** Optional FII flow passthrough — emit null when no data source is wired. */
  fiiFlow?: FiiFlowHeader | null;
  /** Optional sector watch passthrough — same fail-soft contract. */
  sectorWatch?: SectorWatchHeader | null;
}

export function buildMarketContextHeader(
  args: MarketContextHeaderInputs,
): MarketContextHeader {
  // Fail-soft: callers occasionally pass through partial wires (e.g. in the
  // ephemeral test path) where `indices` / `chains` weren't populated. Treat
  // missing keys as null lines rather than throwing.
  const indices = args.indices ?? {};
  const chains = args.chains ?? {};
  const niftyQuote = indices.NIFTY ?? null;
  const bankniftyQuote = indices.BANKNIFTY ?? null;
  const niftyChain = chains.NIFTY ?? null;
  const bankniftyChain = chains.BANKNIFTY ?? null;

  const nifty = niftyQuote
    ? indexLineFromChain(niftyQuote.level, niftyQuote.changePct, niftyChain)
    : null;
  const banknifty = bankniftyQuote
    ? indexLineFromChain(
        bankniftyQuote.level,
        bankniftyQuote.changePct,
        bankniftyChain,
      )
    : null;

  const indiaVix =
    args.indiaVix != null && Number.isFinite(args.indiaVix)
      ? { value: args.indiaVix, regime: classifyIndiaVixRegime(args.indiaVix) }
      : null;

  const pcrValue = niftyChain?.analytics.pcrOi ?? null;
  const pcrNifty =
    pcrValue != null && Number.isFinite(pcrValue)
      ? { value: pcrValue, interpretation: classifyPcr(pcrValue) }
      : null;

  return {
    date: istDateLabel(args.now),
    nifty,
    banknifty,
    indiaVix,
    pcrNifty,
    maxPain: {
      nifty: niftyChain?.analytics.maxPain ?? null,
      banknifty: bankniftyChain?.analytics.maxPain ?? null,
    },
    fiiFlow: args.fiiFlow ?? null,
    sectorWatch: args.sectorWatch ?? null,
    bias: {
      regime: args.context.regime,
      headline: biasHeadline({
        regime: args.context.regime,
        context: args.context,
        indiaVix: args.indiaVix,
      }),
    },
  };
}
