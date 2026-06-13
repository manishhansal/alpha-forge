/**
 * Best-time-to-trade engine — public types.
 *
 * Everything here is computed against India Standard Time (UTC+5:30) because
 * the windows we publish (Golden Zone, Prime Time, Range Scalp, Worst Zone…)
 * are anchored to the Indian retail trader's daily routine.
 */

/** Calendar day-of-week — matches `Date.getUTCDay()` (0 = Sunday). */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Coarse quality buckets for both windows and weekdays. */
export type Quality = "ideal" | "good" | "moderate" | "poor" | "off";

/** Stable identifier for each pre-defined IST trading window. */
export type WindowSlug =
  | "golden"
  | "prime"
  | "breakout"
  | "swing"
  | "range"
  | "worst"
  | "off";

/**
 * A single, named trading window in the IST trader's day. Windows can
 * overlap — `priority` decides which one is "currently active" when more
 * than one applies (higher wins).
 */
export interface TradingWindow {
  slug: WindowSlug;
  label: string;
  headline: string;
  /** Inclusive start in minutes from IST midnight (0–1439). */
  startMin: number;
  /** Exclusive end in minutes from IST midnight (1–1440). */
  endMin: number;
  /** Used when several windows overlap — higher wins. */
  priority: number;
  quality: Quality;
  /** Trading styles this window is most suited for. */
  styles: string[];
  /** One-liner shown in the banner / dashboard. */
  insight: string;
}

/** Per-style "best IST time" entry used by the dashboard table. */
export interface StyleRecommendation {
  style: string;
  istWindow: string;
  rationale: string;
  /** Slug of the matching `TradingWindow` (or "off" if pure guidance). */
  matches: WindowSlug;
}

/** Per-weekday quality entry used by the dashboard table. */
export interface DayRecommendation {
  day: DayOfWeek;
  label: string;
  quality: Quality;
  note: string;
}

/** A scheduled window change — used to count down to the next session. */
export interface UpcomingWindow {
  slug: WindowSlug;
  label: string;
  /** Minutes from `now` (in IST) until this window starts. */
  startsInMinutes: number;
  /** "HH:mm" IST start label. */
  startsAt: string;
  quality: Quality;
}

/**
 * Snapshot returned by `getBestTimeStatus()`. Everything UI-facing needs
 * lives here so components can render without re-deriving anything.
 */
export interface BestTimeStatus {
  /** ISO timestamp the snapshot was computed at (server or client clock). */
  computedAt: string;
  /** Same instant rendered in IST — `"HH:mm"`. */
  istTime: string;
  /** Day-of-week resolved in IST. */
  istDay: DayRecommendation;
  /** Currently active window (worst-case fallback is the "off" sentinel). */
  active: TradingWindow;
  /** Composite 0–100 score blending window quality + weekday quality. */
  score: number;
  /** Headline verdict — "Ideal time to trade", "Good window", etc. */
  verdict: string;
  /** All overlapping windows right now (priority-sorted, highest first). */
  overlapping: TradingWindow[];
  /** Next more-important window starting later today (or null). */
  nextWindow: UpcomingWindow | null;
  /**
   * If `active` is finite, minutes until it ends (so the UI can show
   * "Ends in 1h 12m"). null when the active window is the "off" sentinel.
   */
  activeEndsInMinutes: number | null;
}
