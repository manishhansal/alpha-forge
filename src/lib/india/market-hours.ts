// NSE cash/F&O session helpers. Pure + timezone-explicit (IST = UTC+5:30)
// so callers — most importantly the option-chain capture worker — don't
// snapshot stale chains outside trading hours. Public holidays are not
// modelled (NSE doesn't publish a stable machine-readable calendar); an
// off-day simply captures a flat, unchanged chain, which the reader can
// dedupe later if needed.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** 09:15 IST in minutes-from-midnight. */
const OPEN_MINUTES = 9 * 60 + 15;
/** 15:30 IST in minutes-from-midnight. */
const CLOSE_MINUTES = 15 * 60 + 30;

/**
 * True when `at` falls inside a regular NSE trading session
 * (Mon–Fri, 09:15–15:30 IST inclusive).
 */
export function isNseMarketOpenIST(at: Date): boolean {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= OPEN_MINUTES && minutes <= CLOSE_MINUTES;
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
