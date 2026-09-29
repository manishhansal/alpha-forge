/**
 * GET /api/in/ml-signals
 *
 * Serves the latest LightGBM scoring snapshot from ml-service2.0 to the
 * AlphaForge frontend.  Calls GET /v2/signals/latest and caches the result
 * in Redis for 30 seconds (same TTL as crypto AI signals).
 *
 * Also supports:
 *   GET /api/in/ml-signals?view=history&date=YYYY-MM-DD
 *       → ForecastLedger records for the given date
 *   GET /api/in/ml-signals?view=log&n=10
 *       → Last N autorun tick samples (mini time-series)
 */

import { NextRequest, NextResponse } from "next/server";

import {
  fetchMLLatestSignals,
  fetchMLSignalHistory,
  fetchMLAutorunLog,
  isMLServiceHealthy,
} from "@/lib/india/ml-client";
import { cached } from "@/lib/redis";

export const dynamic = "force-dynamic";

const ML_SIGNALS_KEY   = "ml:signals:latest:v1";
const ML_HISTORY_KEY   = (date: string) => `ml:signals:history:${date}:v1`;
const ML_LOG_KEY       = "ml:signals:autorun-log:v1";
const TTL_SIGNALS      = 30;   // seconds — refreshed every 5 min by autorun
const TTL_HISTORY      = 60;   // ForecastLedger changes once per session
const TTL_LOG          = 20;   // autorun log appended every 5 min

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const view  = searchParams.get("view") ?? "latest";
  const date  = searchParams.get("date") ?? undefined;
  const lastN = Number(searchParams.get("n") ?? "10");

  // ── history view ─────────────────────────────────────────────────────────
  if (view === "history") {
    const key = ML_HISTORY_KEY(date ?? "today");
    const data = await cached(key, TTL_HISTORY, () =>
      fetchMLSignalHistory(date),
    );
    if (!data) {
      return NextResponse.json(
        { error: "ML service unavailable", records: [], n: 0 },
        { status: 503 },
      );
    }
    return NextResponse.json(data);
  }

  // ── autorun log view ──────────────────────────────────────────────────────
  if (view === "log") {
    const data = await cached(ML_LOG_KEY, TTL_LOG, () =>
      fetchMLAutorunLog(Math.min(lastN, 100)),
    );
    if (!data) {
      return NextResponse.json({ samples: [], n: 0 });
    }
    return NextResponse.json(data);
  }

  // ── latest signals (default) ──────────────────────────────────────────────
  const healthy = await isMLServiceHealthy();
  if (!healthy) {
    return NextResponse.json(
      {
        available: false,
        stale: true,
        message: "ML service is not reachable. Start ml-service2.0 and run `make session`.",
        signals: [],
        n_scored: 0,
        n_long: 0,
        n_short: 0,
      },
      { status: 200 }, // 200 so the UI can render the empty-state gracefully
    );
  }

  const data = await cached(ML_SIGNALS_KEY, TTL_SIGNALS, () =>
    fetchMLLatestSignals(),
  );

  if (!data) {
    return NextResponse.json(
      {
        available: false,
        stale: true,
        message: "No signal snapshot found. Run `make session` to start the live session.",
        signals: [],
        n_scored: 0,
        n_long: 0,
        n_short: 0,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({ available: true, ...data });
}
