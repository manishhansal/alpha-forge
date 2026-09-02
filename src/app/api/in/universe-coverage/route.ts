/**
 * GET /api/in/universe-coverage
 *
 * Returns the canonical F&O universe summary and the latest coverage
 * snapshot for the current (or specified) IST session.
 *
 * Query params:
 *   date — IST date YYYY-MM-DD (default: today)
 */

import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  FNOUniverseService,
  buildUnavailableCoverageSnapshot,
  formatCoverageSummary,
} from "@/lib/signal-intelligence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function todayIST(): string {
  const d = new Date(Date.now() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date");
  const sessionDate = dateParam ?? todayIST();

  try {
    const prisma = getPrisma();

    const [universeSummary, coverageSnap] = await Promise.all([
      Promise.resolve(FNOUniverseService.getSummary()),
      prisma.universeCoverageSnapshot.findFirst({
        where: { sessionDate },
        orderBy: { capturedAt: "desc" },
      }),
    ]);

    const coverage = coverageSnap
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
          exclusionReasons: coverageSnap.exclusionReasons,
          coverageScore: coverageSnap.coverageScore,
          isValid: coverageSnap.isValid,
          minValidCoverage: 0.8,
          summary: formatCoverageSummary({
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
          }),
        }
      : {
          ...buildUnavailableCoverageSnapshot(sessionDate, "No snapshot found — scanner has not run yet"),
          summary: `Coverage: 0/${universeSummary.total} (0.0%) — INVALID`,
        };

    return NextResponse.json({
      universe: universeSummary,
      coverage,
      sessionDate,
    });
  } catch (err) {
    console.error("[universe-coverage]", err);
    return NextResponse.json(
      { error: "Universe coverage query failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
