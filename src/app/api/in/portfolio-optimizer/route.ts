import { NextResponse } from "next/server";
import { predictPortfolioV2 } from "@/lib/india/ml-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export interface PortfolioAllocation {
  method: "hrp" | "cvar" | "max_diversification" | "factor";
  weights: Record<string, number>;
  riskMetrics: {
    volatility: number;
    cvar: number;
    sharpe: number;
    maxDrawdown: number;
  };
  available: boolean;
  reason?: string;
}

/**
 * POST /api/in/portfolio-optimizer
 *
 * Accepts { symbols: string[], method: 'hrp' | 'cvar' | 'max_diversification' | 'factor' }
 * and calls the ML service POST /predict/portfolio-v2 via ml-client.ts
 * (which respects ML_MODE, timeouts, circuit-break, etc.).
 *
 * Returns { available: false, reason } when the ML service is unreachable
 * or returns an error — never a 5xx.
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.5, 10.6, 13.1
 */
export async function POST(req: Request): Promise<Response> {
  let symbols: string[] = [];
  let method: string = "hrp";

  try {
    const body = (await req.json()) as {
      symbols?: string[];
      method?: string;
    };
    symbols = body.symbols ?? [];
    method = body.method ?? "hrp";
  } catch {
    return NextResponse.json(
      { available: false, reason: "Invalid JSON body" },
      { status: 200 },
    );
  }

  try {
    // Route through the canonical ML client (respects ML_MODE, timeouts, etc.)
    const data = await predictPortfolioV2({ symbols, method });

    if (!data) {
      return NextResponse.json(
        { available: false, reason: "ML service unreachable or ML_MODE=disabled" },
        { status: 200 },
      );
    }

    if (!data.available) {
      return NextResponse.json(
        {
          available: false,
          reason: (data.reason as string) ?? "ML service returned no data",
        },
        { status: 200 },
      );
    }

    const allocation: PortfolioAllocation = {
      method: (data.method as PortfolioAllocation["method"]) ?? method,
      weights: (data.weights as Record<string, number>) ?? {},
      riskMetrics: (data.riskMetrics as PortfolioAllocation["riskMetrics"]) ?? {
        volatility: 0,
        cvar: 0,
        sharpe: 0,
        maxDrawdown: 0,
      },
      available: true,
    };

    return NextResponse.json(allocation, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "ML service unreachable";
    console.warn(`[portfolio-optimizer] failed: ${reason}`);

    return NextResponse.json(
      { available: false, reason },
      { status: 200 },
    );
  }
}
