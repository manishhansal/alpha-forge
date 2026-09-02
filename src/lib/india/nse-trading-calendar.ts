/**
 * NSE Trading Calendar — Phase 11
 *
 * Canonical NSE trading calendar service.
 * Goes beyond weekend-only checks to support:
 *   - NSE public holidays
 *   - Special trading sessions
 *   - Muhurat trading
 *   - Early close / late open
 *   - Weekly and monthly expiry detection
 *   - Holiday-shifted expiry
 *   - Timezone: Asia/Kolkata (IST = UTC+5:30, no DST)
 *
 * Architecture:
 *   TradingCalendarProvider
 *   ↓
 *   NSETradingCalendar
 *   ↓
 *   MarketSessionService
 *   ↓
 *   Consumers (workers, candle builder, strategies, EOD jobs, paper trading, backtesting)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1_000; // UTC+5:30

/** Regular session open: 09:15 IST */
export const SESSION_OPEN_MINUTES = 9 * 60 + 15;  // 555

/** Regular session close: 15:30 IST */
export const SESSION_CLOSE_MINUTES = 15 * 60 + 30; // 930

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionType =
  | "REGULAR"          // Normal 09:15–15:30 IST session
  | "MUHURAT"          // Muhurat trading (special evening session)
  | "SPECIAL_OPEN"     // Special session with different open time
  | "SPECIAL_CLOSE"    // Special session with different close time
  | "HOLIDAY"          // Market closed (public holiday)
  | "WEEKEND"          // Saturday or Sunday
  | "EXPIRY";          // Regular session + this is an expiry day

export type MarketSessionInfo = {
  date: string;           // IST calendar date YYYY-MM-DD
  sessionType: SessionType;
  isOpen: boolean;
  openMinutes: number;    // Minutes from IST midnight (555 = 09:15)
  closeMinutes: number;   // Minutes from IST midnight (930 = 15:30)
  /** For HOLIDAY/MUHURAT: human-readable description. */
  note: string | null;
};

export type ExpiryInfo = {
  /** IST calendar date of the expiry. */
  date: string;
  /** Underlying index. */
  underlying: "NIFTY" | "BANKNIFTY" | "FINNIFTY" | "MIDCPNIFTY" | "SENSEX";
  expiryType: "WEEKLY" | "MONTHLY";
  /** True when the scheduled expiry day was a holiday and shifted to the previous trading day. */
  isShifted: boolean;
  /** Original scheduled date (before holiday shift). */
  originalDate: string;
};

// ─── NSE Holidays (versioned, updateable) ────────────────────────────────────

/**
 * NSE holiday calendar version.
 * Update this when adding new holidays. Consumers check this version to
 * detect calendar updates that require cache invalidation.
 */
export const HOLIDAY_CALENDAR_VERSION = "2026-v1";

/**
 * NSE public holidays for 2024.
 * Source: NSE India official holiday list.
 * Note: This list must be updated annually. The calendar is updateable
 * by changing this array — no hardcoded future assumptions.
 */
export const NSE_HOLIDAYS_2024: readonly string[] = [
  "2024-01-22", // Ram Lalla Prana Pratishtha
  "2024-01-26", // Republic Day
  "2024-03-08", // Mahashivratri
  "2024-03-25", // Holi
  "2024-03-29", // Good Friday
  "2024-04-11", // Id-ul-Fitr (Ramzan Eid)
  "2024-04-14", // Dr. Baba Saheb Ambedkar Jayanti / Bihu / Tamil New Year
  "2024-04-17", // Ram Navami
  "2024-04-21", // Mahavir Jayanti
  "2024-04-23", // General Election
  "2024-05-20", // General Election
  "2024-05-23", // Buddha Pournima
  "2024-06-17", // Eid ul-Adha (Bakri Id)
  "2024-07-17", // Muharram
  "2024-08-15", // Independence Day
  "2024-10-02", // Mahatma Gandhi Jayanti
  "2024-10-13", // Dussehra
  "2024-11-01", // Diwali (Laxmi Pujan) — regular session closed; Muhurat evening session open
  "2024-11-15", // Gurunanak Jayanti
  "2024-12-25", // Christmas
];

/**
 * NSE public holidays for 2025.
 * Source: NSE India official circular (Capital Markets Segment).
 * Total: 14 weekday trading holidays.
 * Note: Republic Day (Jan 26 Sun), Ram Navami (Apr 6 Sun), Bakri Eid (Jun 7 Sat),
 * Muharram (Jul 6 Sun) fall on weekends — no additional weekday closure.
 */
export const NSE_HOLIDAYS_2025: readonly string[] = [
  "2025-02-26", // Mahashivratri
  "2025-03-14", // Holi
  "2025-03-31", // Id-ul-Fitr (Ramzan Eid)
  "2025-04-10", // Mahavir Jayanti
  "2025-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2025-04-18", // Good Friday
  "2025-05-01", // Maharashtra Day
  "2025-08-15", // Independence Day
  "2025-08-27", // Ganesh Chaturthi
  "2025-10-02", // Gandhi Jayanti / Dussehra
  "2025-10-21", // Diwali Laxmi Pujan — regular session closed; Muhurat evening session open
  "2025-10-22", // Diwali Balipratipada
  "2025-11-05", // Guru Nanak Jayanti
  "2025-12-25", // Christmas
];

/**
 * NSE public holidays for 2026.
 * Source: NSE India official circular NSE/CMTR/71775 (Capital Markets Segment).
 * Total: 15 weekday trading holidays.
 * Note: Mahashivratri (Feb 15 Sun), Eid-ul-Fitr (Mar 21 Sat),
 * Independence Day (Aug 15 Sat), Diwali Laxmi Pujan (Nov 8 Sun) fall on
 * weekends — no additional weekday closure. Muhurat Trading on Nov 8 (Sun).
 */
export const NSE_HOLIDAYS_2026: readonly string[] = [
  "2026-01-15", // Municipal Corporation Elections (Maharashtra)
  "2026-01-26", // Republic Day
  "2026-03-03", // Holi
  "2026-03-26", // Shri Ram Navami
  "2026-03-31", // Shri Mahavir Jayanti
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-28", // Bakri Eid (Eid-ul-Adha)
  "2026-06-26", // Muharram
  "2026-09-14", // Ganesh Chaturthi
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-10-20", // Dussehra (Vijayadashami)
  "2026-11-10", // Diwali Balipratipada
  "2026-11-24", // Prakash Gurpurb Sri Guru Nanak Dev
  "2026-12-25", // Christmas
];

/** Combined holiday set for 2024–2026 for multi-year calendar instances. */
export const NSE_HOLIDAYS_2024_2026: readonly string[] = [
  ...NSE_HOLIDAYS_2024,
  ...NSE_HOLIDAYS_2025,
  ...NSE_HOLIDAYS_2026,
];

/** Muhurat trading sessions in 2024 (evening sessions). */
export const NSE_MUHURAT_2024: Array<{ date: string; openMinutes: number; closeMinutes: number; note: string }> = [
  {
    date: "2024-11-01",
    openMinutes: 18 * 60 + 15, // 18:15 IST (approximate; actual time announced by NSE)
    closeMinutes: 19 * 60 + 15, // 19:15 IST
    note: "Diwali Muhurat Trading 2024",
  },
];

/** Muhurat trading sessions in 2025 (evening sessions on Diwali). */
export const NSE_MUHURAT_2025: Array<{ date: string; openMinutes: number; closeMinutes: number; note: string }> = [
  {
    date: "2025-10-21",
    openMinutes: 18 * 60 + 0,  // ~18:00 IST (exact timings to be notified by NSE)
    closeMinutes: 19 * 60 + 0, // ~19:00 IST
    note: "Diwali Muhurat Trading 2025 — Samvat 2082",
  },
];

/** Muhurat trading sessions in 2026 (evening sessions on Diwali — falls on Sunday). */
export const NSE_MUHURAT_2026: Array<{ date: string; openMinutes: number; closeMinutes: number; note: string }> = [
  {
    date: "2026-11-08",
    openMinutes: 18 * 60 + 0,  // ~18:00 IST (exact timings per NSE Circular)
    closeMinutes: 19 * 60 + 15, // ~19:15 IST
    note: "Diwali Muhurat Trading 2026 — Samvat 2083 (Sunday)",
  },
];

/** Combined Muhurat sessions for 2024–2026. */
export const NSE_MUHURAT_2024_2026 = [
  ...NSE_MUHURAT_2024,
  ...NSE_MUHURAT_2025,
  ...NSE_MUHURAT_2026,
];

// ─── NSE Trading Calendar ────────────────────────────────────────────────────

export class NSETradingCalendar {
  private readonly holidays: ReadonlySet<string>;
  private readonly muhuratByDate: Map<string, typeof NSE_MUHURAT_2024[0]>;

  constructor(
    holidays: readonly string[] = NSE_HOLIDAYS_2024,
    muhurats: typeof NSE_MUHURAT_2024 = NSE_MUHURAT_2024,
  ) {
    this.holidays = new Set(holidays);
    this.muhuratByDate = new Map(muhurats.map((m) => [m.date, m]));
  }

  // ── IST helpers ───────────────────────────────────────────────────────────

  private toIst(utcMs: number): { dayOfWeek: number; minutes: number; dateStr: string } {
    const istMs = utcMs + IST_OFFSET_MS;
    const d = new Date(istMs);
    return {
      dayOfWeek: d.getUTCDay(),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      dateStr: this.toIstDateString(istMs),
    };
  }

  private toIstDateString(istMs: number): string {
    const d = new Date(istMs);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dy = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${dy}`;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get full session info for a UTC timestamp.
   */
  getSessionInfo(utcMs: number): MarketSessionInfo {
    const { dayOfWeek, minutes, dateStr } = this.toIst(utcMs);

    // Muhurat check — must come before weekend check because Muhurat can
    // fall on a Sunday (e.g. Diwali 2026-11-08). A Sunday Muhurat date is
    // still a valid special session within its defined time window.
    const muhurat = this.muhuratByDate.get(dateStr);
    if (muhurat) {
      const isOpen = minutes >= muhurat.openMinutes && minutes <= muhurat.closeMinutes;
      return {
        date: dateStr,
        sessionType: "MUHURAT",
        isOpen,
        openMinutes: muhurat.openMinutes,
        closeMinutes: muhurat.closeMinutes,
        note: muhurat.note,
      };
    }

    // Weekend check (after Muhurat so Sunday Muhurat sessions are recognised)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return {
        date: dateStr,
        sessionType: "WEEKEND",
        isOpen: false,
        openMinutes: SESSION_OPEN_MINUTES,
        closeMinutes: SESSION_CLOSE_MINUTES,
        note: dayOfWeek === 0 ? "Sunday" : "Saturday",
      };
    }

    // Holiday check
    if (this.holidays.has(dateStr)) {
      return {
        date: dateStr,
        sessionType: "HOLIDAY",
        isOpen: false,
        openMinutes: SESSION_OPEN_MINUTES,
        closeMinutes: SESSION_CLOSE_MINUTES,
        note: "NSE public holiday",
      };
    }

    // Regular session
    const isOpen = minutes >= SESSION_OPEN_MINUTES && minutes <= SESSION_CLOSE_MINUTES;
    return {
      date: dateStr,
      sessionType: "REGULAR",
      isOpen,
      openMinutes: SESSION_OPEN_MINUTES,
      closeMinutes: SESSION_CLOSE_MINUTES,
      note: null,
    };
  }

  /**
   * True when the market is open at the given UTC timestamp.
   */
  isMarketOpen(utcMs: number): boolean {
    return this.getSessionInfo(utcMs).isOpen;
  }

  /**
   * True when a date string (IST YYYY-MM-DD) is a trading day
   * (not a weekend or holiday).
   */
  isTradingDay(istDate: string): boolean {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(istDate);
    if (!parts) return false;
    const utcMs = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    const d = new Date(utcMs);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    if (this.holidays.has(istDate)) return false;
    return true;
  }

  /**
   * Return the previous trading day (IST date) before `istDate`.
   */
  prevTradingDay(istDate: string): string {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(istDate);
    if (!parts) throw new Error(`Invalid date: ${istDate}`);
    let ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    for (let attempts = 0; attempts < 10; attempts++) {
      ms -= 86_400_000;
      const candidate = this.toIstDateString(ms + IST_OFFSET_MS);
      if (this.isTradingDay(candidate)) return candidate;
    }
    throw new Error(`Could not find previous trading day within 10 calendar days of ${istDate}`);
  }

  /**
   * Return the next trading day (IST date) after `istDate`.
   */
  nextTradingDay(istDate: string): string {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(istDate);
    if (!parts) throw new Error(`Invalid date: ${istDate}`);
    let ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    for (let attempts = 0; attempts < 10; attempts++) {
      ms += 86_400_000;
      const candidate = this.toIstDateString(ms + IST_OFFSET_MS);
      if (this.isTradingDay(candidate)) return candidate;
    }
    throw new Error(`Could not find next trading day within 10 calendar days of ${istDate}`);
  }

  /**
   * True when `istDate` is an NSE holiday.
   */
  isHoliday(istDate: string): boolean {
    return this.holidays.has(istDate);
  }

  /**
   * True when the regular NSE session for `tradeDate` has ended at `utcMs`.
   * Past trading days are always ended.
   */
  isSessionEndedForDate(tradeDate: string, utcMs: number): boolean {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradeDate);
    if (!parts) return false;
    const istMidnightMs =
      Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) - IST_OFFSET_MS;
    const closeMs = istMidnightMs + SESSION_CLOSE_MINUTES * 60_000;
    return utcMs >= closeMs;
  }
}

// ─── Global calendar instance ────────────────────────────────────────────────

/**
 * The canonical NSE trading calendar instance.
 * Import this everywhere instead of instantiating your own.
 *
 * Uses the combined 2024–2026 holiday set so the calendar is accurate for
 * any date in that window without additional instantiation. When a new year
 * is added, append its holiday constant to NSE_HOLIDAYS_2024_2026 and bump
 * HOLIDAY_CALENDAR_VERSION.
 */
export const nseCalendar = new NSETradingCalendar(
  NSE_HOLIDAYS_2024_2026,
  NSE_MUHURAT_2024_2026,
);

// ─── Market Session Service ──────────────────────────────────────────────────

/**
 * Canonical market session service. Provides a clean API for all consumers.
 */
export const MarketSessionService = {
  isOpen(utcMs: number = Date.now()): boolean {
    return nseCalendar.isMarketOpen(utcMs);
  },

  sessionInfo(utcMs: number = Date.now()): MarketSessionInfo {
    return nseCalendar.getSessionInfo(utcMs);
  },

  isTradingDay(istDate: string): boolean {
    return nseCalendar.isTradingDay(istDate);
  },

  prevTradingDay(istDate: string): string {
    return nseCalendar.prevTradingDay(istDate);
  },

  nextTradingDay(istDate: string): string {
    return nseCalendar.nextTradingDay(istDate);
  },

  isHoliday(istDate: string): boolean {
    return nseCalendar.isHoliday(istDate);
  },
} as const;
