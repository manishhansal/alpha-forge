/**
 * API Route: ML Predictions for the Indian Market
 *
 * Serves the ML-enhanced context (regime, rankings, strategy, risk,
 * portfolio optimization) to the frontend. This is the primary integration
 * point between the Next.js app and the Python ML service.
 *
 * GET  /api/in/ml-predictions         → Full ML context snapshot
 * POST /api/in/ml-predictions/risk    → Per-trade risk estimation
 * POST /api/in/ml-predictions/explain → SHAP explanation
 */

import { NextRequest, NextResponse } from "next/server";

import {
  isMLServiceHealthy,
  predictRegime,
  predictRisk,
  predictStrategy,
  predictPortfolio,
  explainPrediction,
  mlRegimeToAiRegime,
  mlRegimeToScore,
  type MLMarketRegime,
} from "@/lib/india/ml-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const healthy = await isMLServiceHealthy();

  if (!healthy) {
    return NextResponse.json(
      {
        available: false,
        message: "ML service is not reachable",
        fallback: true,
      },
      { status: 200 },
    );
  }

  // Return status and model info
  try {
    const statusRes = await fetch(
      `${process.env.ML_SERVICE_URL || "http://localhost:8100"}/models/status`,
      { cache: "no-store" },
    );
    const modelsStatus = statusRes.ok ? await statusRes.json() : null;

    return NextResponse.json({
      available: true,
      models: modelsStatus,
      timestamp: Date.now(),
    });
  } catch {
    return NextResponse.json({
      available: true,
      models: null,
      timestamp: Date.now(),
    });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { action } = body;

  switch (action) {
    case "regime": {
      const result = await predictRegime(body.features);
      if (!result) {
        return NextResponse.json(
          { error: "ML service unavailable" },
          { status: 503 },
        );
      }
      return NextResponse.json({
        ...result,
        aiRegime: mlRegimeToAiRegime(result.regime),
        regimeScore: mlRegimeToScore(result.regime),
      });
    }

    case "risk": {
      const result = await predictRisk(body.params);
      if (!result) {
        return NextResponse.json(
          { error: "ML service unavailable" },
          { status: 503 },
        );
      }
      return NextResponse.json(result);
    }

    case "strategy": {
      const result = await predictStrategy(body.params);
      if (!result) {
        return NextResponse.json(
          { error: "ML service unavailable" },
          { status: 503 },
        );
      }
      return NextResponse.json(result);
    }

    case "portfolio": {
      const result = await predictPortfolio(body.params);
      if (!result) {
        return NextResponse.json(
          { error: "ML service unavailable" },
          { status: 503 },
        );
      }
      return NextResponse.json(result);
    }

    case "explain": {
      const result = await explainPrediction(body.params);
      if (!result) {
        return NextResponse.json(
          { error: "ML service unavailable" },
          { status: 503 },
        );
      }
      return NextResponse.json(result);
    }

    default:
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 },
      );
  }
}
