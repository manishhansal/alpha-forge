/**
 * GET   /api/experiments/[id]
 *   Full experiment detail: metadata, per-arm performance metrics, pairwise
 *   A/B comparison, sample progress, and promotion readiness.
 *
 * PATCH /api/experiments/[id]
 *   Lifecycle actions:
 *     { action: "start" }
 *     { action: "pause" }
 *     { action: "complete" }
 *     { action: "archive" }
 *
 *   Promotion actions:
 *     { action: "promote", armId, toMode: "PAPER" }
 *       — promotes a SHADOW arm to PAPER after gate checks pass.
 *     { action: "issue-approval-token", armId, issuedBy, justification }
 *       — issues a manual approval token for PAPER → LIVE.
 *     { action: "approve-live", armId, token, approvedBy }
 *       — validates the token and promotes the arm to LIVE.
 *
 * ⛔ There is NO endpoint that auto-promotes to LIVE. The "approve-live"
 *    action requires a human-issued token from "issue-approval-token".
 *
 * All endpoints require authentication.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  globalExperimentManager,
  globalPromotionEngine,
  comparisonEngine,
  ShadowTrader,
  type ExperimentMode,
} from "@/lib/experiments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Zod schemas ────────────────────────────────────────────────────────────────

const lifecycleSchema = z.object({
  action: z.enum(["start", "pause", "complete", "archive"]),
});

const promoteSchema = z.object({
  action: z.literal("promote"),
  armId: z.string().min(1).max(64),
  toMode: z.enum(["PAPER"]), // only SHADOW→PAPER via automated gate check
});

const issueTokenSchema = z.object({
  action: z.literal("issue-approval-token"),
  armId: z.string().min(1).max(64),
  issuedBy: z.string().min(1).max(256),
  justification: z.string().min(10).max(1024),
});

const approveLiveSchema = z.object({
  action: z.literal("approve-live"),
  armId: z.string().min(1).max(64),
  token: z.string().min(32).max(128),
  approvedBy: z.string().min(1).max(256),
});

const patchBodySchema = z.discriminatedUnion("action", [
  lifecycleSchema,
  promoteSchema,
  issueTokenSchema,
  approveLiveSchema,
]);

// ── Route params ───────────────────────────────────────────────────────────────

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(_req: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in required." },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  const experiment = globalExperimentManager.getExperiment(id);
  if (!experiment) {
    return NextResponse.json(
      { error: true, code: "NOT_FOUND", message: `Experiment ${id} not found.` },
      { status: 404 },
    );
  }

  // Per-arm signals & metrics
  const armsDetail = experiment.arms.map((arm) => {
    const signals = globalExperimentManager.getSignalsForArm(id, arm.id);
    const closedTradeCount = arm.closedTradeCount;

    // Promotion readiness
    let readiness: ReturnType<typeof globalPromotionEngine.readinessSummary> | null = null;
    if (arm.mode === "SHADOW" && experiment.startedAtMs !== null) {
      const dummySummary = buildDummySummary(id, arm.id, arm.closedTradeCount, signals);
      try {
        readiness = globalPromotionEngine.readinessSummary(
          id,
          arm.id,
          dummySummary,
          experiment.startedAtMs,
        );
      } catch {
        /* non-fatal */
      }
    }

    // Promotion check for PAPER arms (readiness for LIVE)
    let liveCheck: ReturnType<typeof globalPromotionEngine.checkPromotion> | null = null;
    if (arm.mode === "PAPER" && experiment.startedAtMs !== null) {
      const dummySummary = buildDummySummary(id, arm.id, arm.closedTradeCount, signals);
      try {
        liveCheck = globalPromotionEngine.checkPromotion(
          id,
          arm.id,
          "PAPER",
          "LIVE",
          dummySummary,
          experiment.startedAtMs,
        );
      } catch {
        /* non-fatal */
      }
    }

    return {
      ...arm,
      signalCount: signals.length,
      closedTradeCount,
      recentSignals: signals.slice(-10).map((s) => ({
        id: s.id,
        timestampMs: s.timestampMs,
        symbol: s.symbol,
        direction: s.direction,
        confidence: s.confidence,
        riskReward: s.riskReward,
        acted: s.acted,
      })),
      promotionReadiness: readiness,
      liveCheck,
    };
  });

  // A/B comparison — build minimal arm inputs from signal data
  let comparison = null;
  if (experiment.arms.length >= 2) {
    const armInputs = experiment.arms.map((arm) => {
      const signals = globalExperimentManager.getSignalsForArm(id, arm.id);
      return {
        armId: arm.id,
        label: arm.label,
        role: arm.role,
        trades: [] as ReturnType<ShadowTrader["closedTrades"]>,
        signals,
        summary: buildDummySummary(id, arm.id, arm.closedTradeCount, signals),
        equityValues: [] as number[],
      };
    });

    try {
      comparison = comparisonEngine.compare({
        experimentId: id,
        arms: armInputs,
        observationBars: 0,
      });
    } catch {
      /* non-fatal — insufficient data */
    }
  }

  return NextResponse.json({
    experiment: { ...experiment, arms: armsDetail },
    comparison,
    generatedAtMs: Date.now(),
  });
}

// ── PATCH ──────────────────────────────────────────────────────────────────────

export async function PATCH(req: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: true, code: "UNAUTHORIZED", message: "Sign in required." },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  const experiment = globalExperimentManager.getExperiment(id);
  if (!experiment) {
    return NextResponse.json(
      { error: true, code: "NOT_FOUND", message: `Experiment ${id} not found.` },
      { status: 404 },
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

  const parsed = patchBodySchema.safeParse(body);
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

  const data = parsed.data;

  try {
    // ── Lifecycle actions ────────────────────────────────────────────────
    if (
      data.action === "start" ||
      data.action === "pause" ||
      data.action === "complete" ||
      data.action === "archive"
    ) {
      switch (data.action) {
        case "start":
          globalExperimentManager.startExperiment(id);
          break;
        case "pause":
          globalExperimentManager.pauseExperiment(id);
          break;
        case "complete":
          globalExperimentManager.completeExperiment(id);
          break;
        case "archive":
          globalExperimentManager.archiveExperiment(id);
          break;
      }
      return NextResponse.json({ ok: true, action: data.action, experimentId: id });
    }

    // ── SHADOW → PAPER promotion ─────────────────────────────────────────
    if (data.action === "promote") {
      const { armId, toMode } = data;
      const arm = experiment.arms.find((a) => a.id === armId);
      if (!arm) {
        return NextResponse.json(
          { error: true, code: "ARM_NOT_FOUND", message: `Arm ${armId} not found.` },
          { status: 404 },
        );
      }

      if (arm.mode !== "SHADOW") {
        return NextResponse.json(
          {
            error: true,
            code: "INVALID_TRANSITION",
            message: `Arm is in ${arm.mode} mode — only SHADOW arms can be promoted to PAPER via this endpoint.`,
          },
          { status: 422 },
        );
      }

      // Gate check
      const signals = globalExperimentManager.getSignalsForArm(id, armId);
      const summary = buildDummySummary(id, armId, arm.closedTradeCount, signals);
      const check = globalPromotionEngine.checkPromotion(
        id,
        armId,
        "SHADOW",
        toMode as ExperimentMode,
        summary,
        experiment.startedAtMs ?? Date.now(),
      );

      if (check.status !== "ELIGIBLE") {
        return NextResponse.json(
          {
            error: true,
            code: "PROMOTION_GATES_NOT_MET",
            message: `Promotion blocked: ${check.blockers.join("; ")}`,
            check,
          },
          { status: 422 },
        );
      }

      globalExperimentManager.promoteArm(id, armId, toMode as ExperimentMode);

      return NextResponse.json({
        ok: true,
        action: "promote",
        experimentId: id,
        armId,
        previousMode: "SHADOW",
        newMode: toMode,
        check,
      });
    }

    // ── Issue approval token (PAPER → LIVE first step) ───────────────────
    if (data.action === "issue-approval-token") {
      const { armId, issuedBy, justification } = data;
      const arm = experiment.arms.find((a) => a.id === armId);
      if (!arm) {
        return NextResponse.json(
          { error: true, code: "ARM_NOT_FOUND", message: `Arm ${armId} not found.` },
          { status: 404 },
        );
      }

      if (arm.mode !== "PAPER") {
        return NextResponse.json(
          {
            error: true,
            code: "INVALID_STATE",
            message: `Arm is in ${arm.mode} mode — approval tokens are only for PAPER arms awaiting LIVE promotion.`,
          },
          { status: 422 },
        );
      }

      const tokenRecord = globalPromotionEngine.issueApprovalToken(
        id,
        armId,
        issuedBy,
        justification,
      );

      // Return the token to the caller — they must supply it to approve-live.
      return NextResponse.json({
        ok: true,
        action: "issue-approval-token",
        experimentId: id,
        armId,
        token: tokenRecord.token,
        expiresAtMs: tokenRecord.expiresAtMs,
        issuedBy: tokenRecord.issuedBy,
        message:
          "Token issued. Supply this token to the approve-live action to complete LIVE promotion. " +
          "This token is single-use and expires in 24 hours.",
      });
    }

    // ── Approve live promotion (PAPER → LIVE second step) ────────────────
    if (data.action === "approve-live") {
      const { armId, token, approvedBy } = data;
      const arm = experiment.arms.find((a) => a.id === armId);
      if (!arm) {
        return NextResponse.json(
          { error: true, code: "ARM_NOT_FOUND", message: `Arm ${armId} not found.` },
          { status: 404 },
        );
      }

      if (arm.mode !== "PAPER") {
        return NextResponse.json(
          {
            error: true,
            code: "INVALID_STATE",
            message: `Arm is in ${arm.mode} mode — only PAPER arms can be promoted to LIVE.`,
          },
          { status: 422 },
        );
      }

      // Validate & consume token (throws on any invalid state)
      const tokenRecord = globalPromotionEngine.approveLivePromotion(
        token,
        id,
        armId,
        approvedBy,
      );

      // Complete the promotion — passes approvalToken to enforce the guard
      globalExperimentManager.promoteArm(id, armId, "LIVE", token);

      return NextResponse.json({
        ok: true,
        action: "approve-live",
        experimentId: id,
        armId,
        previousMode: "PAPER",
        newMode: "LIVE",
        approvedBy,
        tokenIssuedBy: tokenRecord.issuedBy,
        tokenIssuedAtMs: tokenRecord.issuedAtMs,
        promotedAtMs: Date.now(),
      });
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: true,
        code: "ACTION_FAILED",
        message: (err as Error).message,
      },
      { status: 422 },
    );
  }

  // Unreachable — discriminatedUnion exhausts all cases
  return NextResponse.json({ error: true, code: "UNKNOWN_ACTION" }, { status: 400 });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildDummySummary(
  experimentId: string,
  armId: string,
  closedTradeCount: number,
  signals: ReturnType<typeof globalExperimentManager.getSignalsForArm>,
) {
  const avgConf =
    signals.length > 0
      ? signals.reduce((a, s) => a + s.confidence, 0) / signals.length
      : 0;

  return {
    experimentId,
    armId,
    totalTrades: closedTradeCount,
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
    equityCurvePoints: signals.length,
    benchmarkPoints: 0,
    lastUpdatedAtMs: signals.length > 0 ? signals[signals.length - 1].timestampMs : null,
    avgConfidence: avgConf,
  };
}
