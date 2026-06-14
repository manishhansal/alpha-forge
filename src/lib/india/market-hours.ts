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
