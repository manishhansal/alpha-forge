/**
 * NSE DIRECT DATA ACQUISITION — REMOVED
 *
 * This provider was REMOVED as of 2026-09-03 as a hard architectural requirement.
 * Direct NSE data acquisition (nseindia.com, nsearchives.nseindia.com,
 * charting.nseindia.com, stock-nse-india npm package, Scrapling browser sessions
 * for NSE) is PROHIBITED in production code.
 *
 * Provider chain is now: DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO
 *
 * Why direct NSE was removed:
 *   1. Fragile — NSE anti-bot / shadow-ban causes silent data failures
 *   2. Legally ambiguous — automated scraping of NSE violates their ToS
 *   3. Unreliable — cookie sessions expire, requiring browser warm-up overhead
 *   4. Superseded — Angel One SmartAPI and Upstox provide the same data
 *      as legitimate broker APIs with SLA guarantees
 *   5. Option chain with greeks — only broker APIs (Angel/Upstox) provide
 *      live greeks; NSE provides none
 *
 * If you need to re-enable an NSE-sourced data path, route it through the
 * Data Service canonical gateway rather than direct acquisition, and ensure
 * it is NOT the primary or fallback production path.
 *
 * For legitimate NSE exchange identifiers (NSE_EQ, NSE_FO, Exchange="NSE",
 * NSE trading calendar, etc.) — those are FINE and remain throughout the codebase.
 *
 * @deprecated Since 2026-09-03 — not exported, not registered, not imported.
 */

// This file is intentionally empty of runtime exports.
// It exists only to:
//   (a) prevent accidental re-introduction via git revert
//   (b) document why the NSE provider was removed
//   (c) serve as a redirect notice for readers

export const NSE_PROVIDER_REMOVED_REASON =
  "Direct NSE data acquisition removed 2026-09-03. Use DATA_SERVICE → ANGEL_ONE → UPSTOX → YAHOO chain.";
