/**
 * Daily Picks — Sector Watch + F&O Flow Tilt builders.
 *
 * Pure (no I/O) helpers that produce the SECTOR WATCH and FII FLOW lines of
 * the institutional Market Context Header from the data sources we can
 * actually reach:
 *
 *   - Sector Watch: derived from intraday % changes on the NSE sectoral
 *     indices (Nifty Bank, Nifty IT, Nifty Auto, …). Resolution happens at
 *     the I/O layer via the standard broker chain (Angel One serves what it
 *     can — Yahoo Finance backfills the rest).
 *
 *   - F&O Flow Tilt: SmartAPI does NOT expose the cash-market FII ₹Cr net
 *     buy/sell figure the spec asks for. The closest first-party signal is
 *     the OI-Buildup endpoint — counts of underlyings classified by Angel
 *     One as Long Built Up / Short Built Up / Short Covering / Long
 *     Unwinding. We surface that as an honest *institutional flow tilt*
 *     instead of a fabricated ₹Cr figure.
 */

import type {
  FiiFlowHeader,
  SectorWatchHeader,
} from "./market-context";

interface SectorRow {
  name: string;
  changePct: number | null | undefined;
}

/** Number of strong + weak picks surfaced on the header. */
const SECTOR_BREADTH = 2;

/**
 * Rank a list of sector intraday % changes into top-N strong + top-N weak.
 * Null / non-finite changes are dropped; an all-null input returns `null`
 * so the header renders `—` for the sector line.
 */
export function buildSectorWatch(
  rows: SectorRow[],
): SectorWatchHeader | null {
  const usable = rows.filter(
    (r): r is { name: string; changePct: number } =>
      typeof r.changePct === "number" && Number.isFinite(r.changePct),
  );
  if (usable.length === 0) return null;
  const byStrength = [...usable].sort((a, b) => b.changePct - a.changePct);
  // Only count a sector as "strong" if it's actually up on the day, and as
  // "weak" only if it's down — otherwise on a flat day we'd double-count the
  // same sectors in both lists.
  const strong = byStrength
    .filter((r) => r.changePct > 0)
    .slice(0, SECTOR_BREADTH)
    .map((r) => r.name);
  const weak = [...byStrength]
    .filter((r) => r.changePct < 0)
    .reverse()
    .slice(0, SECTOR_BREADTH)
    .map((r) => r.name);
  return { strong, weak };
}

export interface OiBuildupCounts {
  longBuiltUp: number;
  shortBuiltUp: number;
  shortCovering: number;
  longUnwinding: number;
}

/**
 * Classify a SmartAPI OI-Buildup snapshot as bullish / bearish / neutral.
 *
 * Maps to the trader's intuition:
 *   bullish  = `Long Built Up` (longs added) + `Short Covering` (shorts exited)
 *   bearish  = `Short Built Up` (shorts added) + `Long Unwinding` (longs exited)
 *   net tilt = bullish − bearish (positive = institutional longs adding;
 *              negative = institutional shorts dominating)
 *
 * Returns `null` when every category is empty (Angel One unconfigured or all
 * four endpoints failed) so the header line renders `—`.
 */
export function buildFnoFlowTilt(
  counts: OiBuildupCounts,
): FiiFlowHeader | null {
  const total =
    counts.longBuiltUp +
    counts.shortBuiltUp +
    counts.shortCovering +
    counts.longUnwinding;
  if (total <= 0) return null;
  const bullish = counts.longBuiltUp + counts.shortCovering;
  const bearish = counts.shortBuiltUp + counts.longUnwinding;
  const net = bullish - bearish;
  // ≥ 10% spread classifies a real tilt — otherwise call it balanced so we
  // don't read direction into noise.
  const spreadPct = total > 0 ? Math.abs(net) / total : 0;
  let label: "bullish" | "bearish" | "neutral";
  if (spreadPct < 0.1) label = "neutral";
  else if (net > 0) label = "bullish";
  else label = "bearish";

  const sign = net > 0 ? "+" : net < 0 ? "" : "±";
  const note =
    label === "neutral"
      ? `F&O OI tilt: balanced (${counts.longBuiltUp} LBU · ${counts.shortBuiltUp} SBU · ${counts.shortCovering} SC · ${counts.longUnwinding} LU)`
      : `F&O OI tilt: ${label} (${sign}${net} net · ${counts.longBuiltUp} LBU · ${counts.shortBuiltUp} SBU · ${counts.shortCovering} SC · ${counts.longUnwinding} LU)`;

  return {
    // SmartAPI does NOT expose the cash-market FII ₹Cr figure. We *only*
    // surface the OI-Buildup-derived tilt and leave `netCr` null so callers
    // can render "₹Cr — unavailable" if they want a footnote.
    netCr: null,
    note,
  };
}
