/**
 * GET  /api/experiments
 *   Returns a snapshot of all experiments: status counts, per-experiment
 *   metadata, signal totals, and promotion readiness for every SHADOW arm.
 *
 * POST /api/experiments
 *   Create a new experiment (name, symbols, arms with versionStamps).
 *
 * All endpoints require authentication.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  globalExperimentManager,
  globalPromotionEngine,
  type CreateExperimentInput,
} from "@/lib/experiments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Zod schemas ────────────────────────────────────────────────────────────────

const versionStampSchema = z.object({
  strategyVersion: z.string().min(1).max(128),
  modelVersion: z.string().min(1).max(128),
  featureVersion: z.string().min(1).max(128),
  experimentId: z.string().default(""),
});

const armSchema = z.object({
  id: z.string().min(1).max(64),
  role: z.enum(["CONTROL", "EXPERIMENT"]),
  label: z.string().min(1).max(128),
  versionStamp: versionStampSchema,
  mode: z.enum(["RESEARCH", "BACKTEST", "SHADOW", "PAPER", "LIVE"]),
});

const createBodySchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  symbols: z.array(z.string().min(1).max(64)).min(1).max(50),
  arms: z.array(armSchema).min(1).max(10),
  tags: z.array(z.string().max(64)).max(20).optional(),
});

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in required." },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get("status"); // RUNNING|PAUSED|COMPLETED|FAILED|ARCHIVED
  const tagFilter = searchParams.get("tag");

  const snapshot = globalExperimentManager.snapshot();

  // Optionally filter experiments
  let experiments = snapshot.experiments;
  if (statusFilter) {
    experiments = experiments.filter((e) => e.status === statusFilter);
  }
  if (tagFilter) {
    experiments = experiments.filter((e) => e.tags?.includes(tagFilter));
  }

  // Enrich each experiment with per-arm signal counts and promotion readiness
  const enriched = experiments.map((exp) => {
    const armsEnriched = exp.arms.map((arm) => {
      const signals = globalExperimentManager.getSignalsForArm(exp.id, arm.id);

      // Compute promotion readiness for SHADOW arms
      let promotionReadiness: ReturnType<
        typeof globalPromotionEngine.readinessSummary
      > | null = null;

      if (arm.mode === "SHADOW" && exp.startedAtMs !== null) {
        // Build a minimal ShadowSummary from recorded signals for readiness check
        const closedSignals = signals.filter((s) => s.acted === false);
        const dummySummary = {
          experimentId: exp.id,
          armId: arm.id,
          totalTrades: arm.closedTradeCount,
          openPositions: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalNetPnlINR: 0,
          avgReturnPct: 0,
          profitFactor: 0,
          sharpe: 0,
          maxDrawdownPct: 0,
          initialCapital: 1_000_000,
          currentEquity: 1_000_000,
          totalReturnPct: 0,
          totalCommissionINR: 0,
          equityCurvePoints: closedSignals.length,
          benchmarkPoints: 0,
          lastUpdatedAtMs: arm.lastTickMs,
        };

        try {
          promotionReadiness = globalPromotionEngine.readinessSummary(
            exp.id,
            arm.id,
            dummySummary,
            exp.startedAtMs,
          );
        } catch {
          // Non-fatal — readiness simply not available
        }
      }

      return {
        ...arm,
        signalCount: signals.length,
        promotionReadiness,
      };
    });

    return { ...exp, arms: armsEnriched };
  });

  return NextResponse.json({
    totalExperiments: snapshot.totalExperiments,
    running: snapshot.running,
    paused: snapshot.paused,
    completed: snapshot.completed,
    failed: snapshot.failed,
    totalSignals: snapshot.totalSignals,
    experiments: enriched,
    generatedAtMs: Date.now(),
  });
}

// ── POST ───────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in required." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: true, code: "INVALID_JSON", message: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: true,
        code: "VALIDATION_ERROR",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  }

  const input = parsed.data;

  // Guard: LIVE mode arms cannot be created directly
  const liveArms = input.arms.filter((a) => a.mode === "LIVE");
  if (liveArms.length > 0) {
    return NextResponse.json(
      {
        error: true,
        code: "LIVE_ARM_FORBIDDEN",
        message:
          "Arms cannot be created directly in LIVE mode. Start in SHADOW or PAPER and use the promotion endpoint.",
      },
      { status: 422 },
    );
  }

  try {
    const experiment = globalExperimentManager.createExperiment(
      input as CreateExperimentInput,
    );

    return NextResponse.json(experiment, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error: true,
        code: "CREATE_FAILED",
        message: (err as Error).message,
      },
      { status: 422 },
    );
  }
}
