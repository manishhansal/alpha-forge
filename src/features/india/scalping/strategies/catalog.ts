/**
 * UI-facing metadata for every India F&O strategy. Modelled on the
 * crypto `src/features/scalping/strategies/catalog.ts` so the picker /
 * signal-card components stay structurally identical across markets —
 * only the data set differs.
 *
 * The first six strategies map 1:1 onto the existing NSE scanners
 * (`src/services/india/scanner/engine.ts`). The fetch-signals adapter
 * (`src/features/india/scalping/fetch-signals.ts`) wraps scanner output
 * into the `IndiaScalpSignal` shape so the live-signals feed renders
 * the same way the crypto feed does.
 *
 * The last two — `LIQUIDITY_EDGE` (India Liquidity Edge) and
 * `MAX_PAIN_GRAVITY` (India Max-Pain Gravity) — are ports of the
 * *India Liquidity Edge — Quant Framework* Pine indicator. They are NOT
 * scanner-backed: their signals come from the option-chain positioning
 * engine in `strategies/positioning.ts` (CE/PE walls, max-pain gravity,
 * PCR, OI build-up) rather than `runScanner`. ILE folds the framework
 * into a broad confluence score; IMPG isolates the max-pain / wall fade
 * into a focused mean-reversion play.
 *
 * New strategies must add their id here so the type system catches any
 * missing picker / chip / badge mapping. Renaming an id is a breaking
 * change for historical `PaperTrade.source` rows (`in:${id}:${tf}`).
 */

export const INDIA_SCALP_STRATEGY_IDS = [
  "RANGE_EXPANSION",
  "MOMENTUM",
  "VOLUME_BREAKOUT",
  "OI_BUILDUP",
  "PCR_EXTREME",
  "IV_SPIKE",
  "LIQUIDITY_EDGE",
  "MAX_PAIN_GRAVITY",
] as const;
export type IndiaScalpStrategyId = (typeof INDIA_SCALP_STRATEGY_IDS)[number];

export type IndiaScalpStrategyCategory =
  | "trend"
  | "momentum"
  | "volume"
  | "orderflow"
  | "options-flow"
  | "volatility"
  | "liquidity";

export type IndiaBadgeVariant =
  | "neutral"
  | "bull"
  | "bear"
  | "warning"
  | "info"
  | "outline";

export interface IndiaScalpStrategyMeta {
  id: IndiaScalpStrategyId;
  /** Short label rendered on chips/badges (≤ 22 chars). */
  label: string;
  /** Long-form description rendered in the picker + "how it works" card. */
  description: string;
  category: IndiaScalpStrategyCategory;
  /** Tags surfaced in the picker — indicators, regimes, etc. */
  tags: string[];
  /** Badge variant used to colour the chip in lists. */
  badge: IndiaBadgeVariant;
  /** One-letter monogram for compact chips. */
  monogram: string;
}

export const INDIA_SCALP_STRATEGY_CATALOG: ReadonlyArray<IndiaScalpStrategyMeta> =
  [
    {
      id: "RANGE_EXPANSION",
      label: "Range Expansion",
      description:
        "Today's H−L is the widest of the past 8 sessions (WR8) with a bullish daily/weekly/monthly close, an SMA 20>50>200 stack, volume ≥ 1.5× 20-day average, and price in the upper half of the range. Catches the first true volatility expansion of a trend leg.",
      category: "trend",
      tags: ["WR8", "SMA stack", "Volume", "Trend continuation"],
      badge: "bull",
      monogram: "R",
    },
    {
      id: "MOMENTUM",
      label: "Momentum",
      description:
        "F&O movers ranked by raw % change. Sorts the F&O universe by intraday move and surfaces the top names so you can ride or fade the leg with size. Useful into the Power Hour band when news-driven impulses chase liquidity.",
      category: "momentum",
      tags: ["% movers", "Intraday", "Power Hour"],
      badge: "warning",
      monogram: "M",
    },
    {
      id: "VOLUME_BREAKOUT",
      label: "Volume Breakout",
      description:
        "Volume ≥ 1.5× the 20-day average AND price closing in the top quartile of the bar's range. Filters out failed breakouts where size shows up but price gives it all back, and prefers names where institutional flow is committing in the direction of the bar.",
      category: "volume",
      tags: ["Volume", "Breakout", "Range close"],
      badge: "info",
      monogram: "V",
    },
    {
      id: "OI_BUILDUP",
      label: "OI Build-up",
      description:
        "Open-interest delta classified into Long Build-up / Short Build-up / Long Unwinding / Short Covering by combining the OI direction with the price direction on the same bar. Surfaces the F&O lane where fresh positioning is being added (or unwound) so you can align entries with the smart-money side.",
      category: "orderflow",
      tags: ["Open Interest", "Long buildup", "Short buildup"],
      badge: "info",
      monogram: "O",
    },
    {
      id: "PCR_EXTREME",
      label: "PCR Extreme",
      description:
        "Index Put-Call Ratio reaching contrarian extremes (very high PCR ⇒ excessive bearish sentiment, possible mean-reversion long; very low PCR ⇒ excessive bullish sentiment, possible mean-reversion short). Particularly useful on NIFTY / BANKNIFTY around weekly expiry where positioning skews matter most.",
      category: "options-flow",
      tags: ["PCR", "Mean reversion", "Sentiment"],
      badge: "neutral",
      monogram: "P",
    },
    {
      id: "IV_SPIKE",
      label: "IV Spike",
      description:
        "Implied-volatility crush / spike on F&O names — large IV jumps without commensurate price moves often precede event-driven moves (results, RBI day, expiry-week vol crush). Pairs naturally with a long-vega or short-vega lean depending on direction.",
      category: "volatility",
      tags: ["IV", "India VIX", "Event risk"],
      badge: "warning",
      monogram: "I",
    },
    {
      id: "LIQUIDITY_EDGE",
      label: "India Liquidity Edge",
      description:
        "Liquidity-first confluence engine ported from the India Liquidity Edge — Quant Framework Pine indicator. Folds option-chain positioning into a single bull/bear score on F&O indices: PCR side (>1.2 bullish PE writing / <0.85 bearish CE writing), max-pain side (pain above spot = bullish pull), OI-wall proximity (at the PE floor = support / at the CE wall = resistance), ΔPE−ΔCE OI build-up, and the intraday trend vs the previous close. Fires only when the net edge clears the confluence threshold, with a 2.5× ATR-band reward target.",
      category: "liquidity",
      tags: ["Liquidity", "PCR", "OI walls", "Max pain", "Confluence"],
      badge: "info",
      monogram: "L",
    },
    {
      id: "MAX_PAIN_GRAVITY",
      label: "Max-Pain Gravity",
      description:
        "Option-positioning mean-reversion play carved from the same ILE Pine framework but distinct from Liquidity Edge. Fades price back toward the max-pain strike once spot has drifted beyond the pull buffer, on the thesis that dealers pin the underlying to max pain into the close. Confidence is boosted when a confirming OI wall (CE ceiling for shorts / PE floor for longs) and the PCR skew align with the fade. Targets the max-pain strike with an ATR-sized stop.",
      category: "options-flow",
      tags: ["Max pain", "Mean reversion", "OI walls", "Pinning"],
      badge: "neutral",
      monogram: "G",
    },
  ] as const;

export const INDIA_SCALP_STRATEGY_META: Record<
  IndiaScalpStrategyId,
  IndiaScalpStrategyMeta
> = INDIA_SCALP_STRATEGY_CATALOG.reduce(
  (acc, s) => {
    acc[s.id] = s;
    return acc;
  },
  {} as Record<IndiaScalpStrategyId, IndiaScalpStrategyMeta>,
);

export function getIndiaStrategyMeta(
  id: IndiaScalpStrategyId,
): IndiaScalpStrategyMeta {
  return INDIA_SCALP_STRATEGY_META[id];
}

/** All India strategy IDs in canonical display order. */
export const ALL_INDIA_STRATEGY_IDS: ReadonlyArray<IndiaScalpStrategyId> =
  INDIA_SCALP_STRATEGY_CATALOG.map((s) => s.id);

/** Type guard — useful when validating untrusted strings from the API. */
export function isIndiaScalpStrategyId(
  value: string,
): value is IndiaScalpStrategyId {
  return (INDIA_SCALP_STRATEGY_IDS as readonly string[]).includes(value);
}
