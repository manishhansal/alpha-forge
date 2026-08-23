/**
 * GET /api/in/signals — Unified Signals Board feed.
 *
 * Aggregates hits from the six core F&O scanner types into a single ranked
 * feed, computing a normalised `strengthScore` for each entry. After building
 * the feed, entries whose `strengthScore` is strictly above the 70th
 * percentile trigger a `SIGNALS_BOARD_NEW` WhatsApp notification (fire-and-
 * forget, Requirement 7.1).
 *
 * 70th-percentile formula (Requirement 7.1, design Property 12):
 *   threshold = sortedScores[Math.floor(0.7 * sortedScores.length)]
 *   emit only when entry.strengthScore > threshold (strictly greater)
 *
 * Requirements: 7.1, 10.3
 */

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { runScanner } from "@/services/india/scanner/engine";
import { dispatchWhatsApp } from "@/features/whatsapp/notifier";
import type { SignalsBoardEvent, SignalsBoardEntry } from "@/features/whatsapp/types";
import type { IndiaExchange } from "@/features/whatsapp/types";
import type { ScannerHit, ScannerType } from "@/types/india/scanner";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

// ─── Scanner types included in the unified board ─────────────────────────────

const BOARD_SCANNER_TYPES: ScannerType[] = [
  "momentum",
  "volume-breakout",
  "oi-buildup",
  "pcr",
  "iv-spike",
  "range-expansion",
];

/** Number of top hits to fetch from each scanner type. */
const HITS_PER_SCANNER = 25;

// ─── Direction inference ──────────────────────────────────────────────────────

/**
 * Infer trade direction from scanner hit fields.
 *
 * Priority:
 *   1. `kind` field — known bearish/bullish/short/long markers
 *   2. `changePct` sign — positive → LONG, negative → SHORT
 *   3. Default: LONG
 */
function inferDirection(hit: ScannerHit): "LONG" | "SHORT" {
  const kind = hit.kind?.toUpperCase() ?? "";

  // Explicit bearish markers from OI-buildup and momentum scanners
  if (
    kind === "SHORT_BUILDUP" ||
    kind === "LONG_UNWINDING" ||
    kind === "LOSER" ||
    kind === "BEAR_VOLUME" ||
    kind === "BEARISH" ||
    kind === "SHORT"
  ) {
    return "SHORT";
  }

  // Explicit bullish markers
  if (
    kind === "LONG_BUILDUP" ||
    kind === "SHORT_COVERING" ||
    kind === "GAINER" ||
    kind === "BULL_VOLUME" ||
    kind === "BULLISH" ||
    kind === "RANGE_EXPANSION" ||
    kind === "LONG"
  ) {
    return "LONG";
  }

  // PCR / IV-spike: infer from PCR value vs 1.0 midpoint
  if (kind === "BULLISH" || kind === "NEUTRAL") {
    return "LONG";
  }

  // Fallback: use price change direction
  if (hit.changePct !== null && hit.changePct < 0) return "SHORT";
  return "LONG";
}

// ─── Exchange inference ───────────────────────────────────────────────────────

/**
 * All signals from this board are NSE F&O instruments.
 * Index underlyings (NIFTY, BANKNIFTY, etc.) and all F&O stocks trade on NSE.
 */
function inferExchange(_symbol: string): IndiaExchange {
  return "NSE";
}

// ─── Key metric builder ───────────────────────────────────────────────────────

/**
 * Build the `keyMetric` string from a scanner hit.
 *
 * Prefers `metricLabel` (already human-readable) and falls back to combining
 * `kind` with the numeric `metric` value.
 */
function buildKeyMetric(hit: ScannerHit): string {
  if (hit.metricLabel && hit.metricLabel.trim().length > 0) {
    return hit.kind
      ? `${hit.kind.replace(/_/g, " ")} · ${hit.metricLabel}`
      : hit.metricLabel;
  }
  if (hit.kind) return hit.kind.replace(/_/g, " ");
  return hit.metric.toFixed(2);
}

// ─── Strength score normalisation ────────────────────────────────────────────

/**
 * Normalise a raw scanner `metric` value to a [0, 100] strength score.
 *
 * Each scanner type has different metric scales, so we clamp and normalise:
 * - `momentum` / `volume-breakout`: relative values (% moves, volume multiples)
 *   naturally cluster 0–10; clamp to [0, 100].
 * - `oi-buildup`: OI values in lakhs; take absolute value, log-scale, clamp.
 * - `pcr`: distance from 1.0 (neutral); scale 0–100.
 * - `iv-spike`: IV percentage; clamp to [0, 100].
 * - `range-expansion`: composite score (rangeRatio × volRatio); clamp [0, 100].
 *
 * For all types: clamp the raw metric to [0, 100] to get a comparable score.
 */
function computeStrengthScore(hit: ScannerHit, scannerType: ScannerType): number {
  const raw = Math.abs(hit.metric);

  switch (scannerType) {
    case "pcr": {
      // PCR: distance from neutral (1.0) normalised to [0, 100]
      // PCR of 0 or 2 → distance of 1 → score of 100
      // PCR of 1 (neutral) → distance of 0 → score of 0
      const dist = Math.abs(raw - 1.0);
      return Math.min(100, Math.round(dist * 100));
    }
    case "iv-spike": {
      // IV%: typical range 8–40%. Normalise: 0% → 0, 50%+ → 100
      return Math.min(100, Math.round((raw / 50) * 100));
    }
    case "oi-buildup": {
      // OI in lakhs (1e5 lots); log-scale to spread scores meaningfully
      if (raw <= 0) return 0;
      const logVal = Math.log10(raw + 1);
      // log10(1_000_000) ≈ 6; clamp at 6 → 100
      return Math.min(100, Math.round((logVal / 6) * 100));
    }
    case "volume-breakout": {
      // Volume ratio (e.g. 1.5× avg → 50, 3.0× → 100)
      return Math.min(100, Math.round(((raw - 1) / 2) * 100));
    }
    case "range-expansion": {
      // Composite score: rangeRatio × volRatio × closeStrength factor
      // Typical range: 0.5–5; clamp at 5 → 100
      return Math.min(100, Math.round((raw / 5) * 100));
    }
    case "momentum":
    default: {
      // % change — absolute value clamped to [0, 100]
      return Math.min(100, Math.max(0, Math.round(Math.abs(raw))));
    }
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // ── 1. Fetch all scanner results in parallel ──────────────────────────
    const scannerResults = await Promise.allSettled(
      BOARD_SCANNER_TYPES.map((type) =>
        runScanner(type, HITS_PER_SCANNER).catch((err) => {
          console.warn(`[/api/in/signals] scanner "${type}" failed:`, (err as Error).message);
          return null;
        }),
      ),
    );

    // ── 2. Flatten into SignalsBoardEntry list ────────────────────────────
    const entries: SignalsBoardEntry[] = [];
    const seenSymbols = new Set<string>();

    for (let i = 0; i < scannerResults.length; i++) {
      const result = scannerResults[i];
      const scannerType = BOARD_SCANNER_TYPES[i];

      if (result.status !== "fulfilled" || !result.value) continue;
      const { hits } = result.value;

      for (const hit of hits) {
        // Skip hits with null price — not actionable
        if (hit.price == null) continue;

        // De-duplicate by symbol within the unified feed
        // (keep first occurrence — highest-ranked scanner wins)
        if (seenSymbols.has(hit.symbol)) continue;
        seenSymbols.add(hit.symbol);

        const strengthScore = computeStrengthScore(hit, scannerType);
        const direction = inferDirection(hit);
        const exchange = inferExchange(hit.symbol);
        const keyMetric = buildKeyMetric(hit);

        entries.push({
          symbol: hit.symbol,
          exchange,
          sourceType: scannerType,
          direction,
          price: hit.price,
          changePct: hit.changePct ?? 0,
          keyMetric,
          strengthScore,
        });
      }
    }

    // ── 3. Sort by strengthScore descending ───────────────────────────────
    entries.sort((a, b) => b.strengthScore - a.strengthScore);

    // ── 4. WhatsApp notifications (fire-and-forget) ───────────────────────
    // Requirements 7.1, 10.3:
    // Compute the 70th percentile threshold and emit SIGNALS_BOARD_NEW for
    // every entry strictly above it.
    //
    // Formula (from design doc):
    //   sortedScores[Math.floor(0.7 * sortedScores.length)]
    //
    // Only dispatch when we have an authenticated userId — no userId means
    // there is no phone number to dispatch to.
    if (entries.length > 0) {
      const session = await auth();
      const userId = session?.user?.id;

      if (userId) {
        // Build sorted score array (ascending) for the percentile formula
        const sortedScores = entries
          .map((e) => e.strengthScore)
          .slice()
          .sort((a, b) => a - b);

        // 70th-percentile threshold (design doc formula)
        const p70Index = Math.floor(0.7 * sortedScores.length);
        const threshold = sortedScores[p70Index] ?? 0;

        for (const entry of entries) {
          if (entry.strengthScore > threshold) {
            const event: SignalsBoardEvent = {
              type: "SIGNALS_BOARD_NEW",
              entry,
            };
            void dispatchWhatsApp(event, userId).catch((err) =>
              console.warn("[/api/in/signals] whatsapp dispatch error:", err),
            );
          }
        }
      }
    }

    // ── 5. Return the unified feed to the client ──────────────────────────
    return NextResponse.json(
      { entries, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[/api/in/signals] error:", err);
    return NextResponse.json(
      {
        error: true,
        code: "SIGNALS_BOARD_FAILED",
        message: (err as Error).message,
      },
      { status: 502 },
    );
  }
}
