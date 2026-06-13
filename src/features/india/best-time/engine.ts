/**
 * Best-time-to-trade engine — Indian NSE F&O surface.
 *
 * Mirrors the structure of `src/features/best-time/engine.ts` (same shape
 * of `BestTimeStatus`, same `Quality` buckets, same IST-shifted resolver)
 * but the windows here are anchored to NSE cash + F&O sessions instead of
 * 24/7 crypto. Trading on NSE only happens 09:15 → 15:30 IST on weekdays,
 * so the catalogue is dense in that band and the rest of the day is the
 * "off" sentinel.
 *
 * Pure, deterministic functions — no DOM access, no `Intl`, no host
 * timezone dependence — so server + client render identically.
 */

import type {
  BestTimeStatus,
  DayOfWeek,
  DayRecommendation,
  Quality,
  StyleRecommendation,
  TradingWindow,
  UpcomingWindow,
  WindowSlug,
} from "@/features/best-time/types";

const IST_OFFSET_MIN = 5 * 60 + 30;

/** Friendly "HH:mm" formatter for an IST minute-of-day. */
function formatHm(minute: number): string {
  const normalised = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(normalised / 60);
  const m = normalised % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

/** Resolve a JS Date into IST wall-clock fields. */
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

const HM = (h: number, m = 0): number => h * 60 + m;

/** Synthetic fallback for "outside NSE trading hours". */
const OFF_WINDOW: TradingWindow = {
  slug: "off",
  label: "Market Closed",
  headline: "NSE is shut",
  startMin: 0,
  endMin: 1440,
  priority: 0,
  quality: "off",
  styles: ["Plan watchlist", "Review trades"],
  insight:
    "NSE cash + F&O is open 09:15 – 15:30 IST on weekdays. Use closed-market hours for journaling, scans and prep — not live trading.",
};

/**
 * NSE trading windows. The catalogue is intentionally dense between
 * 09:15 and 15:30 because that's when the entire surface is liquid.
 *
 * Slug semantics from the shared `WindowSlug` are reused as labels:
 *   - "breakout" → opening-range breakout block (high vol, gap risk)
 *   - "prime"    → mid-morning trend (clean trends, sector rotation)
 *   - "range"    → midday lull (mean reversion, low conviction)
 *   - "swing"    → afternoon trend (directional moves resume)
 *   - "golden"   → power hour (peak liquidity, cleanest scalps)
 *   - "worst"    → pre-open / closing auction (avoid market orders)
 */
export const TRADING_WINDOWS: readonly TradingWindow[] = [
  {
    slug: "worst",
    label: "Pre-Open Auction",
    headline: "Avoid market orders",
    startMin: HM(9),
    endMin: HM(9, 15),
    priority: 1,
    quality: "poor",
    styles: ["Watch", "Cancel stale GTT", "Skip market orders"],
    insight:
      "Discovery-only window — orders match at one auction price at 09:15. Limit orders only; market orders are dangerous because the open can gap several percent on news.",
  },
  {
    slug: "breakout",
    label: "Opening Volatility",
    headline: "Gap fills · ORB · news reactions",
    startMin: HM(9, 15),
    endMin: HM(10, 0),
    priority: 4,
    quality: "ideal",
    styles: ["Opening-range breakout", "Gap fade / continuation", "F&O index momentum"],
    insight:
      "First 45 minutes carry the day's highest volatility — overnight news, SGX Nifty handoff and US-close reactions all collide. Best for ORB and gap setups; avoid mean-reversion trades.",
  },
  {
    slug: "prime",
    label: "Morning Trend",
    headline: "Cleanest trending block",
    startMin: HM(10, 0),
    endMin: HM(11, 30),
    priority: 5,
    quality: "ideal",
    styles: ["Trend-follow", "Sector rotation", "F&O scalping"],
    insight:
      "Volatility cools but direction stays intact — institutional desks add into the morning move. Highest signal-to-noise of the day for trend-followers and intraday F&O scalps.",
  },
  {
    slug: "range",
    label: "Midday Lull",
    headline: "Slow tape · range trade only",
    startMin: HM(11, 30),
    endMin: HM(13, 30),
    priority: 2,
    quality: "moderate",
    styles: ["Mean reversion", "Tight scalps", "Watch only"],
    insight:
      "Volume thins as desks lunch and EU pre-open pulls focus. Treat it as a range-bound regime — fade extremes, avoid breakouts, size down. Strong moves here often reverse by 13:30.",
  },
  {
    slug: "swing",
    label: "Afternoon Trend",
    headline: "Directional flow resumes",
    startMin: HM(13, 30),
    endMin: HM(15, 0),
    priority: 3,
    quality: "good",
    styles: ["Position trades", "Sector rotation", "Index F&O"],
    insight:
      "EU open + late-session institutional flow restart the trend. Good for scaling positions, follow-through on morning setups, and late index F&O entries before the power hour.",
  },
  {
    slug: "golden",
    label: "Power Hour",
    headline: "Peak liquidity for F&O scalpers",
    startMin: HM(15, 0),
    endMin: HM(15, 30),
    priority: 6,
    quality: "ideal",
    styles: ["1m / 5m scalping", "Index option scalping", "Closing-flow trades"],
    insight:
      "Tightest spreads, biggest tape and the final liquidity push. NIFTY / BANKNIFTY weekly option premiums move fastest here — the textbook window for short-time-frame F&O scalpers.",
  },
  {
    slug: "worst",
    label: "Closing Auction",
    headline: "MTM only — limit orders",
    startMin: HM(15, 30),
    endMin: HM(15, 40),
    priority: 1,
    quality: "poor",
    styles: ["MTM exits", "Limit orders only"],
    insight:
      "Closing call auction — only limit orders are accepted and prints often deviate from the last traded price. Square off intraday before 15:30 to avoid auction slippage.",
  },
];

/** Stable weekday quality table for NSE F&O (IST). */
export const DAY_RECOMMENDATIONS: readonly DayRecommendation[] = [
  {
    day: 0,
    label: "Sunday",
    quality: "off",
    note: "Closed — use it to scan and plan the week ahead.",
  },
  {
    day: 1,
    label: "Monday",
    quality: "moderate",
    note: "Often gappy — the tape digests weekend headlines and global cues.",
  },
  {
    day: 2,
    label: "Tuesday",
    quality: "ideal",
    note: "Strong directional days — clean trends and follow-through.",
  },
  {
    day: 3,
    label: "Wednesday",
    quality: "ideal",
    note: "Excellent — peak weekday volume, mid-week trend conviction.",
  },
  {
    day: 4,
    label: "Thursday",
    quality: "good",
    note: "Weekly NIFTY / BANKNIFTY expiry — high IV, fast option moves, plan around it.",
  },
  {
    day: 5,
    label: "Friday",
    quality: "good",
    note: "Position-squaring + monthly expiry weeks. Trend in the morning, fade into close.",
  },
  {
    day: 6,
    label: "Saturday",
    quality: "off",
    note: "Closed — backtest, prep watchlists, study the week.",
  },
];

/** Per-style recommendations matched to NSE windows. */
export const STYLE_RECOMMENDATIONS: readonly StyleRecommendation[] = [
  {
    style: "F&O scalping",
    istWindow: "10:00 AM – 11:30 AM · 3:00 PM – 3:30 PM",
    rationale: "Cleanest tape and tightest option spreads.",
    matches: "golden",
  },
  {
    style: "ORB / gap trading",
    istWindow: "9:15 AM – 10:00 AM",
    rationale: "Opening volatility prints the day's defining range.",
    matches: "breakout",
  },
  {
    style: "Trend / swing entries",
    istWindow: "10:00 AM – 11:30 AM · 1:30 PM – 3:00 PM",
    rationale: "Directional flow with institutional follow-through.",
    matches: "prime",
  },
  {
    style: "Mean reversion",
    istWindow: "11:30 AM – 1:30 PM",
    rationale: "Slow tape, wide ranges — good for fades.",
    matches: "range",
  },
  {
    style: "Index option carry",
    istWindow: "1:30 PM – 3:00 PM",
    rationale: "EU open + India afternoon overlap drives index F&O.",
    matches: "swing",
  },
];

const QUALITY_SCORE: Record<Quality, number> = {
  ideal: 100,
  good: 78,
  moderate: 55,
  off: 20,
  poor: 12,
};

const DAY_MULTIPLIER: Record<Quality, number> = {
  ideal: 1.0,
  good: 0.92,
  moderate: 0.82,
  off: 0.6,
  poor: 0.7,
};

function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isWeekend(day: DayOfWeek): boolean {
  return day === 0 || day === 6;
}

function verdictFromScore(
  score: number,
  windowQuality: Quality,
  weekend: boolean,
): string {
  if (weekend) return "Market closed — plan & journal";
  if (windowQuality === "poor") return "Avoid trading — auction window";
  if (windowQuality === "off") return "Outside NSE hours — sit on hands";
  if (score >= 85) return "Ideal time to trade NSE F&O";
  if (score >= 70) return "Strong window — trade with conviction";
  if (score >= 55) return "Tradeable — stick to your plan";
  if (score >= 40) return "Low-edge window — size down";
  return "Poor conditions — sit on hands";
}

/** Overlapping windows at `minuteOfDay`, priority-sorted. */
export function getOverlappingWindows(minuteOfDay: number): TradingWindow[] {
  return TRADING_WINDOWS.filter(
    (w) => minuteOfDay >= w.startMin && minuteOfDay < w.endMin,
  ).sort((a, b) => b.priority - a.priority);
}

/** Highest-priority "more important than current" window starting later today. */
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
 * Build a `BestTimeStatus` snapshot for `at`. NSE-aware: forces "off" on
 * weekends regardless of clock, and applies the weekday quality multiplier
 * (Tue/Wed are ideal; Mon is moderate; Sat/Sun are off).
 */
export function getBestTimeStatus(at: Date = new Date()): BestTimeStatus {
  const parts = toIstParts(at);
  const weekend = isWeekend(parts.dayOfWeek);

  const overlapping = weekend ? [] : getOverlappingWindows(parts.minuteOfDay);
  const active = overlapping[0] ?? OFF_WINDOW;

  const day =
    DAY_RECOMMENDATIONS.find((d) => d.day === parts.dayOfWeek) ??
    DAY_RECOMMENDATIONS[0];

  const base = QUALITY_SCORE[active.quality];
  const multiplier = DAY_MULTIPLIER[day.quality];
  const score = clampScore(base * multiplier);

  // Next upgrade only makes sense intraday on a weekday.
  const upgrade = weekend
    ? null
    : findNextUpgrade(parts.minuteOfDay, active.priority);
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
    verdict: verdictFromScore(score, active.quality, weekend),
    overlapping,
    nextWindow,
    activeEndsInMinutes,
  };
}

/**
 * Wall-clock minute-of-day when the NSE cash + F&O session opens (09:15 IST).
 * Kept as a named constant so anything that needs the "next session open"
 * timestamp doesn't have to hard-code it in three places.
 */
export const NSE_SESSION_OPEN_MIN = HM(9, 15);
/** Wall-clock minute-of-day when continuous trading ends (15:30 IST). */
export const NSE_SESSION_CLOSE_MIN = HM(15, 30);

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface NextTradingSession {
  /** Absolute UTC ms timestamp of the next 09:15 IST open. */
  opensAt: number;
  /** Friendly day label — "today" / "tomorrow" / "Monday" / "Tuesday" / …. */
  dayLabel: string;
  /** Fully-qualified day label — always the weekday name. */
  weekdayLabel: string;
  /** Fixed "09:15 IST" — exposed so the UI doesn't have to know it. */
  timeLabel: string;
  /** True when `at` is already inside the 09:15 – 15:30 IST cash window. */
  isOpenNow: boolean;
}

/**
 * Resolve the next NSE session open relative to `at`. Walks the IST calendar
 * one day at a time, skipping Saturday / Sunday, and returns the first
 * 09:15 IST that is strictly in the future relative to `at`.
 *
 * Pure / deterministic — derives the absolute timestamp directly from the
 * IST-shifted millisecond stream so it doesn't depend on the host timezone
 * (same invariant as `getBestTimeStatus`).
 *
 * Note: no NSE holiday calendar is consulted (the engine has none today).
 * Worst case the UI says "queued for tomorrow" on a holiday — same scope
 * as the rest of the engine.
 */
export function getNextTradingSessionOpen(at: Date = new Date()): NextTradingSession {
  const parts = toIstParts(at);
  const weekend = isWeekend(parts.dayOfWeek);
  const inSession =
    !weekend &&
    parts.minuteOfDay >= NSE_SESSION_OPEN_MIN &&
    parts.minuteOfDay < NSE_SESSION_CLOSE_MIN;

  // Anchor IST midnight (in UTC ms) for the day `at` falls in. We shift
  // forward by IST_OFFSET_MIN, floor to the UTC-day boundary, then shift
  // back — that's the canonical way to get "today 00:00 IST" without
  // touching the host timezone.
  const shiftedMs = at.getTime() + IST_OFFSET_MIN * 60_000;
  const istDayStartUtcMs =
    Math.floor(shiftedMs / 86_400_000) * 86_400_000 - IST_OFFSET_MIN * 60_000;

  // Pick the offset (in days) of the next weekday whose 09:15 IST is in
  // the future. If we're on a weekday and the clock is still before 09:15,
  // today qualifies; otherwise walk forward.
  let offset = parts.minuteOfDay < NSE_SESSION_OPEN_MIN && !weekend ? 0 : 1;
  for (let i = 0; i < 7; i++) {
    const dow = ((parts.dayOfWeek + offset) % 7) as DayOfWeek;
    if (!isWeekend(dow)) break;
    offset++;
  }

  const opensAt =
    istDayStartUtcMs + offset * 86_400_000 + NSE_SESSION_OPEN_MIN * 60_000;
  const targetDow = ((parts.dayOfWeek + offset) % 7) as DayOfWeek;
  const weekdayLabel = DAY_NAMES[targetDow];
  const dayLabel =
    offset === 0 ? "today" : offset === 1 ? "tomorrow" : weekdayLabel;

  return {
    opensAt,
    dayLabel,
    weekdayLabel,
    timeLabel: "09:15 IST",
    isOpenNow: inSession,
  };
}

/** "1h 24m" / "47m" / "soon". */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "soon";
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** "9:15 AM – 10:00 AM IST". */
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

/** Re-export the shared quality token map so the page can colour-match. */
export type { WindowSlug };
