/**
 * GET /api/in/signal-audit
 *
 * Returns the Today Signal Audit Report for the current or specified IST session.
 *
 * Query params:
 *   date  — IST date YYYY-MM-DD (default: today)
 *
 * The report is cached for 2 minutes during live sessions.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  FNOUniverseService,
  buildUnavailableCoverageSnapshot,
  SignalSourceRegistry,
  buildTodaySignalAuditReport,
  computeReplayHash,
  detectSignalDecay,
} from "@/lib/signal-intelligence";
import type { SignalSourceType } from "@/lib/signal-intelligence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIST(): string {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// 2-minute cache
let cache: { report: unknown; date: string; generatedAt: number } | null = null;
const CACHE_TTL_MS = 2 * 60 * 1000;

export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date");
  const sessionDate = dateParam ?? todayIST();

  if (
    cache &&
    cache.date === sessionDate &&
    Date.now() - cache.generatedAt < CACHE_TTL_MS
  ) {
    return NextResponse.json(cache.report, {
      headers: { "X-Cache": "HIT" },
    });
  }

  try {
    const prisma = getPrisma();
    const since = new Date(`${sessionDate}T00:00:00+05:30`);
    const until = new Date(`${sessionDate}T23:59:59+05:30`);

    // Fetch paper trades for the session
    const paperTrades = await prisma.paperTrade.findMany({
      where: {
        source: { startsWith: "in:" },
        openedAt: { gte: since, lte: until },
      },
      orderBy: { openedAt: "asc" },
      select: {
        id: true,
        symbol: true,
        direction: true,
        status: true,
        source: true,
        entry: true,
        stopLoss: true,
        target: true,
        pnlPct: true,
        meta: true,
        openedAt: true,
        closedAt: true,
      },
    });

    // Fetch universe coverage snapshot for this session
    const coverageSnap = await prisma.universeCoverageSnapshot.findFirst({
      where: { sessionDate },
      orderBy: { capturedAt: "desc" },
    });

    const universeCoverage = coverageSnap
      ? {
          sessionDate: coverageSnap.sessionDate,
          capturedAtMs: coverageSnap.capturedAt.getTime(),
          expectedInstruments: coverageSnap.expectedInstruments,
          availableInstruments: coverageSnap.availableInstruments,
          scannedInstruments: coverageSnap.scannedInstruments,
          dataCompleteInstruments: coverageSnap.dataCompleteInstruments,
          dataPartialInstruments: coverageSnap.dataPartialInstruments,
          dataMissingInstruments: coverageSnap.dataMissingInstruments,
          strategyEvaluatedInstruments: coverageSnap.strategyEvaluatedInstruments,
          paperEligibleInstruments: coverageSnap.paperEligibleInstruments,
          excludedInstruments: coverageSnap.excludedInstruments,
          exclusionReasons: coverageSnap.exclusionReasons as Array<{ instrument: string; reason: string }>,
          coverageScore: coverageSnap.coverageScore,
          isValid: coverageSnap.isValid,
          minValidCoverage: 0.8,
        }
      : buildUnavailableCoverageSnapshot(
          sessionDate,
          "No coverage snapshot found for this session — run the scanner to populate",
        );

    // Fetch signal lifecycle events for de-duplication and funnel
    const lifecycleEvents = await prisma.signalLifecycleEvent.findMany({
      where: { sessionDate },
      orderBy: { occurredAt: "asc" },
      select: { signalId: true, toState: true, strategyId: true, sourceType: true },
    });

    // Fetch opportunity clusters
    const clusters = await prisma.opportunityCluster.findMany({
      where: { sessionDate },
      select: { deduplicated: true },
    });

    // Build per-strategy breakdown
    const byStrategyMap = new Map<string, {
      strategyId: string;
      sourceType: SignalSourceType;
      signalsDetected: number;
      qualified: number;
      paperTrades: number;
      wins: number;
      losses: number;
      pnlPct: number;
    }>();

    for (const t of paperTrades) {
      const classified = SignalSourceRegistry.classifyPaperTradeSource(t.source);
      const sid = classified.strategyId;
      const existing = byStrategyMap.get(sid) ?? {
        strategyId: sid,
        sourceType: classified.sourceType,
        signalsDetected: 0,
        qualified: 0,
        paperTrades: 0,
        wins: 0,
        losses: 0,
        pnlPct: 0,
      };
      existing.paperTrades++;
      if (t.status === "WIN") existing.wins++;
      if (t.status === "LOSS") existing.losses++;
      const resolved = t.status !== "OPEN" && t.pnlPct !== null;
      if (resolved) existing.pnlPct += t.pnlPct ?? 0;
      byStrategyMap.set(sid, existing);
    }

    // Normalise P&L to per-trade average
    for (const entry of byStrategyMap.values()) {
      if (entry.paperTrades > 0) entry.pnlPct /= entry.paperTrades;
    }

    // Lifecycle event counts
    const detectedSignalIds = new Set(lifecycleEvents.filter((e) => e.toState === "DETECTED").map((e) => e.signalId));
    const qualifiedSignalIds = new Set(lifecycleEvents.filter((e) => e.toState === "QUALIFIED").map((e) => e.signalId));
    const approvedSignalIds = new Set(lifecycleEvents.filter((e) => e.toState === "APPROVED").map((e) => e.signalId));
    const rejectedSignalIds = new Set(lifecycleEvents.filter((e) => e.toState === "REJECTED").map((e) => e.signalId));

    const resolved = paperTrades.filter((t) => t.status !== "OPEN");
    const winners = resolved.filter((t) => t.status === "WIN").length;
    const losers = resolved.filter((t) => t.status === "LOSS").length;
    const duplicatesPrevented = clusters.filter((c) => c.deduplicated).length;

    const report = buildTodaySignalAuditReport({
      sessionDate,
      universeCoverage,
      signalsDetected: detectedSignalIds.size || paperTrades.length,
      signalsQualified: qualifiedSignalIds.size || paperTrades.length,
      riskApproved: approvedSignalIds.size || paperTrades.length,
      paperTradesOpened: paperTrades.length,
      paperTradesResolved: resolved.length,
      winners,
      losers,
      missedOpportunities: 0, // Requires independent recall engine
      falseSignals: losers,
      duplicatesPrevented,
      riskRejected: rejectedSignalIds.size,
      byStrategy: [...byStrategyMap.values()],
      mlEvaluated: paperTrades.some((t) => {
        const meta = t.meta as Record<string, unknown> | null;
        return meta?.mlEnhanced === true;
      }),
      mlBaseSignals: paperTrades.length,
      mlFilteredIn: paperTrades.filter((t) => {
        const meta = t.meta as Record<string, unknown> | null;
        return meta?.mlEnhanced === true;
      }).length,
      mlFilteredOut: 0,
      mlIncrementalPrecision: 0, // computed by signal quality engine
      avgSpreadPct: 0.1, // placeholder; real value requires bid/ask data
      avgSlippagePct: 0.05,
      dataFreshnessScore: universeCoverage.coverageScore,
      replayHash: null, // set after building
    });

    // Compute replay hash
    const withHash = { ...report, replayHash: computeReplayHash(report) };

    cache = { report: withHash, date: sessionDate, generatedAt: Date.now() };
    return NextResponse.json(withHash, { headers: { "X-Cache": "MISS" } });
  } catch (err) {
    console.error("[signal-audit]", err);
    return NextResponse.json(
      { error: "Signal audit failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
