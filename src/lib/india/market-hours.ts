// NSE cash/F&O session helpers. Pure + timezone-explicit (IST = UTC+5:30)
// so callers — most importantly the option-chain capture worker — don't
// snapshot stale chains outside trading hours.
//
// CAL-001 FIX: `isNseMarketOpenIST` now delegates to `NSETradingCalendar`
// which includes public-holiday awareness (2024–2026 holiday list).
// Previously this function only checked Mon–Fri + session hours, meaning
// workers would run on NSE holidays and attempt to fetch stale data.
//
// Backward compatibility: the function signature is unchanged so all
// existing callers benefit without modification.

import { NSETradingCalendar, NSE_HOLIDAYS_2024, NSE_HOLIDAYS_2025, NSE_HOLIDAYS_2026, NSE_MUHURAT_2024_2026 } from "@/lib/india/nse-trading-calendar";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** 09:15 IST in minutes-from-midnight. */
const OPEN_MINUTES = 9 * 60 + 15;
/** 15:30 IST in minutes-from-midnight. */
const CLOSE_MINUTES = 15 * 60 + 30;

// Shared calendar instance — lazily built, reused across all calls in this
// module. Uses the combined 2024–2026 holiday list so the fix stays valid
// through end of 2026 without any additional changes.
let _calendar: NSETradingCalendar | null = null;
function getCalendar(): NSETradingCalendar {
  if (!_calendar) {
    _calendar = new NSETradingCalendar(
      [...NSE_HOLIDAYS_2024, ...NSE_HOLIDAYS_2025, ...NSE_HOLIDAYS_2026],
      NSE_MUHURAT_2024_2026,
    );
  }
  return _calendar;
}

/**
 * True when `at` falls inside a regular NSE trading session.
 *
 * CAL-001: Now checks NSE public holidays in addition to Mon–Fri and
 * session-hours (09:15–15:30 IST). On a holiday the session is closed;
 * Muhurat sessions (evening Diwali) are correctly recognised as open.
 */
export function isNseMarketOpenIST(at: Date): boolean {
  return getCalendar().isMarketOpen(at.getTime());
}

/**
 * Epoch ms of the 09:15 IST session open for an IST calendar date
 * (`YYYY-MM-DD`). Returns null for an unparseable date. 09:15 IST = 03:45 UTC.
 */
export function nseOpenMsForDateIST(tradeDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradeDate);
  if (!m) return null;
  const [, y, mo, d] = m;
  const istMidnightMs = Date.UTC(Number(y), Number(mo) - 1, Number(d)) - IST_OFFSET_MS;
  return istMidnightMs + OPEN_MINUTES * 60_000;
}

/**
 * Epoch ms of the 15:30 IST session close for an IST calendar date
 * (`YYYY-MM-DD`). Returns null for an unparseable date. 15:30 IST = 10:00 UTC.
 */
export function nseCloseMsForDateIST(tradeDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradeDate);
  if (!m) return null;
  const [, y, mo, d] = m;
  // IST midnight of the date, in epoch ms, then + the close minute offset.
  const istMidnightMs = Date.UTC(Number(y), Number(mo) - 1, Number(d)) - IST_OFFSET_MS;
  return istMidnightMs + CLOSE_MINUTES * 60_000;
}

/**
 * True when the regular NSE session for `tradeDate` (an IST calendar date) has
 * fully ended at `at`. Used to force intraday positions square-off at the
 * close — past trading days are always "ended"; today only after 15:30 IST.
 */
export function isNseSessionEndedForDateIST(tradeDate: string, at: Date): boolean {
  const closeMs = nseCloseMsForDateIST(tradeDate);
  if (closeMs == null) return false;
  return at.getTime() >= closeMs;
}
