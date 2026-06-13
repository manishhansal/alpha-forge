/**
 * Best-time-to-trade engine (IST).
 *
 * Pure, deterministic functions — no DOM access, no timezone-dependent
 * `Date` formatters. Every computation pivots off `Date.getTime()` plus the
 * fixed +5:30 IST offset so the result is identical on the server and the
 * browser regardless of host timezone.
 *
 * Window definitions come from the prompt the dashboard ships against
 * (see `ALPHAFORGE.md → Best Time to Trade`). Don't tweak
 * priorities without re-running the unit logic — the "currently active"
 * resolver assumes Golden > Breakout > Prime > Swing > Range > Worst > Off.
 */

import type {
  BestTimeStatus,
  DayOfWeek,
  DayRecommendation,
  Quality,
  StyleRecommendation,
  TradingWindow,
  UpcomingWindow,
} from "./types";

const IST_OFFSET_MIN = 5 * 60 + 30;

/** Friendly "HH:mm" formatter for an IST minute-of-day. Pure, no Intl. */
function formatHm(minute: number): string {
  const normalised = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(normalised / 60);
  const m = normalised % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/**
 * Resolve a JS Date into the IST wall-clock fields we care about.
 *
 * Implementation note: we shift `getTime()` by the IST offset and then read
 * the result via the UTC getters. This sidesteps `toLocaleString` (which is
 * locale/runtime dependent and slow) and works identically in Node and the
 * browser.
 */
export function toIstParts(date: Date = new Date()): {
  hour: number;
  minute: number;
  dayOfWeek: DayOfWeek;
  minuteOfDay: number;
} {
  const shifted = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dayOfWeek: shifted.getUTCDay() as DayOfWeek,
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

// ---------------------------------------------------------------------------
// Window catalogue
// ---------------------------------------------------------------------------

const HM = (h: number, m = 0): number => h * 60 + m;

/** Synthetic fallback for "no notable window right now". */
const OFF_WINDOW: TradingWindow = {
  slug: "off",
  label: "Off-Hours",
  headline: "Quiet market",
  startMin: 0,
  endMin: 1440,
  priority: 0,
  quality: "off",
  styles: ["Wait & journal", "Review trades"],
  insight:
    "Liquidity is thin and setups are choppy. Save your capital for the next high-quality window.",
};

/**
 * The full window catalogue, ordered for readability. The "active window"
 * resolver picks by `priority`, not array order — so feel free to move
 * entries around.
 */
export const TRADING_WINDOWS: readonly TradingWindow[] = [
  {
    slug: "worst",
    label: "Worst Zone",
    headline: "Avoid trading",
    startMin: HM(2),
    endMin: HM(7),
    priority: 1,
    quality: "poor",
    styles: ["Sleep", "Skip unless FOMC/CPI/ETF news"],
    insight:
      "Lower liquidity, fake moves, choppy market. Step away unless a scheduled macro event is driving real flow.",
  },
  {
    slug: "range",
    label: "Range Scalp Window",
    headline: "Slow but tradeable",
    startMin: HM(11, 30),
    endMin: HM(15),
    priority: 2,
    quality: "moderate",
    styles: ["VWAP scalping", "Support/resistance", "Range trading"],
    insight:
      "Movement is slow but predictable. Good for mean-reversion setups and tight, defined-risk scalps. Bad for aggressive breakouts.",
  },
  {
    slug: "breakout",
    label: "Volatility Breakout Window",
    headline: "Catalyst-driven moves",
    startMin: HM(18),
    endMin: HM(20),
    priority: 4,
    quality: "ideal",
    styles: ["Breakout trading", "Momentum entries", "News reactions"],
    insight:
      "US pre-market activity, institutional positioning, and crypto-news reactions trigger clean breakouts. Trade with confirmation.",
  },
  {
    slug: "prime",
    label: "Prime Futures Window",
    headline: "Highest probability hours",
    startMin: HM(18, 30),
    endMin: HM(23, 30),
    priority: 3,
    quality: "ideal",
    styles: ["Futures trading", "Scalping", "Momentum trading"],
    insight:
      "European session is active, US session opens, and institutional volume joins. BTC, ETH and SOL print their cleanest setups here.",
  },
  {
    slug: "golden",
    label: "Golden Scalp Zone",
    headline: "Peak liquidity for scalpers",
    startMin: HM(19),
    endMin: HM(22),
    priority: 5,
    quality: "ideal",
    styles: ["1m scalping", "5m scalping", "Futures scalping"],
    insight:
      "High liquidity, tight spreads, strong momentum, cleaner setups. The textbook window professionals trade on Binance / Bybit / Delta.",
  },
  {
    slug: "swing",
    label: "Swing Entry Window",
    headline: "Position-building hours",
    startMin: HM(20),
    endMin: HM(24),
    priority: 2,
    quality: "good",
    styles: ["Swing entries", "Position scaling"],
    insight:
      "After the scalp rush, late-session trend bias becomes clearer — a good time to scale into multi-day positions.",
  },
];

/** Stable weekday quality table (IST). */
export const DAY_RECOMMENDATIONS: readonly DayRecommendation[] = [
  { day: 0, label: "Sunday", quality: "poor", note: "Low liquidity — most desks are offline." },
  { day: 1, label: "Monday", quality: "moderate", note: "Often choppy as the week resets." },
  { day: 2, label: "Tuesday", quality: "ideal", note: "Excellent — full institutional flow." },
  { day: 3, label: "Wednesday", quality: "ideal", note: "Excellent — peak weekday volume." },
  { day: 4, label: "Thursday", quality: "ideal", note: "Excellent — trend-day favourite." },
  { day: 5, label: "Friday", quality: "good", note: "Good but volatile — beware late de-risking." },
  { day: 6, label: "Saturday", quality: "moderate", note: "Medium — retail-driven, thinner books." },
];

/** Per-style recommendations matching the published guidance. */
export const STYLE_RECOMMENDATIONS: readonly StyleRecommendation[] = [
  {
    style: "Scalping",
    istWindow: "7:00 PM – 10:00 PM",
    rationale: "High liquidity, tight spreads, cleaner setups.",
    matches: "golden",
  },
  {
    style: "Futures trading",
    istWindow: "6:30 PM – 11:30 PM",
    rationale: "European + US overlap = institutional volume.",
    matches: "prime",
  },
  {
    style: "Swing entries",
    istWindow: "8:00 PM – 12:00 AM",
    rationale: "Late-session bias to scale multi-day positions.",
    matches: "swing",
  },
  {
    style: "Range trading",
    istWindow: "11:00 AM – 3:00 PM",
    rationale: "Slow, predictable movement for mean reversion.",
    matches: "range",
  },
  {
    style: "Breakouts",
    istWindow: "6:00 PM – 8:00 PM",
    rationale: "US pre-market + news reactions ignite momentum.",
    matches: "breakout",
  },
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const QUALITY_SCORE: Record<Quality, number> = {
  ideal: 100,
  good: 78,
  moderate: 55,
  off: 35,
  poor: 12,
};

const DAY_MULTIPLIER: Record<Quality, number> = {
  ideal: 1.0,
  good: 0.92,
  moderate: 0.82,
  off: 0.78,
  poor: 0.7,
};

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function verdictFromScore(score: number, windowQuality: Quality): string {
  if (windowQuality === "poor") return "Avoid trading — wait for the next window";
  if (windowQuality === "off" && score < 50) return "Off-hours — protect capital";
  if (score >= 85) return "Ideal time to trade";
  if (score >= 70) return "Strong window — trade with conviction";
  if (score >= 55) return "Tradeable — stick to your plan";
  if (score >= 40) return "Low-edge window — size down";
  return "Poor conditions — sit on hands";
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Return every defined window that covers `minuteOfDay`, sorted by
 * priority (highest first). The synthetic `OFF_WINDOW` is never included
 * — callers handle the empty case explicitly.
 */
export function getOverlappingWindows(minuteOfDay: number): TradingWindow[] {
  return TRADING_WINDOWS.filter((w) => minuteOfDay >= w.startMin && minuteOfDay < w.endMin).sort(
    (a, b) => b.priority - a.priority,
  );
}

/**
 * Find the highest-priority "more important than current" window that
 * starts later today. If `currentPriority` is 0 (we're in OFF) the
 * candidates are every catalogued window.
 */
function findNextUpgrade(
  minuteOfDay: number,
  currentPriority: number,
): TradingWindow | null {
  let best: TradingWindow | null = null;
  for (const w of TRADING_WINDOWS) {
    if (w.priority <= currentPriority) continue;
    if (w.startMin <= minuteOfDay) continue;
    if (!best || w.startMin < best.startMin) best = w;
  }
  return best;
}

/**
 * Build a `BestTimeStatus` snapshot for `at`. Defaults to "now". Designed
 * to be called identically on the server (during SSR / route handlers) and
 * the browser (inside a `useEffect` tick).
 */
export function getBestTimeStatus(at: Date = new Date()): BestTimeStatus {
  const parts = toIstParts(at);
  const overlapping = getOverlappingWindows(parts.minuteOfDay);
  const active = overlapping[0] ?? OFF_WINDOW;

  const day = DAY_RECOMMENDATIONS.find((d) => d.day === parts.dayOfWeek) ?? DAY_RECOMMENDATIONS[0];

  const base = QUALITY_SCORE[active.quality];
  const multiplier = DAY_MULTIPLIER[day.quality];
  const score = clampScore(base * multiplier);

  const upgrade = findNextUpgrade(parts.minuteOfDay, active.priority);
  const nextWindow: UpcomingWindow | null = upgrade
    ? {
        slug: upgrade.slug,
        label: upgrade.label,
        startsInMinutes: Math.max(0, upgrade.startMin - parts.minuteOfDay),
        startsAt: formatHm(upgrade.startMin),
        quality: upgrade.quality,
      }
    : null;

  const activeEndsInMinutes =
    active.slug === "off" ? null : Math.max(0, active.endMin - parts.minuteOfDay);

  return {
    computedAt: at.toISOString(),
    istTime: formatHm(parts.minuteOfDay),
    istDay: day,
    active,
    score,
    verdict: verdictFromScore(score, active.quality),
    overlapping,
    nextWindow,
    activeEndsInMinutes,
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** "1h 24m" / "47m" / "soon" — used by countdown chips. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "soon";
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Pretty-print a window's start/end as "7:00 PM – 10:00 PM IST". */
export function formatWindowRange(window: TradingWindow): string {
  return `${minuteToClock(window.startMin)} – ${minuteToClock(window.endMin)} IST`;
}

function minuteToClock(minute: number): string {
  const normalised = ((minute % 1440) + 1440) % 1440;
  const h24 = Math.floor(normalised / 60);
  const m = normalised % 60;
  const period = h24 >= 12 ? "PM" : "AM";
  const h12Raw = h24 % 12;
  const h12 = h12Raw === 0 ? 12 : h12Raw;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

/** Tailwind-friendly tone tokens per Quality bucket. */
export const QUALITY_TOKENS: Record<
  Quality,
  {
    text: string;
    bg: string;
    ring: string;
    dot: string;
    badge: "bull" | "bear" | "warning" | "info" | "neutral";
  }
> = {
  ideal: {
    text: "text-[var(--color-bull)]",
    bg: "bg-[color-mix(in_oklch,var(--color-bull)_15%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bull)_32%,transparent)]",
    dot: "bg-[var(--color-bull)]",
    badge: "bull",
  },
  good: {
    text: "text-[var(--color-info)]",
    bg: "bg-[color-mix(in_oklch,var(--color-info)_14%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-info)_30%,transparent)]",
    dot: "bg-[var(--color-info)]",
    badge: "info",
  },
  moderate: {
    text: "text-[var(--color-warning)]",
    bg: "bg-[color-mix(in_oklch,var(--color-warning)_14%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-warning)_30%,transparent)]",
    dot: "bg-[var(--color-warning)]",
    badge: "warning",
  },
  off: {
    text: "text-[var(--color-fg-muted)]",
    bg: "bg-[var(--color-surface-hover)]",
    ring: "ring-[var(--color-border)]",
    dot: "bg-[var(--color-fg-subtle)]",
    badge: "neutral",
  },
  poor: {
    text: "text-[var(--color-bear)]",
    bg: "bg-[color-mix(in_oklch,var(--color-bear)_14%,transparent)]",
    ring: "ring-[color-mix(in_oklch,var(--color-bear)_30%,transparent)]",
    dot: "bg-[var(--color-bear)]",
    badge: "bear",
  },
};
