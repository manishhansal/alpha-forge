/**
 * GET  /api/research/experiments  — Returns all experiments with optional filtering
 * POST /api/research/experiments  — Creates a new research experiment record
 *
 * Authentication is required for POST.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  createExperimentRecord,
  ExperimentStore,
} from "@/lib/research/experiments/research-experiment-tracker";
import { StrategyRegistry } from "@/lib/research/registry/strategy-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  const strategyId = url.searchParams.get("strategyId");

  let experiments = ExperimentStore.all();
  if (strategyId) {
    experiments = experiments.filter((e) => e.strategyId === strategyId);
  }

  return NextResponse.json({
    experiments,
    total: experiments.length,
    generatedAt: new Date().toISOString(),
  });
}

// ── POST ───────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  strategyId: z.string().min(1).max(64),
  strategyVersion: z.string().min(1).max(64),
  datasetVersion: z.string().min(1).max(128),
  parameterSet: z.record(z.union([z.number(), z.string(), z.boolean()])),
  marketUniverse: z.array(z.string()).min(1).max(200),
  dateRange: z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  validationMethod: z.enum([
    "WALK_FORWARD",
    "ANCHORED_WALK_FORWARD",
    "ROLLING_WALK_FORWARD",
    "PURGED_KFOLD",
    "CPCV",
    "SIMPLE_SPLIT",
  ]),
  costModelId: z.string().min(1).max(64),
  slippageModelId: z.string().min(1).max(64),
  notes: z.string().max(1000).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: true, code: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: true, code: "INVALID_JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: true, code: "VALIDATION_ERROR", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const data = parsed.data;

  // Validate strategy exists
  if (!StrategyRegistry.has(data.strategyId)) {
    return NextResponse.json(
      {
        error: true,
        code: "STRATEGY_NOT_FOUND",
        message: `Strategy "${data.strategyId}" is not registered in the StrategyRegistry.`,
      },
      { status: 422 },
    );
  }

  // Validate date ordering
  if (new Date(data.dateRange.start) >= new Date(data.dateRange.end)) {
    return NextResponse.json(
      { error: true, code: "INVALID_DATE_RANGE", message: "start must be before end" },
      { status: 422 },
    );
  }

  const experiment = createExperimentRecord(data);
  ExperimentStore.add(experiment);

  return NextResponse.json(
    { experiment, message: "Experiment created successfully" },
    { status: 201 },
  );
}
